/**
 * cockpit-main.js — 单元 1 dev 演示页。
 *
 * 场景 + 内核 state/bus + createCockpit，机长视角相机；
 * 自动剧本（bus 命令序列）：松刹车→襟翼→推油门→抬轮→收起落架→
 * 接通 AP 爬升→收襟翼→转弯→巡航→循环。
 * 页面左侧小字实时显示剧本步骤与遥测；window.onerror 写入 DOM；
 * T+2 s 自动点击自检（向 MCP/顶板/中央台发合成指针事件，命令日志进 DOM+控制台）。
 *
 * URL 参数 view=fit|pfd|eicas|ohd|ped|debug 选择评审机位；无参数=机长眼位。
 *
 * 主循环说明：仿真用 setInterval(8ms) 驱动——headless 虚拟时间下 rAF 不触发，
 * 定时器才会随虚拟时间快进；渲染节流 ~90ms，浏览器中同样正常工作。
 */

import * as THREE from 'three';
import {
  createSimState, createCommandBus, stepSimulation,
} from '../src/kernel/index.js';
import { createCockpit, cameraPrefs } from '../src/cockpit/index.js';

/* ---------- 错误显示 ---------- */
const errBox = document.getElementById('errors');
window.onerror = (msg, src, line, col) => {
  errBox.textContent += `ERROR: ${msg} @${(src || '').split('/').pop()}:${line}:${col}\n`;
};
window.addEventListener('unhandledrejection', (e) => {
  errBox.textContent += `REJECTION: ${e.reason}\n`;
});

/* ---------- overlay（默认折叠为小标签，点击/H 键展开；不压第一帧构图） ---------- */
const overlay = document.getElementById('overlay');
let stepLines = [];
let clickResults = '';
let overlayExpanded = false;
overlay.addEventListener('click', () => {
  overlayExpanded = !overlayExpanded;
  renderOverlay();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') {
    overlayExpanded = !overlayExpanded;
    renderOverlay();
  }
});
function renderOverlay(extra) {
  if (!overlayExpanded) {
    overlay.classList.add('mini');
    const step = stepLines.find((l) => l.startsWith('循环')) || '';
    const act = stepLines.find((l) => !l.startsWith('循环')) || '';
    overlay.innerHTML =
      '<b>737 驾驶舱演示</b> ' + (step ? step + ' · ' : '') + act +
      (extra ? ' · ' + extra.replace(/\n/g, ' ') : '') + '（点击/H 展开）';
    return;
  }
  overlay.classList.remove('mini');
  overlay.innerHTML =
    '<b>单元 1 · 驾驶舱演示</b>（机长视角 · 照明 ' + lightMode + '）\n' +
    stepLines.join('\n') +
    (clickResults ? '\n' + clickResults + '\n' : '') +
    (extra ? '\n' + extra : '') +
    '\n（点击或按 H 折叠 · 按住 Q 下视看仪表）';
}

/* ---------- 内核 ---------- */
const state = createSimState({ fuelKg: 8000, payloadKg: 14000 });
const bus = createCommandBus(state);
const FIXED_DT = 1 / 120;

