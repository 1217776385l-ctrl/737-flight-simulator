/**
 * alarms.js — 告警音与一次性音效（WebAudio 全合成）。
 *
 * 音色参照真 737：
 *  - MASTER CAUTION：双谐音 chime（800 → 1000 Hz 短促正弦，各 ≈0.14 s）；
 *  - 火警铃：方波铃音 ≈640 Hz，按 ≈3 Hz 断续（LFO 方波门控），持续循环；
 *  - 超速 clacker：带通噪声脉冲被 ≈8 Hz 方波门控——机械"咔哒咔哒"；
 *  - 振杆器：≈42 Hz 锯齿低频嗡鸣（真机为偏心配重马达），连续；
 *  - 客舱释压：持续 whoop 警报（音调上下摆动的三角波）；
 *  - 地面滚动隆隆：低通（≈120 Hz）白噪，音量随地速；
 *  - 接地 thump：一次性低频冲击（55 Hz 正弦快速衰减）+ 低通噪声爆。
 *
 * 节点预算（持久）：火警铃 3 + clacker 3 + 振杆 3 + 释压 3 + 滚动 2 = 14 源/滤波/增益，
 * 加双发 EngineSound ≈ 24 与一次性 chime/thump（≤4 个瞬时节点）——总预算 < 40，安全。
 */

/**
 * JS 侧指数平滑 AudioParam。
 * @param {AudioParam} p
 * @param {number} target
 * @param {number} dt
 * @param {number} [tau]
 */
function smooth(p, target, dt, tau = 0.08) {
  const k = 1 - Math.exp(-dt / tau);
  p.value += (target - p.value) * k;
}

/**
 * 创建全部告警音节点组。
 * @param {AudioContext} ctx
 * @param {AudioNode} out 母线
 * @param {AudioBuffer} noiseBuffer 共享白噪
 * @returns {{
 *   chime: function(): void,
 *   thump: function(number): void,
 *   setFireBell: function(boolean): void,
 *   setClacker: function(boolean): void,
 *   setStickShaker: function(boolean): void,
 *   setCabinAlarm: function(boolean): void,
 *   setRumble: function(number, number): void,
 * }}
 */
