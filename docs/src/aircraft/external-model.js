/**
 * src/aircraft/external-model.js — 737-800 程序化外部模型（外部追机视角用）。
 *
 * 导出合同：
 *   buildExternalAircraft() → { group, update(state, dt) }
 *     group  挂载约定：g.position.y = 3.0（机身中线离地高，y=0=跑道面=轮底），
 *            由模块内部设置，main.js 只需 aircraft.add(em.group)。
 *     update(state, dt)  每帧调用：只读 state（gear.position / engines[n].n1），
 *            起落架收放（只改 transform，零对象创建）、发动机风扇转动。
 *
 * 建模口径（真 737-800 比例，米）：
 *   全长 39.5 / 翼展 35.8（含翼梢小翼）/ 机高 12.5 / 机身直径 3.76
 *   坐标：-z 机头，+z 机尾，y 上；group 原点 = 机身中线。
 *
 * 全部 THREE 程序化几何 + 一张 Canvas 程序涂装贴图（无外部模型/贴图文件）。
 * 性能预算：整机 ≈5k 三角（≤25k），材质 5 种（≤10），每帧零分配。
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;

/* =========================================================
 * 材质（5 种，模块内单例；低模也要有"金属感区分"：机身/机翼/发动机
 * 用不同 metalness-roughness 组合，杜绝塑料纯色感）
 * ========================================================= */
const MATERIALS = {
  // 机身：程序涂装 Canvas 贴图（白/腹灰/蓝条纹/舷窗/风挡）
  fus: new THREE.MeshStandardMaterial({
    map: null, metalness: 0.25, roughness: 0.38, side: THREE.DoubleSide,
  }),
  // 机翼/平尾/短舱吊架/翼身整流罩：浅暖白
  white: new THREE.MeshStandardMaterial({
    color: 0xe9edf0, metalness: 0.3, roughness: 0.48, side: THREE.DoubleSide,
  }),
  // 垂尾/翼梢小翼：深航空蓝
  blue: new THREE.MeshStandardMaterial({
    color: 0x14396e, metalness: 0.35, roughness: 0.4, side: THREE.DoubleSide,
  }),
  // 轮胎/风扇盘/轮舱贴地片/防撞灯：近黑
  dark: new THREE.MeshStandardMaterial({
    color: 0x171d24, metalness: 0.2, roughness: 0.75, side: THREE.DoubleSide,
  }),
  // 减震柱/轮毂/进气唇口/尾锥：金属
  metal: new THREE.MeshStandardMaterial({
    color: 0x9aa4ad, metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide,
  }),
};

/* =========================================================
 * 程序涂装：机身 Canvas 贴图（2048×512）
 *  u: 机头(0) → 机尾(1)；v: 机腹(0) → 右侧(0.25) → 机背(0.5) → 左侧(0.75) → 机腹(1)
 *  经典涂装：白机身 + 腹灰 + 蓝色腰线（贴图随 v 角度自然随机尾上翘起伏）+ 舷窗带
 * ========================================================= */
