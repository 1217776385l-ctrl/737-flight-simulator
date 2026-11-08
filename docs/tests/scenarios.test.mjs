/**
 * tests/scenarios.test.mjs — 险情剧本引擎 + 结算评分验收测试。
 * 运行：node tests/scenarios.test.mjs   （全部 PASS → 退出码 0）
 *
 * 覆盖：
 *  S1 险情库结构：恰 14 条、id 唯一、声明字段齐全、correctActions↔correctCommands 对齐
 *  S2 apply 真实改状态：14 条逐条断言（含警告由内核汇总点亮）
 *  S3 逐条演练：按 correctCommands 模拟正确处置流程，断言 resolveCheck 最终 resolved
 *     （cabin-press-loss 因需 ~6 min 舱高回落，放在 S4 专项正反两个方向演练）
 *  S4 释压专项：不处置 → cabinAlt>14000 且 failed；处置（紧急下降）→ resolved
 *  S5 评分专项：高分落地 / 重着陆 / 水面迫降 / 坡度坠毁 → outcome 与分数带
 *  S6 可复现：scoreLanding 纯函数同分；引擎同 seed 触发序列一致
 */

import assert from 'node:assert/strict';
import {
  createSimState, createCommandBus, stepSimulation, substepSystems,
} from '../src/kernel/index.js';
import { kt2ms, clamp } from '../src/kernel/math.js';
import { SCENARIOS, getScenarioById } from '../src/scenarios/scenarios.js';
import { createScenarioEngine } from '../src/scenarios/scenario-engine.js';
import { scoreLanding } from '../src/scoring/landing-score.js';

let passed = 0, total = 0;
function ok(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error('      ' + (err && err.message ? err.message.split('\n').join('\n      ') : err));
    process.exitCode = 1;
  }
}

const H = 1 / 120;

function mkSim(opts = {}) {
  const state = createSimState({ enginesRunning: true, ...opts });
  state.ground.parkingBrake = false;
  state.ground.brakes[0] = 0;
  state.ground.brakes[1] = 0;
  const bus = createCommandBus(state);
  return { state, bus };
}

/** 常规步进（物理 + 警告 + 时间） */
function step(state, bus, dt = 1 / 60) {
  stepSimulation(state, dt, bus);
}

/* =========================================================
 * 初始条件构造器
 * ========================================================= */

/** 巡航/高空空中基本态：270 kt（≈干净构型 1g 平衡速度）、3000 m（预热 N1） */
function airborne200kt(state, bus, o = {}) {
  state.ground.onGround = false;
  state.ground.noseOnGround = false;
  state.ground.mainOnGround = false;
  state.position.y = o.y ?? 3000;
  state.velocity.vx = kt2ms(o.iasKt ?? 270);
  state.velocity.vy = 0;
  state.orientation.pitch = 2;
  state.gear.handleDown = false;
  state.gear.position = 0;
  bus.send('flaps/set', 0);
  bus.send('throttle/set', o.throttle ?? 0.7);
  for (let i = 0; i < 120 * 15; i++) substepSystems(state, H); // N1 预热
}

/** 低空滑翔态（双发失效演练）：800 m、130 kt */
function lowGlide(state, bus) {
  state.ground.onGround = false;
  state.ground.noseOnGround = false;
  state.ground.mainOnGround = false;
  state.position.y = 800;
  state.velocity.vx = kt2ms(130);
  state.velocity.vy = -4;
  state.orientation.pitch = 1;
  state.gear.handleDown = false;
  state.gear.position = 0;
  bus.send('flaps/set', 1);
  bus.send('throttle/set', 0);
}

/** 低空爬升态（风切变演练）：250 m、165 kt、AP 已接通 */
function lowClimbAP(state, bus) {
  state.ground.onGround = false;
  state.ground.noseOnGround = false;
  state.ground.mainOnGround = false;
  state.position.y = 250;
  state.velocity.vx = kt2ms(165);
  state.velocity.vy = 3;
  state.orientation.pitch = 3;
  state.gear.handleDown = false;
  state.gear.position = 0;
  bus.send('flaps/set', 3);
  bus.send('throttle/set', 0.75);
  for (let i = 0; i < 120 * 15; i++) substepSystems(state, H);
  bus.send('ap/engage');
  bus.send('ap/hdg', 0);
}

