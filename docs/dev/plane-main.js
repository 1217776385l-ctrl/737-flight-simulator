/**
 * plane-main.js — 外部模型 dev 演示页主程序。
 *
 * 简化机场场景（跑道 + 地面 + 日光）+ 程序化 737-800 外部模型。
 * 六个展示模式自动循环（每 8 s 切换）：
 *  ① 侧前方全貌  ② 后四分之一  ③ 正面
 *  ④ 特写机头/发动机  ⑤ 起落架收放动画（mock state：收-放循环）  ⑥ 夜间涂装
 *
 * 截图模式（tools/shot.sh 用）：URL 参数
 *   ?pose=N   直接进入第 N 个模式（0 起）
 *   &freeze=1 固定镜头/时间不循环（确定性截图）
 *   &gt=X     强制 mock gear.position = X（0..1，pose 4 拍半收状态用）
 *
 * 演示页为运动学 mock：自建 {gear, engines, flaps} 最小 state 喂给 em.update。
 */

import * as THREE from 'three';
import { buildExternalAircraft } from '../src/aircraft/external-model.js';

const qs = new URLSearchParams(location.search);
const freeze = qs.get('freeze') === '1';
const forceGear = qs.get('gt') != null ? parseFloat(qs.get('gt')) : null;
const startPose = qs.get('pose') != null ? parseInt(qs.get('pose'), 10) : 0;
// 展示停机位横向偏移（默认 6m：离开中线标线带，规避"机腹下白色细杆"穿帮；
// URL ?ox= 可覆盖，0=回到跑道中线）
const OFF_X = qs.get('ox') != null ? parseFloat(qs.get('ox')) : 6;

const MODE_LEN = 8; // 每模式秒数（freeze=1 时不推进）

/* =========================================================
 * 渲染基础
 * ========================================================= */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);

/* =========================================================
 * 简化机场：地面 + 跑道 + 中线 + 日光
 * ========================================================= */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3000, 3000),
  new THREE.MeshStandardMaterial({ color: 0x647a4e, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const rwyMat = new THREE.MeshStandardMaterial({ color: 0x3c4045, roughness: 0.95 });
const rwy = new THREE.Mesh(new THREE.BoxGeometry(45, 0.1, 2600), rwyMat);
rwy.position.y = 0.05;
rwy.receiveShadow = true;
scene.add(rwy);
// 中线标线：磨损白（宽 1.2m、长 20m、间距 60m）——避免亮白细条在掠射角下
// 被误读为"机腹下悬空细杆"（v1 穿帮根因，评审 2024-11）
const lineMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 1 });
for (let i = -20; i <= 20; i++) {
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 20), lineMat);
  dash.position.set(0, 0.1, i * 60 + 30); // 相位偏移：展示停机位前后 ±20m 内无标线端点
  scene.add(dash);
}
// 简单航站楼剪影（背景层次）
const term = new THREE.Mesh(
  new THREE.BoxGeometry(120, 18, 60),
  new THREE.MeshStandardMaterial({ color: 0x8d949b, roughness: 0.9 }),
);
term.position.set(-160, 9, -80);
scene.add(term);

const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
sun.position.set(60, 90, -40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbfd4e8, 0x5a6a4a, 0.9);
scene.add(hemi);

/* =========================================================
 * 飞机：外部模型 + mock state
 * ========================================================= */
const em = buildExternalAircraft();
em.group.position.x = OFF_X;
scene.add(em.group);

// 最小 mock state（只含 update 消费的字段；与 kernel/state.js 同形）
const mockState = {
  gear: { position: 1, handleDown: true },
  engines: [{ n1: 0.2 }, { n1: 0.2 }],
  flaps: { angle: 0 },
};

/* =========================================================
 * 六个展示模式
 * ========================================================= */
