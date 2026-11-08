/**
 * terrain.js — 单元 3（外部世界）· 程序化地形。
 *
 * 两层 API：
 *  1. **纯函数层**：terrainHeight(x, z, airportId) —— 分形值噪声高度场，
 *     供地形网格、state.terrain.aheadElevFt 前视采样、迫降表面判定共同使用。
 *     同一 seed 完全确定（无时间/随机数），结算可复现。输入仿真坐标，输出**相对跑道面**
 *     的高度 m（机场平地 ≈ 0，见 airports-data.js 文件头的高度约定）。
 *  2. **网格层**：createTerrain(scene, airport) —— 跟随飞机重定位的双环网格
 *     （内环精细 + 外环粗略带孔），并负责按地形类型/高度/坡度着色。
 *
 * ── 性能预算（60 fps 目标）────────────────────────────────────────────
 *  内环网格：10.24 km × 10.24 km，96×96 四边形 = 18,432 三角形（~107 m 顶点距）
 *  外环网格：64 km × 64 km，128×128 四边形挖去内环重叠区 ≈ 15,800 三角形
 *  水面：    2 三角形（大平面跟随相机）
 *  合计地形 ≈ 34,300 三角形（预算 ≤150,000，余量给机场/云/雨）。
 *  Draw calls：内环 1 + 外环 1 + 水 1 = 3。
 *  重建成本：内环 ~9.4k 顶点 × 6 octave 值噪声 ≈ 3-5 ms，仅在相机跨过吸附步长时发生
 *  （巡航 250 m/s 约 0.5 s 一次）；吸附步长 = 网格间距，保证重建前后顶点世界位置
 *  周期连续、无高度跳变。
 * ─────────────────────────────────────────────────────────────────────
 *
 * @module world/terrain
 */

import * as THREE from 'three';
import { AIRPORTS, worldToAirport } from './airports-data.js';

/* =========================================================
 * 确定性噪声（Math.imul 32 位哈希 + 双线性值噪声 + fbm）
 * ========================================================= */

/** 2D 整数格点哈希 → 0..1，确定性 */
function hash2(ix, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 974711);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** 平滑插值曲线 smoothstep */
function sstep(t) { t = Math.min(Math.max(t, 0), 1); return t * t * (3 - 2 * t); }

/** 通用 smoothstep(a, b, v)：a→b 映射 0→1 */
export function smoothstep(a, b, v) {
  return sstep((v - a) / (b - a || 1e-9));
}

