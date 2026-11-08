/**
 * index.js — 单元 3（外部世界）· 对外入口。
 *
 *   import { createWorld } from './world/index.js';
 *   const world = createWorld(scene, state, 'ZSPD');
 *   // 每帧（推荐次序，供单元 6 集成）：
 *   world.update(dt, camera);        // ① 写 state.weather / state.nav / state.terrain
 *   stepSimulation(state, dt, bus);  // ② 内核消费
 *   renderer.render(scene, camera);  // ③ 渲染
 *
 * createWorld 组装：地形（terrain.js）+ 机场场景（airport-scene.js）+
 * 天气（weather.js）+ 昼夜（daynight.js），并负责三类"世界 → 内核"写回：
 *
 *  1. state.weather —— weather.js 每帧写（风/阵风/湍流/能见度/降水/气温/结冰）
 *  2. state.nav     —— 本文件每 0.2 s 写：
 *     - nav.courseDeg = runwayHeading（着陆航向，AP LOC 用）
 *     - nav.distM     = 至入口水平距离（≥50 m）
 *     - nav.bearingDeg = 飞机指向入口的罗盘方位角 deg（0=北顺时针；**非**反方位），
 *       内核 AP LOC 的 XTK 侧向修正依赖
 *     - nav.thresholdElevFt = 0（**必须为 0**：内核 y=0 即跑道面；真实标高在
 *       airport.elevationM，若写真实值内核 APP 的 aboveThrM = y − thr/3.28084 会整体偏移）
 *     - nav.locValid / gsValid：有 ILS 且飞机在进近窗口（x ∈ [-26 km, +2 km]，
 *       |z| < min(7 km, 0.16·dist)）时为 true；LPMA 无 ILS 恒 false（目视 + PAPI）
 *  3. state.terrain.aheadElevFt —— 每 0.3 s 沿航向前视采样最大地形标高
 *     （相对跑道面，与内核 position.y 同帧，GPWS TERRAIN 直接可比）
 *
 * 另：接地表面 'water' 判定（kernel-api.md 3.9 留给世界单元）——每帧检查
 * touchdown.recorded && surface!=='water' && waterCheck(x,z)，把 'terrain'/'belly'
 * 改写为 'water'（海岛/海湾/河流上接地 = 水面迫降）。
 *
 * ── 全单元性能预算（60 fps 目标，Apple Silicon）────────────────────
 *  三角形：地形 ~34k + 机场 ~1.5k + 云 sprite ~60 个 + 雨线段 1200 ≈ 38k（≤150k ✔）
 *  Draw calls：地形 3 + 机场 ~13 + 云 ~60 + 雨 1 + 天空 3 ≈ 80
 *  材质：共享为主（标线 1、灯点 1、云 4、跑道 2、建筑 3…），每帧不创建对象
 *  光源：Directional + Hemisphere + Ambient = 3（雷暴闪电复用 Ambient 提亮）
 * ─────────────────────────────────────────────────────────────────
 *
 * @module world/index
 */

import * as THREE from 'three';
import { AIRPORTS, DEFAULT_AIRPORT_ID, worldToAirport, waterCheck } from './airports-data.js';
import { createTerrain, terrainHeight } from './terrain.js';
import { buildAirport } from './airport-scene.js';
import { buildScenery } from './scenery.js';
import { createWeather } from './weather.js';
import { createDaynight } from './daynight.js';

const D2R = Math.PI / 180;

/**
 * 创建外部世界。
 * @param {THREE.Scene} scene three.js 场景（本函数会向其添加对象；dispose 时移除）
 * @param {Object} state 内核状态树（createSimState 的返回）
 * @param {string} airportId AIRPORTS 键（默认枢纽）
 * @param {Object} [opts] { storm:boolean, hour:number }
 * @returns {{
 *   airport: Object,
 *   update: (dt:number, camera:THREE.Camera) => void,
 *   setTimeOfDay: (h:number) => void,
 *   getHour: () => number,
 *   setStorm: (on:boolean) => void,
 *   dispose: () => void,
 * }}
 */
