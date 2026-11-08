/**
 * daynight.js — 单元 3（外部世界）· 昼夜循环与光照。
 *
 *  - timeOfDay 0..24 可设（setTimeOfDay），每帧缓慢推进（默认 1 游戏分钟 / 真实秒）
 *  - 太阳方向光（方位 090°→180°→270° 随时刻东升西落）+ 半球环境光 + 少量常亮环境
 *  - 天空：渐变穹顶（ShaderMaterial，uniform 调色，零纹理开销）+ 太阳圆盘 + 星空 Points
 *  - 关键帧插值：夜/黎明/清晨/正午/黄昏/夜，返回 fogColor 供 weather.js 的 FogExp2 对齐
 *  - 夜间机场灯全亮：灯光点阵是 MeshBasic/Points（不受光照），昼夜自然切换观感
 *
 * Draw calls：穹顶 1 + 太阳盘 1 + 星空 1；光源：Directional + Hemisphere + Ambient = 3。
 *
 * @module world/daynight
 */

import * as THREE from 'three';
import { mulberry32 } from '../kernel/index.js';

/** 关键帧：hour → { skyTop, horizon, sunColor, sunI, hemiI, ambI, nightF } */
const KEYS = [
  { h: 0.0,  top: 0x050810, hor: 0x0a0f18, sun: 0x223055, sunI: 0.0, hemiI: 0.08, ambI: 0.04, nf: 1.0 },
  { h: 4.5,  top: 0x0a1226, hor: 0x1a2338, sun: 0x33406a, sunI: 0.0, hemiI: 0.1,  ambI: 0.05, nf: 0.95 },
  { h: 6.0,  top: 0x2a3b66, hor: 0xc97a4a, sun: 0xff9a55, sunI: 0.55, hemiI: 0.35, ambI: 0.12, nf: 0.35 },
  { h: 7.5,  top: 0x5d86c2, hor: 0xc9d6e6, sun: 0xffe8c8, sunI: 1.0,  hemiI: 0.6,  ambI: 0.2,  nf: 0.05 },
  { h: 12.0, top: 0x4a7fd4, hor: 0xcfe0ee, sun: 0xffffff, sunI: 1.25, hemiI: 0.75, ambI: 0.26, nf: 0.0 },
  { h: 17.0, top: 0x4d7ec2, hor: 0xd8dfe4, sun: 0xfff0d8, sunI: 1.0,  hemiI: 0.6,  ambI: 0.2,  nf: 0.05 },
  { h: 18.6, top: 0x35406e, hor: 0xd97a3e, sun: 0xff8a45, sunI: 0.5,  hemiI: 0.32, ambI: 0.11, nf: 0.4 },
  { h: 20.0, top: 0x0a1226, hor: 0x182033, sun: 0x33406a, sunI: 0.0,  hemiI: 0.1,  ambI: 0.05, nf: 0.95 },
  { h: 24.0, top: 0x050810, hor: 0x0a0f18, sun: 0x223055, sunI: 0.0,  hemiI: 0.08, ambI: 0.04, nf: 1.0 },
];

const _cTop = new THREE.Color(), _cHor = new THREE.Color(), _cSun = new THREE.Color();

function sampleKeys(hour) {
  let a = KEYS[0], b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (hour >= KEYS[i].h && hour <= KEYS[i + 1].h) { a = KEYS[i]; b = KEYS[i + 1]; break; }
  }
  const t = (hour - a.h) / (b.h - a.h || 1);
  return {
    top: _cTop.setHex(a.top).lerp(_cHor.setHex(b.top), t).clone(),
    hor: _cHor.setHex(a.hor).lerp(new THREE.Color(b.hor), t).clone(),
    sun: _cSun.setHex(a.sun).lerp(new THREE.Color(b.sun), t).clone(),
    sunI: a.sunI + (b.sunI - a.sunI) * t,
    hemiI: a.hemiI + (b.hemiI - a.hemiI) * t,
    ambI: a.ambI + (b.ambI - a.ambI) * t,
    nf: a.nf + (b.nf - a.nf) * t,
  };
}

/**
 * 创建昼夜系统。
 * @param {THREE.Scene} scene
 * @param {number} [hour=10] 初始时刻
 */
