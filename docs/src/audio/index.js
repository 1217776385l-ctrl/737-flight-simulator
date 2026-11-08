/**
 * index.js — 音景搭建（单元 4）入口：createAudio(state)。
 *
 * 只读内核状态树驱动音景，绝不写 state（本模块内部 trigger/selfTest 的
 * 状态脉冲仅用于 dev/测试，脉冲结束即恢复原值）。
 *
 * 用法（单元 6 集成参考）：
 * ```js
 * import { createAudio } from './audio/index.js';
 * const audio = createAudio(state, { onLog: console.log });
 * // 主循环每帧：
 * audio.update(dt);
 * // 首次用户手势（keydown/pointerdown）里调用一次：
 * audio.resume();
 * ```
 *
 * ⚠ AudioContext 解锁约定：浏览器要求用户手势后才能出声。解锁前 update()
 *   完全静默（直接 return，不推进任何告警边沿），resume() 之后第一帧起
 *   音景才生效。主循环必须在首次 keydown/pointerdown 时调用 audio.resume()。
 *
 * 节点预算（持久，全部复用，绝不每帧 new）：
 *   双发 EngineSound 2×12 + 告警组 ≈14 + 母线 2 ≈ **40 个节点**；
 *   一次性 chime/thump 用后即弃（≤4 个瞬时节点）。
 * speechSynthesis 不可用时静默降级：只记一行日志，speak 照常记录，不抛错。
 */

import { EngineSound, makeNoiseBuffer } from './engine-sound.js';
import { createAlarms } from './alarms.js';
import { createVoice } from './voice.js';
import { getVSpeeds } from '../kernel/vspeeds.js';
import { m2ft, clamp } from '../kernel/math.js';

/** 进近无线电高度 callout 阈值（ft → 短语），20 ft 起附加 RETARD */
const APPROACH_CALLOUTS = [
  [100, 'ONE HUNDRED'],
  [50, 'FIFTY'],
  [40, 'FORTY'],
  [30, 'THIRTY'],
  [20, 'TWENTY'],
  [10, 'TEN'],
];

/** GPWS / 系统警告字符串 → 语音短语映射 */
const WARNING_SPEECH = {
  'GPWS SINKRATE': 'SINK RATE',
  'GPWS PULLUP': 'PULL UP',
  TERRAIN: 'TERRAIN, TERRAIN',
  WINDSHEAR: 'WINDSHEAR',
  'CABIN PRESSURE': 'CABIN PRESSURE',
  STALL: 'STALL',
};

/**
 * 创建音景控制器。
 * @param {Object} state 内核状态树（唯一事实源，只读）
 * @param {{onLog?: (line: string) => void}} [opts] onLog：每条音效/语音事件的回调（dev 页面与 selfTest 用）
 * @returns {{
 *   update: (dt: number) => void,
 *   resume: () => void,
 *   setMuted: (muted: boolean) => void,
 *   selfTest: () => Promise<string[]>,
 *   trigger: (name: string) => void,
 * }}
 */