/* ---------- renderer / scene ---------- */
const renderer = new THREE.WebGLRenderer({
  antialias: false,            // headless SwiftShader 下 MSAA+频繁纹理上传会出棋盘伪影
  preserveDrawingBuffer: true, // headless 截图需要保留帧缓冲
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  errBox.textContent += 'WEBGL CONTEXT LOST\n';
  e.preventDefault();
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db8cc);
scene.fog = new THREE.Fog(0x9db8cc, 300, 4200);

/* 简单外景：地面 + 跑道（验证窗景参考，非单元 4 产物）。
 * 跑道绕 y 转 90°：dev 页 cockpit.group 无外层飞机旋转，相机朝 -z 看，
 * 旋转后跑道沿 -z 从机头向前延伸（正对跑道中线）。 */
{
  const scenery = new THREE.Group();
  scenery.rotation.y = Math.PI / 2;
  scene.add(scenery);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshStandardMaterial({ color: 0x4e5d43, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.4;
  scenery.add(ground);
  const runway = new THREE.Mesh(
    new THREE.PlaneGeometry(3600, 45),
    new THREE.MeshStandardMaterial({ color: 0x3c3f42, roughness: 0.95 }),
  );
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(1800, -1.38, 0);
  scenery.add(runway);
  for (let x = 60; x < 3500; x += 60) {
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 0.9),
      new THREE.MeshBasicMaterial({ color: 0xd8d8d0 }),
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(x, -1.37, 0);
    scenery.add(stripe);
  }
}

/* 光照：世界级光照贴近主游戏量级（座舱明暗由 cockpit.group 内部光源负责，setLightingMode） */
const worldLights = {
  hemi: new THREE.HemisphereLight(0xcfd8e0, 0x44463f, 0.6),
  amb: new THREE.AmbientLight(0xffffff, 0.18),
  sun: new THREE.DirectionalLight(0xfff2dd, 1.2),
};
worldLights.hemi.position.set(0, 60, 0);
worldLights.sun.position.set(-60, 120, 40);
scene.add(worldLights.hemi, worldLights.amb, worldLights.sun);

/* ?light=day|dusk|night：演示座舱照明三态（主游戏中由整合层按世界光照调用） */
const params = new URLSearchParams(location.search);
const lightParam = (params.get('light') || 'day').toLowerCase();

/* ---------- 相机与驾驶舱（fov/near 读 cockpit.cameraPrefs 合同） ---------- */
const camera = new THREE.PerspectiveCamera(
  cameraPrefs.fov, window.innerWidth / window.innerHeight, cameraPrefs.near, cameraPrefs.far,
);
scene.add(camera);

const cockpit = createCockpit(scene, state, bus, {
  domElement: renderer.domElement,
  camera,
});
scene.add(cockpit.group);
cockpit.setLightingMode(lightParam);

/* 夜间/黄昏世界调暗（仅 dev 演示用；主游戏中世界光照由 world 单元负责） */
function applyWorldLighting(mode) {
  const night = mode === 'night' ? 1 : mode === 'dusk' ? 0.55 : 0;
  worldLights.hemi.intensity = 0.6 * (1 - night * 0.92);
  worldLights.amb.intensity = 0.18 * (1 - night * 0.8);
  worldLights.sun.intensity = 1.2 * (1 - night * 0.95);
  const top = new THREE.Color(0x9db8cc).lerp(new THREE.Color(0x050810), night);
  scene.background = top;
  scene.fog.color.copy(top);
}
applyWorldLighting(lightParam);

const fitView = params.get('view') || '';

/* 按住 Q 临时下视看仪表、松开回平视（整合层键位挂接的演示） */
window.addEventListener('keydown', (e) => {
  if (e.key === 'q' || e.key === 'Q') cockpit.setLookPitch();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'q' || e.key === 'Q') cockpit.resetLookPitch();
});
if (fitView === 'scan') cockpit.setLookPitch(); // 评审机位：固定下视

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

/* =========================================================
 * 自动演示剧本（条件/定时混合，循环）
 * ========================================================= */
let scriptIndex = 0;
let cycle = 1;
const steps = [
  { label: '① brakes/park — 松停留刹车', fire: () => bus.send('brakes/park') },
  { label: '② flaps/set 3 — 起飞襟翼 5', fire: () => bus.send('flaps/set', 3) },
  { label: '③ throttle/set 0.95 — 起飞推力 N1↑', fire: () => bus.send('throttle/set', 0.95) },
  { label: '④ 等待 VR≈140kt …', cond: (s) => s.velocity.ias >= 139 },
  { label: '⑤ control/elevator 0.5 — 抬轮 ROTATE', fire: () => bus.send('control/elevator', 0.5) },
  { label: '⑥ control/elevator 0 — 杆回中（已离地）', fire: () => bus.send('control/elevator', 0), cond: (s) => s.agl * 3.28084 > 40 },
  { label: '⑦ gear/up — 收起落架（正爬升率）', fire: () => bus.send('gear/up'), cond: (s) => s.agl * 3.28084 > 120 },
  { label: '⑧ throttle/set 0.88 + ap/cmd + ap/alt 8000 — 爬升', fire: () => {
      bus.send('throttle/set', 0.88);
      bus.send('ap/cmd');
      bus.send('ap/alt', 8000);
    }, cond: (s) => s.agl * 3.28084 > 350 },
  { label: '⑨ ap/hdg 030 — 右转', fire: () => bus.send('ap/hdg', 30), cond: (s) => s.agl * 3.28084 > 1200 },
  { label: '⑩ flaps/up — 收襟翼', fire: () => bus.send('flaps/up'), cond: (s) => s.agl * 3.28084 > 1800 },
  { label: '⑪ ap/hdg 090 — 继续转弯', fire: () => bus.send('ap/hdg', 90), cond: (s) => s.agl * 3.28084 > 2600 },
  { label: '⑫ throttle/set 0.55 — 巡航减推', fire: () => bus.send('throttle/set', 0.55), cond: (s) => s.agl * 3.28084 > 3800 },
  { label: '⑬ ap/alt 6000 + ap/vs -1200 — 下降衔接循环', fire: () => {
      bus.send('ap/alt', 6000);
      bus.send('ap/vs', -1200);
    }, cond: (s) => s.agl * 3.28084 > 4600 },
];
let stepTimer = 0;
let condHold = 0;

function runScript(dt) {
  stepTimer += dt;
  const st = steps[scriptIndex];
  if (!st) return;
  const wait = st.delay ?? (st.fire ? 5 : 0.5);
  // 条件步：条件满足且至少等待 wait 后推进；无条件步等待 wait 秒推进
  if (st.cond) {
    if (st.cond(state)) {
      condHold += dt;
      if (condHold >= wait) advance();
    } else {
      condHold = 0;
    }
  } else if (stepTimer >= wait) {
    advance();
  }
  function advance() {
    if (st.fire) {
      st.fire();
      console.log(`[script] T+${state.time.toFixed(0)}s ${st.label}`);
    }
    stepLines = [`循环 ${cycle} · 步骤 ${scriptIndex + 1}/${steps.length}`, st.label];
    renderOverlay();
    scriptIndex += 1;
    stepTimer = 0;
    condHold = 0;
    if (scriptIndex >= steps.length) {
      scriptIndex = 0;
      cycle += 1;
    }
  }
}

/* =========================================================
 * 点击自检（T+2s）：合成指针事件命中 MCP/顶板/中央台/告警灯
 * ========================================================= */
function clickTest() {
  const dom = renderer.domElement;
  const results = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };

  // 直接按目标画布像素(localX,localY)换算世界点，避免射线扫过近处面板误命中
  const tryClick = (mesh, label, localX, localY) => {
    if (!mesh) return;
    const pick = mesh.userData.pick;
    const lx = localX !== undefined ? ((localX / pick.disp.w) - 0.5) * pick.w : 0;
    const ly = localY !== undefined ? (0.5 - localY / pick.disp.h) * pick.h : 0;
    const wp = mesh.localToWorld(new THREE.Vector3(lx, ly, 0.01));
    const p = wp.clone().project(camera);
    if (p.z > 1) return;
    const cx = (p.x * 0.5 + 0.5) * dom.clientWidth;
    const cy = (-p.y * 0.5 + 0.5) * dom.clientHeight;
    const before = logs.join('\n').length;
    dom.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: cx, clientY: cy, bubbles: true,
    }));
    const out = logs.join('\n').slice(before.length).trim()
      .split('\n').filter((l) => l.includes('[cockpit]')).pop() || '（未命中）';
    results.push(`${label}: ${out}`);
  };

  const byTable = {};
  for (const m of cockpit.clickables) byTable[m.userData.pick.nameTable] = m;
  tryClick(byTable.mcp, '点击MCP-ALT窗', 555, 80);
  tryClick(byTable.overhead, '点击顶板-APU', 630, 130);
  tryClick(byTable.pedestal, '点击中央台-配平轮', 260, 690);
  tryClick(byTable.annunc, '点击告警灯', 192, 96);
  console.log = origLog;
  clickResults = '点击自检:\n' + results.join('\n');
  renderOverlay();
  console.log('[cockpit] 点击自检结果:\n' + results.join('\n'));
}

