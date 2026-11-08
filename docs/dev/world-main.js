/**
 * world-main.js — 单元 3（外部世界）dev 演示页主程序。
 *
 * 六个展示模式自动循环（每 8 s 切换，重建 world）：
 *  ① 枢纽清晨进近（3° 下滑道上，PAPI 两白两红）
 *  ② 高原峡谷白天巡航
 *  ③ 海岛侧风进近
 *  ④ 雾城 CAT-I ILS 决断高
 *  ⑤ 沙漠夜航跑道灯全景
 *  ⑥ 雷暴 + 雨巡航
 *
 * 说明：dev 页为**运动学演示**——直接按脚本给 state.position/orientation 赋值并同步
 * velocity 字段，不步进内核物理；createWorld 只消费位置/航向并写回 weather/nav/terrain。
 * 集成时由单元 6 用真实内核（stepSimulation）驱动同一 createWorld。
 */

import * as THREE from 'three';
import { createSimState, mulberry32 } from '../src/kernel/index.js';
import { createWorld } from '../src/world/index.js';
import { AIRPORTS, glideslopeHeightM, airportToWorld } from '../src/world/airports-data.js';
import { papiAngleTo, papiStates } from '../src/world/airport-scene.js';

const MODE_LEN = 8; // 每模式秒数

/* =========================================================
 * 模式定义（kinematic 路径：t ∈ [0, MODE_LEN) → 位置/姿态）
 * y 一律相对跑道面（与内核一致）；进近 y 取 PAPI 基准 3° 下滑道（含 330 m 偏置）
 * ========================================================= */
const gsH = (d) => glideslopeHeightM(d + 330, 3.0);

/** 机场本地坐标（lx 沿跑道、lz 横向）→ 仿真坐标赋给 state.position */
function setLocal(s, a, lx, lz, y) {
  const w = airportToWorld(a, lx, lz);
  s.position.x = w.x; s.position.z = w.z; s.position.y = y;
}

const MODES = [
  {
    id: 'hub-morning', airportId: 'ZSPD', hour: 6.6, storm: false,
    title: '① 枢纽清晨进近（浦东式 · ILS 短五边）',
    desc: '双跑道枢纽 · 五边 4.2 km 起 3° 下滑道 → PAPI 两白两红 · 林带/城区/廊桥',
    frame(t, s) {
      const a = AIRPORTS.ZSPD, d = 4200 - t * 380;
      setLocal(s, a, -d, 0, gsH(d));
      s.orientation.heading = 350; s.orientation.pitch = -2; s.orientation.bank = 0;
      s.velocity.ias = 145; s.velocity.gs = 143; s.velocity.vsFpm = -740;
      s.velocity.vx = 73; s.velocity.vy = -3.8; s.velocity.vz = 0;
    },
  },
  {
    id: 'canyon-cruise', airportId: 'ZULZ', hour: 10, storm: false,
    title: '② 高原峡谷白天巡航（林芝式 · 2950 m 标高）',
    desc: '1000 m+ 山脊夹河谷 · 河谷林带 · 五边障碍脊 · 雪线着色',
    frame(t, s) {
      const a = AIRPORTS.ZULZ;
      // 谷底侧方巡航：斜看河谷林带（河沿本地 z≈0 蜿蜒）+ 两侧山脊
      setLocal(s, a, -1200 - t * 220, 1500, 780);
      s.orientation.heading = 225; s.orientation.pitch = 2; s.orientation.bank = 8;
      s.velocity.ias = 250; s.velocity.gs = 250; s.velocity.vsFpm = 0;
      s.velocity.vx = -110; s.velocity.vy = 0; s.velocity.vz = 0;
    },
  },
  {
    id: 'island-crosswind', airportId: 'LPMA', hour: 15, storm: false,
    title: '③ 海岛侧风进近（马德拉式 · 20 kt 右侧风 · 无 ILS）',
    desc: '入口端接海 · 目视 + PAPI · 常年 15-25 kt 侧风，冲出跑道即落水',
    frame(t, s) {
      const a = AIRPORTS.LPMA;
      // 海上侧望：看岛内陆山壁密林 + 西侧浪花岸线（x 缓慢东移模拟侧风进近转弯段）
      setLocal(s, a, -3200 + t * 80, -1400, 320);
      s.orientation.heading = 18; s.orientation.pitch = 8; s.orientation.bank = -3;
      s.velocity.ias = 150; s.velocity.gs = 141; s.velocity.vsFpm = -700;
      s.velocity.vx = 27; s.velocity.vy = -3.6; s.velocity.vz = 5;
    },
  },
  {
    id: 'fog-cat1', airportId: 'KSFO', hour: 7.4, storm: false, dim: 0.45,
    title: '④ 雾城 CAT-I ILS 决断高（旧金山式 · 平流雾）',
    desc: '能见度 200-1500 m 随时刻波动 · 贴 ILS 下滑道压到决断高 · 入口灯穿雾而出',
    frame(t, s) {
      const a = AIRPORTS.KSFO, d = 1700 - t * 110;
      setLocal(s, a, -d, 0, gsH(d));
      s.orientation.heading = 281; s.orientation.pitch = -1.5; s.orientation.bank = 0;
      s.velocity.ias = 140; s.velocity.gs = 138; s.velocity.vsFpm = -700;
      s.velocity.vx = -71; s.velocity.vy = -3.6; s.velocity.vz = 0;
    },
  },
  {
    id: 'desert-night', airportId: 'OEJN', hour: 22.3, storm: false,
    title: '⑤ 沙漠夜航跑道灯全景（吉达式 · 4000 m 备降场）',
    desc: '边灯/中线灯/入口绿排/进近灯组全亮 · 塔台与航站楼剪影 · 星空',
    frame(t, s) {
      const a = AIRPORTS.OEJN;
      // 側方全景：跑道中段旁 250 m 高度，正交看向跑道（边灯/中线/入口/末端灯阵展开）
      setLocal(s, a, 2000 - t * 60, -700, 250);
      s.orientation.heading = 75; s.orientation.pitch = -4; s.orientation.bank = 0;
      s.velocity.ias = 160; s.velocity.gs = 158; s.velocity.vsFpm = 0;
      s.velocity.vx = -16; s.velocity.vy = 0; s.velocity.vz = 0;
    },
  },
  {
    id: 'storm-cruise', airportId: 'ZSPD', hour: 16, storm: true,
    title: '⑥ 雷暴 + 雨巡航（浓积云塔 · 定时闪电 · 湍流写回）',
    desc: 'state.weather: turbulence 0.55-1.0 · precipitation rain · 能见度骤降',
    frame(t, s) {
      const a = AIRPORTS.ZSPD;
      setLocal(s, a, -9000 + t * 220, -3000, 2200);
      s.orientation.heading = 80; s.orientation.pitch = 3; s.orientation.bank = -10;
      s.velocity.ias = 280; s.velocity.gs = 272; s.velocity.vsFpm = 0;
      s.velocity.vx = 113; s.velocity.vy = 0; s.velocity.vz = 20;
    },
  },
];