export function createDaynight(scene, hour = 10) {
  // 光照
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(sun);
  scene.add(sun.target); // target 需在场景图中才能每帧跟随相机
  const hemi = new THREE.HemisphereLight(0x99aabb, 0x50584a, 0.6);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffffff, 0.2);
  scene.add(amb);

  // 天空穹顶（跟随相机）
  const skyUniforms = {
    topColor: { value: new THREE.Color(0x4a7fd4) },
    horColor: { value: new THREE.Color(0xcfe0ee) },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunColor: { value: new THREE.Color(0xffffff) },
    sunGlow: { value: 0.35 },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor, horColor, sunColor, sunDir;
      uniform float sunGlow;
      varying vec3 vDir;
      void main() {
        float t = clamp(vDir.y * 1.6 + 0.12, 0.0, 1.0);
        vec3 col = mix(horColor, topColor, t);
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunColor * (pow(s, 180.0) * 0.9 + pow(s, 8.0) * sunGlow);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(42000, 24, 12), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // 太阳圆盘
  const sunDisc = new THREE.Mesh(
    new THREE.SphereGeometry(650, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xfff3d0, fog: false }),
  );
  sunDisc.frustumCulled = false;
  scene.add(sunDisc);

  // 星空（上半球随机点；种子化 → 零 Math.random，同 seed 星图恒定）
  const starRand = mulberry32(0x57a9ee);
  const starPos = [];
  for (let i = 0; i < 900; i++) {
    const az = starRand() * Math.PI * 2;
    const el = Math.asin(starRand()); // 上半球均匀
    const r = 40000;
    starPos.push(r * Math.cos(el) * Math.cos(az), r * Math.sin(el), r * Math.cos(el) * Math.sin(az));
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xcfd8e8, size: 2.2, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  scene.add(stars);

  let curHour = hour;
  let rate = 1 / 60; // 每真实秒推进 1 游戏分钟
  let dim = 0; // 阴天/雷暴压暗系数 0..1（weather/场景设置）

  /**
   * 设置时刻（0..24）。单元 6 场景/菜单可直接调用。
   */
  function setTimeOfDay(h) { curHour = ((h % 24) + 24) % 24; }
  function getHour() { return curHour; }
  function setRate(r) { rate = r; }
  /** 阴天压暗 0..1：雷暴/平流雾天整体调暗日光、天空与环境（weather 层调用） */
  function setDim(v) { dim = Math.min(Math.max(v, 0), 1); }

  /**
   * 每帧更新。
   * @param {number} dt 秒
   * @param {THREE.Vector3} camPos 相机位置（穹顶/星空跟随）
   * @returns {{hour:number, nightFactor:number, fogColor:THREE.Color, sunDir:THREE.Vector3}}
   */
  function update(dt, camPos) {
    curHour = (curHour + dt * rate) % 24;
    const k = sampleKeys(curHour);
    if (dim > 0) {
      const dk = new THREE.Color(0x3a4048);
      k.top.lerp(dk, dim * 0.85);
      k.hor.lerp(dk, dim * 0.85);
      k.sun = k.sun.lerp(new THREE.Color(0x9aa2ac), dim);
      k.sunI *= 1 - 0.8 * dim;
      k.hemiI *= 1 - 0.45 * dim;
      k.ambI *= 1 - 0.25 * dim;
    }

    // 太阳方向：方位 090°(6h) → 180°(12h) → 270°(18h)，仰角 sin 曲线
    const dayT = (curHour - 6) / 12; // 0..1 白天
    const elev = Math.sin(dayT * Math.PI); // 6h/18h=0，12h=1
    const azDeg = 90 + dayT * 180; // 东→南→西（罗盘角）
    const az = azDeg * Math.PI / 180;
    const ce = Math.max(Math.cos(Math.asin(Math.min(Math.max(elev, 0), 1))), 0.05);
    const dir = new THREE.Vector3(ce * Math.cos(az), Math.max(elev, 0.03), ce * Math.sin(az));
    sun.position.copy(dir).multiplyScalar(30000).add(camPos);
    sun.target.position.copy(camPos);
    sun.target.updateMatrixWorld();
    sun.color.copy(k.sun);
    sun.intensity = k.sunI;
    hemi.intensity = k.hemiI;
    amb.intensity = k.ambI;
    // 夜间月光（冷色微光保持地形可辨）
    if (k.sunI < 0.05) {
      sun.position.set(camPos.x - 12000, 16000, camPos.z + 9000);
      sun.target.position.copy(camPos);
      sun.target.updateMatrixWorld();
      sun.color.setHex(0x8fa3c8);
      sun.intensity = 0.13;
    }

    skyUniforms.topColor.value.copy(k.top);
    skyUniforms.horColor.value.copy(k.hor);
    skyUniforms.sunColor.value.copy(k.sun);
    skyUniforms.sunDir.value.copy(dir);
    skyUniforms.sunGlow.value = 0.15 + 0.5 * k.sunI;
    sky.position.copy(camPos);
    stars.position.copy(camPos);
    starMat.opacity = k.nf * 0.9;

    sunDisc.position.copy(dir).multiplyScalar(38000).add(camPos);
    sunDisc.visible = elev > 0.02;
    sunDisc.material.color.copy(k.sun);

    const fogColor = k.hor.clone().lerp(k.top, 0.25);
    if (k.nf > 0.6) fogColor.lerp(new THREE.Color(0x0a0f18), 0.5);
    return { hour: curHour, nightFactor: k.nf, fogColor, sunDir: dir };
  }

  function dispose() {
    scene.remove(sky, sunDisc, stars, sun, hemi, amb);
    sky.geometry.dispose(); skyMat.dispose();
    sunDisc.geometry.dispose(); sunDisc.material.dispose();
    starGeo.dispose(); starMat.dispose();
  }

  return { update, dispose, setTimeOfDay, setRate, getHour, setDim };
}
