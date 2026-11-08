/**
 * main.js — 单元 5（整合搭建）：完整可玩的一局。
 *
 * 职责（单元 0-4 的集成层，本文件是唯一被授权重写的运行时入口）：
 *   主菜单（src/ui/menu.js）→ startFlight(config) →
 *   每帧（按 kernel-api.md 推荐次序）：
 *     输入 → world.update(dt, camera) → phase 推导 + scenarioEngine.armForPhase/update →
 *     stepSimulation(state, dt, bus) → 航线推进/目的地过渡 → cockpit.update → audio.update →
 *     结算检测 → render
 *
 * 相机：默认机长眼位（cockpit.cameraAnchor 的世界矩阵直接驱动相机），
 * C 键切换外部追机视角（程序化 737-800 外部模型，与座舱几何同挂 aircraft Object3D）。
 *
 * 机体坐标约定：aircraft 原点 = 地面接触参考点（起飞/落地时 state.position），
 * rotation YXZ：y=偏航（kernel heading 0°=+x 北，顺时针）、x=俯仰（+抬头）、z=滚转（-坡度）。
 * 驾驶舱几何挂 y=2.2（地板离地高），外部简壳挂 y=3.0（机身中线离地高）。
 *
 * E2E：window.__sim5 暴露 {state, bus, engine, api}；节点用 CustomEvent 'sim5:marker' 广播。
 */

import * as THREE from 'three';
import {
  createSimState, createCommandBus, createKeyboardInput, stepSimulation,
  getVSpeeds, getVref,
} from './kernel/index.js';
import { createWorld } from './world/index.js';
import { AIRPORTS, airportToWorld, glideslopeHeightM } from './world/airports-data.js';
import { createCockpit } from './cockpit/index.js';
import { createScenarioEngine } from './scenarios/scenario-engine.js';
import { SCENARIOS } from './scenarios/scenarios.js';
import { scoreLanding } from './scoring/landing-score.js';
import { createAudio } from './audio/index.js';
import { createMenu, HOUR_OPTIONS, WEIGHT_OPTIONS } from './ui/menu.js';
import { buildExternalAircraft } from './aircraft/external-model.js';
import { createHud, PHASE_ZH } from './ui/hud.js';
import { createExternalHud } from './ui/external-hud.js';
import { createScoreboard } from './ui/scoreboard.js';

const D2R = Math.PI / 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;
const KT2MS = 0.514444;
const M2FT = 3.28084;
/** 目的地过渡：距入口该距离时换世界并摆到进近航道（世界引擎单场景约 40 km 的诚实简化） */
const TRANSITION_DIST_M = 25000;

/* =========================================================
 * 渲染基础
 * ========================================================= */
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 60000);
scene.add(camera);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* =========================================================
 * 机体容器：座舱几何 + 外部简壳（同一 Object3D，随 state 位姿）
 * ========================================================= */
const aircraft = new THREE.Object3D();
aircraft.rotation.order = 'YXZ';
scene.add(aircraft);

/** 程序化 737-800 外部模型（仅外部追机视角可见；见 src/aircraft/external-model.js） */
const em = buildExternalAircraft();
const shell = em.group;
shell.visible = false;
aircraft.add(shell);

/* =========================================================
 * 内核 / 剧本 / 音景（一次创建，重开局用 resetState 复位同一状态树，
 * 保证 cockpit / audio / engine 持有的引用始终有效）
 * ========================================================= */
let state = createSimState({ fuelKg: 14600, payloadKg: 14000 });
const bus = createCommandBus(state);

const cmdLog = [];
/**
 * 命令追踪：包一层 bus.send / bus.damage.*，
 * 玩家（或 E2E 脚本）执行的命令若命中活动险情的 correctCommands → engine.noteAction。
 */
function wrapBus() {
  const rawSend = bus.send.bind(bus);
  bus.send = (name, ...args) => {
    cmdLog.push({ t: state.time, name });
    if (cmdLog.length > 600) cmdLog.shift();
    noteActionFor('cmd', name);
    // MCP 航向目标是罗盘值 → 换算为内核局部角（其余命令不做罗盘换算）
    if (name === 'ap/hdg' && typeof args[0] === 'number') {
      args = [wrap360(args[0] - (state.runway.headingDeg || 0)), ...args.slice(1)];
    }
    return rawSend(name, ...args);
  };
  for (const k of Object.keys(bus.damage)) {
    if (typeof bus.damage[k] !== 'function') continue;
    const raw = bus.damage[k].bind(bus.damage);
    bus.damage[k] = (...args) => { noteActionFor('damage', k); return raw(...args); };
  }
}
function noteActionFor(kind, name) {
  const snap = engine?.active();
  if (!snap) return;
  const sc = SCENARIOS.find((s) => s.id === snap.id);
  if (!sc) return;
  sc.correctCommands.forEach((c, i) => {
    const hit = kind === 'cmd' ? c && c.cmd === name : c && c.damage === name;
    if (hit) engine.noteAction(`执行：${sc.correctActions[i]}`);
  });
}
wrapBus();

let engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: true });

/** 键盘（人工操纵）。suppressKeyboard 供 E2E 脚本飞行时屏蔽（脚本直接发 control 命令） */
const keyboard = createKeyboardInput(bus);
keyboard.attach(window);