function buildFuselageTexture() {
  const W = 2048, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const py = (v) => (1 - v) * H; // v → canvas y（flipY=true：v=0 在画布底部）
  const uPx = (u) => u * W;

  // 基础白（非纯白，略带冷调）
  c.fillStyle = '#f3f6f8';
  c.fillRect(0, 0, W, H);
  // 机头雷达罩（u<0.03 略深灰）
  c.fillStyle = '#c9cfd5';
  c.fillRect(0, 0, uPx(0.03), H);
  // 尾锥 APU 段（u>0.985 略深）
  c.fillStyle = '#c9cfd5';
  c.fillRect(uPx(0.985), 0, W, H);

  // 腹部灰：v < 0.145 或 v > 0.855（画布两端条带）
  c.fillStyle = '#aeb6bd';
  c.fillRect(0, 0, W, py(0.855));          // 左上条带（v 0.855..1）
  c.fillRect(0, py(0.145), W, H - py(0.145)); // 右下条带（v 0..0.145）

  // 蓝色腰线：v 0.232..0.262（右）/ 0.738..0.768（左），随 fuselage 上翘自然起伏
  c.fillStyle = '#14396e';
  c.fillRect(0, py(0.262), W, py(0.232) - py(0.262));
  c.fillRect(0, py(0.768), W, py(0.738) - py(0.768));

  // 舷窗带：u 0.155..0.675，v≈0.272..0.296（窗心略高于中线），双侧
  c.fillStyle = '#10161c';
  const wU0 = 0.155, wU1 = 0.675, pitch = 0.0134, wW = 0.0058, wH = 0.024;
  for (let u = wU0; u <= wU1; u += pitch) {
    const x = uPx(u), ww = uPx(wW);
    c.fillRect(x, py(0.296), ww, H * wH);  // 右侧（v 0.272..0.296）
    c.fillRect(x, py(0.728), ww, H * wH);  // 左侧（v 0.704..0.728）
  }

  // 驾驶舱风挡窗带：u 0.042..0.078，双侧深色四窗面片（中柱留白）
  c.fillStyle = '#0c1218';
  for (const [v0, v1] of [[0.276, 0.318], [0.682, 0.724]]) {
    c.fillRect(uPx(0.042), py(v1), uPx(0.036), H * (v1 - v0));
  }
  c.fillStyle = '#f3f6f8'; // 风挡中柱
  for (const vy of [py(0.318), py(0.724)]) {
    c.fillRect(uPx(0.056), vy - H * 0.05, uPx(0.005), H * 0.062);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}

/* =========================================================
 * 几何工具
 * ========================================================= */

/** 镜像几何（x 取反 + 翻转绕序），用于左右对称部件 */
function mirrorGeometry(geo) {
  const g = geo.clone();
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
  }
  pos.needsUpdate = true;
  g.index.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * 截面放样：sections 数组 + mapFn(section, chordFrac, thickFrac) → [x,y,z]。
 * 截面用 8 点简化翼型（闭环），生成 spanwise 四边形 → 三角，两端加中心扇形端盖。
 */
const FOIL = [
  [0.0, 0.0], [0.12, 0.40], [0.35, 0.50], [0.70, 0.34],
  [1.0, 0.07], [1.0, -0.07], [0.65, -0.42], [0.22, -0.34],
];
function loftGeo(sections, mapFn) {
  const n = FOIL.length, S = sections.length;
  const pos = [];
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < n; j++) {
      pos.push(...mapFn(sections[i], FOIL[j][0], FOIL[j][1]));
    }
  }
  const idx = [];
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = i * n + j, b = i * n + j2, c = (i + 1) * n + j2, d = (i + 1) * n + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  // 端盖
  for (const end of [0, S - 1]) {
    const ci = pos.length / 3;
    const [cx, cy, cz] = mapFn(sections[end], 0.5, 0);
    pos.push(cx, cy, cz);
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      if (end === 0) idx.push(ci, end * n + j, end * n + j2);
      else idx.push(ci, end * n + j2, end * n + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* =========================================================
 * 机身：分段环放样（机头下坠 + 等段筒身 + 尾段上翘锥）
 * ========================================================= */
// 站位 [z, 中心线yc, 半宽rx, 半高ry]（-z 机头）
const FUSE_STATIONS = [
  [-19.75, -0.50, 0.03, 0.03],
  [-19.20, -0.44, 0.42, 0.40],
  [-18.40, -0.30, 0.82, 0.76],
  [-17.40, -0.14, 1.20, 1.10],
  [-16.20, 0.00, 1.54, 1.42],
  [-14.60, 0.07, 1.78, 1.65],
  [-12.50, 0.10, 1.87, 1.75],
  [-9.00, 0.10, 1.88, 1.78],
  [-4.00, 0.10, 1.88, 1.79],
  [4.00, 0.10, 1.88, 1.79],
  [9.00, 0.11, 1.87, 1.78],
  [12.50, 0.16, 1.83, 1.74],
  [15.00, 0.38, 1.70, 1.62],
  [17.20, 0.86, 1.38, 1.32],
  [18.70, 1.32, 0.88, 0.90],
  [19.45, 1.62, 0.36, 0.40],
  [19.75, 1.72, 0.05, 0.06],
];
function buildFuselage() {
  const N = 30; // 周向段数
  const pos = [], uv = [], idx = [];
  const S = FUSE_STATIONS.length;
  const zMin = FUSE_STATIONS[0][0], zMax = FUSE_STATIONS[S - 1][0];
  for (let i = 0; i < S; i++) {
    const [z, yc, rx, ry] = FUSE_STATIONS[i];
    const u = (z - zMin) / (zMax - zMin);
    for (let j = 0; j <= N; j++) {
      const th = (j / N) * Math.PI * 2;
      pos.push(rx * Math.sin(th), yc - ry * Math.cos(th), z);
      uv.push(u, j / N);
    }
  }
  const row = N + 1;
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * row + j, b = a + 1, c = a + row + 1, d = a + row;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* =========================================================
 * 起落架（收放动画：gear.position 0..1 驱动支柱绕轮舱口旋转）
 * ========================================================= */
const GEAR_MAX_MAIN = 100 * D2R;  // 主起绕 z 轴向内收
const GEAR_MAX_NOSE = 98 * D2R;   // 前起绕 x 轴向前收

function buildWheel(r, w) {
  // 轮胎 + 金属轮毂（一体的两圆柱）
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), MATERIALS.dark);
  tire.rotation.z = Math.PI / 2;
  g.add(tire);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.42, r * 0.42, w + 0.04, 10), MATERIALS.metal);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  return g;
}