/* =========================================================
 * 主循环：setInterval 推进仿真 + 节流渲染
 * headless 截图路径：?ff=秒 在首帧渲染前同步快进仿真
 *（避免数千次纹理上传触发 headless SwiftShader 的棋盘伪影）
 * ========================================================= */
const ffSeconds = parseFloat(new URLSearchParams(location.search).get('ff') || '0') || 0;
let ffMode = ffSeconds > 0;
let last = -1;
let acc = 0;
let frameCount = 0;
let clickTestDone = false;
let lastRenderAt = -1;

if (ffMode) {
  const steps30 = Math.round(ffSeconds * 60);
  for (let i = 0; i < steps30; i++) {
    stepSimulation(state, 1 / 60, bus);
    runScript(1 / 60);
    cockpit.update(1 / 60);
  }
  last = performance.now();
  acc = 0;
  ffMode = false;
  clickTestDone = false; // 快进后重新择机自检
  console.log(`[script] 快进 ${ffSeconds}s → T+${state.time.toFixed(0)}s ias ${state.velocity.ias.toFixed(0)}kt alt ${(state.position.y * 3.28084).toFixed(0)}ft`);
}

function advance(now) {
  if (last < 0) last = now - 1 / 125;
  const dtReal = Math.min(Math.max((now - last) / 1000, 0), 0.25);
  last = now;

  acc = Math.min(acc + dtReal, 0.25);
  while (acc >= FIXED_DT) {
    stepSimulation(state, FIXED_DT, bus);
    acc -= FIXED_DT;
  }
  frameCount += 1;
  runScript(dtReal);
  try {
    cockpit.update(dtReal);
  } catch (e) {
    errBox.textContent += `UPDATE ERROR: ${e}\n`;
  }

  if (!clickTestDone && state.time > ffSeconds + 2) {
    clickTestDone = true;
    try { clickTest(); } catch (e) { errBox.textContent += `CLICKTEST ERROR: ${e}\n`; }
  }

  if (frameCount % 25 === 0) {
    renderOverlay(`T+${state.time.toFixed(1)}s · ias ${state.velocity.ias.toFixed(0)}kt · alt ${(state.position.y * 3.28084).toFixed(0)}ft · 帧 ${frameCount} · raf ${rafCount}`
      + (state.warnings.active.length ? '\n警告: ' + state.warnings.active.join(', ') : ''));
  }
}