/** 值噪声（双线性 + smoothstep），输出 0..1 */
export function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = sstep(fx), uz = sstep(fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** 分形布朗运动（分形值噪声），输出约 0..1 */
export function fbm(x, z, seed, octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** 各向同性高斯山包 */
function gauss(dx, dz, sigma) {
  return Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
}

/**
 * 山脊（ridged）分形噪声：锯齿山脊 + 冲沟细节，输出 0..1。
 * (1−|2n−1|)² 逐 octave 叠加，频率比 fbm 略高、带幅宽衰减。
 */
export function ridgedFbm(x, z, seed, octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0, w = 1;
  for (let i = 0; i < octaves; i++) {
    let n = valueNoise(x * freq, z * freq, seed + i * 197);
    n = 1 - Math.abs(2 * n - 1);
    sum += amp * n * n * w;
    norm += amp;
    amp *= 0.5;
    freq *= 2.15;
    w *= 0.85;
  }
  return sum / norm;
}

/**
 * 【位移层】山体高频细节：叠加 3 octave ridged 噪声（波长 ~180-900m）。
 * 振幅随基础高度（mask）增大、平地收敛为 0；flattenToPad 在其后执行，
 * 机场平地不受影响。供 canyon/island/bay/desert 各高度函数在 flatten 前调用。
 */
function ridgeDetail(lx, lz, seed, baseH, amp) {
  const mask = smoothstep(amp * 0.5, amp * 3, baseH);
  if (mask <= 0) return 0;
  return (ridgedFbm(lx / 420, lz / 420, seed, 3) - 0.35) * amp * 2.6 * mask;
}

/* =========================================================
 * 高度场：按地形类型（本地坐标）
 * ========================================================= */

/**
 * 机场平地整形：跑道及周边矩形+过渡带内把地形压回 0（跑道面）。
 * 矩形：x ∈ [-1800, L+1800]，|z| ≤ 800；过渡带 2600 m 平滑衰减。
 */
function flattenToPad(h, lx, lz, L) {
  const dx = Math.max(-1800 - lx, 0, lx - (L + 1800));
  const dz = Math.max(-800 - lz, 0, lz - 800);
  const d = Math.hypot(dx, dz);
  if (d >= 2600) return h;
  const t = sstep(1 - d / 2600); // 1=pad 中心 → 0=过渡带外缘
  return h * (1 - t);
}

/** 枢纽平原：缓丘 + 东侧海岸（本地 +z 9 km 外为东海） */
function heightPlain(lx, lz, a) {
  const s = a.terrainSeed;
  let h = 14 * fbm(lx / 1400, lz / 1400, s, 4) - 7;
  h += 70 * fbm(lx / 9000, lz / 9000, s + 17, 2) - 35;
  h = flattenToPad(h, lx, lz, a.runwayLength);
  const coast = 9000 + 1800 * (fbm(lx / 5000, 0.37, s + 11, 2) - 0.5) * 2;
  if (lz > coast) {
    const d = lz - coast;
    h = -2 - 55 * sstep(d / 1200) - 6 * fbm(lx / 700, lz / 700, s + 5, 2);
  }
  return h;
}

/** 高原峡谷：河谷 + 两侧 1000 m+ 山脊 + 五边地形障碍 + 谷底河流 */
function heightCanyon(lx, lz, a) {
  const s = a.terrainSeed;
  const d = Math.abs(lz);
  const valley = smoothstep(1600, 5400, d); // 谷底 → 山脊过渡
  let ridge = 1250 * valley;
  ridge += (fbm(lx / 2600, lz / 2600, s, 4) - 0.5) * 800 * valley;   // 山脊起伏
  ridge += (fbm(lx / 500, lz / 500, s + 41, 3) - 0.5) * 120 * valley; // 岩壁细节
  let floor = 22 * fbm(lx / 900, lz / 900, s + 5, 3);
  let h = floor + ridge;
  // 五边峡谷地形障碍（GPWS TERRAIN 的考场）：两个侧脊刺入五边空域
  h += 780 * gauss(lx + 6500, lz + 3400, 2200);
  h += 950 * gauss(lx - 12500, lz - 3000, 2600);
  h += 620 * gauss(lx + 15000, lz - 3800, 2400);
  // 谷底河流（waterCheck 同源：|z − riverZ| < 60；平滑下切避免锯齿）
  const rz = 140 * Math.sin(lx / 4200) + 120 * (fbm(lx / 2200, 7.7, s + 9, 2) - 0.5) * 2;
  const rd = Math.abs(lz - rz);
  const carve = 1 - sstep(rd / 260);
  if (carve > 0) h = h * (1 - carve) + (-5) * carve;
  // 【位移层】山脊锯齿 + 冲沟（谷底/机场平地收敛）
  h += ridgeDetail(lx, lz, s + 61, h, 110);
  return flattenToPad(h, lx, lz, a.runwayLength);
}

/** 海岛：入口端与东侧海岸 + 内陆 800-1300 m 山地 + 海滩过渡 */
function heightIsland(lx, lz, a) {
  const s = a.terrainSeed;
  const cx = -1100 + 1000 * (fbm(lz / 3500, 0.61, s, 3) - 0.5) * 2;   // 入口端海岸线
  const cz = 1500 + 1800 * (fbm(lx / 4000, 3.13, s + 4, 3) - 0.5) * 2; // 东侧海岸线
  const inWater = lx < cx || lz > cz;
  if (inWater) {
    const dEdge = Math.max(cx - lx, cz - lz);
    return -2 - 60 * sstep(dEdge / 900) - 5 * fbm(lx / 500, lz / 500, s + 6, 2);
  }
  let h = 500 + 900 * fbm(lx / 2800, lz / 2800, s + 2, 5); // 内陆山地基高
  h *= smoothstep(cx + 100, cx + 2600, lx);   // 从海岸爬升
  h *= 1 - smoothstep(cz - 2200, cz, lz) * 0.9;
  h += 70 * fbm(lx / 620, lz / 620, s + 8, 4) * smoothstep(cx, cx + 1400, lx);
  h += ridgeDetail(lx, lz, s + 63, h, 90); // 【位移层】山脊冲沟
  h = flattenToPad(h, lx, lz, a.runwayLength);
  if (h < 0.5 && lx > cx) h = Math.max(h, 0.5 - 40 * sstep((cx + 300 - lx) / 300)); // 海滩反坡
  return h;
}

/** 海湾：沿岸陆地条带（|z| < ~2.6 km）+ 三面海湾 + 远丘 */
function heightBay(lx, lz, a) {
  const s = a.terrainSeed;
  const half = 2600 + 1400 * (fbm(lx / 6000, 1.71, s, 3) - 0.5) * 2;
  const westEnd = -5000 + 800 * (fbm(lz / 4000, 5.5, s + 31, 2) - 0.5) * 2;
  const eastEnd = a.runwayLength + 5500 + 800 * (fbm(lz / 4000, 8.8, s + 33, 2) - 0.5) * 2;
  if (Math.abs(lz) > half || lx < westEnd || lx > eastEnd) {
    const dEdge = Math.max(Math.abs(lz) - half, westEnd - lx, lx - eastEnd);
    return -2 - 45 * sstep(dEdge / 1000) - 4 * fbm(lx / 600, lz / 600, s + 6, 2);
  }
  let h = 45 * fbm(lx / 2200, lz / 2200, s, 4);
  h += 260 * smoothstep(half * 0.45, half, Math.abs(lz)) * fbm(lx / 1500, lz / 1500, s + 12, 3);
  h *= 1 - 0.55 * sstep(1800, half, Math.abs(lz)); // 岸线前放缓
  h += ridgeDetail(lx, lz, s + 65, h, 55); // 【位移层】丘陵冲沟（轻度）
  return flattenToPad(h, lx, lz, a.runwayLength);
}

/** 沙漠：风蚀沙丘（沿本地 z 拉长）+ 缓原 + 远处陡崖 */
function heightDesert(lx, lz, a) {
  const s = a.terrainSeed;
  let h = 20 * fbm(lx / 700, lz / 4500, s, 3) - 10;           // 沙丘脊（垂直于主导风向拉长）
  h += 70 * fbm(lx / 12000, lz / 12000, s + 3, 2) - 35;       // 缓原
  h += 300 * smoothstep(-14000, -24000, lx) * fbm(lx / 3000, lz / 3000, s + 15, 3); // 西缘陡崖
  h += (ridgedFbm(lx / 260, lz / 800, s + 81, 2) - 0.4) * 16; // 【位移层】沙丘纹理（轻度，全域）
  return flattenToPad(h, lx, lz, a.runwayLength);
}

const HEIGHT_BY_TYPE = {
  plain: heightPlain, canyon: heightCanyon, island: heightIsland,
  bay: heightBay, desert: heightDesert,
};

/**
 * 地形高度（**纯函数**，供内核侧/结算侧查询）。
 *
 * @param {number} x 仿真系北向 m
 * @param {number} z 仿真系东向 m
 * @param {string} airportId AIRPORTS 键
 * @returns {number} 相对跑道面的高度 m（机场平地 ≈ 0；水面区域为负）
 */
export function terrainHeight(x, z, airportId) {
  const a = AIRPORTS[airportId] || AIRPORTS.ZSPD;
  const { lx, lz } = worldToAirport(a, x, z);
  return localHeight(lx, lz, a);
}

/** 本地坐标高度（内部/渲染用） */
export function localHeight(lx, lz, a) {
  return HEIGHT_BY_TYPE[a.terrainType](lx, lz, a);
}

/**
 * 水面判定（渲染与迫降共用；与 airports-data.waterCheck 同一语义）。
 * @param {number} x 仿真系 m
 * @param {number} z 仿真系 m
 * @param {Object} a 机场对象
 */
export function waterAt(x, z, a) {
  if (a.waterLevelRel === null) return false;
  const { lx, lz } = worldToAirport(a, x, z);
  return waterRegionLocal(lx, lz, a);
}

function waterRegionLocal(lx, lz, a) {
  switch (a.terrainType) {
    case 'plain': {
      const coast = 9000 + 1800 * (fbm(lx / 5000, 0.37, a.terrainSeed + 11, 2) - 0.5) * 2;
      return lz > coast;
    }
    case 'canyon': {
      const rz = 140 * Math.sin(lx / 4200) + 120 * (fbm(lx / 2200, 7.7, a.terrainSeed + 9, 2) - 0.5) * 2;
      return Math.abs(lz - rz) < 60;
    }
    case 'island': {
      const cx = -1100 + 1000 * (fbm(lz / 3500, 0.61, a.terrainSeed, 3) - 0.5) * 2;
      const cz = 1500 + 1800 * (fbm(lx / 4000, 3.13, a.terrainSeed + 4, 3) - 0.5) * 2;
      return lx < cx || lz > cz;
    }
    case 'bay': {
      const half = 2600 + 1400 * (fbm(lx / 6000, 1.71, a.terrainSeed, 3) - 0.5) * 2;
      if (Math.abs(lz) > half) return true;
      const westEnd = -5000 + 800 * (fbm(lz / 4000, 5.5, a.terrainSeed + 31, 2) - 0.5) * 2;
      const eastEnd = a.runwayLength + 5500 + 800 * (fbm(lz / 4000, 8.8, a.terrainSeed + 33, 2) - 0.5) * 2;
      return lx < westEnd || lx > eastEnd;
    }
    default: return false;
  }
}

/**
 * 岸线折线（机场本地坐标）——与 waterRegionLocal 同一套解析式，供浪花带
 * （scenery.js）沿水边生成。每条折线附水体方向提示 (wx, wz)（单位向量，
 * 指向水体一侧；0,0 = 河流类居中窄带）。
 * @param {Object} a 机场对象
 * @returns {Array<{pts:number[][], wx:number, wz:number}>}
 */
export function shorePolylines(a) {
  const s = a.terrainSeed, L = a.runwayLength;
  const out = [];
  switch (a.terrainType) {
    case 'plain': {
      const pts = [];
      for (let lx = -32000; lx <= 32000; lx += 800) {
        pts.push([lx, 9000 + 1800 * (fbm(lx / 5000, 0.37, s + 11, 2) - 0.5) * 2]);
      }
      out.push({ pts, wx: 0, wz: 1 });
      break;
    }
    case 'canyon': {
      const pts = [];
      for (let lx = -32000; lx <= 32000; lx += 400) {
        pts.push([lx, 140 * Math.sin(lx / 4200) + 120 * (fbm(lx / 2200, 7.7, s + 9, 2) - 0.5) * 2]);
      }
      out.push({ pts, wx: 0, wz: 0 }); // 河流：居中窄带
      break;
    }
    case 'island': {
      const pA = [], pB = [];
      for (let lz = -24000; lz <= 20000; lz += 600) {
        pA.push([-1100 + 1000 * (fbm(lz / 3500, 0.61, s, 3) - 0.5) * 2, lz]);
      }
      for (let lx = -1400; lx <= 30000; lx += 600) {
        pB.push([lx, 1500 + 1800 * (fbm(lx / 4000, 3.13, s + 4, 3) - 0.5) * 2]);
      }
      out.push({ pts: pA, wx: -1, wz: 0 }, { pts: pB, wx: 0, wz: 1 });
      break;
    }
    case 'bay': {
      const pN = [], pS = [], pW = [], pE = [];
      for (let lx = -6000; lx <= L + 6500; lx += 500) {
        const half = 2600 + 1400 * (fbm(lx / 6000, 1.71, s, 3) - 0.5) * 2;
        pN.push([lx, half]); pS.push([lx, -half]);
      }
      for (let lz = -4200; lz <= 4200; lz += 500) {
        pW.push([-5000 + 800 * (fbm(lz / 4000, 5.5, s + 31, 2) - 0.5) * 2, lz]);
        pE.push([L + 5500 + 800 * (fbm(lz / 4000, 8.8, s + 33, 2) - 0.5) * 2, lz]);
      }
      out.push(
        { pts: pN, wx: 0, wz: 1 }, { pts: pS, wx: 0, wz: -1 },
        { pts: pW, wx: -1, wz: 0 }, { pts: pE, wx: 1, wz: 0 },
      );
      break;
    }
    default: break; // desert 无水域
  }
  return out;
}

/* =========================================================
 * 着色（按类型 + 高度 + 坡度；色调统一自然、无花哨）
 * ========================================================= */

/* =========================================================
 * 【纹理层】可平铺噪声细节纹理（512px，世界坐标锚定 UV）
 * ========================================================= */

const UV_TILE = 42; // 细节纹理平铺周期 m

let detailTex = null;
function getDetailTexture() {
  if (detailTex) return detailTex;
  const S = 512, P = 8; // P = 平铺周期（格点数）
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const wrap = (v) => ((v % P) + P) % P;
  const h2 = (ix, iz, seed) => {
    let hh = Math.imul(wrap(ix) | 0, 374761393) ^ Math.imul(wrap(iz) | 0, 668265263) ^ Math.imul(seed | 0, 974711);
    hh = Math.imul(hh ^ (hh >>> 13), 1274126177);
    hh ^= hh >>> 16;
    return (hh >>> 0) / 4294967295;
  };
  const pnoise = (x, z, seed) => { // 周期化双线性值噪声（x,z ∈ 格点单位）
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz, ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = h2(ix, iz, seed), b = h2(ix + 1, iz, seed), c = h2(ix, iz + 1, seed), d = h2(ix + 1, iz + 1, seed);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  };
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const u = (i / S) * P, v = (j / S) * P;
      // 四层周期噪声：细颗粒 + 中尺度斑驳 + 斜向纹理 + 沿 u 拉长的冲沟条纹
      //（冲沟项各向异性 5:1：u*2.5 / v*0.5 的参数跨度均为 P 的整数倍，保证可平铺无缝）
      const gully = 1 - Math.abs(2 * pnoise(u * 2.5, v * 0.5, 53) - 1);
      let n = 0.42 * pnoise(u * 4, v * 4, 11)
        + 0.26 * pnoise(u, v, 23)
        + 0.14 * (1 - Math.abs(2 * pnoise(u * 2, v * 2, 37) - 1))
        + 0.18 * gully * gully;
      n = 0.6 + 0.4 * n; // 0.60..1.0 亮度（乘法细节，避免过暗）
      const b = Math.round(255 * Math.min(n, 1));
      const k = (j * S + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  detailTex = new THREE.CanvasTexture(cv);
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  detailTex.anisotropy = 4;
  return detailTex;
}

const C = {
  grass: [0.32, 0.45, 0.24], grassDry: [0.45, 0.5, 0.3],
  sand: [0.76, 0.68, 0.5], dune: [0.78, 0.66, 0.44],
  rock: [0.48, 0.43, 0.38], rockDark: [0.36, 0.33, 0.3],
  snow: [0.93, 0.94, 0.96], seabed: [0.3, 0.34, 0.3],
  forest: [0.16, 0.27, 0.13], // 植被带深绿（与 scenery.js 树冠同族色）
  scrub: [0.35, 0.39, 0.22],  // 沙漠绿洲橄榄色
};

function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 顶点着色：h 相对跑道面高度、slope 为 |∇h| 近似、waterLevel 水面高 */
function terrainColor(a, h, slope, x, z, waterLevel) {
  const s = a.terrainSeed;
  const v = fbm(x / 300, z / 300, s + 77, 2); // 细碎色斑
  let c;
  switch (a.terrainType) {
    case 'desert':
      c = mix3(C.dune, C.sand, v);
      if (h > 180) c = mix3(c, C.rock, smoothstep(180, 400, h));
      // 绿洲暗斑（与 scenery.js 绿洲灌丛同源噪声：树丛落在色斑上）
      {
        const oasis = fbm(x / 1500, z / 1500, s + 95, 2);
        if (oasis > 0.6) c = mix3(c, C.scrub, smoothstep(0.6, 0.8, oasis) * 0.5);
      }
      break;
    case 'canyon': {
      c = mix3(C.grass, C.grassDry, v);
      // 河谷条带林远景色块（与 scenery.js 河道林带同源；岩石/雪在其上覆盖）
      const rz = 140 * Math.sin(x / 4200) + 120 * (fbm(x / 2200, 7.7, s + 9, 2) - 0.5) * 2;
      const veg = 1 - smoothstep(120, 750, Math.abs(z - rz));
      c = mix3(c, C.forest, veg * 0.85);
      c = mix3(c, C.rock, smoothstep(0.45, 0.85, slope));
      c = mix3(c, C.rockDark, smoothstep(700, 1100, h));
      c = mix3(c, C.snow, smoothstep(1500, 1680, h + 60 * v));
      break;
    }
    case 'island':
      c = mix3(C.grass, C.grassDry, v * 0.7);
      // 山麓密林远景色块（高处渐稀，崖壁保持岩色）
      {
        const veg = (1 - smoothstep(380, 720, h)) * (1 - smoothstep(0.5, 0.9, slope)) * 0.8;
        c = mix3(c, C.forest, veg);
      }
      c = mix3(c, C.rock, smoothstep(0.6, 1.0, slope));
      c = mix3(c, C.rockDark, smoothstep(700, 1100, h));
      break;
    case 'bay':
      c = mix3(C.grassDry, C.grass, v);
      c = mix3(c, C.forest, smoothstep(0.5, 0.72, fbm(x / 380, z / 380, s + 96, 2)) * 0.55);
      c = mix3(c, C.rock, smoothstep(0.55, 0.95, slope));
      break;
    default: // plain
      c = mix3(C.grass, C.grassDry, v);
      // 成片树丛底色（与 scenery.js clump 同源噪声）
      c = mix3(c, C.forest, smoothstep(0.5, 0.72, fbm(x / 380, z / 380, s + 96, 2)) * 0.55);
      c = mix3(c, C.rock, smoothstep(0.7, 1.1, slope));
      break;
  }
  if (waterLevel !== null) {
    // 岸滩沙带
    c = mix3(C.sand, c, smoothstep(waterLevel + 2, waterLevel + 9, h));
    // 水下压暗
    if (h < waterLevel) c = mix3(c, C.seabed, 0.7);
  }
  // 【冲沟增强】陡坡上叠 ridged 暗纹（汇水线变暗、沟脊留亮），各类地形通用
  if (slope > 0.35) {
    const g = ridgedFbm(x / 150, z / 150, s + 87, 2);
    c = mix3(c, C.rockDark, 0.3 * g * smoothstep(0.35, 0.75, slope));
  }
  return c;
}

/* =========================================================
 * 跟随飞机的地形网格（内环 + 外环带孔 + 水面）
 * ========================================================= */

/** 内环参数：尺寸/分段（面数预算见文件头） */
const INNER_SIZE = 10240, INNER_N = 96;
/** 外环参数 */
const OUTER_SIZE = 65536, OUTER_N = 128;

/**
 * 创建地形（含水面）。返回 update/dispose 句柄。
 * @param {THREE.Scene} scene
 * @param {Object} airport AIRPORTS 成员
 */
export function createTerrain(scene, airport) {
  const waterLevel = airport.waterLevelRel;

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: getDetailTexture() });
  const innerGeo = new THREE.PlaneGeometry(INNER_SIZE, INNER_SIZE, INNER_N, INNER_N);
  innerGeo.rotateX(-Math.PI / 2); // 平面 → 水平（+y 上）
  innerGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(innerGeo.attributes.position.count * 3), 3));
  const inner = new THREE.Mesh(innerGeo, mat);
  inner.frustumCulled = false;
  scene.add(inner);

  const outerGeo = buildRingGeometry(OUTER_SIZE, OUTER_N, INNER_SIZE / 2);
  const outer = new THREE.Mesh(outerGeo, mat);
  outer.frustumCulled = false;
  scene.add(outer);

  // 水面（可选）
  let water = null;
  if (waterLevel !== null) {
    const wGeo = new THREE.PlaneGeometry(OUTER_SIZE, OUTER_SIZE);
    wGeo.rotateX(-Math.PI / 2);
    const wMat = new THREE.MeshPhongMaterial({
      color: 0x2a5d7d, shininess: 90, specular: 0x445566,
    });
    water = new THREE.Mesh(wGeo, wMat);
    water.position.y = waterLevel;
    water.frustumCulled = false;
    scene.add(water);
  }

  let innerCX = NaN, innerCZ = NaN, outerCX = NaN, outerCZ = NaN;

  /** 仿真坐标 → 高度（内部先转机场本地系，localHeight 只吃本地坐标） */
  function simHeight(wx, wz) {
    const { lx, lz } = worldToAirport(airport, wx, wz);
    return localHeight(lx, lz, airport);
  }

  /** 重建内环：采样 terrainHeight 至顶点 y + 着色 + 法线 */
  function rebuildInner(cx, cz) {
    const pos = innerGeo.attributes.position;
    const col = innerGeo.attributes.color;
    const uv = innerGeo.attributes.uv;
    const n = INNER_N + 1;
    const step = INNER_SIZE / INNER_N;
    // 先采样高度
    const hs = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const wx = cx + pos.getX(j * n + i);
        const wz = cz + pos.getZ(j * n + i);
        hs[j * n + i] = simHeight(wx, wz);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const wx = cx + pos.getX(idx);
        const wz = cz + pos.getZ(idx);
        pos.setY(idx, hs[idx]);
        // 【纹理层】世界坐标锚定 UV：重建/平移不游移
        uv.setXY(idx, wx / UV_TILE, wz / UV_TILE);
        // 坡度：与邻点最大高差 / 间距
        const hL = hs[j * n + Math.max(i - 1, 0)], hR = hs[j * n + Math.min(i + 1, n - 1)];
        const hD = hs[Math.max(j - 1, 0) * n + i], hU = hs[Math.min(j + 1, n - 1) * n + i];
        const slope = Math.max(Math.abs(hR - hL), Math.abs(hU - hD)) / (2 * step);
        const c = terrainColor(airport, hs[idx], slope, wx, wz, waterLevel);
        col.setXYZ(idx, c[0], c[1], c[2]);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    uv.needsUpdate = true;
    innerGeo.computeVertexNormals();
    inner.position.set(cx, 0, cz);
  }

  /** 重建外环（粗略，3 octave + 同源 ridged 项） */
  function rebuildOuter(cx, cz) {
    const pos = outerGeo.attributes.position;
    const col = outerGeo.attributes.color;
    const uv = outerGeo.attributes.uv;
    const cnt = pos.count;
    for (let k = 0; k < cnt; k++) {
      const wx = cx + pos.getX(k);
      const wz = cz + pos.getZ(k);
      // 粗略高度：直接 fbm 近似（外环远，细节无感）；pad 内仍压平避免边缘穿帮
      const h = outerHeight(wx, wz, airport);
      pos.setY(k, h);
      uv.setXY(k, wx / UV_TILE, wz / UV_TILE);
      const slope = 0; // 远环不按坡度着色
      const c = terrainColor(airport, h, slope, wx, wz, waterLevel);
      col.setXYZ(k, c[0], c[1], c[2]);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    uv.needsUpdate = true;
    outerGeo.computeVertexNormals();
    outer.position.set(cx, 0, cz);
  }

  function update(camX, camZ) {
    const stepIn = INNER_SIZE / INNER_N;
    if (!Number.isFinite(innerCX) || Math.abs(camX - innerCX) >= stepIn * 0.9 || Math.abs(camZ - innerCZ) >= stepIn * 0.9) {
      innerCX = Math.round(camX / stepIn) * stepIn;
      innerCZ = Math.round(camZ / stepIn) * stepIn;
      rebuildInner(innerCX, innerCZ);
    }
    const stepOut = OUTER_SIZE / OUTER_N;
    if (!Number.isFinite(outerCX) || Math.abs(camX - outerCX) >= stepOut * 0.9 || Math.abs(camZ - outerCZ) >= stepOut * 0.9) {
      outerCX = Math.round(camX / stepOut) * stepOut;
      outerCZ = Math.round(camZ / stepOut) * stepOut;
      rebuildOuter(outerCX, outerCZ);
    }
    if (water) {
      water.position.x = Math.round(camX / 512) * 512;
      water.position.z = Math.round(camZ / 512) * 512;
    }
  }

  function dispose() {
    scene.remove(inner, outer);
    innerGeo.dispose();
    outerGeo.dispose();
    mat.dispose();
    if (water) {
      scene.remove(water);
      water.geometry.dispose();
      water.material.dispose();
    }
  }

  update(0, 0);

  /** 调试：中心顶点的高度与颜色 + 网格中心 */
  function debug() {
    const n = INNER_N + 1;
    const idx = Math.floor(n / 2) * n + Math.floor(n / 2);
    const col = innerGeo.attributes.color;
    const posA = innerGeo.attributes.position;
    return {
      innerCX, innerCZ,
      y: posA.getY(idx),
      rgb: [col.getX(idx).toFixed(2), col.getY(idx).toFixed(2), col.getZ(idx).toFixed(2)],
    };
  }

  return { update, dispose, debug };
}