export function createAudio(state, opts = {}) {
  /** 可替换的日志出口：selfTest 期间临时换成"双写"收集器 */
  let logSink = opts.onLog || (() => {});
  const emit = (line) => logSink(line);

  /** @type {AudioContext} */
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  const noiseBuffer = makeNoiseBuffer(ctx);
  const engineSounds = [
    new EngineSound(ctx, master, noiseBuffer, 'L'),
    new EngineSound(ctx, master, noiseBuffer, 'R'),
  ];
  const alarms = createAlarms(ctx, master, noiseBuffer);
  const voice = createVoice(emit);

  /* ---------- 边沿检测 / 时序状态（内部） ---------- */
  let prev = {
    masterCaution: false,
    activeSet: new Set(),
    stickShaker: false,
    onGround: true,
    fire: false,
    clack: false,
    cabinAlarm: false,
  };
  /** 起飞 callout 预位（onGround && ias<30 时复位） */
  const armed = { eighty: false, v1: false, vr: false, positive: false };
  /** 已播报的进近高度阈值集合 */
  const crossed = new Set();
  /** RETARD 复读时刻（performance.now()/1000） */
  let lastRetardAt = -1e9;

  /** 警告语音（映射短语 + 去抖） */
  function speakWarn(warningStr, debounceMs) {
    voice.speak(WARNING_SPEECH[warningStr] || warningStr, { debounceMs });
  }

  /* =========================================================
   * 每帧驱动
   * ========================================================= */
  function update(dt) {
    if (!unlocked) return; // 解锁前完全静默（见文件头 JSDoc）
    const s = state;

    /* ----- 引擎声（双发独立跟随） ----- */
    for (let i = 0; i < 2; i++) {
      engineSounds[i].update(dt, s.engines[i], s.reverse ? s.reverse[i] : 0);
    }

    /* ----- 地面滚动隆隆（地速相关） ----- */
    const gs = s.velocity.gs || 0;
    alarms.setRumble(s.ground.onGround ? clamp(gs / 160, 0, 1) : 0, dt);

    /* ----- 警告集合 ----- */
    const activeSet = new Set(s.warnings.active || []);

    // MASTER CAUTION：上升沿 → 双谐音 chime
    if (s.warnings.masterCaution && !prev.masterCaution) {
      alarms.chime();
      emit('sound: MASTER CAUTION chime');
    }

    // 火警铃：火警警告或 fire 字段任一为真即持续响
    const fireOn =
      activeSet.has('ENGINE FIRE L') || activeSet.has('ENGINE FIRE R') ||
      (s.fire && (s.fire.engines[0] || s.fire.engines[1] || s.fire.cabin || s.fire.cargo));
    alarms.setFireBell(!!fireOn);
    if (!!fireOn !== prev.fire) emit(`sound: 火警铃 ${fireOn ? 'on' : 'off'}`);

    // 超速 clacker
    const clack = activeSet.has('OVERSPEED');
    alarms.setClacker(clack);
    if (clack !== prev.clack) emit(`sound: 超速 clacker ${clack ? 'on' : 'off'}`);

    // 振杆器 + STALL 语音
    const shaker = !!s.warnings.stickShaker;
    alarms.setStickShaker(shaker);
    if (shaker !== prev.stickShaker) emit(`sound: 振杆器 ${shaker ? 'on' : 'off'}`);
    if (shaker && !prev.stickShaker) speakWarn('STALL', 3000);

    // 客舱释压：持续警报 + 语音
    const cabin = activeSet.has('CABIN PRESSURE');
    alarms.setCabinAlarm(cabin);
    if (cabin !== prev.cabinAlarm) emit(`sound: 释压警报 ${cabin ? 'on' : 'off'}`);
    if (cabin && !prev.activeSet.has('CABIN PRESSURE')) {
      speakWarn('CABIN PRESSURE', 5000);
    }

    // GPWS / TERRAIN / WINDSHEAR 语音（上升沿触发 + 5 s 去抖）
    for (const phrase of ['GPWS SINKRATE', 'GPWS PULLUP', 'TERRAIN', 'WINDSHEAR']) {
      if (activeSet.has(phrase) && !prev.activeSet.has(phrase)) {
        speakWarn(phrase, 5000);
      }
    }

    /* ----- 副驾驶起飞 callout（80kt / V1 / VR / POSITIVE RATE） ----- */
    const ias = s.velocity.ias || 0;
    if (s.ground.onGround && ias < 30) {
      armed.eighty = armed.v1 = armed.vr = armed.positive = false;
    }
    const vs = getVSpeeds(s.massKg, s.flaps.index);
    if (!armed.eighty && ias >= 80) { armed.eighty = true; voice.speak('EIGHTY KNOTS', { force: true }); }
    if (!armed.v1 && ias >= vs.v1) { armed.v1 = true; voice.speak('V1', { force: true }); }
    if (!armed.vr && ias >= vs.vr) { armed.vr = true; voice.speak('ROTATE', { force: true }); }
    if (!armed.positive && !s.ground.onGround && (s.velocity.vsFpm || 0) > 150 && s.agl > 3) {
      armed.positive = true;
      voice.speak('POSITIVE RATE', { force: true });
    }

    /* ----- 进近无线电高度 callout（下降中，AGL 驱动） ----- */
    const aglFt = m2ft(s.agl || 0);
    const descending = (s.velocity.vsFpm || 0) < -50;
    if (aglFt > 150 || s.ground.onGround) crossed.clear();
    if (descending && !s.ground.onGround) {
      for (const [ft, phrase] of APPROACH_CALLOUTS) {
        if (aglFt <= ft && !crossed.has(ft)) {
          crossed.add(ft);
          voice.speak(phrase, { force: true });
          if (ft === 20) voice.speak('RETARD', { force: true }); // 20 ft 起喊 RETARD
          break; // 一帧只播一条（低空掉得快时按最高阈值优先）
        }
      }
      // RETARD 复读：拉平后油门仍在进车位
      const thrAvg = s.throttle ? (s.throttle[0] + s.throttle[1]) / 2 : 0;
      const nowS = performance.now() / 1000;
      if (aglFt < 15 && thrAvg > 0.15 && nowS - lastRetardAt > 2.5) {
        voice.speak('RETARD', { force: true });
        lastRetardAt = nowS;
      }
    }

    /* ----- 接地 thump（离地 → 接地上升沿） ----- */
    if (s.ground.onGround && !prev.onGround) {
      const vsAbs = Math.abs(s.touchdown.vsFpm || 300);
      alarms.thump(clamp(vsAbs / 600, 0.2, 1));
      emit(`sound: 接地 thump (vsFpm=${Math.round(vsAbs)})`);
    }

    prev = {
      masterCaution: !!s.warnings.masterCaution,
      activeSet,
      stickShaker: shaker,
      onGround: !!s.ground.onGround,
      fire: !!fireOn,
      clack,
      cabinAlarm: cabin,
    };
  }

  /** 用户手势解锁标志：false 时 update() 静默 */
  let unlocked = false;

  /* =========================================================
   * dev / 测试触发表
   * ========================================================= */

  /**
   * @param {string} phrase 警告枚举
   * @param {number} ms 脉冲时长（之后自动从 active 移除）
   */
  function pulseWarning(phrase, ms) {
    const w = state.warnings;
    if (!w.active.includes(phrase)) w.active.push(phrase);
    setTimeout(() => {
      const i = w.active.indexOf(phrase);
      if (i >= 0) w.active.splice(i, 1);
    }, ms);
  }

  /* =========================================================
   * 对外接口
   * ========================================================= */
  return {
    /** 每帧调用：解锁前静默 */
    update,

    /**
     * 解锁 AudioContext —— 必须在用户手势事件（keydown/pointerdown）里调用。
     * 解锁后第一帧 update() 起音景生效；已处于活动状态的警告会立刻补发声。
     */
    resume() {
      unlocked = true;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      emit('audio: AudioContext 已解锁');
    },

    /** 静音开关（母线增益归零，状态机继续跑） */
    setMuted(m) {
      master.gain.value = m ? 0 : 1;
      emit(`audio: ${m ? '已静音' : '取消静音'}`);
    },

    /**
     * dev/测试用：按名强制触发单个音效/语音。
     * 警告类 = 向 state.warnings 短暂加枚举（上升沿 + 去抖逻辑照常生效）；
     * 离散 callout = 直接经语音通道播报。
     * 可用名见 selfTest 内 names 列表。
     * @param {string} name
     */
    trigger(name) {
      const w = state.warnings;
      switch (name) {
        case 'masterCaution':
          w.masterCaution = true;
          setTimeout(() => { w.masterCaution = false; }, 1200);
          break;
        case 'fireBell': {
          const prevFire = state.fire.engines[0];
          state.fire.engines[0] = true;
          pulseWarning('ENGINE FIRE L', 3000);
          setTimeout(() => { state.fire.engines[0] = prevFire; }, 3000);
          break;
        }
        case 'clacker': pulseWarning('OVERSPEED', 2500); break;
        case 'stickShaker': {
          const prevShaker = w.stickShaker;
          w.stickShaker = true;
          pulseWarning('STALL', 2500);
          setTimeout(() => { w.stickShaker = prevShaker; }, 2500);
          break;
        }
        case 'cabinPressure': pulseWarning('CABIN PRESSURE', 4000); break;
        case 'sinkrate': pulseWarning('GPWS SINKRATE', 1500); break;
        case 'pullup': pulseWarning('GPWS PULLUP', 1500); break;
        case 'terrain': pulseWarning('TERRAIN', 1500); break;
        case 'windshear': pulseWarning('WINDSHEAR', 1500); break;
        case 'touchdown': {
          const prevOn = state.ground.onGround;
          const prevVs = state.touchdown.vsFpm;
          state.ground.onGround = false;
          state.touchdown.vsFpm = 380;
          setTimeout(() => {
            state.ground.onGround = true;
            state.touchdown.vsFpm = prevVs;
          }, 300);
          break;
        }
        // 离散 callout：直接播报（state 驱动路径由 dev 页自动脚本验证）
        case 'eightyKnots': voice.speak('EIGHTY KNOTS', { force: true }); break;
        case 'v1': voice.speak('V1', { force: true }); break;
        case 'rotate': voice.speak('ROTATE', { force: true }); break;
        case 'positiveRate': voice.speak('POSITIVE RATE', { force: true }); break;
        case 'oneHundred': voice.speak('ONE HUNDRED', { force: true }); break;
        case 'fifty': voice.speak('FIFTY', { force: true }); break;
        case 'forty': voice.speak('FORTY', { force: true }); break;
        case 'thirty': voice.speak('THIRTY', { force: true }); break;
        case 'twenty': voice.speak('TWENTY', { force: true }); break;
        case 'ten': voice.speak('TEN', { force: true }); break;
        case 'retard': voice.speak('RETARD', { force: true }); break;
        default: emit(`trigger: 未知音效名 "${name}"`);
      }
    },

    /**
     * dev/测试用：强制逐个触发全部音效/语音（间隔 1.5 s），返回触发日志。
     * 脉冲式修改 state（警告枚举/火警/接地沿），结束后恢复原值——
     * 单元 5/6 评审可直接 `const log = await audio.selfTest()`，
     * 断言日志行数与 "spoke:" / "sound:" 关键字齐全。
     * @returns {Promise<string[]>}
     */
    async selfTest() {
      const names = [
        'masterCaution', 'fireBell', 'clacker', 'stickShaker',
        'sinkrate', 'pullup', 'terrain', 'windshear', 'cabinPressure',
        'touchdown',
        'eightyKnots', 'v1', 'rotate', 'positiveRate',
        'oneHundred', 'fifty', 'forty', 'thirty', 'twenty', 'ten', 'retard',
      ];
      const log = [];
      const orig = logSink;
      logSink = (l) => { orig(l); log.push(l); };
      try {
        unlocked = true; // selfTest 视为已解锁（dev/测试环境）
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        log.push(`selfTest: 开始（${names.length} 项，间隔 1.5 s）`);
        for (const name of names) {
          log.push(`selfTest: >>> ${name}`);
          this.trigger(name);
          await sleep(1500);
        }
        log.push('selfTest: 完成');
      } finally {
        logSink = orig;
      }
      return log;
    },
  };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