const cockpit = createCockpit(scene, state, bus, { domElement: renderer.domElement, camera });
cockpit.group.position.y = 2.2; // 驾驶舱地板离地高（眼位 ≈3.4 m，真实 737 量级）
aircraft.add(cockpit.group);

const audio = createAudio(state, { onLog: (line) => console.log('[audio]', line) });
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audio.resume();
}
window.addEventListener('keydown', unlockAudio, { once: false });
window.addEventListener('pointerdown', unlockAudio, { once: false });

/* =========================================================
 * UI（菜单 / HUD / 结算）
 * ========================================================= */
const hud = createHud(document.body);
const scoreboard = createScoreboard(document.body);
const extHud = createExternalHud(document.body); // uxBC2 任务 1：外部视角仪表叠加

/* ---------- 单元 B/C：新手/行话 HUD、引导首飞、K 指南 ---------- */
let noviceMode = true;        // N 键切换（默认新手模式）
let guide = null;             // 引导首飞状态机（仅 config.guided 时非 null）
let guideAutoShown = false;   // K 指南"首局默认展开"每会话只发生一次
let navVisible = true;        // J 键切换导航引导卡（默认显示；?nonav=1 供 E2E 截图）
// dev 截图钩子：?pro=1（行话 HUD）/ ?guided=1（引导首飞）/ ?ui=guide|guided|guideqr / ?nonav=1
const UI_PARAMS = new URLSearchParams(location.search);
if (UI_PARAMS.has('pro')) { noviceMode = false; hud.setNovice(false); }
if (UI_PARAMS.has('nonav')) { navVisible = false; hud.setNavVisible(false); }

/** 引导首飞：返回当前应呼吸提示的关键动作文案（null = 无）。完成即一次性正向确认 */
function guidedHint() {
  if (!guide) return null;
  const st = state;
  if (!guide.thr) {
    if (st.throttle[0] >= 0.5) { guide.thr = true; hud.toast('油门已推满——保持中线加速！', 2000); }
    else if (st.time > 15 && st.ground.onGround) return '按 PgUp 推满油门（起飞推力 TOGA）';
    return null;
  }
  if (!guide.rot) {
    if (st.velocity.vsFpm > 300 && st.agl > 15) { guide.rot = true; hud.toast('好，抬轮！保持 10-13° 爬升', 2200); }
    else if (st.ground.onGround && st.velocity.ias >= 140) return '速度到了——按住 ↓（下方向键）拉杆抬轮，保持 10-13°';
    return null;
  }
  if (!guide.gear) {
    if (!st.gear.handleDown) { guide.gear = true; hud.toast('起落架已收上', 1800); }
    else if (st.agl > 50 && st.velocity.vsFpm > 300) return '正爬升率——按 G 收起落架';
    return null;
  }
  if (!guide.flaps) {
    if (st.flaps.index === 0) {
      guide.flaps = true;
      hud.toast('襟翼收净——爬升到巡航高度，一路平安！', 2600);
      guide = null;
      return null;
    }
    if (st.agl > 300 && st.velocity.ias > 200) return '加速后按 F 收襟翼（一档一档收）';
  }
  return null;
}

/** 上下文提示条 key：按阶段/构型细分（文案表在 hud.js；险情优先级最高） */
function contextHintKey() {
  if (!flightActive) return null;
  if (engine.active()) return 'scenario';
  const st = state;
  if (phase === 'rollout') return 'rollout'; // 落地滑跑（相位机已区分，不再挂在 takeoff 下）
  if (phase === 'takeoff') {
    if (st.ground.onGround) return st.velocity.ias < 80 ? 'to-ground' : 'to-roll';
    return 'to-rotate';
  }
  if (phase === 'climb') {
    if (st.gear.handleDown && st.agl < 400) return 'climb-gear';
    if (st.flaps.index > 0 && st.agl > 200 && st.velocity.ias > 190) return 'climb-flaps';
    return 'climb';
  }
  if (phase === 'cruise') return 'cruise';
  if (phase === 'descent') return 'descent';
  if (phase === 'approach') return st.gear.handleDown ? 'approach' : 'app-gear';
  if (phase === 'landing') return st.ground.onGround ? 'rollout' : 'final';
  return null;
}

/* ---------- 防御性对接 cockpit 单元导出（待 cockpit Agent 交付后自动生效） ----------
 * 期待导出：cameraPrefs = { fov, near }、setLookPitch() / resetLookPitch()（Shift 按住下视）、
 * setLightingMode(hourKey)（dawn|day|dusk|night）。导出尚不存在时全部静默跳过。 */
function applyCameraPrefs() {
  if (typeof cockpit.cameraPrefs !== 'object' || !cockpit.cameraPrefs) return;
  const p = cockpit.cameraPrefs;
  if (typeof p.fov === 'number' && Math.abs(camera.fov - p.fov) > 0.01) {
    camera.fov = p.fov;
    camera.updateProjectionMatrix();
  }
  if (typeof p.near === 'number' && camera.near !== p.near) camera.near = p.near;
}
function setLightingMode(hourKey) {
  if (typeof cockpit.setLightingMode === 'function') {
    try { cockpit.setLightingMode(hourKey); } catch { /* 防御：签名未定不阻塞主循环 */ }
  }
}

/* =========================================================
 * 飞行会话状态
 * ========================================================= */
let world = null;
let config = null;
let phase = 'takeoff';
let flightActive = false;
let ended = false;
let paused = false;
let externalView = false;
let simSpeed = 1;
let suppressKeyboard = false;