export function createWorld(scene, state, airportId, opts = {}) {
  const airport = AIRPORTS[airportId] || AIRPORTS[DEFAULT_AIRPORT_ID];

  // 同步内核跑道参数（内核地面即此跑道：沿 +x、中线 z=0、面 y=0）
  state.runway.lengthM = airport.runwayLength;
  state.runway.widthM = airport.width;
  state.runway.headingDeg = airport.runwayHeading;
  state.runway.elevFt = airport.elevationM * 3.28084;

  // 场景容器 = 内核跑道局部系（跑道沿 +x）。罗盘值只在显示/输入边界换算
  //（runway.headingDeg），世界不做几何旋转——旧的 -runwayHeading 旋转会让
  // 视觉跑道与内核跑道矩形/飞机朝向差出一个航向角（重构后不再有该巧合对齐）。
  const group = new THREE.Group();
  scene.add(group);

  const terrain = createTerrain(scene, airport);
  const airportScene = buildAirport(group, airport);
  const scenery = opts.noscenery ? { dispose() {}, stats: null } : buildScenery(group, airport); // 植被/建筑群/道路/浪花（静态，无逐帧更新）
  const weather = createWeather(scene, airport, {
    storm: !!opts.storm, nocloud: !!opts.nocloud,
    rngSeed: state.rngSeed, // 世界装饰随机流的种子（独立流，不消耗内核 state.rng）
    onLightning: opts.onLightning || null, // 雷击回调（dev 页全屏闪屏用）
  });
  const daynight = createDaynight(scene, opts.hour ?? 10);
  daynight.setDim(opts.dim ?? (opts.storm ? 0.65 : 0));

  // 雾对象挂 scene（weather 每帧调密度）
  scene.fog = new THREE.FogExp2(0xcfe0ee, 0.0001);

  /* ---------- nav / 前视地形（节流写回） ---------- */
  let navAcc = 1, terrAcc = 1;

  function updateNav() {
    const p = state.position;
    const { lx, lz } = worldToAirport(airport, p.x, p.z);
    const distM = Math.max(50, -lx); // 入口在本地 x=0，进近侧 lx<0
    const nav = state.nav;
    // 内核为跑道局部系（0°=跑道轴）：course 写局部 0°；罗盘值见 airport.runwayHeading
    nav.courseDeg = 0;
    nav.distM = distM;
    nav.thresholdElevFt = 0; // 见文件头：内核 y=0 即跑道面
    // bearingDeg：飞机 → 跑道入口（本地 (0,0) 即仿真原点）的罗盘方位角 deg（0=北、顺时针）。
    // 语义注意：这是"指向入口的方位"，不是跑道反方位/着陆航向；内核 AP LOC 的 XTK
    // 侧向修正按此计算偏航。入口即仿真坐标原点，故方位 = atan2(-z, -x) 归一化 0..360。
    nav.bearingDeg = (Math.atan2(-p.z, -p.x) * 180 / Math.PI + 360) % 360;
    const ilsOk = !!airport.ils;
    nav.locValid = ilsOk && lx > -26000 && lx < 2000 &&
      Math.abs(lz) < Math.min(7000, Math.max(400, 0.16 * distM));
    nav.gsValid = nav.locValid && ilsOk && distM < 26000;
  }

  function updateTerrainAhead() {
    const p = state.position;
    const h = state.orientation.heading * D2R;
    const cosH = Math.cos(h), sinH = Math.sin(h);
    let maxElev = -Infinity;
    for (const d of [500, 1000, 2000, 4000, 8000, 16000]) {
      const ex = p.x + cosH * d;
      const ez = p.z + sinH * d;
      maxElev = Math.max(maxElev, terrainHeight(ex, ez, airport.id));
    }
    state.terrain.aheadElevFt = Math.round(maxElev * 3.28084);
  }

  /** 接地表面 → water 改写（kernel-api.md 8.9 留给世界单元的口子） */
  function checkTouchdownSurface() {
    const td = state.touchdown;
    if (!td.recorded || td.surface === 'water') return;
    if (!waterCheck(airport, state.position.x, state.position.z)) return;
    if (!state.ground.onGround) return;
    td.surface = 'water'; // 海面/河面接地：水面迫降（覆盖 terrain/belly 判定）
  }

  /* ---------- 主更新 ---------- */
  function update(dt, camera) {
    const camPos = camera.position;
    const dn = daynight.update(dt, camPos);
    weather.update(dt, state, camPos, dn);
    terrain.update(camPos.x, camPos.z);

    navAcc += dt;
    if (navAcc >= 0.2) { navAcc = 0; updateNav(); }
    terrAcc += dt;
    if (terrAcc >= 0.3) { terrAcc = 0; updateTerrainAhead(); }
    checkTouchdownSurface();

    airportScene.updatePapi(state);
  }

  function setTimeOfDay(h) { daynight.setTimeOfDay(h); }
  function setNofog(v) { weather.setNofog(v); }
  function getHour() { return daynight.getHour(); }
  /**
   * setStorm 是构建期选项的运行期占位：云的构成（散布云 ↔ 浓积云塔）在
   * createWeather 时定型，运行期切换需重建 world（dev 页按模式重建即可）。
   */
  function setStorm(on) { void on; }

  function dispose() {
    terrain.dispose();
    weather.dispose();
    daynight.dispose();
    for (const d of airportScene.disposables) d.dispose?.();
    scenery.dispose();
    scene.remove(group);
    scene.fog = null;
  }

  return { airport, update, setTimeOfDay, getHour, setStorm, setNofog, dispose, terrainDebug: terrain.debug ? terrain.debug : null, sceneryStats: scenery.stats };
}