export function createAlarms(ctx, out, noiseBuffer) {
  /* ---------- MASTER CAUTION 双谐音 chime（按需瞬时节点） ---------- */
  function chime() {
    const t0 = ctx.currentTime;
    [
      [800, t0],
      [1000, t0 + 0.16],
    ].forEach(([f, t]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.28, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.18);
    });
  }

  /* ---------- 火警铃（方波 + 断续门控） ---------- */
  const bellOsc = ctx.createOscillator();
  bellOsc.type = 'square';
  bellOsc.frequency.value = 640;
  const bellBp = ctx.createBiquadFilter();
  bellBp.type = 'bandpass';
  bellBp.frequency.value = 640;
  bellBp.Q.value = 2.5; // 收窄谐波，去掉方波的刺耳高次波
  const bellGate = ctx.createGain();
  bellGate.gain.value = 0;
  const bellLfo = ctx.createOscillator();
  bellLfo.type = 'square';
  bellLfo.frequency.value = 3; // ≈3 Hz 断续节奏
  const bellLfoGain = ctx.createGain();
  bellLfoGain.gain.value = 0; // 深度随开关变化
  bellLfo.connect(bellLfoGain).connect(bellGate.gain);
  const bellOut = ctx.createGain();
  bellOut.gain.value = 0; // 总开关（平滑启停）
  bellOsc.connect(bellBp).connect(bellGate).connect(bellOut).connect(out);
  bellOsc.start();
  bellLfo.start();

  /* ---------- 超速 clacker（噪声脉冲 8 Hz 门控） ---------- */
  const clackNoise = ctx.createBufferSource();
  clackNoise.buffer = noiseBuffer;
  clackNoise.loop = true;
  const clackBp = ctx.createBiquadFilter();
  clackBp.type = 'bandpass';
  clackBp.frequency.value = 2100;
  clackBp.Q.value = 0.8;
  const clackGate = ctx.createGain();
  clackGate.gain.value = 0;
  const clackLfo = ctx.createOscillator();
  clackLfo.type = 'square';
  clackLfo.frequency.value = 8; // ≈8 Hz 咔哒节奏
  const clackLfoGain = ctx.createGain();
  clackLfoGain.gain.value = 0;
  clackLfo.connect(clackLfoGain).connect(clackGate.gain);
  const clackOut = ctx.createGain();
  clackOut.gain.value = 0;
  clackNoise.connect(clackBp).connect(clackGate).connect(clackOut).connect(out);
  clackNoise.start();
  clackLfo.start();

  /* ---------- 振杆器（42 Hz 锯齿连续嗡鸣） ---------- */
  const shakerOsc = ctx.createOscillator();
  shakerOsc.type = 'sawtooth';
  shakerOsc.frequency.value = 42;
  const shakerLp = ctx.createBiquadFilter();
  shakerLp.type = 'lowpass';
  shakerLp.frequency.value = 220;
  const shakerOut = ctx.createGain();
  shakerOut.gain.value = 0;
  shakerOsc.connect(shakerLp).connect(shakerOut).connect(out);
  shakerOsc.start();

  /* ---------- 客舱释压 whoop 警报 ---------- */
  const cabinOsc = ctx.createOscillator();
  cabinOsc.type = 'triangle';
  cabinOsc.frequency.value = 800;
  const cabinSweep = ctx.createOscillator();
  cabinSweep.type = 'sine';
  cabinSweep.frequency.value = 1.1; // 音调上下摆动 → whoop 质感
  const cabinSweepGain = ctx.createGain();
  cabinSweepGain.gain.value = 350;
  cabinSweep.connect(cabinSweepGain).connect(cabinOsc.frequency);
  const cabinOut = ctx.createGain();
  cabinOut.gain.value = 0;
  cabinOsc.connect(cabinOut).connect(out);
  cabinOsc.start();
  cabinSweep.start();

  /* ---------- 地面滚动隆隆 ---------- */
  const rumbleNoise = ctx.createBufferSource();
  rumbleNoise.buffer = noiseBuffer;
  rumbleNoise.loop = true;
  const rumbleLp = ctx.createBiquadFilter();
  rumbleLp.type = 'lowpass';
  rumbleLp.frequency.value = 120;
  const rumbleOut = ctx.createGain();
  rumbleOut.gain.value = 0;
  rumbleNoise.connect(rumbleLp).connect(rumbleOut).connect(out);
  rumbleNoise.start();

  let lastDt = 1 / 60;

  return {
    /** MASTER CAUTION 双谐音 */
    chime,

    /**
     * 接地 thump：低频冲击 + 噪声爆。
     * @param {number} strength 0..1（由接地垂直速度归一）
     */
    thump(strength) {
      const t0 = ctx.currentTime;
      const s = Math.max(0.15, Math.min(1, strength));
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(58, t0);
      o.frequency.exponentialRampToValueAtTime(28, t0 + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 * s, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + 0.35);
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.3 * s, t0);
      ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      n.connect(lp).connect(ng).connect(out);
      n.start(t0);
      n.stop(t0 + 0.2);
    },

    /** 火警铃开关 */
    setFireBell(on) {
      bellLfoGain.gain.value = on ? 0.11 : 0;
      smooth(bellOut.gain, on ? 1 : 0, lastDt, 0.05);
    },

    /** 超速 clacker 开关 */
    setClacker(on) {
      clackLfoGain.gain.value = on ? 0.16 : 0;
      smooth(clackOut.gain, on ? 1 : 0, lastDt, 0.03);
    },

    /** 振杆器开关 */
    setStickShaker(on) {
      smooth(shakerOut.gain, on ? 0.22 : 0, lastDt, 0.05);
    },

    /** 客舱释压警报开关 */
    setCabinAlarm(on) {
      smooth(cabinOut.gain, on ? 0.12 : 0, lastDt, 0.1);
    },

    /**
     * 地面滚动隆隆。
     * @param {number} level 0..1 音量目标（地速归一）
     * @param {number} dt 帧间隔
     */
    setRumble(level, dt) {
      lastDt = dt;
      smooth(rumbleOut.gain, Math.max(0, Math.min(1, level)) * 0.5, dt, 0.15);
    },
  };
}
