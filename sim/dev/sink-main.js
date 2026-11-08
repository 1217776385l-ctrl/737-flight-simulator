/**
 * 外部视角"沉入跑道"复现页（调试用，不属于产品）。
 * 全程外部视角：停机 12s → 满推起飞 → VR 抬轮 → 爬升 60m，三个节点各自 stopAt 停住供截图。
 * 用法：dev/sink.html?stopAt=parked-ext|rotate-ext|climb-ext
 */
const S = window.__sim5;
const params = new URLSearchParams(location.search);
const STOP_AT = params.get('stopAt');
const STEP = 0.25;

const logEl = document.getElementById('sink-log');
function log(line, cls = '') {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  const sim = S.state ? `T+${S.state.time.toFixed(1).padStart(6)}` : 'T+----';
  div.textContent = `${sim}  ${line}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[sink] ${line}`);
}

function snapshot(name, data) {
  log(`SNAPSHOT ${name} ${JSON.stringify(data)}`, 'snap');
  if (STOP_AT && name === STOP_AT) {
    S.api.setPaused(true);
    document.title = `STOP:${name}`;
    log(`stopAt 命中：仿真已停住（${name}）`);
  }
}

function tele() {
  const st = S.state;
  return {
    y: +st.position.y.toFixed(2), agl: +st.agl.toFixed(2),
    pitch: +st.orientation.pitch.toFixed(1), bank: +st.orientation.bank.toFixed(1),
    ias: +st.velocity.ias.toFixed(0), vs: +st.velocity.vsFpm.toFixed(0),
    x: +st.position.x.toFixed(0), z: +st.position.z.toFixed(1),
  };
}

const CFG = {
  mode: 'route', from: 'ZSPD', to: 'OEJN',
  weight: 'std', hour: 'day', weather: 'good',
  practice: true, routeDistKm: 120,
};

let stage = 'wait-start';
let vr = 143;

const tick = () => {
  const st = S.state;
  const bus = S.bus;
  if (stage === 'wait-start') {
    if (!S.flightActive) {
      S.api.setRenderOnly(true);
      S.api.setSuppressKeyboard(true);
      S.api.startFlight(CFG);
      S.api.toggleExternal(); // 全程外部视角（必须在 startFlight 之后——开局会重置视角）
      stage = 'parked';
      log('开局：ZSPD→OEJN · 全程外部视角 · 静置观测');
    }
    return;
  }
  if (S.ended || S.paused) return;

  if (stage === 'parked') {
    if (st.time === 0 || st.time % 3 < STEP) log(`parked ${JSON.stringify(tele())}`);
    if (st.time >= 12) {
      snapshot('parked-ext', tele());
      vr = 143;
      stage = 'roll';
      log('满推起飞');
    }
    return;
  }
  if (stage === 'roll') {
    bus.send('throttle/set', 1);
    if (st.velocity.ias >= vr) { stage = 'rotate'; log(`VR 到（${st.velocity.ias}kt）抬轮`); }
    return;
  }
  if (stage === 'rotate') {
    const el = Math.min(0.6, 0.15 + (12 - st.orientation.pitch) * 0.06);
    bus.send('control/elevator', el);
    if (st.orientation.pitch >= 10 && st.agl > 3) {
      snapshot('rotate-ext', tele());
      stage = 'climb';
      bus.send('gear/up');
      log('正爬升，收轮');
    }
    return;
  }
  if (stage === 'climb') {
    const el = Math.min(0.45, 0.10 + (12 - st.orientation.pitch) * 0.05);
    bus.send('control/elevator', el);
    if (st.velocity.ias > 210) bus.send('flaps/set', 0);
    if (st.agl > 60) {
      snapshot('climb-ext', tele());
      stage = 'done';
    }
  }
};

let started = false;
const timer = setInterval(() => {
  if (stage === 'wait-start' && !started && S.api) { started = true; }
  if (stage === 'done' || document.title.startsWith('STOP:')) return;
  if (stage !== 'wait-start' || S.api) S.api.advance(STEP, 0.02);
  tick();
}, 1);