/** 进近态：距入口 ~700 m、130 m 高、AP VS 下滑（着陆类演练通用） */
function approachState(state, bus, o = {}) {
  state.ground.onGround = false;
  state.ground.noseOnGround = false;
  state.ground.mainOnGround = false;
  state.ground.parkingBrake = false;
  state.position.x = o.x ?? -700;
  state.position.y = o.y ?? 130;
  state.position.z = o.z ?? 0;
  state.velocity.vx = kt2ms(o.iasKt ?? 140);
  state.velocity.vy = o.vy ?? -3;
  state.velocity.vz = 0;
  state.orientation.pitch = o.pitch ?? 2;
  state.orientation.heading = 0;
  bus.send('flaps/set', o.flaps ?? 6);
  bus.send('throttle/set', o.throttle ?? 0.55);
  if (o.gearUp) bus.send('gear/up');
  if (o.ap !== false) {
    bus.send('ap/engage');
    bus.send('ap/hdg', 0);
    bus.send('ap/vs', o.vs ?? -800);
  }
  state.touchdown.recorded = false;
}

/* =========================================================
 * 通用飞行技术 pilot（空中处置期间由测试代替玩家握杆）
 * ========================================================= */

function wingsLevelPilot(state, bus) {
  const o = state.orientation;
  bus.send('control/aileron', clamp(-o.bank * 0.08 - o.bankRate * 0.03, -0.6, 0.6));
  bus.send('control/rudder', clamp(state.orientation.heading * -0.02 - o.headingRate * 1.2, -0.8, 0.8));
}

function shearPilot(state, bus) {
  if (state.ap.engaged) bus.send('ap/vs', 2000); // TOGA + 俯仰上仰（AP VS 方式）
}

/* =========================================================
 * 逐条演练配置：setup → forced 触发 → 按 correctCommands 处置 → 步进至 resolved
 * ========================================================= */

const REHEARSALS = {
  'single-engine-fail': { phase: 'cruise', setup: airborne200kt, maxS: 120, pilot: wingsLevelPilot },
  'dual-engine-fail': { phase: 'approach', setup: lowGlide, maxS: 60 },
  'engine-fire': { phase: 'cruise', setup: airborne200kt, maxS: 30 },
  'hydraulic-fail': { phase: 'approach', setup: approachState, maxS: 150 },
  'fuel-leak': { phase: 'cruise', setup: airborne200kt, maxS: 10 },
  'airspeed-unreliable': {
    phase: 'cruise',
    setup: (state, bus) => {
      airborne200kt(state, bus);
      state.ap.engaged = true;          // 制造"自动化受污染空速驱动"语境
      state.ap.modes.spd = true;
      state.ap.atArmed = true;
    },
    maxS: 10,
  },
  'flaps-jam': { phase: 'approach', setup: (s, b) => approachState(s, b, { flaps: 3, iasKt: 160, throttle: 0.6 }), maxS: 150 },
  'cabin-fire': { phase: 'cruise', setup: airborne200kt, maxS: 10 },
  'windshear': { phase: 'approach', setup: lowClimbAP, maxS: 120, pilot: shearPilot },
  'thunderstorm-icing': { phase: 'cruise', setup: airborne200kt, maxS: 10 },
  'crosswind-gust': { phase: 'approach', setup: (s, b) => approachState(s, b, { z: 25 }), maxS: 150 },
  'fog-cat1': { phase: 'approach', setup: approachState, maxS: 150 },
  'gear-jammed': {
    phase: 'approach',
    setup: (s, b) => approachState(s, b, { gearUp: true, flaps: 4, iasKt: 175, vy: -7, y: 90, throttle: 0 }),
    maxS: 120,
  },
};

/**
 * 演练一条险情：强制触发 → 执行 correctCommands → 步进至解除。
 * @returns {{state:Object, bus:Object, engine:Object, status:string, rt:Object}}
 */
function rehearse(id) {
  const cfg = REHEARSALS[id];
  assert.ok(cfg, `缺少 ${id} 的演练配置`);
  const { state, bus } = mkSim();
  cfg.setup(state, bus);
  const engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: false });
  engine.armForPhase(cfg.phase);
  const rt = engine.forced(id);
  assert.ok(rt, `${id} 强制触发失败`);
  // 按 correctActions 顺序执行对应的总线命令 / damage 钩子
  const sc = getScenarioById(id);
  sc.correctCommands.forEach((c) => {
    if (!c) return;
    const args = typeof c.args === 'function' ? c.args(state, rt) : (c.args ?? []);
    if (c.cmd) bus.send(c.cmd, ...args);
    else bus.damage[c.damage](...args);
  });
  let status = 'active';
  while (state.time < cfg.maxS && engine.active()) {
    cfg.pilot?.(state, bus);
    step(state, bus);
    status = engine.update(1 / 60);
  }
  return { state, bus, engine, status, rt };
}

