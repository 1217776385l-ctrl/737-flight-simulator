/**
 * weather.js — 单元 3（外部世界）· 天气（云 / 雨 / 雾 / 闪电）+ **state.weather 写回**。
 *
 * ── 写回内核的授权与时机（供单元 5 / 单元 6 集成阅读）─────────────
 * kernel-api.md 第 0 节铁律 2 的例外条款授权世界单元写"环境数据"字段。
 * 本模块 **每渲染帧** 通过 update() 把下列字段写入 state.weather（同步赋值，
 * 下一帧 stepSimulation 的子步即读取生效）：
 *   weather.windDirDeg / windKts / gustKts   —— 机场 climate 基准 + 缓慢游走 + 雷暴增幅
 *   weather.turbulence                       —— climate 基准；雷暴 0.55..1.0 随机游走
 *   weather.visibilityM                      —— climate；marine 雾循环按时刻正弦 200..1500 m
 *   weather.precipitation                    —— 'none' | 'rain' | 'snow'
 *   weather.tempC                            —— climate.tempC 按 ISA 直减率 -6.5°C/km 修正
 *   weather.icingConditions                  —— 结冰环境（低温且高空/降水）
 *
 * 推荐集成次序（单元 6 主循环）：
 *   world.update(dt, camera);        // 写 state.weather + state.nav + state.terrain
 *   stepSimulation(state, dt, bus);  // 内核消费
 *   renderer.render(...);
 * 本模块**绝不**写 windDirDeg 之外任何飞行状态；wind 影响由内核 flight-model 消费。
 * ─────────────────────────────────────────────────────────────────
 *
 * 视觉要素：
 *  - billboard 云团：巡航高度散布（共享 1 张软点贴图 + 4 个共享材质）；
 *    雷暴模式换浓积云塔（深灰、垂直堆叠至 ~9.5 km）+ 定时闪电（环境光 + 云色增亮全屏闪光）
 *  - 雨/雪：LineSegments 粒子跟随相机，倾角含风
 *  - 雾：THREE.FogExp2，密度 = 1.9 / visibilityM（由写回的 state.weather.visibilityM 驱动，
 *    保证仪表能见度与画面雾一致）
 *
 * @module world/weather
 */

import * as THREE from 'three';
import { mulberry32, DEFAULT_RNG_SEED } from '../kernel/index.js';

/** 湍流游走固定步长 s：state.rng 消费次数只随仿真时间增长（帧率无关、同 seed 可复现） */
const TURB_STEP = 0.05;

/* =========================================================
 * 云贴图与材质（进程内共享）
 * ========================================================= */
let cloudTex = null;
function getCloudTexture() {
  if (cloudTex) return cloudTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  cloudTex = new THREE.CanvasTexture(cv);
  return cloudTex;
}

/** 云配色：日光因子会随昼夜/闪电整体调制 */
function makeCloudMats() {
  const tex = getCloudTexture();
  const mk = (color, opacity, fog = true) => new THREE.SpriteMaterial({
    map: tex, color, opacity, transparent: true, depthWrite: false, fog,
  });
  return {
    white: mk(0xffffff, 0.85),
    grey: mk(0xb9bec6, 0.9),
    dark: mk(0x565b63, 0.95, false), // 雷暴散布云：不受雾影响（塔体远距可见）
    low: mk(0xdfe4ea, 0.55),         // 低空碎云
    // 【分层积雨云】深灰云底 / 中层 / 砧状顶（均不受雾影响）
    cbLow: mk(0x23262c, 0.98, false),
    cbMid: mk(0x454b56, 0.97, false),
    cbTop: mk(0x8b929e, 0.95, false),
  };
}

/* =========================================================
 * 雨雪粒子
 * ========================================================= */

function createRain(count, rng) {
  const pos = new Float32Array(count * 6); // 每滴 2 顶点（线段）
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x9fb4c4, transparent: true, opacity: 0.34 });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.visible = false;
  const drops = [];
  for (let i = 0; i < count; i++) {
    drops.push({ x: 0, y: 0, z: 0, v: 9 + rng() * 4, init: false });
  }
  return { lines, geo, drops, count };
}

/* =========================================================
 * 模块主对象
 * ========================================================= */

/**
 * @param {THREE.Scene} scene
 * @param {Object} airport AIRPORTS 成员
 * @param {Object} [opts] { storm:boolean }
 */