const POSES = [
  {
    title: '① 侧前方全貌',
    cam: [30, 8, -34], look: [0, 2.5, 2], fov: 40,
    night: false,
  },
  {
    title: '② 后四分之一（垂尾涂装 + 尾锥上翘）',
    cam: [-22, 10, 38], look: [0, 4, 8], fov: 42,
    night: false,
  },
  {
    title: '③ 正面（翼梢小翼 + 发动机布局）',
    cam: [0, 3.6, -42], look: [0, 3.2, 0], fov: 44,
    night: false,
  },
  {
    title: '④ 特写机头/发动机',
    cam: [8.5, 1.4, -16], look: [0, 1.6, -13.5], fov: 38,
    night: false,
  },
  {
    title: '⑤ 起落架收放动画（mock state.gear.position 收-放循环）',
    cam: [26, 3.2, -6], look: [0, 1.5, -2], fov: 40,
    night: false,
    gearCycle: true,
  },
  {
    title: '⑥ 夜间涂装',
    cam: [-16, 6, -30], look: [0, 3, -2], fov: 40,
    night: true,
  },
];

let pose = startPose % POSES.length;
let poseT = 0;

function applyPose(idx) {
  const p = POSES[idx];
  camera.position.set(p.cam[0] + OFF_X, p.cam[1], p.cam[2]);
  camera.fov = p.fov;
  camera.updateProjectionMatrix();
  camera.lookAt(p.look[0] + OFF_X, p.look[1], p.look[2]);
  if (p.night) {
    scene.background = new THREE.Color(0x0a1020);
    sun.intensity = 0.55;
    sun.color.set(0x9fb6d8);
    hemi.intensity = 0.45;
    hemi.color.set(0x41597a);
    hemi.groundColor.set(0x1a2129);
  } else {
    scene.background = new THREE.Color(0x9ec7e8);
    sun.intensity = 2.6;
    sun.color.set(0xfff2e0);
    hemi.intensity = 0.9;
    hemi.color.set(0xbfd4e8);
    hemi.groundColor.set(0x5a6a4a);
  }
}

applyPose(pose);

/* =========================================================
 * 主循环
 * ========================================================= */
const overlay = document.getElementById('overlay');
let last = performance.now();
let shownStats = -1;

function updateOverlay() {
  const info = renderer.info;
  overlay.textContent =
    `${POSES[pose].title}\n` +
    `三角形: ${info.render.triangles}  draw call: ${info.render.calls}\n` +
    `模式 ${pose + 1}/6 · gear=${mockState.gear.position.toFixed(2)} · ` +
    `${freeze ? 'freeze（截图模式）' : `t=${poseT.toFixed(1)}s`}`;
  shownStats = pose;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (!freeze) {
    poseT += dt;
    if (poseT >= MODE_LEN) {
      poseT = 0;
      pose = (pose + 1) % POSES.length;
      applyPose(pose);
    }
  }

  // mock 起落架收-放循环（pose ⑤）：8s 一轮（2s 停放 → 2s 收 → 2s 停 → 2s 放）
  if (forceGear != null) {
    mockState.gear.position = forceGear;
  } else if (POSES[pose].gearCycle && !freeze) {
    const t = poseT;
    if (t < 2) mockState.gear.position = 1;
    else if (t < 4) mockState.gear.position = 1 - (t - 2) / 2;
    else if (t < 6) mockState.gear.position = 0;
    else mockState.gear.position = (t - 6) / 2;
  } else {
    mockState.gear.position = 1;
  }
  mockState.engines[0].n1 = 0.2;

  em.update(mockState, dt);

  // 起落架特写镜头跟随（pose ⑤）
  if (POSES[pose].gearCycle) {
    camera.position.set(24 + OFF_X, 4.5, -14 + mockState.gear.position * 6);
    camera.lookAt(1.5 + OFF_X, 0.8, 0);
  }

  renderer.render(scene, camera);

  if (shownStats !== pose) updateOverlay();
}
requestAnimationFrame(frame);
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { pose = (pose + 1) % POSES.length; poseT = 0; applyPose(pose); }
  if (e.key === 'ArrowLeft') { pose = (pose + POSES.length - 1) % POSES.length; poseT = 0; applyPose(pose); }
});
window.__planeDev = { POSES, get pose() { return pose; } };