/* =========================================================
 * S1 险情库结构
 * ========================================================= */
ok('S1a 险情库恰 14 条、id 唯一', () => {
  assert.equal(SCENARIOS.length, 14, `实际 ${SCENARIOS.length} 条`);
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, 14, 'id 有重复');
  assert.equal(getScenarioById('engine-fire').id, 'engine-fire');
});

ok('S1b 每条声明字段齐全（apply/resolveCheck/correctActions/briefing/权重/保护期）', () => {
  const PHASE_KEYS = ['takeoff', 'climb', 'cruise', 'descent', 'approach', 'landing'];
  for (const s of SCENARIOS) {
    assert.equal(typeof s.apply, 'function', `${s.id}.apply`);
    assert.equal(typeof s.resolveCheck, 'function', `${s.id}.resolveCheck`);
    assert.ok(Array.isArray(s.correctActions) && s.correctActions.length > 0, `${s.id}.correctActions`);
    assert.ok(typeof s.briefing === 'string' && s.briefing.length > 8, `${s.id}.briefing`);
    assert.ok(typeof s.name === 'string' && s.name.length > 2, `${s.id}.name`);
    assert.ok(['mechanical', 'weather'].includes(s.category), `${s.id}.category`);
    assert.ok(typeof s.minElapsedS === 'number' && s.minElapsedS >= 0, `${s.id}.minElapsedS`);
    for (const k of PHASE_KEYS) {
      const w = s.phaseWeights[k];
      assert.ok(typeof w === 'number' && w >= 0 && w <= 1, `${s.id}.phaseWeights.${k}`);
    }
    assert.ok(PHASE_KEYS.some((k) => s.phaseWeights[k] > 0), `${s.id} 全阶段权重为 0`);
    assert.equal(s.correctCommands.length, s.correctActions.length, `${s.id} correctCommands 与 correctActions 未对齐`);
    for (const c of s.correctCommands) {
      if (c === null) continue;
      assert.ok(c.cmd || c.damage, `${s.id} 命令项缺少 cmd/damage`);
    }
  }
});

ok('S1c 机械 10 条 + 气象 4 条', () => {
  const mech = SCENARIOS.filter((s) => s.category === 'mechanical').length;
  const wx = SCENARIOS.filter((s) => s.category === 'weather').length;
  assert.equal(mech, 10, `机械 ${mech}`);
  assert.equal(wx, 4, `气象 ${wx}`);
});

/* =========================================================
 * S2 apply 真实改状态（逐条断言 + 内核警告点亮）
 * ========================================================= */