let routeDistM = 0;
let flownM = 0;
let transitioned = false;
let forcedFired = false;
let briefShown = false;
let lastScenarioName = null;
let scoreDelayS = null;
let lastResult = null;
let previewAngle = 0;
let lastPhaseToast = { phase: '', t: -1e9 };
let touchdownZM = null; // 接地时刻的带符号 z（内核 touchdown.centerlineOffsetM 只存绝对值）
let fuelFlowAvg = 0;    // 平滑油流（EMA，τ≈90s）：续航估算不随油门瞬变跳变

const worldOpts = () => ({
  storm: config?.weather === 'storm',
  hour: HOUR_OPTIONS[config?.hour ?? 'day'].hour,
});

/** 节点标记：console + CustomEvent('sim5:marker')，E2E 监听写日志/截图 */
function marker(name, detail) {
  const entry = { ...(detail ?? {}), name, t: state?.time ?? 0 }; // detail 在前：name/t 不可被覆盖
  console.log(`[marker] ${name} @T+${entry.t.toFixed(1)}s`, detail ?? '');
  window.dispatchEvent(new CustomEvent('sim5:marker', { detail: entry }));
}

/* =========================================================
 * 状态复位（重开局不换引用：按 createSimState 模板深拷贝覆盖）
 * ========================================================= */
function resetState(cfg, rngSeed) {
  const w = WEIGHT_OPTIONS[cfg.weight];
  // 起飞重量：内核无燃油装载命令（bus 表不含 fuel/set），按合同直接写初始油量/载荷。
  // 总重 = OEW 41400 + 载荷 + 燃油（轻 55t / 标准 70t / 重 78t）。
  // rngSeed 与剧本引擎同源：内核湍流/皮托漂移等全部走 state.rng，同选项整局可复现。
  const fresh = createSimState({ fuelKg: w.fuelKg, payloadKg: w.payloadKg, enginesRunning: true, rngSeed });
  for (const k of Object.keys(fresh)) {
    const v = fresh[k];
    state[k] = (v && typeof v === 'object') ? structuredClone(v) : v;
  }
  state.time = 0;
  state._acc = 0;
  // 起飞就绪态：停留刹车松开、襟翼 5、扰流板预位、双发慢车
  state.ground.parkingBrake = false;
  state.ground.brakes[0] = 0;
  state.ground.brakes[1] = 0;
  bus.send('flaps/set', 3);
  state.spoilers.armed = true;
  cmdLog.length = 0;
}