export function createWeather(scene, airport, opts = {}) {
  /* ── 随机源纪律（kernel-api.md：禁止 Math.random）────────────────
   * - 装饰性随机（云形/雨滴/闪电时刻）：独立种子流 rng（种子 = rngSeed ⊕ 机场
   *   terrainSeed），绝不消耗内核 state.rng —— 世界每帧消费次数随帧率变化，
   *   若共用内核流会把帧率差异泄入湍流序列，破坏"同 seed 同分"。
   * - 影响飞行状态的湍流游走（turbWalk）：在 update 里按固定步长读
   *   state.rng（内核注入），消费次数只随仿真时间增长 → 帧率无关、可复现。
   * ─────────────────────────────────────────────────────────────── */
  const rng = mulberry32(
    ((opts.rngSeed ?? DEFAULT_RNG_SEED) ^ Math.imul(airport.terrainSeed, 2654435761)) >>> 0,
  );
  const mats = makeCloudMats();
  const storm = !!opts.storm;
  const clouds = [];
  const disposables = [];

  /** 云团：若干 sprite 组成的椭球簇；cb 为分层积雨云（底/中/砧三色） */
  function spawnCloud(kind) {
    const g = new THREE.Group();
    const matOf = (t) => kind === 'cb'
      ? (t < 0.3 ? mats.cbLow : t < 0.65 ? mats.cbMid : mats.cbTop)
      : kind === 'low' ? mats.low : kind === 'grey' ? mats.grey : mats.white;
    const spec = kind === 'cb'
      ? { n: 16 + (rng() * 6 | 0), r: 1100, vy: 1000, base: 500 + rng() * 700 }
      : kind === 'low'
        ? { n: 4 + (rng() * 3 | 0), r: 320, vy: 110, base: 1700 + rng() * 1300 }
        : { n: 6 + (rng() * 5 | 0), r: 700, vy: 220, base: 5200 + rng() * 4800 };
    for (let i = 0; i < spec.n; i++) {
      // CB：垂直塔形堆叠（低层密集深灰、高层变宽成浅灰砧）
      let py = rng() * spec.vy;
      let t = py / spec.vy;
      let pw = 1;
      if (kind === 'cb') {
        t = Math.pow(rng(), 1.4); // 0..1，偏底层
        py = t * 6800;
        pw = 1 + t * 1.8; // 越高越宽（砧状）
      }
      const s = new THREE.Sprite(matOf(t));
      const sx = spec.r * (0.5 + rng() * 0.9);
      const sy = spec.vy * (0.4 + rng() * 0.9);
      s.position.set((rng() - 0.5) * 2.2 * spec.r, py, (rng() - 0.5) * 2.2 * spec.r);
      s.scale.set(sx * pw, sy * (0.5 + rng() * 0.4) * (kind === 'cb' ? 1 + rng() : 1), 1);
      g.add(s);
    }
    g.userData.kind = kind;
    g.userData.wrapR = kind === 'cb' ? 9000 : kind === 'low' ? 9000 : 26000;
    scene.add(g);
    clouds.push(g);
    return g;
  }

  // 散布云（opts.nocloud 供调试/评审对照）
  if (opts.nocloud) {
    // 不生成任何云
  } else if (storm) {
    for (let i = 0; i < 10; i++) spawnCloud('cb');
    for (let i = 0; i < 8; i++) spawnCloud('dark');
    for (let i = 0; i < 6; i++) spawnCloud('low');
  } else {
    for (let i = 0; i < 16; i++) spawnCloud('white');
    for (let i = 0; i < 8; i++) spawnCloud('grey');
    for (let i = 0; i < 6; i++) spawnCloud('low');
  }

  const rain = createRain(2400, rng);

  // 闪电：环境闪光灯（初始短延时，让演示页第一屏就可能截到闪电）+ onLightning 回调（dev 页闪屏）
  const flashLight = new THREE.AmbientLight(0xdfe8ff, 0);
  scene.add(flashLight);
  scene.add(rain.lines); // 雨雪线段入场景（此前缺失导致雨丝不可见）
  let flash = 0;
  let flashTimer = 2.5 + rng() * 2.5; // 首次雷击延后：进画面先见云塔与雨丝
  const onLightning = opts.onLightning || null;

  // 气象游走内部状态
  let wander = 0;
  let turbWalk = 0.5;
  let turbAcc = 0;
  let nofog = false; // 调试开关

  /** 初始云位摆放到相机四周 */
  function seedClouds(cam) {
    for (const c of clouds) placeCloud(c, cam, true);
  }

  function placeCloud(c, cam, anywhere) {
    const R = c.userData.wrapR;
    const a = rng() * Math.PI * 2;
    const r = anywhere ? Math.sqrt(rng()) * R : R * (0.85 + rng() * 0.15);
    c.position.set(
      cam.x + Math.cos(a) * r,
      c.position.y,
      cam.z + Math.sin(a) * r,
    );
  }

  /**
   * 每帧更新 + 写回 state.weather（见文件头：授权与时机）。
   * @param {number} dt 秒
   * @param {Object} state 内核状态（写 state.weather；读 position.y/tempC 输入）
   * @param {THREE.Vector3} camPos 相机世界位置
   * @param {Object} dn daynight.update 的返回 { hour, nightFactor, fogColor }
   */
  function update(dt, state, camPos, dn) {
    const cl = airport.climate;
    const hour = dn.hour;

    /* ---- 能见度 ---- */
    let vis = cl.visM;
    if (cl.fogCycle === 'marine') {
      const m = 0.5 + 0.5 * Math.sin((hour / 24) * Math.PI * 4 - 1.2); // 清晨最差
      const minM = cl.fogMinM ?? 200, maxM = cl.fogMaxM ?? 1500;
      vis = minM + (maxM - minM) * m;
    }
    if (storm) vis = 2500 + 1500 * Math.sin(state.time * 0.05);

    /* ---- 风 ---- */
    wander += dt * 0.07;
    const windKts = cl.windKts * (1 + 0.25 * Math.sin(wander * 2.1)) + (storm ? 14 : 0);
    const gustKts = cl.gustKts + (storm ? 22 : 0) + 4 * Math.abs(Math.sin(wander * 3.7));

    /* ---- 湍流（雷暴随机游走；state.rng 固定步长 → 帧率无关、同 seed 可复现） ---- */
    const turbBase = storm ? 0.55 : cl.turbulence;
    turbAcc += dt;
    while (turbAcc >= TURB_STEP) {
      turbAcc -= TURB_STEP;
      if (state.rng) turbWalk += (state.rng() - 0.5) * TURB_STEP * 0.8;
      turbWalk = Math.min(Math.max(turbWalk, 0), 1);
    }
    const turbulence = Math.min(1, turbBase * (0.6 + 0.8 * turbWalk));

    /* ---- 气温 / 降水 / 结冰 ---- */
    const tempC = (cl.tempC ?? 15) - 6.5 * (state.position.y / 1000);
    const precip = storm ? 'rain' : (tempC < 1 && vis < 8000 ? 'snow' : 'none');
    const icing = tempC < 3 && (state.position.y > 2500 || precip !== 'none');

    // ---- ★ 写回内核（唯一写 state.weather 的地方）----
    const w = state.weather;
    w.windDirDeg = (cl.windDirDeg + 12 * Math.sin(wander)) % 360;
    w.windKts = Math.round(windKts * 10) / 10;
    w.gustKts = Math.round(gustKts * 10) / 10;
    w.turbulence = turbulence;
    w.visibilityM = Math.round(vis);
    w.precipitation = precip;
    w.tempC = Math.round(tempC * 10) / 10;
    w.icingConditions = icing;

    /* ---- 雾（画面密度与能见度一致；nofog 供调试对照） ----
     * 密度系数取 1.25（气象能见度定义≈1.9/vis 时中景已 80% 灰），
     * 折衷：5% 对比度距离 ≈ 1.4×能见度，中景地形可辨而远景仍被吞没。 */
    if (scene.fog && scene.fog.isFogExp2) {
      scene.fog.density = nofog ? 0 : 1.25 / Math.max(vis, 40);
      scene.fog.color.copy(dn.fogColor);
    }

    /* ---- 云跟随相机（水平环绕）---- 前 3 个 CB 固定相对方位，保证画面有塔 */
    let cbAnchor = 0;
    for (const c of clouds) {
      if (storm && c.userData.kind === 'cb' && cbAnchor < 3) {
        const ang = cbAnchor * 2.1 + 0.5;
        const r = 4200 + cbAnchor * 1600;
        c.position.set(camPos.x + Math.cos(ang) * r, c.position.y, camPos.z + Math.sin(ang) * r);
        cbAnchor++;
        continue;
      }
      const dx = c.position.x - camPos.x;
      const dz = c.position.z - camPos.z;
      if (dx * dx + dz * dz > c.userData.wrapR * c.userData.wrapR * 1.3) {
        placeCloud(c, camPos, false);
      }
    }
    // 云色调随昼夜 + 闪电（分层积雨云：底深、砧浅）
    const nf = dn.nightFactor;
    const lit = 1 + flash * 1.6;
    mats.white.color.setRGB(lit * (0.98 - 0.72 * nf), lit * (0.98 - 0.68 * nf), lit * (1.0 - 0.55 * nf));
    mats.grey.color.setRGB(lit * (0.7 - 0.5 * nf), lit * (0.71 - 0.48 * nf), lit * (0.75 - 0.45 * nf));
    mats.low.color.setRGB(lit * (0.85 - 0.6 * nf), lit * (0.86 - 0.58 * nf), lit * (0.9 - 0.5 * nf));
    mats.dark.color.setRGB(lit * 0.16, lit * 0.17, lit * 0.2);
    mats.cbLow.color.setRGB(lit * 0.15, lit * 0.16, lit * 0.19);
    mats.cbMid.color.setRGB(lit * 0.3, lit * 0.32, lit * 0.37);
    mats.cbTop.color.setRGB(lit * 0.55, lit * 0.58, lit * 0.63);

    /* ---- 闪电 ---- */
    if (storm) {
      flashTimer -= dt;
      if (flashTimer <= 0) {
        flash = 1;
        flashTimer = 1.8 + rng() * 4;
        if (onLightning) onLightning(flash);
      }
      flash *= Math.exp(-dt * 6);
      flashLight.intensity = flash * 2.8;
    }

    /* ---- 雨 / 雪 ---- */
    const isRain = state.weather.precipitation === 'rain';
    const isSnow = state.weather.precipitation === 'snow';
    rain.lines.visible = isRain || isSnow;
    if (isRain || isSnow) {
    rain.lines.material.color.setHex(isSnow ? 0xe8f0f8 : 0xaebfd0);
    rain.lines.material.opacity = isSnow ? 0.5 : 0.85;
      // 风向量（世界系）：由写回后的 weather 换算（与内核同式）
      const wd = state.weather.windDirDeg * Math.PI / 180;
      const wms = state.weather.windKts * 0.5144;
      const wx = -Math.cos(wd) * wms, wz = -Math.sin(wd) * wms;
      const fall = isSnow ? 2.2 : 10;
      const len = isSnow ? 1.2 : 9;
      const R = 55;
      const pos = rain.geo.attributes.position.array;
      for (let i = 0; i < rain.count; i++) {
        const d = rain.drops[i];
        if (!d.init || d.y < camPos.y - 25) {
          d.x = camPos.x + (rng() - 0.5) * 2 * R;
          d.y = camPos.y + 12 + rng() * 30;
          d.z = camPos.z + (rng() - 0.5) * 2 * R;
          d.init = true;
        }
        d.y -= fall * dt;
        d.x += wx * dt;
        d.z += wz * dt;
        const k = i * 6;
        pos[k] = d.x; pos[k + 1] = d.y; pos[k + 2] = d.z;
        pos[k + 3] = d.x + wx * (len / fall) * 0.1 + wx * 0.02;
        pos[k + 4] = d.y + len * (fall / 10);
        pos[k + 5] = d.z + wz * (len / fall) * 0.1 + wz * 0.02;
      }
      rain.geo.attributes.position.needsUpdate = true;
    }
  }

  function dispose() {
    for (const c of clouds) scene.remove(c);
    clouds.length = 0;
    scene.remove(flashLight, rain.lines);
    rain.geo.dispose();
    rain.lines.material.dispose();
    flashLight.dispose?.();
    disposables.push(mats.white, mats.grey, mats.dark, mats.low, mats.cbLow, mats.cbMid, mats.cbTop);
    for (const d of disposables) d.dispose?.();
    if (cloudTex) { cloudTex.dispose(); cloudTex = null; }
  }

  seedClouds({ x: 0, z: 0 });

  /** 调试：关掉雾便于评审地形本体 */
  function setNofog(v) { nofog = v; }

  return { update, dispose, storm, setNofog };
}
