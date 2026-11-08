/**
 * scenarios.js — 险情库（14 条 · 数据驱动）。
 *
 * 每条险情是一份声明对象：触发权重 / 保护期 / 触发条件 / 首次施加（真实改变仿真状态，
 * 只经 bus.damage.* 与 bus.send）/ 持续时间线 / 中文简报 / 正确处置步骤（对齐命令表）/
 * 处置判据（active | resolved | failed）。
 *
 * 设计约定：
 *  - apply() 必须真实改变 state（推力、液压、舱压、燃油、天气……），禁止只弹警告；
 *    警告由内核 computeWarnings 每步统一汇总，险情本身不点灯。
 *  - correctActions[i] 与 correctCommands[i] 一一对应：correctActions 是给提示卡 UI 的
 *    中文步骤（QRH 语言风格），correctCommands 是该步骤对应的总线命令 / damage 钩子
 *    （null = 纯飞行技术动作，无对应命令）。args 可以是数组，也可以是 (state, rt) => 数组。
 *  - resolveCheck(state, rt) 纯读 state + rt.data，给出处置进展判定：
 *      'active'   处置进行中（或未处置）
 *      'resolved' 处置正确完成
 *      'failed'   处置失败 / 情景失控
 *  - rt（runtime）= { scenarioId, name, triggeredAtS, phase, forced, rng, data, timelineIdx }；
 *    rt.data 是该次触发的私有记录（失效发动机号、语境标志等），resolveCheck 据此判据。
 *
 * 天气类险情按单元授权直接改 state.weather（环境数据字段，等同世界单元权限）；
 * 机械类一律走 bus.damage.* 钩子，绝不直接写其它 state 字段。
 */

import { getVSpeeds } from '../kernel/vspeeds.js';
import { FLAP_NOTCHES } from '../kernel/state.js';

/** @typedef {'mechanical'|'weather'} ScenarioCategory */
/** @typedef {'takeoff'|'climb'|'cruise'|'descent'|'approach'|'landing'} FlightPhase */

/** 持续失速判失败的时间窗 s（抖杆后 20 s 仍未改出） */
const STALL_FAIL_S = 20;
/** 结构性俯冲判失败的下降率 fpm（紧急下降合法值约 -3000~-6000，超出即失控） */
const DIVE_FAIL_FPM = -6000;

/**
 * 通用失败判定：持续失速超时，或结构性俯冲。
 * @param {Object} state 仿真状态树
 * @param {Object} rt   本次触发运行时记录
 * @returns {boolean} true = 情景已失控
 */
function commonFailure(state, rt) {
  const stalled = state.warnings.active.includes('STALL');
  if (stalled) {
    if (rt.data.stallSince === undefined) rt.data.stallSince = state.time;
    else if (state.time - rt.data.stallSince > STALL_FAIL_S) return true;
  } else {
    rt.data.stallSince = undefined;
  }
  if (state.velocity.vsFpm < DIVE_FAIL_FPM) return true;
  return false;
}

/** 失效发单侧油门收慢车（保留好发油门杆位置） */
function splitThrottle(state, failedIndex) {
  const t = [state.throttle[0], state.throttle[1]];
  t[failedIndex] = 0;
  return [t];
}

/**
 * 险情库全表（14 条：机械/系统 10 条 + 气象 4 条）。
 * @type {Array<Object>}
 */