/** 种子：航线 + 险情 + 时刻派生（同选项 = 同剧本、同随机序列） */
function strHash(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* =========================================================
 * 开局 / 回菜单
 * ========================================================= */
function startFlight(cfg) {
  config = cfg;
  // 清理上一局世界
  if (world) { world.dispose(); world = null; }
  // seed 由航线+险情+时刻派生（同选项 = 同剧本、同随机序列、同物理抖动）
  const seed = strHash(`${cfg.from}>${cfg.to}|${cfg.weight}|${cfg.hour}|${cfg.weather}|${cfg.scenarioId ?? 'rand'}|${cfg.triggerPhase}`);
  resetState(cfg, seed);

  const from = AIRPORTS[cfg.from];
  world = createWorld(scene, state, cfg.from, worldOpts());
  // 机位 = 出发机场跑道头（本地 x=0, z=0）。
  // 内核 heading 恒为**跑道局部角**（0°=跑道轴 +x）；罗盘值只存 state.runway.headingDeg，
  // 显示/输入边界（HUD/座舱/MCP/风）各自换算——见 docs/kernel-api.md 航向约定。
  state.orientation.heading = 0;
  state.runway.headingDeg = from.runwayHeading;
  state.position.x = 0; state.position.y = 0; state.position.z = 0;

  // 剧本引擎重建（randomEnabled 为构建期选项：航线模式随机抛险情，剧本模式只用 forced）
  engine = createScenarioEngine(state, bus, SCENARIOS, { randomEnabled: cfg.mode === 'route' });
  engine.setRandomSeed(seed);

  // 航线距离：同机场对固定（可被 config.routeDistKm 覆盖，E2E 用）
  routeDistM = (cfg.routeDistKm ?? (150 + (strHash(`${cfg.from}>${cfg.to}`) % 150))) * 1000;
  flownM = 0;
  transitioned = false;
  forcedFired = false;
  briefShown = false;
  lastScenarioName = null;
  scoreDelayS = null;
  lastResult = null;
  touchdownZM = null;
  // 平滑油流从开局慢车油流起步（EMA 预热，避免续航数字从 0 慢慢爬）
  fuelFlowAvg = (state.engines[0].running ? state.engines[0].fuelFlowKgs : 0) +
    (state.engines[1].running ? state.engines[1].fuelFlowKgs : 0);
  phase = 'takeoff';
  phaseCand = null;
  phaseCandSince = -1e9;
  flightActive = true;
  ended = false;
  paused = false;
  externalView = false;

  // 导航数据契约（给 CDU/导航卡用，见 docs/kernel-api.md「nav.guidance」）：
  // resetState 会整体换掉 state.nav，这里重建；之后每帧 6Hz 由 tick 刷新
  state.nav.guidance = {
    destId: cfg.to,
    destName: AIRPORTS[cfg.to].name,
    phase: 'takeoff',
    adviceZh: '滑跑加速，VR 抬轮后建立正爬升',
    distKm: routeDistM / 1000,
    brgCompass: from.runwayHeading, // 过渡前无目的地几何：直飞航向 ≈ 出发跑道罗盘航向（诚实简化）
  };

  aircraft.visible = true;
  shell.visible = false;
  cockpit.group.visible = true;
  menu.hide();
  hud.reset();
  scoreboard.hide();
  // 单元 B/C：HUD 术语模式 / 引导首飞 / K 指南首局展开 / 座舱光照（防御性对接）
  if (typeof cfg.novice === 'boolean') noviceMode = cfg.novice;
  hud.setNovice(noviceMode);
  hud.setNavVisible(navVisible); // 导航引导卡每局恢复默认显隐（J 切换）
  guide = (cfg.guided ?? UI_PARAMS.has('guided')) ? { thr: false, rot: false, gear: false, flaps: false } : null;
  if (guide && !guideAutoShown) {
    guideAutoShown = true;
    hud.openGuideTemporarily(30000); // 首局默认展开，30 秒后渐隐为右下角"K 指南"小标签
  }
  setLightingMode(cfg.hour);
  hud.toast(`${from.name} → ${AIRPORTS[cfg.to].name} · 襟翼 5 · 双发慢车 · 停留刹车已松`);
  console.log(`[flight] 开局 seed=${seed} 航线 ${cfg.from}->${cfg.to} 距离 ${(routeDistM / 1000).toFixed(0)} km`);
}

function backToMenu() {
  flightActive = false;
  ended = false;
  paused = false;
  config = null;
  guide = null;
  hud.reset();
  scoreboard.hide();
  aircraft.visible = false;
  menu.show();
  marker('menu');
}

function setPaused(on) {
  if (!flightActive || ended) on = false;
  paused = on;
  hud.showPause(on, {
    onResume: () => setPaused(false),
    onMenu: backToMenu,
    onMute: toggleMute,
  });
}

function toggleMute() {
  audio.setMuted(!muted);
  muted = !muted;
  hud.toast(muted ? '已静音' : '声音开启', 1200);
}
let muted = false;

const menu = createMenu(document.body, { onStart: startFlight });

/* =========================================================
 * 飞行相位机（带滞回 + 单调推进，2026-11-08 导航修复）：
 *   takeoff → climb → cruise → descent → approach → landing → rollout → ended
 *
 * 判定条件（docs/kernel-api.md「飞行相位机」节）：
 *   takeoff  : onGround（未记录过接地；松刹车 IAS>35 即滑跑）
 *   rollout  : touchdown.recorded 后 onGround（落地滑跑绝不再判回 takeoff）
 *   climb    : 离地且 vsFpm > +300（离地后的兜底段）
 *   cruise   : AGL ≥ 2400 m 或（AGL ≥ 1500 m 且 |vs| < 300）——稳定平台，
 *              一旦进入不允许被 vs 抖动打回 climb（单调推进保证）
 *   descent  : vsFpm < -800 且 AGL > 300（真实下降，微下沉不触发）
 *   approach : transitioned（目的地世界已建）或（待飞 <30 km 且下降且 AGL<1800）
 *   landing  : AGL < 150 m 且 vsFpm < -100 且待飞 <6 km
 *
 * 滞回：候选相位条件需持续 ≥3 s 才提交（防 vs/AGL 抖动来回横跳）。
 * 单调：相位序只进不退——任何回跳（如 cruise→takeoff / cruise→climb）直接忽略，
 *      takeoff 只能从开局进入。旧 derivePhase 的缺陷（onGround 三元死代码、
 *      AGL<150 一刀切判 landing 导致起飞爬升段报"降落"、落地滑跑报回"起飞"）一并移除。
 * ========================================================= */
const PHASE_ORDER = ['takeoff', 'climb', 'cruise', 'descent', 'approach', 'landing', 'rollout', 'ended'];
const PHASE_ZH_ALL = { ...PHASE_ZH, rollout: '滑跑', ended: '结束' };
const PHASE_HYSTERESIS_S = 3;
let phaseCand = null;        // 滞回候选相位
let phaseCandSince = -1e9;   // 候选开始持续的时刻（state.time）

/** 原始相位判定（不含滞回/单调，见上方条件表） */
function rawPhase() {
  const vs = state.velocity.vsFpm;
  // 待飞距离统一口径：过渡前 world.updateNav 写的 nav.distM 是对**出发地**机场的，
  // 必须用航线余程；过渡后 nav.distM 才指向目的地入口。
  const destDistKm = transitioned
    ? state.nav.distM / 1000
    : Math.max(0, routeDistM - flownM) / 1000;
  if (state.ground.onGround) {
    return state.touchdown.recorded ? 'rollout' : 'takeoff';
  }
  if (state.agl < 150 && vs < -100 && destDistKm < 6) return 'landing';
  if (transitioned || (destDistKm < 30 && vs < -300 && state.agl < 1800)) return 'approach';
  if (vs < -800 && state.agl > 300) return 'descent';
  if (state.agl >= 2400 || (state.agl >= 1500 && Math.abs(vs) < 300)) return 'cruise';
  return 'climb'; // 离地默认段（初始爬升 / 拉平过渡）
}

/** 相位推进：滞回 ≥3s + 单调（只进不退），每仿真帧调用一次 */
function updatePhase() {
  if (!flightActive) { phase = 'takeoff'; return; }
  if (ended) { phase = 'ended'; return; }
  const raw = rawPhase();
  if (PHASE_ORDER.indexOf(raw) < PHASE_ORDER.indexOf(phase)) return; // 回跳一律忽略
  if (raw === phase) { phaseCand = null; return; }
  // rollout 由离散事件 touchdown.recorded 触发（无抖动可言），免滞回立即提交——
  // 否则 3s 滞回会与结算检测的 3s 延迟赛跑，序列里永远看不到 rollout。
  // 但只允许从进近/着陆侧进入：起飞抬轮初期擦地回跳内核同样会记一次 touchdown
  //（flight-model recordTouchdown），那不是落地滑跑，保持原相位等它自己再离地。
  if (raw === 'rollout' && state.touchdown.recorded) {
    if (PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf('approach')) {
      phase = raw;
      phaseCand = null;
      return;
    }
    return; // 起飞段回跳：忽略
  }
  if (raw !== phaseCand) { phaseCand = raw; phaseCandSince = state.time; return; }
  if (state.time - phaseCandSince >= PHASE_HYSTERESIS_S) {
    phase = raw;
    phaseCand = null;
  }
}

/* =========================================================
 * 航线推进 + 目的地世界过渡
 * ========================================================= */
function updateRoute(dt) {
  if (!flightActive || ended || transitioned) return;
  if (state.agl > 300 && phase !== 'takeoff') {
    flownM += state.velocity.gs * KT2MS * dt;
  }
  const remainingM = routeDistM - flownM;
  const okPhase = phase === 'climb' || phase === 'cruise' || phase === 'descent';
  if (remainingM <= TRANSITION_DIST_M && state.agl > 800 && okPhase) {
    transitionToDestination();
  }
}

/** 换世界到目的地：摆到入口前 25 km、3° 下滑道上方 220 m、对正跑道（诚实简化，见报告） */
function transitionToDestination() {
  transitioned = true;
  if (world) world.dispose();
  world = createWorld(scene, state, config.to, worldOpts());
  const dest = world.airport;
  // 立即同步 nav（新世界的 updateNav 要到下一帧 world.update 才运行；
  // 若不同步，本 tick 内 pilot/AP 读到的是旧机场的 course/dist）
  state.nav.courseDeg = 0; // 内核局部系：跑道轴即 0°（世界 updateNav 现也写局部）
  state.nav.distM = TRANSITION_DIST_M;
  state.nav.thresholdElevFt = 0;
  const w = airportToWorld(dest, -TRANSITION_DIST_M, 0);
  state.position.x = w.x;
  state.position.z = w.z;
  state.position.y = glideslopeHeightM(TRANSITION_DIST_M, 3.0) + 220;
  state.orientation.heading = 0; // 内核局部系：正对跑道轴
  state.orientation.pitch = 0;
  state.orientation.bank = 0;
  state.runway.headingDeg = dest.runwayHeading; // 罗盘锚点随活动世界切换
  const v = Math.max(state.velocity.ias, 200) * KT2MS;
  state.velocity.vx = v;
  state.velocity.vz = 0;
  state.velocity.vy = 0;
  state.velocity.vsFpm = 0;
  // 导航契约同步（新世界的 updateNav 下一帧才跑；本 tick 内 CDU 不得读到出发地数据）
  if (state.nav.guidance) {
    state.nav.guidance.distKm = TRANSITION_DIST_M / 1000;
    state.nav.guidance.brgCompass = dest.runwayHeading; // 摆位后直对入口：直飞方位 ≈ 跑道罗盘航向
    state.nav.guidance.destId = config.to;
    state.nav.guidance.destName = dest.name;
    state.nav.guidance.phase = phase;
  }
  hud.toast(`进入 ${dest.name} 进近空域 · ${dest.ils ? `ILS ${dest.ils.ident}` : '目视 PAPI'} · 距入口 25 km`);
  marker('transition', { to: dest.id });
}

/* =========================================================
 * 结算
 * ========================================================= */
function checkScore(dt) {
  if (!flightActive || ended || !state.touchdown.recorded) return;
  if (touchdownZM === null) touchdownZM = state.position.z; // 接地瞬间捕获（白话"偏左/偏右"用）
  if (scoreDelayS === null) scoreDelayS = 0;
  scoreDelayS += dt;
  const crashNow = state.touchdown.vsFpm > 1200; // 坠毁即结算
  if (crashNow || scoreDelayS >= 3) finishFlight();
}

function finishFlight() {
  ended = true;
  phase = 'ended'; // 相位序列终点（e2e 断言 rollout → ended）
  phaseCand = null;
  const result = scoreLanding(state, { scenarioName: lastScenarioName });
  lastResult = result;
  const from = config ? AIRPORTS[config.from] : null;
  const to = config ? AIRPORTS[config.to] : null;
  scoreboard.show(result, {
    history: engine.history(),
    routeZh: from && to ? `${from.name} → ${to.name}` : '',
    scenarioName: lastScenarioName,
    novice: noviceMode,
    centerlineZM: touchdownZM, // 接地时刻带符号 z：+右 / -左（白话方位用）
    onMenu: backToMenu,
    onRetry: () => config && startFlight(config), // 同配置同 seed = 同剧本
  });
  marker('score', { outcome: result.outcome, score: result.score, survived: result.survived });
}

/* =========================================================
 * 剧本 UI 同步
 * ========================================================= */
function syncScenarioUI(status) {
  const snap = engine.active();
  if (snap && !briefShown) {
    briefShown = true;
    lastScenarioName = snap.name;
    marker('briefing', { id: snap.id, name: snap.name }); // 先广播（E2E 监听里会展开提示卡）
    hud.showBriefing(snap);
    hud.setActions(snap, config?.practice && hud.actionsVisible);
  } else if (!snap && briefShown) {
    briefShown = false;
    hud.showBriefing(null);
    hud.setActions(null, false);
  }
  if (status === 'resolved') marker('resolved', { scenario: lastScenarioName });
  if (status === 'failed') marker('scenario-failed', { scenario: lastScenarioName });
}

/* =========================================================
 * 相机
 * ========================================================= */
/**
 * 导航引导卡 · 阶段建议文案（uxBC2 任务 2④）。
 * 巡航高度简化为固定 3000 m（E2E/AP 可飞更高，建议文案按任务书口径不变）；
 * 短五边/着陆（landing 阶段）不产文案——交给现有上下文提示条，避免重复指挥。
 * 航向一律罗盘值：局部角 + runway.headingDeg（见 docs/kernel-api.md 航向约定）。
 */
function navAdvice(distKm, hdgC) {
  if (!flightActive || ended) return '';
  // 文案与相位机严格一一对应：cruise 段绝不可能出现起飞/进近建议（phase 单调推进保证）
  if (phase === 'takeoff') return '滑跑加速，VR 抬轮后建立正爬升';
  if (phase === 'climb') return '爬升到巡航高度 3000 m 后平飞';
  if (phase === 'cruise') {
    if (distKm != null && distKm <= 35) return '准备下降：建议以 -1500 ft/min 下降';
    return `保持航向 ${hdgC.toFixed(0)}°，距目的地 ${distKm == null ? '——' : distKm.toFixed(0)} km`;
  }
  if (phase === 'descent') return '下降至 900 m 保持速度 250 kt';
  if (phase === 'approach') {
    const rwyC = wrap360((state.nav.courseDeg ?? 0) + state.runway.headingDeg); // courseDeg 局部 → 罗盘
    const vRef = Math.round(getVref(state.massKg) + 5);
    return `对准跑道航向 ${rwyC.toFixed(0)}°，目标速度 ${vRef} kt（Vref+5），放轮襟翼按提示条`;
  }
  return ''; // landing / rollout：交给提示条
}

/* =========================================================
 * 相机
 * ========================================================= */
const _v1 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _v2 = new THREE.Vector3();
function updateCamera(dtReal) {
  applyCameraPrefs(); // 防御性对接 cockpit.cameraPrefs（交付前为 no-op）
  aircraft.position.set(state.position.x, state.position.y, state.position.z);
  aircraft.rotation.set(
    state.orientation.pitch * D2R,
    -(state.orientation.heading + 90) * D2R,
    -state.orientation.bank * D2R,
  );

  if (!flightActive) {
    // 主菜单预览：绕机场慢速环绕
    previewAngle += dtReal * 0.05;
    camera.position.set(Math.cos(previewAngle) * 1500, 280, Math.sin(previewAngle) * 1500);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    return;
  }
  shell.visible = externalView;
  cockpit.group.visible = !externalView;
  // uxBC2 任务 1：外部视角仪表叠加（视角切换点复用此处；结束/回座舱自动隐藏）
  extHud.setVisible(flightActive && externalView && !ended);
  if (flightActive && externalView) extHud.update(state); // 内部 10 Hz 限频
  if (externalView) {
    // 外部相机偏移在世界系计算、只随航向旋转（不随俯仰/坡度）：
    // 旧实现用 aircraft.localToWorld，抬轮 12° 俯仰会把 (0,12,62) 的垂直分量
    // 转成负值，相机被压到跑道面以下——跑道变成"立在飞机上方的墙"（用户实拍）。
    _q.setFromAxisAngle(_up, -(state.orientation.heading + 90) * D2R);
    _v1.set(0, 14, 62).applyQuaternion(_q).add(aircraft.position);
    // 防穿地保底：外部相机不允许低于离地 0.6 m
    if (_v1.y < 0.6) _v1.y = 0.6;
    camera.position.copy(_v1);
    _v2.copy(aircraft.position); _v2.y += 3;
    camera.up.set(0, 1, 0);
    camera.lookAt(_v2);
  } else {
    cockpit.cameraAnchor.updateWorldMatrix(true, false);
    camera.position.setFromMatrixPosition(cockpit.cameraAnchor.matrixWorld);
    camera.quaternion.setFromRotationMatrix(cockpit.cameraAnchor.matrixWorld);
  }
}

/* =========================================================
 * 主循环
 * ========================================================= */
let last = performance.now();
let hudAcc = 0;

function tick(dtSim, dtReal) {
  if (!suppressKeyboard) keyboard.update(dtReal, state);

  // ① 世界（写 state.weather / state.nav / state.terrain）
  world.update(Math.min(dtSim, 0.5), camera);


  // ② 相位机（滞回+单调）→ 剧本引擎
  updatePhase();
  engine.armForPhase(phase);
  if (config?.mode === 'scenario' && config.scenarioId && !forcedFired && phase === config.triggerPhase) {
    forcedFired = true;
    engine.forced(config.scenarioId);
  }
  const st = engine.update(dtSim);
  syncScenarioUI(st);

  // ③ 内核（唯一事实源演化）
  stepSimulation(state, Math.min(dtSim, 0.5), bus);

  // ③' 平滑油流（续航估算用）：EMA 时间常数约 90s，油门瞬变时数字不跳
  {
    const ff = (state.engines[0].running ? state.engines[0].fuelFlowKgs : 0) +
      (state.engines[1].running ? state.engines[1].fuelFlowKgs : 0);
    fuelFlowAvg += (ff - fuelFlowAvg) * Math.min(1, dtSim / 90);
  }

  // ④ 航线推进 / 目的地过渡
  updateRoute(dtSim);

  // ⑤ 驾驶舱（真实帧间隔做动画平滑）与音景
  cockpit.update(dtReal);
  audio.update(dtReal);
  // ⑤' 外部模型动画（起落架收放读 state.gear.position；只改 transform，零分配）
  em.update(state, dtSim);

  // ⑥ 阶段提示（去抖）
  if (phase !== lastPhaseToast.phase && state.time - lastPhaseToast.t > 8) {
    lastPhaseToast = { phase, t: state.time };
    hud.toast(`进入${PHASE_ZH_ALL[phase] ?? phase}阶段`, 2000);
  }

  // ⑦ 结算检测
  checkScore(dtSim);

  // ⑧ HUD ~6 Hz（双层状态 + 上下文提示条 + 引导首飞呼吸提示）
  hudAcc += dtReal;
  if (hudAcc >= 0.16) {
    hudAcc = 0;
    hud.setStatus({
      phaseZh: PHASE_ZH_ALL[phase] ?? '——',
      distKm: transitioned ? state.nav.distM / 1000 : Math.max(0, routeDistM - flownM) / 1000,
      fuelKg: state.fuel.left + state.fuel.right + state.fuel.center,
      fuelFlowKgs: fuelFlowAvg, // 平滑值：同一油量不会因油门瞬变给出两个自相矛盾的续航
      timeS: state.time,
      iasKt: state.velocity.ias,
      altFt: state.position.y * M2FT,
      hdgDeg: wrap360(state.orientation.heading + state.runway.headingDeg), // 罗盘显示
      viewZh: externalView ? '外部' : '座舱',
      speed: simSpeed,
    });
    hud.setWarnings(state.warnings.active, state.warnings.masterWarning, state.warnings.masterCaution);
    // 上下文提示条：引导首飞呼吸提示（优先） > 阶段提示
    const gHint = guidedHint();
    hud.setGuideHint(gHint);
    hud.setPhaseHint(gHint ? null : contextHintKey());
    // uxBC2 任务 2：导航引导卡数据（航线 + 距离/直飞航向 + 阶段建议 + 险情让位标记）
    {
      const fromA = AIRPORTS[config.from];
      const toA = AIRPORTS[config.to];
      let distKm;
      let brgDeg;
      if (transitioned) {
        distKm = state.nav.distM / 1000;
        // nav.bearingDeg 是局部角（0°=跑道轴）→ 罗盘值（唯一换算点，勿二次换算）
        brgDeg = state.nav.bearingDeg != null
          ? wrap360(state.nav.bearingDeg + state.runway.headingDeg)
          : null;
      } else {
        // 目的地过渡前无目的地几何：待飞距离 = 航线余程，直飞航向 ≈ 航线方向（出发跑道罗盘航向，诚实简化）
        distKm = Math.max(0, routeDistM - flownM) / 1000;
        brgDeg = wrap360(state.runway.headingDeg);
      }
      const hdgC = wrap360(state.orientation.heading + state.runway.headingDeg); // 罗盘显示
      const advice = navAdvice(distKm, hdgC);
      hud.setNav({
        route: `${fromA.name} ${fromA.id} → ${toA.name} ${toA.id}`,
        distKm,
        brgDeg,
        hdgDeg: hdgC,
        alert: !!engine.active(),
        advice,
      });
      // 导航数据契约（state.nav.guidance，CDU 只读此块——见 docs/kernel-api.md）。
      // 本块在 world.update 之后执行：distKm/brgCompass 已按"过渡前=航线余程"重算，
      // 覆盖渡期 world.updateNav 写的出发地 nav.distM/bearingDeg。world 不认识 guidance 字段不会动它。
      state.nav.guidance = {
        destId: config.to,
        destName: toA.name,
        phase,
        adviceZh: advice,
        distKm,
        brgCompass: brgDeg,
      };
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min((now - last) / 1000, 0.25);
  last = now;
  const running = flightActive && !paused && !ended;
  if (world && !renderOnly && (running || !flightActive)) {
    if (running) tick(dtReal * simSpeed, dtReal);
    else world.update(Math.min(dtReal * 0.3, 0.1), camera); // 菜单预览：世界慢速呼吸
  }
  updateCamera(dtReal);
  for (const cb of frameCallbacks) cb(dtReal, dtReal * simSpeed);
  renderer.render(scene, camera);
}

const frameCallbacks = new Set();
const stepCallbacks = new Set();
let renderOnly = false; // E2E：仿真由 advance() 定时驱动，rAF 只渲染

/**
 * 推进一个仿真步（E2E 定时驱动用；渲染仍由 rAF 完成）。
 * @param {number} dtSim  仿真步长 s（内部按 1/120 子步切分）
 * @param {number} [dtReal] 动画用"真实"步长（座舱 Canvas 刷新限频基准）
 */
function advance(dtSim, dtReal = 0.02) {
  if (!flightActive || !world || paused || ended) return;
  tick(dtSim, dtReal);
  for (const cb of stepCallbacks) cb(dtSim, dtReal);
}

/* =========================================================
 * 全局键位（P/ESC 暂停、M 静音、H 提示、C 视角）
 * ========================================================= */
window.addEventListener('keydown', (e) => {
  unlockAudio();
  const k = e.key.toLowerCase();
  if (k === 'p' || e.key === 'Escape') {
    if (flightActive && !ended) setPaused(!paused);
  } else if (k === 'm') {
    toggleMute();
  } else if (k === 'h') {
    if (!flightActive || ended) return;
    if (config?.practice) hud.toggleActions();
    else hud.toast('严格模式：处置提示不可用', 1800);
  } else if (k === 'c') {
    if (!flightActive || ended) return;
    externalView = !externalView;
    hud.toast(externalView ? '外部追机视角（C 切回座舱）' : '机长座舱视角', 1500);
  } else if (k === 'k') {
    hud.toggleGuide(); // K 指南：菜单页/飞行中均可呼出
  } else if (k === 'n') {
    if (!flightActive || ended) return;
    noviceMode = !noviceMode;
    hud.setNovice(noviceMode);
    hud.toast(noviceMode ? '新手模式：数据白话化（N 切回行话）' : '行话模式：IAS/ALT/HDG 原样（N 切回新手）', 1600);
  } else if (k === 'j') {
    // uxBC2 任务 2：导航引导卡显隐（默认显示；菜单页切换在开局生效）
    navVisible = !navVisible;
    hud.setNavVisible(navVisible);
    hud.toast(navVisible ? '导航引导卡：显示（J 隐藏）' : '导航引导卡：隐藏（J 显示）', 1400);
  } else if (e.key === 'Shift') {
    // 防御性对接：按住 Shift 下视看仪表（cockpit Agent 导出 setLookPitch 后自动生效）
    if (flightActive && !ended && !paused && !externalView) {
      if (typeof cockpit.setLookPitch === 'function') cockpit.setLookPitch();
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift' && typeof cockpit.resetLookPitch === 'function') {
    cockpit.resetLookPitch(); // 松开平滑回平视
  }
});

/* =========================================================
 * 启动：菜单预览世界 + 菜单
 * ========================================================= */
world = createWorld(scene, state, 'ZSPD', { hour: 10 });
aircraft.visible = false;
menu.show();
setLightingMode('day'); // 防御性对接：菜单预览白天光照
marker('menu');

/* ---------- dev 截图钩子（不影响正常玩法）：?ui=guide|guided|guideqr ---------- */
{
  const uiDemo = UI_PARAMS.get('ui');
  if (uiDemo === 'guide' || uiDemo === 'guideqr') {
    hud.toggleGuide(true);
    if (uiDemo === 'guideqr') {
      requestAnimationFrame(() => {
        const el = document.querySelector('.sim-guide');
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  } else if (uiDemo === 'guided') {
    // 引导首飞呼吸提示一帧：菜单页直接点亮提示条
    hud.setNovice(true);
    hud.setGuideHint('按 PgUp 推满油门（起飞推力 TOGA）');
  }
}

/* =========================================================
 * E2E / 调试 API
 * ========================================================= */
window.__sim5 = {
  get state() { return state; },
  bus,
  get engine() { return engine; },
  get world() { return world; },
  get phase() { return phase; },
  get config() { return config; },
  get flightActive() { return flightActive; },
  get ended() { return ended; },
  get paused() { return paused; },
  get lastResult() { return lastResult; },
  get routeRemainingM() { return Math.max(0, routeDistM - flownM); },
  get transitioned() { return transitioned; },
  cmdLog,
  api: {
    startFlight,
    backToMenu,
    setPaused,
    marker,
    onFrame: (cb) => { frameCallbacks.add(cb); return () => frameCallbacks.delete(cb); },
    onStep: (cb) => { stepCallbacks.add(cb); return () => stepCallbacks.delete(cb); },
    advance: (dtSim, dtReal) => advance(dtSim, dtReal),
    setRenderOnly: (v) => { renderOnly = !!v; },
    setSimSpeed: (v) => { simSpeed = v; },
    setSuppressKeyboard: (v) => { suppressKeyboard = v; },
    toggleExternal: () => { externalView = !externalView; },
    toggleNav: () => { navVisible = !navVisible; hud.setNavVisible(navVisible); },
    toggleActions: () => hud.toggleActions(),
    toast: (m) => hud.toast(m),
  },
};
window.__e2eSnapshot = window.__e2eSnapshot ?? ((name) => console.log(`[e2e] snapshot ${name}`));

/* ---------- 错误显示（无头截图可确认无 console error） ---------- */
window.onerror = (msg, src, line) => {
  console.error(`ERROR: ${msg} @${(src || '').split('/').pop()}:${line}`);
  const box = document.getElementById('sim-errbox') ?? (() => {
    const b = document.createElement('div');
    b.id = 'sim-errbox';
    b.style.cssText = 'position:fixed;bottom:4px;left:4px;color:#f66;font:11px monospace;max-width:98%;z-index:99;white-space:pre-wrap;';
    document.body.appendChild(b);
    return b;
  })();
  box.textContent += `ERROR: ${msg} @${(src || '').split('/').pop()}:${line}\n`;
};

requestAnimationFrame(frame);
