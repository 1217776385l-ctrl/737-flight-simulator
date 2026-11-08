/**
 * scenario-engine.js — 险情剧本引擎。
 *
 * 职责：
 *  - 按飞行阶段与权重随机抛出险情（每局最多 1 条随机险情；剧本模式可 forced() 强制）；
 *  - 随机数种子化（mulberry32）：同一 seed + 同样操作 ⇒ 同样的触发序列，评分可复现；
 *  - 驱动险情 timeline（持续效应/叙事节点）与 resolveCheck（处置判据）；
 *  - 记录 event log（触发/时间线/处置动作/解除/失败，全部带仿真时间戳）供结算画面回放。
 *
 * 与内核的关系：引擎只读 state、只经 bus.send / bus.damage.* 改状态，绝不绕过命令总线
 * （天气类 apply 直写 state.weather 属环境数据字段授权，见 scenarios.js 头注）。
 *
 * 典型主循环接入：
 *   const engine = createScenarioEngine(state, bus);
 *   // 每帧：
 *   engine.armForPhase(currentPhase);
 *   const status = engine.update(dt);
 *   // 剧本模式：
 *   engine.forced('engine-fire');
 */

import { SCENARIOS } from './scenarios.js';

/**
 * mulberry32 种子化 PRNG（确定性、快、统计性质够用）。
 * @param {number} seed 任意整数种子
 * @returns {() => number} 产出 [0,1) 的随机函数
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 创建绑定到状态树与命令总线的剧本引擎。
 * @param {Object} state           createSimState() 产出的状态树（只读 + 天气授权写）
 * @param {Object} bus             createCommandBus() 产出的命令总线（含 bus.damage）
 * @param {Array<Object>} [registry] 险情注册表（默认 SCENARIOS）
 * @param {Object} [opts]
 * @param {number} [opts.meanIntervalS=240] 随机触发的平均间隔 s（每秒掷骰 p = 1/mean）
 * @param {boolean} [opts.randomEnabled=true] 是否允许随机触发（测试/剧本模式可关）
 * @returns {Object} 引擎 API
 */