/* =========================================================
 * 错误面板（window.onerror → DOM）
 * ========================================================= */
const errBox = document.getElementById('err');
window.onerror = (msg, src, line, col, err) => {
  errBox.style.display = 'block';
  errBox.textContent = `ERROR: ${msg}\n${src || ''}:${line || ''}:${col || ''}\n${err && err.stack ? err.stack : ''}`;
};
window.addEventListener('unhandledrejection', (e) => {
  errBox.style.display = 'block';
  errBox.textContent = `REJECTION: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`;
});

/* =========================================================
 * three.js 基础设施
 * ========================================================= */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 100000);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hudMode = document.getElementById('hudMode');
const hudDesc = document.getElementById('hudDesc');
const hudLive = document.getElementById('hudLive');

/** 雷暴闪电 → 全屏闪屏（快速点亮、缓出衰减） */
const flashEl = document.getElementById('flash');
function lightningFlash() {
  flashEl.style.transition = 'none';
  flashEl.style.opacity = '0.8';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flashEl.style.transition = 'opacity 320ms ease-out';
      flashEl.style.opacity = '0';
    });
  });
}

/* =========================================================
 * 模式切换与主循环
 * ========================================================= */
let state = null, world = null, modeIdx = -1, modeT = 0, lastNow = performance.now();
const shakeRng = mulberry32(0x5EED); // 相机抖动相位（纯装饰，种子化：零 Math.random）
let shakeSeed = 0;

// URL 参数：?mode=N&t0=秒（进入该模式 N 并快进 t0 秒）&pause=1（暂停模式轮转）
const Q = new URLSearchParams(location.search);
const qMode = Q.get('mode') !== null ? parseInt(Q.get('mode'), 10) : null;
const qT0 = Q.get('t0') !== null ? parseFloat(Q.get('t0')) : 0;
const qPause = Q.get('pause') === '1';