/** 主起落架总成（pivot 在轮舱口，收起时绕 z 轴向内翻） */
function buildMainGear(side) {
  const pivot = new THREE.Group();
  pivot.position.set(side * 2.86, -0.9, 3.2);
  const metal = MATERIALS.metal;
  // 外筒（金属）+ 内杆（亮银 oleo，加粗保证外部视角可辨）
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 1.1, 10), metal);
  outer.position.y = -0.55; pivot.add(outer);
  const oleo = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.9, 10), MATERIALS.metal);
  oleo.material = new THREE.MeshStandardMaterial({
    color: 0xd6dde2, metalness: 0.95, roughness: 0.18, side: THREE.DoubleSide,
  });
  oleo.position.y = -1.35; pivot.add(oleo);
  // 侧撑杆（斜向细杆，从轮舱口斜向下到支柱中部）
  const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6), metal);
  brace.position.set(-side * 0.42, -0.7, 0.1);
  brace.rotation.z = side * 0.55; pivot.add(brace);
  // 轮轴 + 双轮
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.0, 8), metal);
  axle.rotation.z = Math.PI / 2; axle.position.y = -1.53; pivot.add(axle);
  for (const dx of [-0.29, 0.29]) {
    const w = buildWheel(0.57, 0.36);
    w.position.set(dx, -1.53, 0); pivot.add(w);
  }
  return pivot;
}

/** 前起落架总成（pivot 在轮舱口，收起时绕 x 轴向前翻；双前轮） */
function buildNoseGear() {
  const pivot = new THREE.Group();
  pivot.position.set(0, -1.2, -10.5);
  const metal = MATERIALS.metal;
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 1.0, 10), metal);
  outer.position.y = -0.5; pivot.add(outer);
  const oleo = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.8, 10), metal);
  oleo.position.y = -1.15; pivot.add(oleo);
  // 撑杆（向后斜）
  const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), metal);
  brace.position.set(0, -0.7, 0.35);
  brace.rotation.x = 0.9; pivot.add(brace);
  // 双前轮
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.62, 8), metal);
  axle.rotation.z = Math.PI / 2; axle.position.y = -1.4; pivot.add(axle);
  for (const dx of [-0.19, 0.19]) {
    const w = buildWheel(0.34, 0.22);
    w.position.set(dx, -1.4, 0); pivot.add(w);
  }
  return pivot;
}

/* =========================================================
 * 发动机：CFM56 短舱（lathe 唇口 + 风扇盘 + spinner + 尾锥 + 吊架）
 * ========================================================= */
function buildEngine() {
  const g = new THREE.Group();
  // 短舱外壳（lathe：进气口 → 外鼓 → 收缩）
  const prof = [
    [0.90, 0.0], [1.00, 0.10], [1.03, 0.55], [1.00, 1.6],
    [0.93, 2.9], [0.85, 3.9], [0.80, 4.4],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const nac = new THREE.Mesh(new THREE.LatheGeometry(prof, 24), MATERIALS.white);
  nac.rotation.x = Math.PI / 2; // profile y → +z
  nac.position.z = -2.4;
  g.add(nac);
  // 进气唇口环（金属亮圈）
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.945, 0.055, 8, 24), MATERIALS.metal);
  lip.position.z = -2.4; g.add(lip);
  // 风扇盘（深色）+ 8 叶片组（可旋转）+ spinner
  const fan = new THREE.Group();
  fan.position.z = -2.28;
  const disk = new THREE.Mesh(new THREE.CircleGeometry(0.86, 24), MATERIALS.dark);
  disk.rotation.y = Math.PI; // 朝 -z
  fan.add(disk);
  const bladeGeo = new THREE.BoxGeometry(0.07, 0.62, 0.14);
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(bladeGeo, MATERIALS.metal);
    const a = (i / 8) * Math.PI * 2;
    b.position.set(Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0.02);
    b.rotation.z = a + 0.5;
    fan.add(b);
  }
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 10), MATERIALS.dark);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = -0.16;
  fan.add(spinner);
  g.add(fan);
  // 尾锥（金属收敛喷口 + 深色内芯）
  const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.34, 0.9, 16, 1, true), MATERIALS.metal);
  noz.rotation.x = Math.PI / 2; noz.position.z = 4.75;
  g.add(noz);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 10), MATERIALS.metal);
  core.rotation.x = Math.PI / 2; core.position.z = 5.15;
  g.add(core);
  return { group: g, fan };
}

