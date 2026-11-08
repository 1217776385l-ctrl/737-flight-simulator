/**
 * audio-main.js — 单元 4 dev 控制台逻辑。
 *
 * 说明：本页面只演示音景触发，**不跑 stepSimulation**（仿真由单元 6 集成）。
 * 引擎/地速滑杆直接写 state（dev 专用便利）；警告类触发经 audio.trigger()
 * 走 state.warnings 脉冲；自动脚本通过改 state（ias/agl/onGround）验证
 * state 驱动路径（80kt→V1→ROTATE→POSITIVE RATE→100→…→TEN→接地 thump）。
 *
 * URL 参数 ?selftest=1：加载后自动跑 audio.selfTest()（无头截图用）。
 */

import { createSimState } from '../src/kernel/index.js';
import { createAudio } from '../src/audio/index.js';

/* ---------- 日志区（评审验证物） ---------- */
const logEl = document.getElementById('log');

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function logLine(text, cls = '') {
  const div = document.createElement('div');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `[${ts()}] `;
  div.appendChild(t);
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  div.appendChild(span);
  logEl.appendChild(div);
  while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

window.__audioLog = (text) => logLine(text); // 供控制台调试

/* ---------- 组装 ---------- */
const state = createSimState();
const audio = createAudio(state, { onLog: (l) => {
  if (l.startsWith('spoke:')) logLine(l, 'spoke');
  else if (l.startsWith('selfTest:')) logLine(l, 'selftest');
  else if (l.startsWith('auto:')) logLine(l, 'auto');
  else if (l.startsWith('sound:')) logLine(l, 'sound');
  else logLine(l);
} });

logLine('dev: createAudio 就绪（AudioContext 需解锁后出声；语音日志以 spoke 行为准）');

// JS 错误也进日志区（无头排障 + 评审可见"无错误"）
window.addEventListener('error', (e) => logLine(`err: ${e.message} @${e.filename}:${e.lineno}`, 'err'));
window.addEventListener('unhandledrejection', (e) => logLine(`err: ${e.reason}`, 'err'));

/* ---------- 主循环（音频 update 用 16ms 定时器驱动：
   无头/后台页 rAF 不可靠，而 update 只是写 AudioParam，定时器足够） ---------- */
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  audio.update(dt);
}, 16);

// 浏览器手势解锁约定：任何按键/点击都调 resume()
const unlock = () => audio.resume();
window.addEventListener('keydown', unlock, { once: false });
window.addEventListener('pointerdown', unlock, { once: false });

/* ---------- 控制按钮 ---------- */
let muted = false;
document.getElementById('btnResume').addEventListener('click', () => audio.resume());
document.getElementById('btnMute').addEventListener('click', (e) => {
  muted = !muted;
  audio.setMuted(muted);
  e.target.textContent = muted ? '取消静音' : '静音';
});

// 逐条"触发"按钮
document.querySelectorAll('button[data-trigger]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.trigger;
    if (name === '_killL') {
      state.engines[0].running = !state.engines[0].running;
      if (!state.engines[0].running) state.engines[0].n1 = 0;
      logLine(`dev: 左发 running=${state.engines[0].running}`);
      return;
    }
    logLine(`dev: 触发 ${name}`);
    audio.trigger(name);
  });
});

/* ---------- 滑杆 → state（dev 便利写法，仿真态由内核负责） ---------- */
function bindSlider(id, valId, fn, fmt = (v) => v.toFixed(2)) {
  const el = document.getElementById(id);
  const out = document.getElementById(valId);
  const apply = () => {
    const v = parseFloat(el.value);
    fn(v);
    out.textContent = fmt(v);
  };
  el.addEventListener('input', apply);
  apply();
}
bindSlider('n1L', 'n1Lv', (v) => { state.engines[0].n1 = v; });
bindSlider('n1R', 'n1Rv', (v) => { state.engines[1].n1 = v; });
bindSlider('rev', 'revV', (v) => { state.reverse[0] = state.reverse[1] = v; });
bindSlider('gs', 'gsV', (v) => {
  state.velocity.gs = v;
  state.velocity.ias = state.ground.onGround ? v : state.velocity.ias;
}, (v) => `${v | 0}`);
document.getElementById('onGround').addEventListener('change', (e) => {
  state.ground.onGround = e.target.checked;
  logLine(`dev: ground.onGround=${e.target.checked}`);
});