function enterMode(idx) {
  modeIdx = idx % MODES.length;
  modeT = (modeIdx === qMode && qT0) ? qT0 : 0;
  const m = MODES[modeIdx];
  if (world) { world.dispose(); world = null; }
  scene.clear();
  scene.fog = null;
  state = createSimState({
    runwayLengthM: AIRPORTS[m.airportId].runwayLength,
    fuelKg: 6000, payloadKg: 12000,
  });
  state.ground.onGround = false;
  world = createWorld(scene, state, m.airportId, {
    storm: m.storm, hour: m.hour, dim: m.dim,
    nocloud: Q.get('nocloud') === '1',
    noscenery: Q.get('noscenery') === '1',
    onLightning: lightningFlash,
  });
  if (Q.get('nofog') === '1') world.setNofog(true);
  hudMode.textContent = `${m.title}  —  ${world.airport.name}（${world.airport.archetype}）`;
  hudDesc.textContent = m.desc;
  shakeSeed = shakeRng() * 1000;
}

const D2R = Math.PI / 180;

function placeCameraFromState() {
  if (Q.get('cam') === 'top') { // 调试：正上方俯视
    camera.position.set(state.position.x, state.position.y + 4000, state.position.z);
    camera.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
    return;
  }
  if (Q.get('cam') === 'apron') { // 调试：停机坪近景（机位标线/廊桥/风向袋）
    const a = world.airport;
    const tzZ = a.width / 2 + 150;
    camera.position.set(a.runwayLength / 2 - 40, 22, tzZ + 10);
    camera.lookAt(a.runwayLength / 2 - 60, 3, tzZ + 160);
    return;
  }
  const turb = state.weather ? state.weather.turbulence : 0;
  const t = performance.now() / 1000 + shakeSeed;
  const shake = turb * turb * 1.6;
  camera.position.set(
    state.position.x + Math.sin(t * 13.7) * shake,
    state.position.y + 3.2 + Math.sin(t * 17.3 + 1) * shake,
    state.position.z + Math.cos(t * 11.1) * shake,
  );
  const h = state.orientation.heading * D2R;
  camera.quaternion.setFromEuler(new THREE.Euler(
    state.orientation.pitch * D2R,
    -h - Math.PI / 2,
    -state.orientation.bank * D2R,
    'YXZ',
  ));
}

function updateHudLive() {
  const dbg = Q.has('debug')
    ? ` | cam(${camera.position.x.toFixed(0)},${camera.position.y.toFixed(0)},${camera.position.z.toFixed(0)})` +
      ` pos(${state.position.x.toFixed(0)},${state.position.y.toFixed(0)},${state.position.z.toFixed(0)})` +
      ` scene=${scene.children.length} tris=${renderer.info.render.triangles} calls=${renderer.info.render.calls}` +
      (world.sceneryStats ? ` scenery=${JSON.stringify(world.sceneryStats)}` : '') +
      (world.terrainDebug ? ` terr=${JSON.stringify(world.terrainDebug())}` : '')
    : '';
  const w = state.weather;
  const angle = papiAngleTo(world.airport, state.position);
  const whites = papiStates(angle).filter(Boolean).length;
  const papiTxt = `${whites}白${4 - whites}红`;
  hudLive.textContent =
    `T+${state.time.toFixed(0)}s · 时刻 ${world.getHour().toFixed(1)}h · ` +
    `风 ${w.windDirDeg.toFixed(0)}°/${w.windKts.toFixed(0)}kt 阵风${w.gustKts.toFixed(0)} · ` +
    `能见度 ${w.visibilityM}m · ${w.precipitation} · 湍流 ${w.turbulence.toFixed(2)} · ` +
    `PAPI ${papiTxt}（${angle.toFixed(2)}°）· nav.loc ${state.nav.locValid} · ` +
    `nav方位 ${state.nav.bearingDeg?.toFixed(1) ?? '-'}° · ` +
    `前视地形 ${state.terrain.aheadElevFt ?? 'null'} ft${dbg}`;
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastNow) / 1000, 0.25);
  lastNow = now;
  modeT += (qPause && modeIdx === qMode) ? 0 : dt;
  if (modeT >= MODE_LEN) {
    enterMode(modeIdx + 1);
  }
  const m = MODES[modeIdx];
  m.frame(modeT, state);
  state.time += dt;
  state.agl = state.position.y;
  placeCameraFromState();      // 先定位相机（世界各系统跟随相机）
  world.update(dt, camera);
  updateHudLive();
  renderer.render(scene, camera);
}

enterMode(qMode !== null ? qMode : 0);
requestAnimationFrame((n) => { lastNow = n; loop(n); });