/* =========================================================
 * 整机组装
 * ========================================================= */
export function buildExternalAircraft() {
  const g = new THREE.Group();
  g.position.y = 3.0; // 机身中线离地高（挂载约定不变）

  /* ---- 机身（涂装贴图） ---- */
  MATERIALS.fus.map = buildFuselageTexture();
  const fuse = new THREE.Mesh(buildFuselage(), MATERIALS.fus);
  g.add(fuse);

  /* ---- 翼身整流罩（鼓包）：椭球 ---- */
  const fair = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), MATERIALS.white);
  fair.scale.set(2.25, 1.45, 6.2);
  fair.position.set(0, -1.05, 1.6);
  g.add(fair);

  /* ---- 机翼（后掠 + 上反 + 翼根厚翼尖薄 + 后缘 Yehudi 折线） ---- */
  const wingSections = [
    { x: 1.7, y: -1.0, zLE: -1.6, chord: 7.0, t: 1.05 },  // 翼根（藏进整流罩）
    { x: 6.5, y: -0.60, zLE: 0.70, chord: 4.6, t: 0.72 }, // 后缘折点
    { x: 16.4, y: 0.54, zLE: 5.15, chord: 1.2, t: 0.20 }, // 翼尖
  ];
  const wingR = new THREE.Mesh(
    loftGeo(wingSections, (s, c, f) => [s.x, s.y + f * s.t, s.zLE + c * s.chord]),
    MATERIALS.white,
  );
  g.add(wingR);
  const wingL = new THREE.Mesh(
    mirrorGeometry(wingR.geometry),
    MATERIALS.white,
  );
  g.add(wingL);

  /* ---- 翼梢小翼（上翘 80°+，737-800 标志，深蓝） ---- */
  const wlSections = [
    { x: 16.35, y: 0.50, zLE: 5.05, chord: 1.25, t: 0.18 },
    { x: 17.0, y: 1.85, zLE: 5.95, chord: 0.98, t: 0.14 },
    { x: 17.55, y: 3.25, zLE: 6.85, chord: 0.72, t: 0.10 },
  ];
  const wlR = new THREE.Mesh(
    loftGeo(wlSections, (s, c, f) => [s.x, s.y + f * s.t, s.zLE + c * s.chord]),
    MATERIALS.blue,
  );
  g.add(wlR);
  g.add(new THREE.Mesh(mirrorGeometry(wlR.geometry), MATERIALS.blue));

  /* ---- 襟翼滑轨整流罩（canoe，每侧 3 个，贴机翼下表面） ---- */
  const canoeGeo = new THREE.SphereGeometry(0.24, 10, 6);
  for (const side of [-1, 1]) {
    for (const [cx, cz] of [[4.5, 5.9], [8.5, 6.2], [12.5, 6.7]]) {
      const cn = new THREE.Mesh(canoeGeo, MATERIALS.white);
      cn.scale.set(0.9, 0.7, 3.6);
      cn.position.set(side * cx, -1.0 + 0.105 * (cx - 1.7) - 0.13, cz);
      cn.rotation.y = side * -0.06;
      g.add(cn);
    }
  }

  /* ---- 发动机 ×2 ---- */
  const fans = [];
  for (const side of [-1, 1]) {
    const eng = buildEngine();
    eng.group.position.set(side * 4.85, -1.8, -2.4);
    g.add(eng.group);
    fans.push(eng.fan);
    // 吊架：从短舱顶连到机翼前缘下方
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.05, 3.0), MATERIALS.white);
    pylon.position.set(side * 4.85, -0.85, 0.0);
    pylon.rotation.y = side * 0.04;
    g.add(pylon);
  }

  /* ---- 垂直尾翼（深蓝涂装）+ 背鳍 ---- */
  const finSections = [
    { y: 0.9, zLE: 13.6, chord: 6.2, t: 0.62 },
    { y: 5.0, zLE: 15.9, chord: 3.6, t: 0.5 },
    { y: 9.0, zLE: 17.9, chord: 1.9, t: 0.4 },
  ];
  const fin = new THREE.Mesh(
    loftGeo(finSections, (s, c, f) => [f * s.t, s.y, s.zLE + c * s.chord]),
    MATERIALS.blue,
  );
  g.add(fin);
  // 背鳍（dorsal fin 三角楔）
  const dorsal = new THREE.Mesh(new THREE.BufferGeometry(), MATERIALS.blue);
  {
    const p = [
      0, 0.9, 10.6, 0, 0.9, 13.7, 0, 3.6, 15.0,   // 前侧面
      0.16, 0.9, 10.6, 0.16, 0.9, 13.7, 0.16, 3.6, 15.0, // 后侧面（薄楔）
    ];
    const idx = [0, 1, 2, 5, 4, 3, 0, 2, 5, 0, 5, 3, 1, 4, 5, 1, 5, 2];
    dorsal.geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    dorsal.geometry.setIndex(idx);
    dorsal.geometry.computeVertexNormals();
  }
  g.add(dorsal);

  /* ---- 水平尾翼（小上反） ---- */
  const stabSections = [
    { x: 0.2, y: 0.85, zLE: 17.1, chord: 3.6, t: 0.5 },
    { x: 6.6, y: 1.6, zLE: 18.9, chord: 1.3, t: 0.22 },
  ];
  const stabR = new THREE.Mesh(
    loftGeo(stabSections, (s, c, f) => [s.x, s.y + f * s.t, s.zLE + c * s.chord]),
    MATERIALS.white,
  );
  g.add(stabR);
  g.add(new THREE.Mesh(mirrorGeometry(stabR.geometry), MATERIALS.white));

  /* ---- APU 尾锥 ---- */
  const apu = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.5, 10), MATERIALS.dark);
  apu.rotation.x = Math.PI / 2; apu.position.set(0, 1.68, 19.7);
  g.add(apu);

  /* ---- 机腹防撞灯（小红球，夜间模式有戏） ---- */
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xd02020, emissive: 0x800000, roughness: 0.4 }),
  );
  beacon.position.set(0, -1.55, -2.0);
  g.add(beacon);

  /* ---- 起落架 + 轮舱凹槽暗示 ---- */
  const gearMainL = buildMainGear(-1);
  const gearMainR = buildMainGear(1);
  const gearNose = buildNoseGear();
  g.add(gearMainL, gearMainR, gearNose);
  // 轮舱深色贴地片（收轮后暗示舱位）：主舱在整流罩底、前舱在机腹
  const bayMat = MATERIALS.dark;
  for (const side of [-1, 1]) {
    const bay = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 2.6), bayMat);
    bay.position.set(side * 1.8, -2.3, 3.2);
    g.add(bay);
  }
  const noseBay = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 2.4), bayMat);
  noseBay.position.set(0, -1.72, -10.5);
  g.add(noseBay);

  /* ---- 状态更新（零分配：只写 transform / visible） ---- */
  const gearParts = [gearMainL, gearMainR, gearNose];
  let fanAngle = 0;
  function update(state, dt) {
    // 起落架收放：position 0(收上)..1(放下锁定)，<0.05 隐藏（视作完全进舱）
    const p = state?.gear?.position ?? 1;
    const retract = Math.min(Math.max(1 - p, 0), 1);
    gearMainR.rotation.z = -retract * GEAR_MAX_MAIN; // 右侧向内（-x）翻
    gearMainL.rotation.z = retract * GEAR_MAX_MAIN;  // 左侧向内（+x）翻
    gearNose.rotation.x = retract * GEAR_MAX_NOSE;   // 向前（-z）翻
    const vis = p > 0.05;
    for (const gp of gearParts) gp.visible = vis;
    // 发动机风扇：n1 驱动转速（只转 fan 组）
    const n1 = state?.engines?.[0]?.n1 ?? 0;
    fanAngle -= n1 * 55 * dt;
    fans[0].rotation.z = fanAngle;
    fans[1].rotation.z = fanAngle;
  }

  return { group: g, update };
}