export function createScenarioEngine(state, bus, registry = SCENARIOS, opts = {}) {
  const meanIntervalS = opts.meanIntervalS ?? 240;
  const randomEnabled = opts.randomEnabled ?? true;

  let rng = mulberry32(1);
  let rollTimer = 0;
  let phase = null;            // 当前飞行阶段（armForPhase 喂入）
  let activeRt = null;         // 活动险情运行时记录（见 scenarios.js 头注）
  let randomTriggered = false; // 本局已随机触发过（每局最多 1 条）
  /** @type {Array<{t:number,type:string,scenarioId:string|null,label:string}>} */
  const history = [];

  const byId = (id) => registry.find((s) => s.id === id);

  function log(type, scenarioId, label) {
    history.push({ t: state.time, type, scenarioId: scenarioId ?? null, label: label ?? '' });
  }

  /**
   * 触发一条险情（内部）。
   * @param {Object} scenario 险情声明
   * @param {boolean} forced  是否剧本强制
   */
  function triggerScenario(scenario, forced) {
    if (activeRt) return null;
    const rt = {
      scenarioId: scenario.id,
      name: scenario.name,
      triggeredAtS: state.time,
      phase,
      forced: !!forced,
      rng,
      data: {},
      timelineIdx: 0,
    };
    activeRt = rt;
    scenario.apply(state, bus, rt);
    log('trigger', scenario.id, `${scenario.name}——${forced ? '剧本强制触发' : '随机触发'}`);
    return rt;
  }

  /** 随机触发掷骰（每 1 s 一次，p = 1/meanIntervalS），从合格险情中按阶段权重挑一条 */
  function tryRandomTrigger() {
    if (randomTriggered) return;
    if (rng() >= 1 / meanIntervalS) return;
    const candidates = registry.filter((s) =>
      !activeRt &&
      (s.phaseWeights?.[phase] ?? 0) > 0 &&
      state.time >= (s.minElapsedS ?? 0) &&
      (!s.trigger || s.trigger(state, { phase, rng })));
    if (candidates.length === 0) return;
    let total = 0;
    for (const s of candidates) total += s.phaseWeights[phase];
    let r = rng() * total;
    let picked = candidates[candidates.length - 1];
    for (const s of candidates) {
      r -= s.phaseWeights[phase];
      if (r <= 0) { picked = s; break; }
    }
    randomTriggered = true;
    triggerScenario(picked, false);
  }

  return {
    /**
     * 喂入当前飞行阶段（主循环每帧调用）。
     * @param {'takeoff'|'climb'|'cruise'|'descent'|'approach'|'landing'} p
     */
    armForPhase(p) {
      phase = p;
    },

    /**
     * 每帧推进：处理 timeline 持续效应、处置判据、随机触发。
     * @param {number} dt 帧间隔 s
     * @returns {'idle'|'active'|'resolved'|'failed'} 本帧结束时的剧本状态
     */
    update(dt) {
      if (!(dt > 0)) return activeRt ? 'active' : 'idle';
      if (activeRt) {
        const sc = byId(activeRt.scenarioId);
        const tRel = state.time - activeRt.triggeredAtS;
        const timeline = sc.timeline ?? [];
        while (activeRt.timelineIdx < timeline.length) {
          const entry = timeline[activeRt.timelineIdx];
          if (entry.atS > tRel) break;
          entry.action?.(state, bus, activeRt);
          log('timeline', sc.id, entry.label);
          activeRt.timelineIdx++;
        }
        const check = sc.resolveCheck(state, activeRt);
        if (check === 'resolved') {
          log('resolve', sc.id, `${sc.name}——处置完成（resolved）`);
          activeRt = null;
          return 'resolved';
        }
        if (check === 'failed') {
          log('fail', sc.id, `${sc.name}——处置失败（failed）`);
          activeRt = null;
          return 'failed';
        }
        return 'active';
      }
      if (randomEnabled) {
        rollTimer += dt;
        while (rollTimer >= 1) {
          rollTimer -= 1;
          tryRandomTrigger();
        }
      }
      return 'idle';
    },

    /** 当前活动险情快照（供 UI 简报/提示卡），无则 null */
    active() {
      if (!activeRt) return null;
      const sc = byId(activeRt.scenarioId);
      return {
        id: sc.id,
        name: sc.name,
        category: sc.category,
        briefing: sc.briefing,
        correctActions: sc.correctActions.slice(),
        triggeredAtS: activeRt.triggeredAtS,
        elapsedS: state.time - activeRt.triggeredAtS,
        phase: activeRt.phase,
        forced: activeRt.forced,
      };
    },

    /** 活动险情的内部运行时记录（correctCommands 的 args(state, rt) 需要它；测试/调试用） */
    activeRuntime() {
      return activeRt;
    },

    /** 事件日志（触发/时间线/处置动作/解除/失败，含仿真时间戳） */
    history() {
      return history.slice();
    },

    /** history() 别名：结算画面回放摘要用 */
    eventLog() {
      return history.slice();
    },

    /**
     * 记录玩家处置动作（提示卡/UI 在玩家执行对应命令时调用）。
     * @param {string} label 处置动作描述
     */
    noteAction(label) {
      log('action', activeRt?.scenarioId ?? null, label);
    },

    /**
     * 剧本模式强制触发指定险情（绕过权重/保护期/触发条件/每局一条限制；活动险情存在时拒绝）。
     * @param {string} id 险情 id
     * @returns {Object|null} 触发后的运行时记录（id 无效或已有活动险情 → null）
     */
    forced(id) {
      const sc = byId(id);
      if (!sc) return null;
      return triggerScenario(sc, true);
    },

    /**
     * 重设随机种子（评分与触发完全可复现：同 seed + 同样操作 ⇒ 同样剧本）。
     * @param {number} n
     */
    setRandomSeed(n) {
      rng = mulberry32(n);
      rollTimer = 0;
      randomTriggered = false;
      history.length = 0;
    },
  };
}