/** 外环粗略高度（少 octave；pad 区域压平，水下区域取水下高度） */
function outerHeight(wx, wz, a) {
  const { lx, lz } = worldToAirport(a, wx, wz);
  const s = a.terrainSeed;
  // 通用粗略形：中尺度起伏 + 按类型给大形（山/海）
  let h = 40 * fbm(wx / 4200, wz / 4200, s, 3) - 20;
  const dx = Math.max(-1800 - lx, 0, lx - (a.runwayLength + 1800));
  const dz = Math.max(-800 - lz, 0, lz - 800);
  const padT = 1 - sstep(Math.hypot(dx, dz) / 2600);
  h *= (1 - padT);
  if (a.terrainType === 'canyon') {
    h += (1250 + 200) * smoothstep(1600, 5400, Math.abs(lz)) * (1 - padT);
    h += ridgeDetail(lx, lz, s + 61, h, 110) * (1 - padT); // 与内环同源，避免接缝
  } else if (a.terrainType === 'island') {
    const inWater = waterRegionLocal(lx, lz, a);
    h = inWater ? -30 : h + 900 * smoothstep(-300, 6000, lx) * (1 - padT);
    if (!inWater) h += ridgeDetail(lx, lz, s + 63, h, 90) * (1 - padT);
  } else if (a.terrainType === 'bay' || a.terrainType === 'plain') {
    if (waterRegionLocal(lx, lz, a)) h = -35;
  } else if (a.terrainType === 'desert') {
    h += 300 * smoothstep(-14000, -24000, lx) * (1 - padT);
  }
  return h;
}

/** 外环带孔网格：128×128 网格挖去完全落在内环范围内的四边形 */
function buildRingGeometry(size, n, holeHalf) {
  const step = size / n;
  const verts = [];
  const cols = [];
  const idx = [];
  const half = size / 2;
  // 顶点集 = 全网格；仅生成保留四边形的索引（顶点冗余可接受，换实现简单）
  const n1 = n + 1;
  for (let j = 0; j < n1; j++) {
    for (let i = 0; i < n1; i++) {
      verts.push(-half + i * step, 0, -half + j * step);
      cols.push(1, 1, 1);
    }
  }
  const halfQ = holeHalf + step; // 略扩，避免接缝穿帮
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step, z0 = -half + j * step;
      if (Math.abs(x0) <= halfQ && Math.abs(x0 + step) <= halfQ &&
          Math.abs(z0) <= halfQ && Math.abs(z0 + step) <= halfQ) continue; // 孔内
      const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n1 * n1 * 2), 2));
  g.setIndex(idx);
  // 顶点直接按 (x, 0, z) 水平面生成，无需 rotateX（与 PlaneGeometry.rotateX 后的约定一致）
  return g;
}