/** 每条险情的 apply 断言：rt 为强制触发返回的运行时记录 */
const APPLY_ASSERTS = {
  'single-engine-fail': (state, rt) => {
    const i = rt.data.engineIndex;
    assert.equal(state.engines[i].running, false, '失效发应已熄车');
    assert.ok(state.engines[i].thrustKN < 20, `失效发推力应趋零（风车衰减）实际 ${state.engines[i].thrustKN}`);
    assert.equal(state.engines[1 - i].running, true, '好发应保持运转');
  },
  'dual-engine-fail': (state) => {
    assert.equal(state.engines[0].running, false);
    assert.equal(state.engines[1].running, false);
    assert.ok(state.warnings.active.includes('DUAL ENG FAIL'), '应出现 DUAL ENG FAIL 警告');
  },
  'engine-fire': (state, rt) => {
    const i = rt.data.engineIndex;
    assert.equal(state.engines[i].onFire, true, 'engines[i].onFire 应为 true');
    const warn = i === 0 ? 'ENGINE FIRE L' : 'ENGINE FIRE R';
    assert.ok(state.warnings.active.includes(warn), `应出现 ${warn} 警告`);
  },
  'cabin-press-loss': (state) => {
    assert.equal(state.pressurization.outflowOpen, true, '外流活门应全开');
  },
  'hydraulic-fail': (state, rt) => {
    const key = rt.data.sys === 'A' ? 'failedA' : 'failedB';
    assert.equal(state.hydraulics[key], true, `液压 ${rt.data.sys} 应硬失效`);
  },
  'gear-jammed': (state) => {
    assert.equal(state.gear.jammed, true, '起落架应卡阻');
    assert.equal(state.gear.handleDown, false);
    assert.ok(state.gear.position < 0.01, '卡在收上位');
  },
  'fuel-leak': (state, rt) => {
    assert.equal(state.fuel.leakTank, rt.data.tank);
    assert.ok(state.fuel.leakPerSecond > 0, '应有持续泄漏率');
  },
  'airspeed-unreliable': (state) => {
    assert.equal(state.pitot.blockedL, true);
    assert.equal(state.pitot.blockedR, true);
  },
  'flaps-jam': (state, rt) => {
    assert.equal(state.flaps.jam, rt.data.idx, '襟翼应卡阻在声明档位');
  },
  'cabin-fire': (state) => {
    assert.equal(state.fire.cabin, true, '客舱火警应置位');
  },
  'windshear': (state) => {
    assert.ok(state.weather.windKts >= 35, '应注入强风');
    assert.ok(state.weather.turbulence >= 0.5);
  },
  'thunderstorm-icing': (state) => {
    assert.equal(state.weather.icingConditions, true, '应为结冰环境');
    assert.equal(state.weather.precipitation, 'snow', '应有降水');
    assert.ok(state.weather.tempC <= -2, '应为低温');
  },
  'crosswind-gust': (state, rt) => {
    assert.ok(state.weather.windKts >= 27, '应有 27 kt 侧风');
    const rel = Math.abs(((state.weather.windDirDeg - rt.data.baseHeading) % 360 + 360) % 360);
    assert.ok(Math.abs(rel - 90) < 1, `风向应约正侧风（相对 ${rel}°）`);
  },
  'fog-cat1': (state) => {
    assert.equal(state.weather.visibilityM, 550, '能见度应压到 550 m');
  },
};

/** 警告类断言需要的最小步进时长 s */
const APPLY_STEP_S = {
  'single-engine-fail': 2, 'dual-engine-fail': 2, 'engine-fire': 2,
  'cabin-press-loss': 130,   // 舱高爬到 >10000 ft 触发 CABIN PRESSURE
  'hydraulic-fail': 4,       // 压力衰减到 <0.35 触发 HYD PRESS
  'gear-jammed': 2, 'fuel-leak': 60, 'airspeed-unreliable': 2, 'flaps-jam': 2,
  'cabin-fire': 2, 'windshear': 8, 'thunderstorm-icing': 30, 'crosswind-gust': 2, 'fog-cat1': 2,
};

ok('S2 14 条险情 apply 后仿真状态真实改变', () => {
  for (const sc of SCENARIOS) {
    const { state, bus } = mkSim();
    airborne200kt(state, bus);
    const engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: false });
    engine.armForPhase('cruise');
    const rt = engine.forced(sc.id);
    assert.ok(rt, `${sc.id} 强制触发失败`);
    const dur = APPLY_STEP_S[sc.id] ?? 2;
    const dt = dur > 10 ? 0.25 : 1 / 60;
    for (let t = 0; t < dur && engine.active(); t += dt) {
      step(state, bus, dt);
      engine.update(dt);
    }
    APPLY_ASSERTS[sc.id](state, rt);
  }
});

ok('S2b 燃油泄漏持续扣油（timeline 持续效应由内核泄漏率体现）', () => {
  const { state, bus } = mkSim();
  airborne200kt(state, bus);
  const engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: false });
  engine.armForPhase('cruise');
  const rt = engine.forced('fuel-leak');
  const f0 = state.fuel.left + state.fuel.right + state.fuel.center;
  for (let t = 0; t < 60; t += 1 / 60) step(state, bus);
  const f1 = state.fuel.left + state.fuel.right + state.fuel.center;
  assert.ok(f1 <= f0 - 60, `60 s 应泄漏 ≥60 kg（实际 ${(f0 - f1).toFixed(1)}，泄漏率 ${rt.data.leakKgs} kg/s + 发动机耗油）`);
});

/* =========================================================
 * S3 逐条演练：正确处置流程 → resolved
 * （cabin-press-loss 在 S4 专项以正反两方向演练）
 * ========================================================= */

