/**
 * scenery.js — 单元 3（外部世界）· 环境精细化散布层。
 *
 * 在地形/机场之上叠加四类静态地物（全部确定性生成，无 Math.random）：
 *  1. **植被**：3 种树形（针叶两级锥、阔叶团冠、海岛棕榈）+ 灌丛暗斑，
 *     InstancedMesh 渲染（每种 1 draw call），分布由 terrainHeight/坡度/高度带 +
 *     成片簇噪声驱动：枢纽/海湾平原草地成片稀疏树、峡谷河谷条带林、
 *     海岛山地密林、沙漠绿洲零星灌丛。跑道净空区（含枢纽第二跑道带）不长树。
 *  2. **建筑群**：机场周边 2-5 km 盒子+屋顶双色小建筑（合并几何 1 draw call），
 *     枢纽/海湾多且高（城区感）、沙漠稀疏。
 *  3. **道路**：深色贴地长条从机场围界连到各建筑簇（随地形起伏采样，遇水截断）。
 *  4. **浪花岸线**：沿 terrain.shorePolylines 的浅色半透明条带（水面 +0.22 m）。
 *
 * ── 面数预算（≤ +40k 三角，实测见 dev 页 renderer.info）──────────────
 *  树：针叶 34 tri × ~550 + 阔叶 28 tri × ~350 + 棕榈 22 tri × ~200 ≈ 31k（最重峡谷/海岛）
 *  灌丛：20 tri × ~240 ≈ 4.8k；建筑 ~24 tri × 40 ≈ 1k；道路+浪花 ≈ 2k
 *  Draw calls 新增：树 ≤3 + 灌丛 1 + 建筑 1 + 道路 1 + 浪花 1 = ≤7
 * ─────────────────────────────────────────────────────────────────────
 *
 * @module world/scenery
 */

import * as THREE from 'three';
import { localHeight, fbm, smoothstep, shorePolylines } from './terrain.js';

/* =========================================================
 * 小工具：确定性 PRNG + 几何合并（顶点色）
 * ========================================================= */

/** mulberry32 PRNG（种子确定性） */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 给几何体涂单色顶点色（可选矩阵变换），返回非索引几何（供合并）。
 */