export const SCENARIOS = [

  /* ================================================================
   * 1. 单发失效（含 V1 前后中断/继续语境）
   * ================================================================ */
  {
    id: 'single-engine-fail',
    name: '单发失效',
    category: 'mechanical',
    phaseWeights: { takeoff: 0.30, climb: 0.15, cruise: 0.25, descent: 0.10, approach: 0.20, landing: 0 },
    minElapsedS: 90,
    trigger: () => true,
    /** 失效一侧发动机（随机）；地面滑跑且 IAS<V1 时记为中断起飞语境 */
    apply(state, bus, rt) {
      const i = rt.rng() < 0.5 ? 0 : 1;
      const v1 = getVSpeeds(state.massKg, 3).v1;
      rt.data.engineIndex = i;
      rt.data.v1Kt = v1;
      rt.data.rtoContext = state.ground.onGround && state.velocity.ias > 80 && state.velocity.ias < v1;
      bus.damage.engineFail(i);
    },
    timeline: [
      { atS: 30, label: '失效发确认：N1/EGT/燃油流量消失，燃油已切断' },
      { atS: 90, label: '单发漂航：保持 V2/最佳单发速度，评估返场或备降' },
    ],
    briefing: '发动机失效——推力与转速消失。V1 前中断起飞；空中用方向舵抗住偏航，执行单发失效检查单。',
    correctActions: [
      '确认失效发动机（N1/EGT/燃油流量消失），方向舵抵住偏航并配平',
      'V1 前（中断语境）：油门 idle——最大刹车——中断起飞',
      '空中：失效发油门杆——慢车',
      '起动手柄——拉到断开位（切断该发供油）',
      'APU——启动（恢复电源与起动引气备用）',
      '保持 V2 或最佳单发速度，宣布 PAN PAN，返场单发进近',
    ],
    correctCommands: [
      null,
      null,
      { cmd: 'throttle/set', args: (state, rt) => splitThrottle(state, rt.data.engineIndex) },
      { cmd: 'engine/stop', args: (state, rt) => [rt.data.engineIndex] },
      { cmd: 'apu/toggle', args: [] },
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      const i = rt.data.engineIndex;
      if (rt.data.rtoContext) {
        // 中断起飞语境：停稳在地面 = 处置完成；带故障离地 = 决策错误
        if (state.ground.onGround && state.velocity.ias < 20) return 'resolved';
        if (!state.ground.onGround && state.time - rt.triggeredAtS > 15) return 'failed';
        return 'active';
      }
      const other = 1 - i;
      if (!state.engines[other].running) {
        // 好发也熄火（燃油耗尽等）= 双发失效失控
        return state.time - rt.triggeredAtS > 30 ? 'failed' : 'active';
      }
      // 空中处置完成 = 好发稳定运转 + 坡度受控 + 失效发已关车
      const stabilized = !state.engines[i].running && Math.abs(state.orientation.bank) < 20;
      return stabilized && state.time - rt.triggeredAtS > 10 ? 'resolved' : 'active';
    },
  },

  /* ================================================================
   * 2. 双发失效（鸟击群）——哈德逊河式滑翔迫降
   * ================================================================ */
  {
    id: 'dual-engine-fail',
    name: '双发失效（鸟击群）',
    category: 'mechanical',
    phaseWeights: { takeoff: 0.05, climb: 0.10, cruise: 0.40, descent: 0.20, approach: 0.25, landing: 0 },
    minElapsedS: 120,
    /** 鸟击群：低空爬升/进近；或高空双熄（冰/燃油污染） */
    trigger(state, ctx) {
      if ((ctx.phase === 'climb' || ctx.phase === 'approach') && state.agl < 900) return true;
      return state.agl > 7000;
    },
    apply(state, bus, rt) {
      rt.data.birdStrike = state.agl < 900;
      bus.damage.dualEngineFail();
    },
    timeline: [
      { atS: 0, label: '双发推力全部丢失——立即转入最佳滑翔姿态' },
      { atS: 60, label: '重启未成功：滑翔比约每 1000 ft 高度换 2 NM 距离，决定迫降点' },
    ],
    briefing: '鸟击群——双发推力丢失。保持滑翔姿态（约 220 kt），启动 APU 尝试重启；重启失败即选点迫降（水面或最近跑道）。',
    correctActions: [
      'APU——启动（恢复电源）',
      '双发重启尝试（风车/起动手柄 IDirect）',
      '俯仰配最佳滑翔：约 220 kt，每 1000 ft 高度换约 2 NM 距离',
      '决定迫降：水面 ditching（沿浪向、机头 10-12°、接地前关车）或就近跑道',
      '滑翔至最后进近：襟翼 15，接地前双发关车',
    ],
    correctCommands: [
      { cmd: 'apu/toggle', args: [] },
      { cmd: 'engine/start', args: [2] },
      null,
      null,
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.engines[0].running && state.engines[1].running) return 'resolved'; // 重启成功
      if (state.touchdown.recorded) return 'resolved'; // 滑翔迫降完成（质量由结算评分判定）
      return 'active';
    },
  },

  /* ================================================================
   * 3. 发动机火警
   * ================================================================ */
  {
    id: 'engine-fire',
    name: '发动机火警',
    category: 'mechanical',
    phaseWeights: { takeoff: 0.10, climb: 0.20, cruise: 0.35, descent: 0.10, approach: 0.25, landing: 0 },
    minElapsedS: 90,
    trigger: () => true,
    apply(state, bus, rt) {
      const i = rt.rng() < 0.5 ? 0 : 1;
      rt.data.engineIndex = i;
      bus.damage.engineFire(i);
    },
    timeline: [
      { atS: 30, label: '火警持续：EGT 冲高、推力衰减，执行灭火检查单', action: (state, bus, rt) => { if (state.engines[rt.data.engineIndex]?.onFire) rt.data.fireRisk = true; } },
      { atS: 120, label: '火势未控：短舱烧穿临界——立即释放灭火瓶', action: (state, bus, rt) => { if (state.engines[rt.data.engineIndex]?.onFire) rt.data.fireCritical = true; } },
    ],
    briefing: '发动机火警——EGT 冲高、火警灯亮。油门 idle——起动手柄断开——灭火瓶 1 号，单发进近着陆。',
    correctActions: [
      '自动油门断开——受影响发油门杆 idle',
      '发动机起动手柄——拉到断开位（切断燃油）',
      '火警灯确认——发动机灭火瓶手柄：拔出——旋转到 1 号位',
      '30 s 后火警灯仍亮——旋转到 2 号位（本模拟一次即灭）',
      '单发进近：Flap 15、Vref15+10，就近着陆',
    ],
    correctCommands: [
      { cmd: 'throttle/set', args: (state, rt) => splitThrottle(state, rt.data.engineIndex) },
      { cmd: 'engine/stop', args: (state, rt) => [rt.data.engineIndex] },
      { cmd: 'fire/extinguish', args: (state, rt) => [rt.data.engineIndex] },
      null,
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      const e = state.engines[rt.data.engineIndex];
      if (rt.data.fireCritical && e.onFire) return 'failed'; // 2 分钟未灭火
      if (!e.onFire && !e.running) return 'resolved';        // 火灭 + 已关车
      return 'active';
    },
  },

  /* ================================================================
   * 4. 客舱释压
   * ================================================================ */
  {
    id: 'cabin-press-loss',
    name: '客舱释压',
    category: 'mechanical',
    phaseWeights: { takeoff: 0, climb: 0.15, cruise: 0.60, descent: 0.15, approach: 0.10, landing: 0 },
    minElapsedS: 180,
    trigger: () => true,
    apply(state, bus, rt) {
      bus.damage.depressurize();
    },
    timeline: [
      { atS: 0, label: '客舱释压：外流活门全开，客舱高度上升，氧气面罩自动落下' },
      { atS: 60, label: '客舱高度持续上升——立即紧急下降到 10000 ft' },
      { atS: 300, label: '仍高于 14000 ft：缺氧临界', action: (state, bus, rt) => { rt.data.hypoxiaWindow = true; } },
    ],
    briefing: '客舱释压——氧气面罩落下。戴好面罩建立通信，立即紧急下降到 10000 ft 或最低安全高度。',
    correctActions: [
      '氧气面罩——戴好，建立机组通话；客舱广播安抚',
      '断开自动驾驶——油门 idle，打开扰流板',
      '紧急下降：最大速度 Vmo/Mmo，目标 10000 ft 或最低安全高度',
      '客舱高度受控后——增压恢复（外流活门关闭）',
      '高度稳定后按需恢复自动化，继续进近',
    ],
    correctCommands: [
      null,
      { cmd: 'ap/disconnect', args: [] },
      null,
      { damage: 'repairPressurization', args: [] },
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      const pz = state.pressurization;
      if (!pz.outflowOpen && pz.cabinAltFt < 10000) return 'resolved';   // 释压修复 + 舱高回落
      // 缺氧临界：窗口期到仍未修复释压（舱高回落受内核 800 fpm 上限约束，
      // 已修复的紧急下降按处置正确处理，不再以绝对舱高判失败）
      if (rt.data.hypoxiaWindow && pz.outflowOpen && pz.cabinAltFt > 14000) return 'failed';
      return 'active';
    },
  },

  /* ================================================================
   * 5. 液压 A/B 系统失效
   * ================================================================ */
  {
    id: 'hydraulic-fail',
    name: '液压 A/B 系统失效',
    category: 'mechanical',
    phaseWeights: { takeoff: 0.10, climb: 0.15, cruise: 0.30, descent: 0.15, approach: 0.30, landing: 0 },
    minElapsedS: 120,
    trigger: () => true,
    apply(state, bus, rt) {
      const sys = rt.rng() < 0.5 ? 'A' : 'B';
      rt.data.sys = sys;
      bus.damage.hydraulicFail(sys);
    },
    timeline: [
      { atS: 0, label: '液压系统压力丧失——襟翼/起落架/刹车受限' },
      { atS: 60, label: '按液压失效构型：襟翼受限、起落架人工重力、自动刹车预位' },
    ],
    briefing: '液压系统失效——压力丧失。襟翼受限、起落架需人工重力放出、刹车能力下降，按受限构型加长着陆。',
    correctActions: [
      '确认 HYD PRESS 警告与失效系统（A/B）',
      '备用液压系统——确认状态（本模拟备用泵仅限 damage 侧控制，处置按受限构型继续）',
      '襟翼——受限使用，速度按襟翼卡阻表加大余量',
      '起落架——人工重力放出',
      '自动刹车预位，选长跑道，落地即完成处置',
    ],
    correctCommands: [
      null,
      null,
      null,
      { cmd: 'gear/manualRelease', args: [] },
      { cmd: 'autobrake/set', args: ['3'] },
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.touchdown.recorded) return 'resolved'; // 落地即 resolved（着陆质量由结算评分判定）
      return 'active';
    },
  },

  /* ================================================================
   * 6. 燃油泄漏
   * ================================================================ */
  {
    id: 'fuel-leak',
    name: '燃油泄漏',
    category: 'mechanical',
    phaseWeights: { takeoff: 0, climb: 0.10, cruise: 0.45, descent: 0.25, approach: 0.20, landing: 0 },
    minElapsedS: 150,
    trigger: () => true,
    apply(state, bus, rt) {
      const tank = rt.rng() < 0.5 ? 'left' : 'right';
      rt.data.tank = tank;
      rt.data.leakKgs = 1.5;
      bus.damage.fuelLeak(tank, 1.5);
    },
    timeline: [
      { atS: 0, label: '燃油以 1.5 kg/s 泄漏——监控总油量与油量差' },
      { atS: 180, label: '油量接近 LOW FUEL 警戒（2300 kg）' },
      { atS: 480, label: '燃油临界：立即决断就近着陆/野外迫降' },
    ],
    briefing: '燃油泄漏——油量异常下降。关闭交输活门、隔离泄漏油箱，直飞最近合适机场；耗尽则迫降。',
    correctActions: [
      '确认泄漏侧（左右油量差、目视证实）',
      '交输活门——关闭（防止燃油交叉流失）',
      '泄漏侧燃油泵——关闭（隔离泄漏油箱）',
      '直飞最近合适机场，持续监控总油量',
      'LOW FUEL 或双发熄火风险 → 立即就近着陆/野外迫降',
    ],
    correctCommands: [
      null,
      { cmd: 'fuel/crossfeed', args: [false] },
      { cmd: 'fuel/pump', args: (state, rt) => [rt.data.tank, false] },
      null,
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      const isolated = state.fuel.crossfeed === false && state.fuel.pumps[rt.data.tank] === false;
      if (state.touchdown.recorded) return 'resolved'; // 带油（或滑翔）落地
      if (isolated) return 'resolved';                 // 泄漏隔离完成（QRH 处置正确）
      if (!state.engines[0].running && !state.engines[1].running) return 'failed'; // 燃油耗尽双熄
      return 'active';
    },
  },

  /* ================================================================
   * 7. 空速不可靠（皮托管堵塞）
   * ================================================================ */
  {
    id: 'airspeed-unreliable',
    name: '空速不可靠（皮托管堵塞）',
    category: 'mechanical',
    phaseWeights: { takeoff: 0, climb: 0.35, cruise: 0.25, descent: 0.25, approach: 0.15, landing: 0 },
    minElapsedS: 120,
    trigger: () => true,
    apply(state, bus, rt) {
      bus.damage.pitotBlock(0, true);
      bus.damage.pitotBlock(1, true);
    },
    timeline: [
      { atS: 0, label: '左右空速/马赫不一致——空速不可靠' },
      { atS: 60, label: '按已知俯仰与推力飞行：爬升 15°/CLB 推力，巡航 2.5°/CRZ 推力' },
    ],
    briefing: '空速不可靠——皮托管堵塞，空速/马赫指示异常。断开自动化，按已知俯仰与推力飞行。',
    correctActions: [
      '空速不可靠识别：左右/备用空速不一致，IAS 与 GS/垂直趋势矛盾',
      '自动驾驶——断开（可能受污染数据驱动）',
      '自动油门——断开（人工油门）',
      '按已知俯仰与推力飞行（QRH 表），参考 GPS 地速',
      '穿出降水/结冰区后空速恢复——皮托疏通，恢复自动化',
    ],
    correctCommands: [
      null,
      { cmd: 'ap/disconnect', args: [] },
      { cmd: 'throttle/set', args: (state) => [state.throttle[0]] },
      null,
      { damage: 'pitotBlock', args: (state, rt) => [0, false] },
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      const pitotClear = !state.pitot.blockedL && !state.pitot.blockedR;
      const manual = !state.ap.engaged && !state.ap.modes.spd; // 已按人工俯仰+推力飞行
      if (pitotClear || manual) return 'resolved';
      return 'active';
    },
  },

  /* ================================================================
   * 8. 襟翼卡阻
   * ================================================================ */
  {
    id: 'flaps-jam',
    name: '襟翼卡阻',
    category: 'mechanical',
    phaseWeights: { takeoff: 0, climb: 0.10, cruise: 0, descent: 0.35, approach: 0.55, landing: 0 },
    minElapsedS: 120,
    trigger: () => true,
    apply(state, bus, rt) {
      const idx = Math.min(state.flaps.index, 3); // 卡阻在当前档位（最多襟翼 5）
      rt.data.idx = idx;
      rt.data.angleDeg = FLAP_NOTCHES[idx].angleDeg;
      bus.damage.flapsJam(idx);
    },
    timeline: [
      { atS: 0, label: '襟翼卡阻：手柄与位置指示不一致' },
      { atS: 60, label: '按襟翼卡阻表计算 Vref（速度显著增大），防超速放襟翼' },
    ],
    briefing: '襟翼卡阻——舵面无法继续放出。手柄收到卡阻位，按卡阻档位查 Vref，选长跑道加长进近。',
    correctActions: [
      '确认襟翼位置指示与手柄不一致——襟翼卡阻',
      '襟翼手柄——收到卡阻位',
      '按卡阻档位查 Vref（速度显著增大），严禁超速放襟翼',
      '选择长跑道，着陆距离 ×1.5 以上',
      '接地后：反推最大 + 自动刹车 MAX + 扰流板',
    ],
    correctCommands: [
      null,
      { cmd: 'flaps/set', args: (state, rt) => [rt.data.idx] },
      null,
      null,
      { cmd: 'autobrake/set', args: ['MAX'] },
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.touchdown.recorded) return 'resolved';
      return 'active';
    },
  },

  /* ================================================================
   * 9. 客舱火警
   * ================================================================ */
  {
    id: 'cabin-fire',
    name: '客舱火警',
    category: 'mechanical',
    phaseWeights: { takeoff: 0, climb: 0.20, cruise: 0.40, descent: 0.20, approach: 0.20, landing: 0 },
    minElapsedS: 120,
    trigger: () => true,
    apply(state, bus, rt) {
      bus.damage.cabinFire(true);
    },
    timeline: [
      { atS: 0, label: '客舱火警：烟雾/异味报告，乘务组定位火源' },
      { atS: 240, label: '火势蔓延临界：立即就近着陆/紧急下降', action: (state, bus, rt) => { rt.data.fireSpread = true; } },
    ],
    briefing: '客舱火警——烟雾报告。乘务组灭火，机组立即下降就近着陆，落地后紧急疏散。',
    correctActions: [
      '确认火警位置，乘务组用海伦灭火瓶灭火',
      '驾驶舱客舱灭火——释放灭火瓶',
      '立即下降并就近着陆——尽快落地',
      '着陆后紧急撤离（EVAC 呼叫）',
    ],
    correctCommands: [
      null,
      { cmd: 'fire/extinguish', args: [] },
      null,
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (rt.data.fireSpread && state.fire.cabin) return 'failed'; // 4 min 未灭火
      if (!state.fire.cabin) return 'resolved';
      return 'active';
    },
  },

  /* ================================================================
   * 10. 风切变（起飞/进近）
   * ================================================================ */
  {
    id: 'windshear',
    name: '风切变（起飞/进近）',
    category: 'weather',
    phaseWeights: { takeoff: 0.45, climb: 0, cruise: 0, descent: 0, approach: 0.55, landing: 0 },
    minElapsedS: 60,
    /** 风切变只发生在低空（警告区 <1200 ft）的起飞/进近 */
    trigger(state, ctx) {
      return (ctx.phase === 'takeoff' || ctx.phase === 'approach') && state.agl < 350;
    },
    apply(state, bus, rt) {
      rt.data.groundStart = state.ground.onGround;
      rt.data.v1Kt = getVSpeeds(state.massKg, state.flaps.index).v1;
      // 低空强风突变：接近顺风的强风+阵风+湍流（天气字段属环境数据，单元授权直写）
      state.weather.windDirDeg = ((state.runway.headingDeg || 0) + 170) % 360; // 罗盘：跑道右侧风
      state.weather.windKts = 35;
      state.weather.gustKts = Math.max(state.weather.gustKts, 20);
      state.weather.turbulence = Math.max(state.weather.turbulence, 0.5);
    },
    timeline: [
      { atS: 0, label: 'WINDSHEAR——空速/下沉率突变，性能损失' },
      { atS: 20, label: '风切变持续：脱离前不改构型，TOGA 推力俯仰 15°' },
    ],
    briefing: '风切变——WINDSHEAR 警告。V1 前立即中断；空中 TOGA 油门最大、俯仰 15°、不改构型直到脱离。',
    correctActions: [
      'WINDSHEAR——立即识别（空速/下沉率/俯仰角突变）',
      'V1 前地面：油门 idle 最大刹车中断；空中：TOGA——油门最大',
      '俯仰 15° 上仰限制，保持当前襟翼构型',
      '脱离风切变/接地前：不收油门、不收襟翼、不收起落架',
    ],
    correctCommands: [
      null,
      { cmd: 'throttle/set', args: [1.0] },
      null,
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (rt.data.groundStart) {
        if (state.ground.onGround && state.velocity.ias < 30) return 'resolved'; // RTO 成功
        if (!state.ground.onGround && state.time - rt.triggeredAtS > 15) return 'failed';
        return 'active';
      }
      if (state.agl > 400 && state.velocity.vsFpm > 200) return 'resolved'; // 爬升脱离低空切变区
      if (state.agl < 30 && state.velocity.vsFpm < -800) return 'failed';   // 撞地
      return 'active';
    },
  },

  /* ================================================================
   * 11. 雷暴湍流与机体结冰
   * ================================================================ */
  {
    id: 'thunderstorm-icing',
    name: '雷暴湍流与机体结冰',
    category: 'weather',
    phaseWeights: { takeoff: 0, climb: 0.30, cruise: 0.30, descent: 0.30, approach: 0.10, landing: 0 },
    minElapsedS: 120,
    trigger: () => true,
    apply(state, bus, rt) {
      bus.damage.setIcingConditions(true); // 结冰环境（低温+降雪倾向）
      state.weather.turbulence = Math.max(state.weather.turbulence, 0.7);
      state.weather.visibilityM = Math.min(state.weather.visibilityM, 5000);
      state.weather.gustKts = Math.max(state.weather.gustKts, 18);
    },
    timeline: [
      { atS: 0, label: '进入雷暴/结冰区：强湍流、低温、降水' },
      { atS: 120, label: '机体积冰增长——CLmax 下降、失速速度升高' },
      { atS: 600, label: '严重积冰：立即脱离并全程使用防冰' },
    ],
    briefing: '雷暴+结冰——强湍流、机体结冰。发动机与机翼防冰接通，气象雷达绕飞，谨慎使用襟翼。',
    correctActions: [
      '发动机防冰——接通',
      '机翼防冰——接通',
      '气象雷达识别回波——绕飞/改变高度脱离结冰区',
      '襟翼——谨慎使用（结冰限制），速度余量 +10 kt',
    ],
    correctCommands: [
      { cmd: 'antiIce/toggle', args: ['engine'] },
      { cmd: 'antiIce/toggle', args: ['wings'] },
      null,
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.ice.accumulation >= 0.98) return 'failed';          // 满积冰失控
      const bothOn = state.ice.antiIceOn && state.ice.wingsAntiIce;
      if (bothOn && state.ice.accumulation < 0.5) return 'resolved'; // 防冰接通+冰受控
      if (!state.weather.icingConditions && state.ice.accumulation < 0.02) return 'resolved'; // 脱离结冰区
      return 'active';
    },
  },

  /* ================================================================
   * 12. 大侧风进近
   * ================================================================ */
  {
    id: 'crosswind-gust',
    name: '大侧风进近',
    category: 'weather',
    phaseWeights: { takeoff: 0.20, climb: 0, cruise: 0, descent: 0, approach: 0.80, landing: 0 },
    minElapsedS: 60,
    trigger(state, ctx) {
      return (ctx.phase === 'approach' || ctx.phase === 'takeoff') && state.agl < 400;
    },
    apply(state, bus, rt) {
      rt.data.baseHeading = state.orientation.heading;
      // 正侧风 27 kt + 阵风（天气字段属环境数据，单元授权直写）
      state.weather.windDirDeg = ((state.runway.headingDeg || 0) + 90) % 360; // 罗盘：正侧风
      state.weather.windKts = 27;
      state.weather.gustKts = Math.max(state.weather.gustKts, 10);
    },
    timeline: [
      { atS: 0, label: '正侧风 27 kt 阵风 10：五边修正' },
      { atS: 60, label: '保持 crab 修正，拉平 de-crab，主轮先接地' },
    ],
    briefing: '大侧风——正侧风 27 kt 阵风。五边 crab 修正，拉平蹬舵对正，接地后副翼压向风侧。',
    correctActions: [
      '评估侧风分量（演示限值：稳定 20 kt / 阵风内）',
      '五边：航向偏风侧 + 向风侧压盘，保持航迹压跑道中线',
      '拉平：de-crab——蹬舵对正机头，上风侧主轮先接地',
      '接地后：副翼压向风侧，方向舵保持方向',
    ],
    correctCommands: [null, null, null, null],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.touchdown.recorded) {
        return state.touchdown.bankDeg < 15 ? 'resolved' : 'failed'; // 接地坡度过大
      }
      return 'active';
    },
  },

  /* ================================================================
   * 13. 平流雾（CAT I 低能见度）
   * ================================================================ */
  {
    id: 'fog-cat1',
    name: '平流雾（CAT I 低能见度）',
    category: 'weather',
    phaseWeights: { takeoff: 0, climb: 0, cruise: 0, descent: 0.20, approach: 0.80, landing: 0 },
    minElapsedS: 60,
    trigger(state, ctx) {
      return (ctx.phase === 'approach' || ctx.phase === 'descent') && state.agl < 800;
    },
    apply(state, bus, rt) {
      rt.data.visBeforeM = state.weather.visibilityM;
      state.weather.visibilityM = 550; // CAT I RVR 550 m（环境数据直写）
    },
    timeline: [
      { atS: 0, label: '平流雾：RVR 550 m（CAT I），ILS 进近' },
      { atS: 90, label: '决断高 200 ft：目视参考或复飞' },
    ],
    briefing: '平流雾——能见度 550 m（CAT I）。ILS 压到决断高 200 ft，见目视参考继续，否则复飞。',
    correctActions: [
      'ILS 进近：APP 预位，确认 LOC/GS 截获',
      '稳定进近：1000 ft 前建立稳定（速度/构型/下滑道）',
      '决断高 200 ft：目视进近灯/跑道标志 → 继续；否则复飞',
      '雨刷低速档，着陆灯开',
    ],
    correctCommands: [
      { cmd: 'ap/app', args: [] },
      null,
      null,
      { cmd: 'wipers', args: [1] },
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.agl < 25) rt.data.wasLow = true;
      if (state.touchdown.recorded) {
        return state.touchdown.onRunway ? 'resolved' : 'failed'; // 雾中偏出跑道 = 失败
      }
      if (rt.data.wasLow && state.agl > 150) return 'resolved';   // 复飞脱离
      return 'active';
    },
  },

  /* ================================================================
   * 14. 起落架放不下（机腹迫降）
   * ================================================================ */
  {
    id: 'gear-jammed',
    name: '起落架放不下（机腹迫降）',
    category: 'mechanical',
    phaseWeights: { takeoff: 0, climb: 0, cruise: 0.10, descent: 0.30, approach: 0.60, landing: 0 },
    minElapsedS: 150,
    trigger: () => true,
    apply(state, bus, rt) {
      bus.send('gear/up');        // 处于"应收起"语境（放不下 = 卡在收上位）
      bus.damage.gearJam(true);   // 卡阻：液压作动与人工重力均无效
    },
    timeline: [
      { atS: 0, label: '起落架手柄放下——无"放下锁定"指示' },
      { atS: 30, label: '备用放出系统无效' },
      { atS: 90, label: '确认卡阻——准备机腹迫降：选长跑道，接地前关车' },
    ],
    briefing: '起落架卡阻——无法放出锁定。尝试备用/人工重力放出；确认卡阻即机腹迫降：选长跑道、接地前关车。',
    correctActions: [
      '起落架手柄——放下位，确认三个位置指示',
      '备用放出系统——尝试',
      '人工重力放出——曲柄 25 s（本模拟仍卡阻）',
      '确认卡阻：机腹迫降——选长跑道，接地前关车断电',
      '进近 Flap 15，保持机头 5-8° 轻触地',
    ],
    correctCommands: [
      { cmd: 'gear/down', args: [] },
      null,
      { cmd: 'gear/manualRelease', args: [] },
      { cmd: 'engine/stop', args: [2] },
      null,
    ],
    resolveCheck(state, rt) {
      if (commonFailure(state, rt)) return 'failed';
      if (state.touchdown.recorded) return 'resolved'; // 机腹迫降（或意外放出的正常落地）完成
      return 'active';
    },
  },
];

/** 全部飞行阶段枚举 */
export const PHASES = Object.freeze(['takeoff', 'climb', 'cruise', 'descent', 'approach', 'landing']);

/**
 * 按 id 查险情。
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getScenarioById(id) {
  return SCENARIOS.find((s) => s.id === id);
}