const REHEARSAL_IDS = Object.keys(REHEARSALS);
ok(`S3 逐条演练 ${REHEARSAL_IDS.length} 条（处置 → resolved）`, () => {
  for (const id of REHEARSAL_IDS) {
    const r = rehearse(id);
    assert.equal(r.status, 'resolved', `${id} 演练未 resolved（状态 ${r.status}）`);
    const ev = r.engine.history();
    assert.ok(ev.some((e) => e.type === 'trigger'), `${id} 事件日志缺 trigger`);
    assert.ok(ev.some((e) => e.type === 'resolve'), `${id} 事件日志缺 resolve`);
  }
});

ok('S3b 演练事件日志含仿真时间戳且有序', () => {
  const r = rehearse('engine-fire');
  const ev = r.engine.history();
  assert.ok(ev.length >= 2);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t, '时间戳应单调不减');
});

/* =========================================================
 * S4 释压专项：不处置 → failed；处置 → resolved
 * ========================================================= */

function setupCruiseFL350(state, bus) {
  state.ground.onGround = false;
  state.ground.noseOnGround = false;
  state.ground.mainOnGround = false;
  state.position.y = 10668; // FL350
  state.velocity.vx = 235;  // ≈ TAS 457 kt / M 0.78
  state.velocity.vy = 0;
  state.orientation.pitch = 2;
  state.gear.handleDown = false;
  state.gear.position = 0;
  bus.send('flaps/set', 0);
  bus.send('throttle/set', 1.0);
  for (let i = 0; i < 120 * 40; i++) substepSystems(state, H); // N1 预热到全推力
  bus.send('ap/engage');
  bus.send('ap/alt', 35000);
}

ok('S4a 释压不处置：cabinAlt 升破 14000 ft、面罩落下、resolveCheck → failed', () => {
  const { state, bus } = mkSim();
  setupCruiseFL350(state, bus);
  const engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: false });
  engine.armForPhase('cruise');
  assert.ok(engine.forced('cabin-press-loss'));
  let status = 'active';
  let sawCabinPressureWarn = false;
  for (let t = 0; t < 400 && status === 'active'; t += 0.25) {
    step(state, bus, 0.25);
    sawCabinPressureWarn = sawCabinPressureWarn || state.warnings.active.includes('CABIN PRESSURE');
    status = engine.update(0.25);
  }
  assert.ok(sawCabinPressureWarn, '应出现 CABIN PRESSURE 主警告');
  assert.ok(state.pressurization.cabinAltFt > 14000, `舱高应 >14000（实际 ${state.pressurization.cabinAltFt.toFixed(0)}）`);
  assert.equal(state.pressurization.o2MasksDropped, true, '氧气面罩应自动落下');
  assert.equal(status, 'failed', `不处置应演变为 failed（实际 ${status}）`);
});

ok('S4b 释压处置（紧急下降+修复增压）：舱高回落 <10000 ft → resolved', () => {
  const { state, bus } = mkSim();
  setupCruiseFL350(state, bus);
  const engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: false });
  engine.armForPhase('cruise');
  const rt = engine.forced('cabin-press-loss');
  // 前段：不处置 170 s —— 舱高爬破 14000、面罩落下
  for (let t = 0; t < 170; t += 0.25) {
    step(state, bus, 0.25);
    engine.update(0.25);
  }
  assert.ok(state.pressurization.cabinAltFt > 14000, '前段舱高应 >14000');
  assert.equal(state.pressurization.o2MasksDropped, true);
  // 处置：紧急下降（油门管理 + AP VS 平滑追下沉率，避免阶跃指令过冲失速）+ 修复增压
  bus.damage.repairPressurization();
  let status = 'active';
  for (let t = 0; t < 1800 && status === 'active'; t += 0.25) {
    // 紧急下降：VS 指令从当前下沉率平滑追到 -3000 fpm（内核 AP VS 为 P 控制，阶跃会过冲）
    bus.send('ap/vs', Math.max(-3000, Math.round(state.velocity.vsFpm) - 500));
    if (state.velocity.ias > 320) bus.send('throttle/set', 0.2);   // Vmo 附近收油门
    else if (state.velocity.ias < 270) bus.send('throttle/set', 1.0); // 保持加速脱离
    step(state, bus, 0.25);
    status = engine.update(0.25);
  }
  assert.equal(status, 'resolved', `处置后应 resolved（实际 ${status}）`);
  assert.ok(state.pressurization.cabinAltFt < 10000, `舱高应 <10000（实际 ${state.pressurization.cabinAltFt.toFixed(0)}）`);
  assert.ok(state.pressurization.outflowOpen === false);
  assert.ok(rt.data.hypoxiaWindow !== true || status === 'resolved');
});