function renderNow() {
  cockpit.cameraAnchor.updateWorldMatrix(true, false);
  if (fitView === 'pfd') {
    camera.position.set(-0.42, 1.14, -0.28);
    camera.lookAt(-0.455, 1.01, -0.66);
  } else if (fitView === 'eicas') {
    camera.position.set(0.02, 1.18, -0.24);
    camera.lookAt(0.02, 1.00, -0.66);
  } else if (fitView === 'ohd') {
    camera.position.set(0, 1.52, 0.08);
    camera.lookAt(0, 2.0, -0.55);
  } else if (fitView === 'ped') {
    camera.position.set(0, 1.32, 0.22);
    camera.lookAt(0, 0.52, -0.40);
  } else if (fitView === 'fit') {
    camera.position.set(0.02, 1.30, 0.64);
    camera.lookAt(0, 0.95, -0.9);
  } else {
    camera.position.setFromMatrixPosition(cockpit.cameraAnchor.matrixWorld);
    camera.quaternion.setFromRotationMatrix(cockpit.cameraAnchor.matrixWorld);
  }
  renderer.render(scene, camera);
}

setInterval(() => advance(performance.now()), 16);

/* headless 虚拟时间下 rAF 稀少但承担“呈现”；每次触发都重画当前世界状态 */
let rafCount = 0;
(function loop() {
  rafCount += 1;
  renderNow();
  requestAnimationFrame(loop);
})();

/* view=debug：把原始 canvas 平铺到页面上，独立于 three.js 检查仪表绘制 */
if (fitView === 'debug') {
  const d = cockpit.displays;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;inset:0;z-index:99;background:#111;overflow:auto;padding:8px;';
  document.body.appendChild(holder);
  const row = (label, disp) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:6px;vertical-align:top;color:#9f9;font:11px monospace;';
    const t = document.createElement('div');
    t.textContent = label;
    disp.canvas.style.cssText = 'width:410px;image-rendering:pixelated;border:1px solid #444;background:#000;';
    wrap.appendChild(t);
    wrap.appendChild(disp.canvas);
    holder.appendChild(wrap);
  };
  row('PFD', d.pfd); row('ND', d.nd); row('UPPER EICAS', d.upper);
  row('LOWER EICAS', d.lower); row('MCP', d.mcp); row('OVERHEAD', d.overhead);
  row('PEDESTAL', d.pedestal); row('CDU', d.cdu); row('ANNUNCIATOR', d.annL);
  overlay.style.display = 'none';
}

/* 调试钩子 */
window.__cockpit = { state, bus, cockpit, steps };