/* =========================================================
 * 自动脚本：≈11 s 完整呼叫序列（state 驱动路径验证）
 * 80kt → V1 → ROTATE → POSITIVE RATE → 100/50/40/30/20+RETARD/10 → 接地
 * ========================================================= */
let autoRunning = false;

async function runAutoSequence() {
  if (autoRunning) return;
  autoRunning = true;
  audio.resume(); // dev 页直接解锁（headless 无手势；真实主循环在手势事件里调）
  const at = (ms, fn) => new Promise((r) => setTimeout(() => { fn(); r(); }, ms));
  logLine('auto: ===== 起飞呼叫序列开始 =====', 'auto');

  // 复位到起飞滑跑起点
  state.ground.onGround = true;
  state.velocity.ias = 0;
  state.agl = 0;
  state.velocity.vsFpm = 0;
  state.flaps.index = 3; // 襟翼 5 → V1/VR/ROTATE 阈值来自重量插值表
  await at(600, () => { state.velocity.ias = 40; });
  await at(1400, () => { state.velocity.ias = 85; logLine('auto: IAS=85kt（应触发 EIGHTY KNOTS）', 'auto'); });
  await at(1400, () => { state.velocity.ias = 120; });
  await at(1200, () => { state.velocity.ias = 140; logLine('auto: IAS=140kt（应触发 V1）', 'auto'); });
  await at(1400, () => { state.velocity.ias = 152; logLine('auto: IAS=152kt（应触发 ROTATE）', 'auto'); });
  await at(1400, () => {
    state.ground.onGround = false;
    state.agl = 15;
    state.velocity.vsFpm = 600;
    logLine('auto: 离地 vsFpm=+600（应触发 POSITIVE RATE）', 'auto');
  });
  // 转入进近下降
  await at(1600, () => {
    state.velocity.vsFpm = -700;
    state.agl = 40; // ≈131 ft
    logLine('auto: 五边下降 vsFpm=-700', 'auto');
  });
  await at(1000, () => { state.agl = 28; });  // ≈92 ft → ONE HUNDRED
  await at(700, () => { state.agl = 14.5; }); // ≈48 ft → FIFTY
  await at(600, () => { state.agl = 11.5; }); // ≈38 ft → FORTY
  await at(600, () => { state.agl = 8.8; });  // ≈29 ft → THIRTY
  await at(600, () => { state.agl = 5.5; });  // ≈18 ft → TWENTY + RETARD
  await at(800, () => { state.agl = 2.5; });  // ≈8 ft → TEN
  await at(1000, () => {
    state.ground.onGround = true;
    state.touchdown.vsFpm = 140; // 内核约定：正 = 下降
    logLine('auto: 接地 vsFpm=140（应触发 thump）', 'auto');
  });
  logLine('auto: ===== 序列结束 =====', 'auto');
  autoRunning = false;
}

document.getElementById('btnAuto').addEventListener('click', runAutoSequence);

/* ---------- 全部自检 ---------- */
document.getElementById('btnSelfTest').addEventListener('click', async () => {
  logLine('dev: selfTest 开始，逐项触发（见紫色行）…', 'selftest');
  const lines = await audio.selfTest();
  logLine(`dev: selfTest 完成，共 ${lines.length} 行日志`, 'selftest');
});

/* ---------- 启动 ---------- */
const params = new URLSearchParams(location.search);
if (params.get('selftest') === '1') {
  setTimeout(async () => {
    audio.resume();
    const lines = await audio.selfTest();
    logLine(`dev: selfTest 完成，共 ${lines.length} 行日志`, 'selftest');
  }, 800);
} else {
  setTimeout(runAutoSequence, 800); // 自动脚本（无头截图的验证内容）
}