/* =========================================================
 * S5 评分专项
 * ========================================================= */

/** 构造带 touchdown 结算字段的接地状态（纯评分输入，不跑物理） */
function mkTouchdownState(fields) {
  const { state } = mkSim();
  Object.assign(state.touchdown, { recorded: true, time: 1000, ...fields });
  state.flaps.index = 6;    // 襟翼 30
  state.flaps.angle = 30;
  return state;
}

ok('S5a 教科书落地：-100 fpm/中线 2 m/跑道内 → normal，score 950±30', () => {
  const state = mkTouchdownState({
    vsFpm: 100, bankDeg: 0.5, pitchDeg: 3, driftDeg: 1,
    centerlineOffsetM: 2, iasKt: 140, onRunway: true, surface: 'runway',
  });
  const r = scoreLanding(state);
  assert.equal(r.outcome, 'normal');
  assert.equal(r.survived, true);
  assert.equal(r.survivalRate, 1.0);
  assert.ok(r.score >= 920 && r.score <= 980, `score=${r.score}（期望 950±30）`);
  assert.equal(r.breakdown.flapsAppropriate, true);
  assert.equal(r.breakdown.overspeedOnTouchdown, false);
});

ok('S5b 重着陆：-800 fpm → 低分（<520）且含结构罚', () => {
  const state = mkTouchdownState({
    vsFpm: 800, bankDeg: 1, pitchDeg: 4, driftDeg: 1,
    centerlineOffsetM: 5, iasKt: 145, onRunway: true, surface: 'runway',
  });
  const r = scoreLanding(state);
  assert.equal(r.outcome, 'normal'); // 800 < 1200 不判坠毁
  assert.ok(r.score < 520, `score=${r.score}（期望 <520）`);
  assert.ok(r.breakdown.heavyLandingPenalty > 0);
  assert.ok(r.survivalRate <= 0.9);
});

ok('S5c 水面迫降：姿态 11°/低接地率 → ditching 高存活', () => {
  const state = mkTouchdownState({
    vsFpm: 150, bankDeg: 1, pitchDeg: 11, driftDeg: 0,
    centerlineOffsetM: 0, iasKt: 125, onRunway: false, surface: 'water',
  });
  const r = scoreLanding(state);
  assert.equal(r.outcome, 'ditching');
  assert.equal(r.survived, true);
  assert.ok(r.survivalRate >= 0.85, `survivalRate=${r.survivalRate}`);
});

ok('S5d 坡度 35° 接地 → crash、survived=false、低分', () => {
  const state = mkTouchdownState({
    vsFpm: 400, bankDeg: 35, pitchDeg: 2, driftDeg: 2,
    centerlineOffsetM: 4, iasKt: 140, onRunway: true, surface: 'runway',
  });
  const r = scoreLanding(state);
  assert.equal(r.outcome, 'crash');
  assert.equal(r.survived, false);
  assert.ok(r.score < 150, `score=${r.score}`);
  assert.ok(r.survivalRate <= 0.3);
});

ok('S5e 跑道外撞地形（重接地）→ crash；轻接地 → off-field', () => {
  const hard = scoreLanding(mkTouchdownState({
    vsFpm: 900, bankDeg: 5, pitchDeg: 3, driftDeg: 3,
    centerlineOffsetM: 60, iasKt: 150, onRunway: false, surface: 'terrain',
  }));
  assert.equal(hard.outcome, 'crash');
  const soft = scoreLanding(mkTouchdownState({
    vsFpm: 350, bankDeg: 3, pitchDeg: 5, driftDeg: 3,
    centerlineOffsetM: 60, iasKt: 140, onRunway: false, surface: 'terrain',
  }));
  assert.equal(soft.outcome, 'off-field');
  assert.ok(soft.survivalRate > 0.2 && soft.survivalRate < 0.6);
});