export function colorPart(geo, color, matrix) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (matrix) g.applyMatrix4(matrix);
  const cnt = g.attributes.position.count;
  const col = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) {
    col[i * 3] = color[0]; col[i * 3 + 1] = color[1]; col[i * 3 + 2] = color[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** 合并多个带 position/normal/color 的非索引几何（合并后释放源几何） */
export function mergeColored(parts) {
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/* =========================================================
 * 植被几何（模块级缓存：跨机场/跨 world 重建复用）
 * ========================================================= */

let TREE_GEOS = null;
let VEG_MAT = null;

function getVegAssets() {
  if (TREE_GEOS) return TREE_GEOS;
  // 针叶树：树干（5 棱柱，10 tri）+ 两级开口圆锥（7 棱 ×2，14 tri）= 24 tri
  const conifer = mergeColored([
    colorPart(new THREE.CylinderGeometry(0.26, 0.42, 3.4, 5, 1, true).translate(0, 1.7, 0), [0.34, 0.24, 0.16]),
    colorPart(new THREE.ConeGeometry(2.7, 5.4, 7, 1, true).translate(0, 5.4, 0), [0.15, 0.29, 0.13]),
    colorPart(new THREE.ConeGeometry(1.8, 3.8, 7, 1, true).translate(0, 8.8, 0), [0.19, 0.35, 0.15]),
  ]);
  // 阔叶树：树干（4 棱柱，8 tri）+ 团冠两个二十面体（40 tri）= 48 tri
  const broadleaf = mergeColored([
    colorPart(new THREE.CylinderGeometry(0.3, 0.46, 3.8, 4, 1, true).translate(0, 1.9, 0), [0.4, 0.29, 0.19]),
    colorPart(new THREE.IcosahedronGeometry(2.7, 0).scale(1, 0.82, 1).translate(0, 5.6, 0), [0.23, 0.38, 0.16]),
    colorPart(new THREE.IcosahedronGeometry(1.6, 0).translate(1.3, 4.3, 0.6), [0.27, 0.42, 0.18]),
  ]);
  // 棕榈：弯干近似直干（4 棱柱）+ 7 片叶面（14 tri）= 22 tri
  const palmParts = [colorPart(new THREE.CylinderGeometry(0.16, 0.3, 7.2, 4, 1, true).translate(0, 3.6, 0), [0.45, 0.36, 0.24])];
  for (let k = 0; k < 7; k++) {
    const blade = new THREE.PlaneGeometry(0.85, 3.6);
    blade.translate(0, 0, 1.8);          // 叶根在原点、叶尖朝外
    blade.rotateX(-1.25);                // 下垂
    blade.translate(0, 7.1, 0);
    blade.rotateY((k / 7) * Math.PI * 2);
    palmParts.push(colorPart(blade, [0.2, 0.42, 0.2]));
  }
  const palm = mergeColored(palmParts);
  // 灌丛：压扁二十面体暗斑（20 tri）
  const shrub = mergeColored([
    colorPart(new THREE.IcosahedronGeometry(1.5, 0).scale(1.5, 0.75, 1.5).translate(0, 0.6, 0), [0.16, 0.24, 0.12]),
  ]);
  TREE_GEOS = { conifer, broadleaf, palm, shrub };
  if (!VEG_MAT) {
    // 顶点色 Lambert；叶面 Plane 需双面
    VEG_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  return TREE_GEOS;
}

/** 跑道净空区判定：跑道矩形（含枢纽第二跑道带）外扩禁植。返回到净空区矩形
 *  边界的距离（净空区内为 0，越大越远）。 */
function padClearance(lx, lz, a) {
  const dzPad = a.dualRunway ? 1750 : 950; // 第二条平行跑道在 z=±800 之外再留余量
  const dx = Math.max(-1950 - lx, 0, lx - (a.runwayLength + 1950));
  const dz = Math.max(-dzPad - lz, 0, lz - dzPad);
  return Math.hypot(dx, dz); // ≥160 才允许植树（调用方门控）
}

/* =========================================================
 * 植被分布（按地形类型 + 高度带 + 坡度 + 成片簇噪声）
 * ========================================================= */

/** 各地形类型的植被配置：采样区间 / 目标株数 / 接受规则 / 株高倍率 */
const VEG_CFG = {
  plain: { // 枢纽平原：草地成片稀疏树林（簇噪声门控）+ 机场周边草环树丛
    x0: -11000, x1: 10500, z0: -8500, z1: 8300,
    trees: 700, shrubs: 260, scaleMul: 1.0, ring: true,
    accept(lx, lz, h, slope, a) {
      if (h < 2 || h > 110 || slope > 0.2) return 0;
      const grove = fbm(lx / 1000, lz / 1000, a.terrainSeed + 91, 2);
      return grove > 0.5 ? 0.95 : 0.05;
    },
    kind(h, slope, r) { return (h > 60 || slope > 0.12) && r < 0.55 ? 'conifer' : 'broadleaf'; },
  },
  canyon: { // 峡谷：河谷条带林（越近河越密），山腰零星针叶；株高放大（峡谷巨树）
    x0: -22000, x1: 14500, z0: -2600, z1: 2600,
    trees: 1000, shrubs: 120, scaleMul: 1.5,
    accept(lx, lz, h, slope, a) {
      if (h < 0.5 || h > 420 || slope > 0.62) return 0;
      const rz = 140 * Math.sin(lx / 4200) + 120 * (fbm(lx / 2200, 7.7, a.terrainSeed + 9, 2) - 0.5) * 2;
      const near = 1 - smoothstep(140, 900, Math.abs(lz - rz)); // 与 waterRegionLocal 同源河道
      return 0.9 * near + 0.08;
    },
    kind(h, slope, r) { return r < 0.78 ? 'conifer' : 'broadleaf'; },
  },
  island: { // 海岛：山地密林（低海拔混棕榈，高处针叶，>500 m 渐稀）；无灌丛（海岛 draw call 余量让给云层）
    x0: -1500, x1: 9500, z0: -6500, z1: 9500,
    trees: 950, shrubs: 0, scaleMul: 1.3,
    accept(lx, lz, h, slope, a) {
      if (h < 1.2 || h > 760 || slope > 0.72) return 0;
      const dense = fbm(lx / 1100, lz / 1100, a.terrainSeed + 93, 2);
      return (0.6 + dense * 0.4) * (1 - smoothstep(450, 760, h) * 0.75);
    },
    kind(h, slope, r) {
      if (h < 60 && r < 0.3) return 'palm';
      return h > 350 || r > 0.82 ? 'conifer' : 'broadleaf';
    },
  },
  bay: { // 海湾：沿岸草地疏林 + 丘陵灌丛 + 机场周边草环树丛
    x0: -4600, x1: 9200, z0: -2500, z1: 2500,
    trees: 600, shrubs: 210, scaleMul: 1.1, ring: true,
    accept(lx, lz, h, slope, a) {
      if (h < 1.5 || h > 140 || slope > 0.3) return 0;
      const grove = fbm(lx / 850, lz / 850, a.terrainSeed + 92, 2);
      return grove > 0.48 ? 0.6 : 0.05;
    },
    kind(h, slope, r) { return h > 70 && r < 0.5 ? 'conifer' : 'broadleaf'; },
  },
  desert: { // 沙漠：绿洲灌丛（簇噪声 > 0.62 处成小片），零星棕榈
    x0: -11000, x1: 12500, z0: -6500, z1: 6500,
    trees: 120, shrubs: 260, scaleMul: 0.9,
    accept(lx, lz, h, slope, a) {
      if (h < -6 || h > 60 || slope > 0.35) return 0;
      const oasis = fbm(lx / 1500, lz / 1500, a.terrainSeed + 95, 2);
      return oasis > 0.62 ? 0.45 : 0.015;
    },
    kind(h, slope, r) { return r < 0.25 ? 'palm' : 'broadleaf'; },
  },
};

/**
 * 拒绝采样散布植被。attempts 上限内每候选做 1 次高度 + 4 次坡度采样，
 * 接受概率 × PRNG 门控；返回各形态实例位姿列表。
 */
function distributeVegetation(a) {
  const cfg = VEG_CFG[a.terrainType];
  const rand = mulberry32(a.terrainSeed * 7919 + 37);
  const out = { conifer: [], broadleaf: [], palm: [], shrub: [] };
  const hR = (lx, lz) => localHeight(lx, lz, a);
  let treesLeft = cfg.trees, shrubsLeft = cfg.shrubs;
  const attempts = Math.max(cfg.trees, cfg.shrubs) * 9;
  for (let i = 0; i < attempts && (treesLeft > 0 || shrubsLeft > 0); i++) {
    const lx = cfg.x0 + rand() * (cfg.x1 - cfg.x0);
    const lz = cfg.z0 + rand() * (cfg.z1 - cfg.z0);
    const padDist = padClearance(lx, lz, a);
    if (padDist < 160) continue; // 净空区（含第二跑道）禁植
    const h = hR(lx, lz);
    if (a.waterLevelRel !== null && h < a.waterLevelRel + 1.5) continue; // 水下/滩面
    const e = 55;
    const sx = hR(lx + e, lz) - hR(lx - e, lz);
    const sz = hR(lx, lz + e) - hR(lx, lz - e);
    const slope = Math.hypot(sx, sz) / (2 * e);
    // 近场加密：机场周边 2.2-7 km 环带内接受概率 ×2（进近视角可见性）
    const nearBoost = 1 + 1.2 * (1 - smoothstep(2200, 7000, padDist));
    // 400 m 尺度成片簇：树集中在林斑里（远处看是冠层色块，近处是林缘）
    const clump = fbm(lx / 380, lz / 380, a.terrainSeed + 96, 2);
    const clumpMul = clump > 0.54 ? 1.7 : clump > 0.44 ? 0.8 : 0.12;
    let acc = cfg.accept(lx, lz, h, slope, a) * nearBoost * clumpMul;
    // 枢纽/海湾：机场周边 4.5 km 草环保底树丛（保证进近视野有植被）
    if (cfg.ring && padDist < 4500) acc = Math.max(acc, 0.09);
    const r = rand();
    // 树
    if (treesLeft > 0 && r < acc) {
      const kind = cfg.kind(h, slope, rand());
      out[kind].push({
        x: lx, y: h - 0.25, z: lz,
        s: (0.8 + rand() * 0.8) * (cfg.scaleMul || 1),
        rot: rand() * Math.PI * 2,
        tint: 0.82 + rand() * 0.32,
      });
      treesLeft--;
      continue;
    }
    // 灌丛（耐坡度， anywhere 植被带内）
    if (shrubsLeft > 0 && slope < 0.85 && rand() < 0.32) {
      out.shrub.push({
        x: lx, y: h - 0.15, z: lz,
        s: (0.7 + rand() * 1.1) * (cfg.scaleMul || 1),
        rot: rand() * Math.PI * 2,
        tint: 0.8 + rand() * 0.3,
      });
      shrubsLeft--;
    }
  }
  return out;
}

/** 建实例化网格（共享几何/材质，仅实例矩阵与染色独立）；数量为 0 则跳过。 */
function plantInstances(group, geo, items, disposables) {
  if (!items.length) return null;
  const im = new THREE.InstancedMesh(geo, VEG_MAT, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), sc = new THREE.Vector3(), tint = new THREE.Color();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    e.set(0, it.rot, 0);
    q.setFromEuler(e);
    p.set(it.x, it.y, it.z);
    sc.set(it.s, it.s * (0.92 + (i % 5) * 0.04), it.s); // 高度微差，避免剪影完全一致
    m4.compose(p, q, sc);
    im.setMatrixAt(i, m4);
    tint.setScalar(it.tint);
    im.setColorAt(i, tint);
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.frustumCulled = false; // 散布范围大，免每帧重算包围球
  group.add(im);
  disposables.push(im);
  return im;
}

/* =========================================================
 * 建筑群 + 道路
 * ========================================================= */

/** 各类型建筑簇配置（机场本地坐标；n=栋数，tall=允许高层） */
const CITY_CFG = {
  plain: [
    { cx: -4200, cz: -2000, n: 16, tall: true },  // 跑道西侧高地（离场/俯视的"城区"天际线）
    { cx: -6600, cz: -1500, n: 10, tall: false },
    { cx: -7100, cz: 1800, n: 8, tall: false },
  ],
  bay: [
    { cx: 1400, cz: -1250, n: 13, tall: true },   // 决断高视角前方 ~1.3 km（雾中剪影）
    { cx: -3400, cz: 1200, n: 9, tall: false },
  ],
  canyon: [{ cx: -2900, cz: 1100, n: 7, tall: false }],
  island: [], // 海岛除净空区外皆为山地（无平地可建，马德拉式特征），不放建筑群
  desert: [{ cx: -3000, cz: 1500, n: 5, tall: false }],
};

const WALL_COLS = [[0.62, 0.6, 0.55], [0.7, 0.66, 0.58], [0.55, 0.56, 0.58], [0.66, 0.6, 0.52]];
const ROOF_COLS = [[0.32, 0.3, 0.28], [0.42, 0.3, 0.24], [0.3, 0.34, 0.36]];

function buildBuildings(a, disposables) {
  const rand = mulberry32(a.terrainSeed * 104729 + 11);
  const parts = [];
  const clusters = [];
  for (const c of CITY_CFG[a.terrainType] || []) {
    const placed = [];
    for (let i = 0; i < c.n; i++) {
      const gx = c.cx + ((i % 4) - 1.5) * 85 + (rand() - 0.5) * 44;
      const gz = c.cz + (Math.floor(i / 4) - 1) * 85 + (rand() - 0.5) * 44;
      if (padClearance(gx, gz, a) < 120) continue;
      const h = localHeight(gx, gz, a);
      if (a.waterLevelRel !== null && h < a.waterLevelRel + 1) continue;
      const e = 40;
      const slope = Math.hypot(localHeight(gx + e, gz, a) - localHeight(gx - e, gz, a),
        localHeight(gx, gz + e, a) - localHeight(gx, gz - e, a)) / (2 * e);
      if (slope > 0.16) continue;
      const w = 10 + rand() * 12, d = 10 + rand() * 12;
      const bh = (c.tall && rand() < 0.3 ? 16 + rand() * 14 : 5 + rand() * 8);
      const wall = WALL_COLS[(rand() * WALL_COLS.length) | 0];
      const roof = ROOF_COLS[(rand() * ROOF_COLS.length) | 0];
      const y0 = h - 1.2; // 基础沉入地形 1.2 m
      parts.push(colorPart(new THREE.BoxGeometry(w, bh, d).translate(gx, y0 + bh / 2, gz), wall));
      parts.push(colorPart(new THREE.BoxGeometry(w + 1, 0.8, d + 1).translate(gx, y0 + bh + 0.4, gz), roof));
      placed.push({ x: gx, z: gz });
    }
    if (placed.length) clusters.push({ center: placed[0], n: placed.length });
  }
  return { parts, clusters };
}

/** 道路：从机场围界最近点到各簇中心的贴地深色条带（遇水截断）。 */
function buildRoads(a, clusters, disposables) {
  const pos = [], col = [], idx = [];
  let v = 0;
  const L = a.runwayLength;
  for (const c of clusters) {
    const sx = Math.max(-1800, Math.min(L + 1800, c.x));
    const sz = Math.max(-900, Math.min(900, c.z));
    const dx = c.x - sx, dz = c.z - sz;
    const len = Math.hypot(dx, dz);
    if (len < 300) continue;
    const nx = -dz / len, nz = dx / len; // 横向
    const seg = Math.ceil(len / 140);
    let prev = null;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const x = sx + dx * t, z = sz + dz * t;
      const h = localHeight(x, z, a);
      if (a.waterLevelRel !== null && h < a.waterLevelRel + 0.4) break; // 遇水截断（桥留白）
      const w = 4.2;
      if (prev) {
        pos.push(prev.x - nx * w, prev.y, prev.z - nz * w, prev.x + nx * w, prev.y, prev.z + nz * w,
          x - nx * w, h + 0.09, z - nz * w, x + nx * w, h + 0.09, z + nz * w);
        const shade = 0.16 + 0.03 * ((i % 3) / 2);
        for (let k = 0; k < 4; k++) col.push(shade, shade, shade * 1.05);
        idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        v += 4;
      }
      prev = { x, z, y: h + 0.09 };
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  disposables.push(g);
  return new THREE.Mesh(g, getRoadMat());
}

let ROAD_MAT = null;
function getRoadMat() {
  if (!ROAD_MAT) ROAD_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
  return ROAD_MAT;
}

/* =========================================================
 * 浪花岸线
 * ========================================================= */

let SURF_MAT = null;
function getSurfMat() {
  if (!SURF_MAT) {
    SURF_MAT = new THREE.MeshBasicMaterial({
      color: 0xdfeef4, transparent: true, opacity: 0.55, depthWrite: false,
    });
  }
  return SURF_MAT;
}

/** 沿岸线折线生成浪花条带（宽 18-42 m 随噪声起伏，偏向水体一侧）。 */
function buildSurf(a, disposables) {
  if (a.waterLevelRel === null) return null;
  const lines = shorePolylines(a);
  const pos = [], col = [], idx = [];
  let v = 0;
  const y = a.waterLevelRel + 0.22;
  for (const line of lines) {
    const { pts, wx, wz } = line;
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
      const tx = x1 - x0, tz = z1 - z0;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;         // 折线法向
      const w = 24 + 16 * fbm(i * 0.31, 0.53, a.terrainSeed + 97, 2);
      // 条带中心偏向水体侧（wx/wz 提示方向与法向同号时取正）
      const side = (nx * wx + nz * wz) >= 0 ? 1 : -1;
      const ox = nx * side * w * 0.3, oz = nz * side * w * 0.3;
      const hx0 = x0 + ox, hz0 = z0 + oz, hx1 = x1 + ox, hz1 = z1 + oz;
      pos.push(hx0 - nx * w / 2, y, hz0 - nz * w / 2, hx0 + nx * w / 2, y, hz0 + nz * w / 2,
        hx1 - nx * w / 2, y, hz1 - nz * w / 2, hx1 + nx * w / 2, y, hz1 + nz * w / 2);
      for (let k = 0; k < 4; k++) col.push(0.88, 0.94, 0.96);
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      v += 4;
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  disposables.push(g);
  const mesh = new THREE.Mesh(g, getSurfMat());
  mesh.frustumCulled = false;
  return mesh;
}

/* =========================================================
 * 总装
 * ========================================================= */

/**
 * 构建环境散布层（植被/建筑/道路/浪花），加入机场本地系容器。
 * @param {THREE.Object3D} group 机场本地系容器（index.js 的 group）
 * @param {Object} airport AIRPORTS 成员
 * @returns {{ dispose: () => void, stats: Object }} stats 含各形态实例数与三角估算
 */
export function buildScenery(group, airport) {
  const a = airport;
  const disposables = [];
  const veg = distributeVegetation(a);
  const assets = getVegAssets();

  plantInstances(group, assets.conifer, veg.conifer, disposables);
  plantInstances(group, assets.broadleaf, veg.broadleaf, disposables);
  plantInstances(group, assets.palm, veg.palm, disposables);
  plantInstances(group, assets.shrub, veg.shrub, disposables);

  const { parts, clusters } = buildBuildings(a, disposables);
  if (parts.length) {
    const geo = mergeColored(parts);
    disposables.push(geo);
    const bMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    disposables.push(bMat);
    group.add(new THREE.Mesh(geo, bMat));
  }

  const roadMesh = buildRoads(a, clusters.map((c) => ({ x: c.center.x, z: c.center.z })), disposables);
  if (roadMesh) group.add(roadMesh);

  const surf = buildSurf(a, disposables);
  if (surf) group.add(surf);

  const tri = veg.conifer.length * 34 + veg.broadleaf.length * 48 + veg.palm.length * 22 +
    veg.shrub.length * 20 + parts.length * 12;

  function dispose() {
    for (const d of disposables) d.dispose?.();
    // 共享缓存（TREE_GEOS/VEG_MAT/ROAD_MAT/SURF_MAT）跨 world 复用，不在此释放
  }

  return {
    dispose,
    stats: {
      conifer: veg.conifer.length, broadleaf: veg.broadleaf.length,
      palm: veg.palm.length, shrub: veg.shrub.length,
      buildings: parts.length / 2, clusters: clusters.length,
      trisEst: tri,
    },
  };
}
