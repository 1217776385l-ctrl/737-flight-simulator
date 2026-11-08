/**
 * engine-sound.js — 单台 CFM56-7B 发动机的持续合成声（WebAudio 全合成，零外部文件）。
 *
 * 三层结构（全部为**持久节点**，update 只平滑参数，绝不每帧 new 节点）：
 *  1. 基础轰鸣：锯齿低频振荡器 40-90 Hz 随 N1 映射 → 低通 180 Hz；
 *  2. 风扇噪声：循环白噪 → 带通（中心频率 150→1750 Hz 随 N1 升高，Q≈1.1）；
 *  3. 涡轮啸声：正弦振荡器 900→6100 Hz 随 N1（高频"尖啸"，N1 高时才明显）。
 * 附加层：
 *  - 反推层：带通噪声（稀碎气流声），N1×reverse 驱动，音量带轻微随机抖动；
 *  - 发动机失效（running=false）或 N1≈0 时该发全部静音。
 *
 * 平滑策略：内核 N1 本身有一阶滞后，这里只做"跟随"——JS 侧指数平滑
 * （tau≈0.08 s）后直接写 AudioParam.value，避免每帧堆积调度事件。
 */

/**
 * 生成 2 秒循环白噪声 AudioBuffer（全部噪声源共用一份）。
 * @param {AudioContext} ctx
 * @returns {AudioBuffer}
 */
export function makeNoiseBuffer(ctx) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * JS 侧指数平滑 AudioParam（避免每帧 schedule 事件堆积）。
 * @param {AudioParam} p
 * @param {number} target 目标值
 * @param {number} dt 帧间隔 s
 * @param {number} [tau] 时间常数 s
 */
function smooth(p, target, dt, tau = 0.08) {
  const k = 1 - Math.exp(-dt / tau);
  p.value += (target - p.value) * k;
}

/** 单发持久节点数：4 源（2 振荡器 + 2 噪声）+ 4 滤波 + 4 增益 ≈ 12 */
export class EngineSound {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} out 汇入节点（母线）
   * @param {AudioBuffer} noiseBuffer 共享白噪 buffer
   * @param {string} name 发动机名（'L'|'R'，仅日志用）
   */
  constructor(ctx, out, noiseBuffer, name) {
    this.name = name;
    this.ctx = ctx;

    // 1. 基础低频轰鸣
    this.oscBase = ctx.createOscillator();
    this.oscBase.type = 'sawtooth';
    this.oscBase.frequency.value = 40;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    this.gBase = ctx.createGain();
    this.gBase.gain.value = 0;
    this.oscBase.connect(lp).connect(this.gBase).connect(out);
    this.oscBase.start();

    // 2. 风扇带通噪声
    this.noiseFan = ctx.createBufferSource();
    this.noiseFan.buffer = noiseBuffer;
    this.noiseFan.loop = true;
    this.bpFan = ctx.createBiquadFilter();
    this.bpFan.type = 'bandpass';
    this.bpFan.frequency.value = 150;
    this.bpFan.Q.value = 1.1;
    this.gFan = ctx.createGain();
    this.gFan.gain.value = 0;
    this.noiseFan.connect(this.bpFan).connect(this.gFan).connect(out);
    this.noiseFan.start();

    // 3. 涡轮啸声
    this.oscWhine = ctx.createOscillator();
    this.oscWhine.type = 'sine';
    this.oscWhine.frequency.value = 900;
    this.gWhine = ctx.createGain();
    this.gWhine.gain.value = 0;
    this.oscWhine.connect(this.gWhine).connect(out);
    this.oscWhine.start();

    // 4. 反推稀碎层（独立噪声源 → 带通）
    this.noiseRev = ctx.createBufferSource();
    this.noiseRev.buffer = noiseBuffer;
    this.noiseRev.loop = true;
    this.bpRev = ctx.createBiquadFilter();
    this.bpRev.type = 'bandpass';
    this.bpRev.frequency.value = 700;
    this.bpRev.Q.value = 0.4;
    this.gRev = ctx.createGain();
    this.gRev.gain.value = 0;
    this.noiseRev.connect(this.bpRev).connect(this.gRev).connect(out);
    this.noiseRev.start();
  }

  /**
   * 每帧跟随 N1 / 反推状态。
   * @param {number} dt 帧间隔 s
   * @param {{n1:number, running:boolean}} engine 内核 engines[i]
   * @param {number} reverse 反推量 0..1
   */
  update(dt, engine, reverse) {
    const n1 = engine && engine.running ? Math.max(0, engine.n1 || 0) : 0;
    // 音高/频率映射（N1 0..1 → 起伏区间）
    smooth(this.oscBase.frequency, 40 + n1 * 50, dt, 0.1);
    smooth(this.bpFan.frequency, 150 + n1 * 1600, dt, 0.1);
    smooth(this.oscWhine.frequency, 900 + n1 * 5200, dt, 0.1);
    // 音量映射：N1 越大越响；啸声按 n1² 使其在高功率才浮现
    smooth(this.gBase.gain, n1 > 0.005 ? 0.06 + n1 * 0.20 : 0, dt);
    smooth(this.gFan.gain, Math.pow(n1, 1.5) * 0.45, dt);
    smooth(this.gWhine.gain, n1 * n1 * 0.05, dt);
    // 反推层：叠加随机抖动（"稀碎"感）
    const revTarget = reverse * Math.pow(n1, 1.2) * 0.35;
    const jitter = revTarget > 0 ? revTarget * (0.75 + Math.random() * 0.5) : 0;
    smooth(this.gRev.gain, jitter, dt, 0.05);
  }
}