ok('S5f 机腹迫降：可控参数 → belly、survivalRate 0.85 基准带', () => {
  const r = scoreLanding(mkTouchdownState({
    vsFpm: 250, bankDeg: 0, pitchDeg: 6, driftDeg: 1,
    centerlineOffsetM: 6, iasKt: 130, onRunway: true, surface: 'belly',
  }));
  assert.equal(r.outcome, 'belly');
  assert.equal(r.survived, true);
  assert.ok(r.survivalRate >= 0.7 && r.survivalRate <= 0.85, `survivalRate=${r.survivalRate}`);
});

/* =========================================================
 * S6 可复现
 * ========================================================= */

ok('S6a scoreLanding 纯函数：两次调用同分（无随机、无时间依赖）', () => {
  const state = mkTouchdownState({
    vsFpm: 120, bankDeg: 2.5, pitchDeg: 4, driftDeg: 6,
    centerlineOffsetM: 8, iasKt: 150, onRunway: true, surface: 'runway',
  });
  const a = scoreLanding(state);
  const b = scoreLanding(state);
  assert.equal(a.score, b.score);
  assert.equal(a.outcome, b.outcome);
  assert.equal(a.survivalRate, b.survivalRate);
  assert.deepEqual(a.breakdown, b.breakdown);
});

ok('S6b 引擎同 seed：随机触发序列完全一致', () => {
  function runSeeded() {
    const { state, bus } = mkSim();
    const engine = createScenarioEngine(state, bus, SCENARIOS, {});
    engine.setRandomSeed(2024);
    engine.armForPhase('cruise');
    for (let i = 0; i < 3000; i++) {
      state.time += 1;       // 只推时钟（不跑物理）——触发序列只依赖 seed 与时间
      engine.update(1);
    }
    return JSON.stringify(engine.history());
  }
  const a = runSeeded();
  const b = runSeeded();
  assert.equal(a, b, '同 seed 两次触发序列应一致');
  const hist = JSON.parse(a);
  assert.ok(hist.some((e) => e.type === 'trigger'), '3000 s 内应至少随机触发 1 条');
  const trig = hist.find((e) => e.type === 'trigger');
  assert.ok(trig.t >= SCENARIOS.find((s) => s.id === trig.scenarioId).minElapsedS, '触发应满足 minElapsedS 保护期');
});

ok('S6c 引擎不同 seed → 触发时刻大概率不同；forced 不受每局一条限制', () => {
  function firstTrigger(seed) {
    const { state, bus } = mkSim();
    const engine = createScenarioEngine(state, bus, SCENARIOS, {});
    engine.setRandomSeed(seed);
    engine.armForPhase('cruise');
    for (let i = 0; i < 4000; i++) {
      state.time += 1;
      engine.update(1);
    }
    const trig = engine.history().find((e) => e.type === 'trigger');
    return trig ? `${trig.scenarioId}@${trig.t}` : 'none';
  }
  // 不强求不同（概率性），只验证同 seed 稳定 + forced 链可用
  assert.equal(firstTrigger(7), firstTrigger(7));
  const { state, bus } = mkSim();
  const engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: false });
  engine.armForPhase('cruise');
  const rt = engine.forced('engine-fire');
  step(state, bus);
  assert.equal(engine.update(1 / 60), 'active', '火警燃烧中应为 active');
  // 执行 correctCommands（灭火处置）
  const sc = getScenarioById('engine-fire');
  sc.correctCommands.forEach((c) => {
    if (!c) return;
    const args = typeof c.args === 'function' ? c.args(state, rt) : (c.args ?? []);
    if (c.cmd) bus.send(c.cmd, ...args);
    else bus.damage[c.damage](...args);
  });
  step(state, bus);
  assert.equal(engine.update(1 / 60), 'resolved', '关车+灭火后应 resolved');
  assert.ok(engine.forced('cabin-fire'), 'resolved 后可强制下一条（剧本模式链式）');
});

ok('S6c2 setRandomSeed 重置触发状态', () => {
  const { state, bus } = mkSim();
  const engine = createScenarioEngine(state, bus, SCENARIOS, {});
  engine.setRandomSeed(42);
  engine.armForPhase('cruise');
  for (let i = 0; i < 1500; i++) { state.time += 1; engine.update(1); }
  engine.setRandomSeed(42);
  assert.equal(engine.history().length, 0, 'setRandomSeed 应清空日志');
});

console.log(`\n${passed}/${total} 通过${process.exitCode ? '（存在失败）' : ' —— 全部 PASS'}`);
