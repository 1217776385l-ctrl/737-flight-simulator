/**
 * airport-scene.js — 单元 3（外部世界）· 机场场景生成（数据驱动，五座共用一套生成器）。
 *
 * 每座机场生成：
 *  - 跑道面（沥青）+ 真实标线（中线虚线、入口条纹、接地带标、瞄准点、跑道号、边线）
 *  - 灯光点阵（THREE.Points 单 draw call）：边灯/中线灯/入口绿排/末端红排/接地带灯/
 *    进近灯光系统（中线延伸 900 m + 300 m 横排，简化 ALSF-2）/ 滑行道蓝边灯 / 停机坪泛光
 *  - **PAPI 四灯**：真实角度逻辑（见 papiAngleTo 与 PAPI_THRESHOLDS），每帧可查询可渲染
 *  - 滑行道 + 停机坪 + 航站楼/塔台剪影；枢纽补第二条平行跑道（dualRunway）
 *
 * 性能预算：
 *  - 标线合并为 1 个 BufferGeometry（~170 quad）+ 1 白色 MeshBasicMaterial
 *  - 灯光合并为 1 个 Points（~500 点，圆点贴图），PAPI 4 灯独立（动态换色）
 *  - 建筑 5-7 个 Mesh（共享 Lambert 材质 3 种）
 *  - 每座机场 draw calls ≈ 12；光源 0 个 PointLight（夜景靠 Basic 材质点阵，太阳/环境光由 daynight 提供）
 *
 * 所有几何建在**机场本地坐标系**（跑道沿 +x，入口 x=0），由 index.js 统一旋转到仿真系。
 *
 * @module world/airport-scene
 */

import * as THREE from 'three';
import { papiPosition, runwayNumber } from './airports-data.js';
import { colorPart, mergeColored } from './scenery.js';

/** PAPI 四灯的下滑角门限 deg：飞机相对门限高 → 白，低 → 红。
 *  2白2红 = 正好在 3° 下滑道上；全白 = 高；全红 = 低。 */
const PAPI_THRESHOLDS = [3.5, 3.2, 2.8, 2.5];

const D2R = Math.PI / 180;

/* =========================================================
 * 共享材质（跨机场复用；dispose 由 index.js 统一处理时保留材质对象）
 * ========================================================= */
const MAT = {
  // 标线用 Lambert：昼间随日照明暗（避免"裸白细棍"过曝），夜间由灯光点阵承担引导
  marking: new THREE.MeshLambertMaterial({ color: 0xdad6cc }),
  asphalt: new THREE.MeshLambertMaterial({ color: 0x3b3e42 }),               // 跑道沥青
  asphalt2: new THREE.MeshLambertMaterial({ color: 0x44474b }),              // 第二条跑道/滑行道
  taxi: new THREE.MeshLambertMaterial({ color: 0x53565a }),                  // 滑行道
  apron: new THREE.MeshLambertMaterial({ color: 0x676c72 }),                 // 停机坪
  building: new THREE.MeshLambertMaterial({ color: 0x8d949c }),              // 航站楼
  buildingDark: new THREE.MeshLambertMaterial({ color: 0x6d757e }),          // 塔台
  papiWhite: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  papiRed: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
};

/** 灯点圆形贴图（共享一张） */
let lightSpriteTex = null;
function getLightTexture() {
  if (lightSpriteTex) return lightSpriteTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 15);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,1)');   // 硬核心：远处灯点仍亮
  grad.addColorStop(0.7, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  lightSpriteTex = new THREE.CanvasTexture(cv);
  return lightSpriteTex;
}

/* =========================================================
 * 标线几何（手工 quad 合并）
 * ========================================================= */

/** quad 写入器：所有白色标线合并为一个 geometry */
class QuadWriter {
  constructor() { this.pos = []; this.idx = []; this.n = 0; }
  /** 水平矩形：中心 (cx, cz)、沿 x 长 len、沿 z 宽 wid、高度 y */
  quad(cx, cz, len, wid, y) {
    const x0 = cx - len / 2, x1 = cx + len / 2, z0 = cz - wid / 2, z1 = cz + wid / 2;
    const b = this.n;
    this.pos.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
    this.idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    this.n += 4;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

/** 单条跑道标线（本地坐标，入口 x=0，长 L 宽 W） */
function buildMarkings(L, W, numPrimary, numRecip) {
  const qw = new QuadWriter();
  const Y = 0.09;
  // 中线：30m 虚线 / 20m 空隙（0.9 m 宽）
  for (let x = 60; x <= L - 60; x += 50) qw.quad(x, 0, 30, 0.9, Y);
  // 边线（连续 0.45 m，距边缘 2 m）
  qw.quad(L / 2, -(W / 2 - 2), L, 0.45, Y);
  qw.quad(L / 2, (W / 2 - 2), L, 0.45, Y);
  // 两端入口条纹 + 接地带 + 瞄准点 + 跑道号
  for (const end of [0, 1]) {
    const dir = end === 0 ? 1 : -1;               // 从入口向跑道内的方向
    const base = end === 0 ? 0 : L;               // 入口 x
    const px = (off) => base + dir * off;
    // 入口条纹（piano keys）：条纹 30 m 长 × 1.8 m 宽，60 m 宽跑道 12 条 / 45 m 8 条
    const nKeys = W >= 55 ? 12 : 8;
    const keyW = 1.8, keyGap = 1.8;
    const span = nKeys * keyW + (nKeys - 1) * keyGap;
    let z = -span / 2 + keyW / 2;
    for (let i = 0; i < nKeys; i++) {
      qw.quad(px(22), z, 30, keyW, Y);
      z += keyW + keyGap;
    }
    // 接地带标：150/300/450/600/750/900 m 处左右成对（22 m × 1.8 m）
    for (let d = 150; d <= 900; d += 150) {
      if (px(d) < 30 || px(d) > L - 30) break;
      const zOff = W / 2 - 8;
      qw.quad(px(d), -zOff, 22, 1.8, Y);
      qw.quad(px(d), zOff, 22, 1.8, Y);
    }
    // 瞄准点（大块 45 m × 3 m，距入口 300 m）
    qw.quad(px(300), -(W / 2 - 11), 45, 3, Y);
    qw.quad(px(300), (W / 2 - 11), 45, 3, Y);
  }
  const geo = qw.build();
  // 跑道号（Canvas 贴图小贴片，独立 mesh）
  const nums = new THREE.Group();
  for (const end of [0, 1]) {
    const dir = end === 0 ? 1 : -1;
    const base = end === 0 ? 0 : L;
    const label = end === 0 ? numPrimary : numRecip;
    const m = makeNumberMesh(label);
    m.position.set(base + dir * 55, 0.1, 0);
    // 贴片平面立在 XZ 平面上，文字朝向：着陆员从 -dir 侧读向 +dir
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = end === 0 ? 0 : Math.PI;
    m.position.z = 0;
    nums.add(m);
  }
  return { geo, nums };
}

/** Canvas 贴图跑道号贴片（20 m × 14 m） */
function makeNumberMesh(label) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 192;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 256, 192);
  g.font = 'bold 150px Arial, sans-serif';
  g.fillStyle = '#dad6cc';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 128, 100);
  const tex = new THREE.CanvasTexture(cv);
  const geo = new THREE.PlaneGeometry(16, 12);
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(geo, mat);
}

/* =========================================================
 * 灯光点阵
 * ========================================================= */

/** 灯点收集器：位置 + 颜色 → 一个 Points */
class LightSet {
  constructor() { this.p = []; this.c = []; }
  add(x, y, z, color, intensity = 1) {
    this.p.push(x, y, z);
    this.c.push(color[0] * intensity, color[1] * intensity, color[2] * intensity);
  }
  build(scene) {
    if (this.p.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    const m = new THREE.PointsMaterial({
      size: 7, vertexColors: true, map: getLightTexture(),
      color: new THREE.Color(1.7, 1.7, 1.65), // 加法混合提亮（HDR 观感）
      transparent: true, depthWrite: false, sizeAttenuation: false, // 固定像素：远距离灯点仍可辨（真实进近灯数公里外可见）
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    scene.add(pts);
    return pts;
  }
}

const COL = {
  white: [1, 1, 0.95], green: [0.1, 1, 0.3], red: [1, 0.15, 0.1],
  amber: [1, 0.7, 0.15], blue: [0.2, 0.4, 1], warm: [1, 0.85, 0.55],
};

/** 单条跑道灯光点阵 */
function buildRunwayLights(ls, L, W, zCenter) {
  const yEdge = 0.8, yC = 0.6;
  // 边灯：60 m 间隔（最后 600 m 琥珀色）
  for (let x = 0; x <= L; x += 60) {
    const c = x > L - 600 ? COL.amber : COL.white;
    ls.add(x, yEdge, zCenter - W / 2 - 1, c);
    ls.add(x, yEdge, zCenter + W / 2 + 1, c);
  }
  // 中线灯：30 m 间隔
  for (let x = 30; x < L; x += 30) ls.add(x, yC, zCenter, COL.white, 0.8);
  // 入口绿排 / 末端红排
  for (let z = -W / 2 + 2; z <= W / 2 - 2; z += 4) {
    ls.add(-2, 0.8, zCenter + z, COL.green);
    ls.add(L + 2, 0.8, zCenter + z, COL.red);
  }
  // 接地带灯：每 150 m 两侧各 1 点（简化，真实为每侧一排）
  for (let d = 150; d <= 900; d += 150) {
    ls.add(d, 0.5, zCenter - W / 2 + 6, COL.white, 0.7);
    ls.add(d, 0.5, zCenter + W / 2 - 6, COL.white, 0.7);
  }
  // 进近灯光系统：入口前 30..900 m 中线延伸灯 + 300 m 横排（简化 ALSF-2）
  for (let d = 30; d <= 900; d += 30) ls.add(-d, 0.9, zCenter, COL.white, 0.85);
  for (let z = -13.5; z <= 13.5; z += 4.5) ls.add(-300, 0.9, zCenter + z, COL.white, 0.85);
  // 顺序闪光灯（rabbit）视觉近似：入口前 1000..1200 m 五个亮点
  for (let i = 0; i < 5; i++) ls.add(-(1000 + i * 60), 0.9, zCenter, COL.white, 0.5);
}

/* =========================================================
 * PAPI
 * ========================================================= */

/**
 * 飞机相对 PAPI 的下滑角 deg（PAPI 位于入口后 330 m）。
 * @param {Object} a 机场对象
 * @param {{x:number,y:number,z:number}} p 飞机仿真坐标（y 相对跑道面）
 * @returns {number} 角度 deg（>3.5 全白 … <2.5 全红）
 */
export function papiAngleTo(a, p) {
  const { lx, lz } = worldToAirportLocal(a, p.x, p.z);
  const pp = papiPosition(a);
  const dx = lx - pp.x, dz = lz - pp.z;
  const dist = Math.max(Math.hypot(dx, dz), 12);
  return Math.atan2(p.y - 1.2, dist) / D2R;
}

/** 仿真坐标 → 本地坐标（恒等：仿真系 = 机场局部系，同 airports-data 转换器） */
function worldToAirportLocal(a, x, z) {
  return { lx: x, lz: z };
}

/**
 * PAPI 四灯状态：true=白，false=红。
 * @param {number} angleDeg papiAngleTo 的结果
 */
export function papiStates(angleDeg) {
  return PAPI_THRESHOLDS.map((t) => angleDeg > t);
}

/* =========================================================
 * 总装
 * ========================================================= */

/**
 * 构建机场场景（加入 scene；调用方负责把 scene 设为机场本地系 Group）。
 * @param {THREE.Object3D} scene 机场本地系容器
 * @param {Object} airport AIRPORTS 成员
 * @returns {{ papiLamps: THREE.Mesh[], papiGlow: THREE.Points, disposables: (THREE.BufferGeometry|THREE.Material|THREE.Texture)[] }}
 */
export function buildAirport(scene, airport) {
  const disposables = [];
  const L = airport.runwayLength, W = airport.width;
  const numP = runwayNumber(airport, false);
  const numR = runwayNumber(airport, true);

  // ---- 跑道 ----
  const rwGeo = new THREE.PlaneGeometry(L, W);
  rwGeo.rotateX(-Math.PI / 2);
  const runway = new THREE.Mesh(rwGeo, MAT.asphalt);
  runway.position.set(L / 2, 0.02, 0);
  scene.add(runway);
  disposables.push(rwGeo);

  // ---- 标线 ----
  const mk = buildMarkings(L, W, numP, numR);
  const mkMesh = new THREE.Mesh(mk.geo, MAT.marking);
  scene.add(mkMesh);
  disposables.push(mk.geo);
  scene.add(mk.nums);
  for (const child of mk.nums.children) disposables.push(child.geometry, child.material.map, child.material);

  // ---- 灯光点阵 ----
  const ls = new LightSet();
  buildRunwayLights(ls, L, W, 0);
  if (airport.dualRunway) {
    // 第二条平行跑道（间隔 800 m）：简化为跑道面 + 灯光（迎面对景更有枢纽感）
    const L2 = L, z2 = 800;
    const g2 = new THREE.PlaneGeometry(L2, W);
    g2.rotateX(-Math.PI / 2);
    const rw2 = new THREE.Mesh(g2, MAT.asphalt2);
    rw2.position.set(L2 / 2, 0.02, z2);
    scene.add(rw2);
    disposables.push(g2);
    buildRunwayLights(ls, L2, W, z2);
  }

  // ---- 滑行道 + 联络道 ----
  const tzZ = W / 2 + 150;
  const twGeo = new THREE.PlaneGeometry(L - 700, 23);
  twGeo.rotateX(-Math.PI / 2);
  const taxi = new THREE.Mesh(twGeo, MAT.taxi);
  taxi.position.set(L / 2, 0.02, tzZ);
  scene.add(taxi);
  disposables.push(twGeo);
  for (const cx of [900, L / 2, L - 900]) {
    const cGeo = new THREE.PlaneGeometry(23, tzZ - W / 2 + 2);
    cGeo.rotateX(-Math.PI / 2);
    const conn = new THREE.Mesh(cGeo, MAT.taxi);
    conn.position.set(cx, 0.015, (W / 2 + tzZ) / 2);
    scene.add(conn);
    disposables.push(cGeo);
    ls.add(cx, 0.6, tzZ - 11.5, COL.blue, 0.8);
    ls.add(cx, 0.6, tzZ + 11.5, COL.blue, 0.8);
  }
  // 滑行道蓝边灯
  for (let x = 700; x <= L - 700; x += 90) {
    ls.add(x, 0.6, tzZ - 11.5, COL.blue, 0.8);
    ls.add(x, 0.6, tzZ + 11.5, COL.blue, 0.8);
  }

  // ---- 停机坪 + 航站楼 + 塔台 ----
  const apGeo = new THREE.PlaneGeometry(420, 300);
  apGeo.rotateX(-Math.PI / 2);
  const apron = new THREE.Mesh(apGeo, MAT.apron);
  apron.position.set(L / 2, 0.02, tzZ + 180);
  scene.add(apron);
  disposables.push(apGeo);

  const termGeo = new THREE.BoxGeometry(320, 26, 48);
  const terminal = new THREE.Mesh(termGeo, MAT.building);
  terminal.position.set(L / 2, 13, tzZ + 350);
  scene.add(terminal);
  disposables.push(termGeo);
  // 航站楼窗灯（点阵）
  for (let i = 0; i < 26; i++) {
    ls.add(L / 2 - 150 + i * 12, 12, tzZ + 325, COL.warm, 0.55);
  }

  const twrGeo = new THREE.CylinderGeometry(4.5, 6, 52, 10);
  const tower = new THREE.Mesh(twrGeo, MAT.buildingDark);
  tower.position.set(L / 2 + 320, 26, tzZ + 260);
  scene.add(tower);
  disposables.push(twrGeo);
  const cabGeo = new THREE.BoxGeometry(16, 9, 16);
  const cab = new THREE.Mesh(cabGeo, MAT.buildingDark);
  cab.position.set(L / 2 + 320, 56, tzZ + 260);
  scene.add(cab);
  disposables.push(cabGeo);
  ls.add(L / 2 + 320, 62, tzZ + 260, COL.green, 0.9); // 塔台顶灯

  // 停机坪泛光点
  for (let i = 0; i < 6; i++) {
    ls.add(L / 2 - 150 + i * 60, 14, tzZ + 200, COL.warm, 0.5);
  }

  // ---- 地面细节（单 draw call：机位标线 + 目视助航标志 + 枢纽廊桥，顶点色合并）----
  {
    const parts = [];
    // 停机坪机位标线（引导线 + 停止条 + T 位，黄系）：QuadWriter 索引几何 → 顶点色
    const qwY = new QuadWriter();
    const yA = 0.09;
    for (let i = 0; i < 5; i++) {
      const sx = L / 2 - 150 + i * 70;
      qwY.quad(sx, tzZ + 40, 4, 0.5, yA);       // 引入线（从滑行道侧伸入停机坪）
      qwY.quad(sx, tzZ + 78, 4, 0.5, yA);
      qwY.quad(sx, tzZ + 96, 7, 0.9, yA);       // 停止条
      qwY.quad(sx, tzZ + 112, 0.5, 7, yA);      // T 位立杆
      qwY.quad(sx, tzZ + 115, 4, 0.5, yA);      // T 位横杠
    }
    const yGeo = qwY.build().toNonIndexed();
    const yCnt = yGeo.attributes.position.count;
    const yCol = new Float32Array(yCnt * 3);
    for (let i = 0; i < yCnt; i++) { yCol[i * 3] = 0.78; yCol[i * 3 + 1] = 0.63; yCol[i * 3 + 2] = 0.2; }
    yGeo.setAttribute('color', new THREE.BufferAttribute(yCol, 3));
    parts.push(yGeo);
    // 目视助航标志：风向袋 ×2（杆 + 橙色锥袋）+ 跑道边标记牌 ×4（白身红顶）
    for (const [wx, wz] of [[L - 500, -(W / 2 + 90)], [500, W / 2 + 90]]) {
      parts.push(colorPart(new THREE.CylinderGeometry(0.14, 0.18, 9, 5).translate(wx, 4.5, wz), [0.75, 0.75, 0.78]));
      const sock = new THREE.ConeGeometry(0.75, 3, 6);
      sock.rotateZ(Math.PI / 2);            // 锥尖水平指向下风向（本地 -z 侧）
      sock.translate(wx, 8.2, wz - 1.5);
      parts.push(colorPart(sock, [0.95, 0.45, 0.1]));
    }
    for (let i = 0; i < 4; i++) {           // 跑道边标记牌
      const bx = 400 + i * (L - 800) / 3;
      const bz = i % 2 === 0 ? -(W / 2 + 45) : W / 2 + 45;
      parts.push(colorPart(new THREE.BoxGeometry(2.6, 1.1, 0.35).translate(bx, 0.75, bz), [0.92, 0.92, 0.9]));
      parts.push(colorPart(new THREE.BoxGeometry(2.6, 0.35, 0.4).translate(bx, 1.45, bz), [0.85, 0.15, 0.1]));
    }
    // 枢纽航站楼廊桥体块：4 条登机桥（桥身 + 顶盖 + 外端立柱）
    if (airport.dualRunway) {
      for (let i = 0; i < 4; i++) {
        const bx = L / 2 - 120 + i * 80;
        // 桥身从航站楼正面（z = tzZ+326）向停机坪伸出 ~92 m
        parts.push(colorPart(new THREE.BoxGeometry(3.4, 3.4, 92).translate(bx, 5.2, tzZ + 280), [0.88, 0.89, 0.91]));
        parts.push(colorPart(new THREE.BoxGeometry(3.8, 0.5, 93).translate(bx, 7.1, tzZ + 280), [0.4, 0.43, 0.46]));
        parts.push(colorPart(new THREE.CylinderGeometry(0.7, 0.7, 5, 6).translate(bx, 2.5, tzZ + 238), [0.6, 0.62, 0.64]));
      }
    }
    const detGeo = mergeColored(parts);
    disposables.push(detGeo);
    const detMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    disposables.push(detMat);
    scene.add(new THREE.Mesh(detGeo, detMat));
  }

  // ---- 滑行道中线灯（绿色点阵，并入 LightSet 单 draw call）----
  for (let x = 750; x <= L - 750; x += 60) {
    ls.add(x, 0.5, tzZ, COL.green, 0.75);
  }

  // ---- PAPI 四灯 ----
  const pp = papiPosition(airport);
  const lampGeo = new THREE.BoxGeometry(1.6, 1.1, 1.6);
  disposables.push(lampGeo);
  const papiLamps = [];
  const glowPos = [], glowCol = [];
  // 色点精灵的渲染间距放大 3.5 倍（物理 6m 在 3km 外不足 4px，红白无法分色）
  const glowSpacing = pp.spacingM * 3.5;
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(lampGeo, MAT.papiWhite);
    const z = pp.z - (1.5 - i) * pp.spacingM; // 从跑道侧向外：门限由高到低
    m.position.set(pp.x, 0.8, z);
    scene.add(m);
    papiLamps.push(m);
    glowPos.push(pp.x, 1.4 + i * 1.1, pp.z - (1.5 - i) * glowSpacing); // 纵向微错位：远距四点分离
    glowCol.push(1, 1, 1);
  }
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
  glowGeo.setAttribute('color', new THREE.Float32BufferAttribute(glowCol, 3));
  // PAPI 色点精灵：NormalBlending 高饱和红/白，昼间背景上也清晰分色
  const glowMat = new THREE.PointsMaterial({
    size: 9, vertexColors: true, map: getLightTexture(),
    transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false,
    blending: THREE.NormalBlending,
  });
  const papiGlow = new THREE.Points(glowGeo, glowMat);
  papiGlow.frustumCulled = false;
  scene.add(papiGlow);
  disposables.push(glowGeo, glowMat);

  ls.build(scene);

  /**
   * 每帧更新 PAPI（真实角度逻辑）。
   * @param {Object} state 内核状态（读 position）
   */
  function updatePapi(state) {
    const angle = papiAngleTo(airport, state.position);
    const whites = papiStates(angle);
    const c = glowGeo.attributes.color;
    for (let i = 0; i < 4; i++) {
      papiLamps[i].material = whites[i] ? MAT.papiWhite : MAT.papiRed;
      if (whites[i]) c.setXYZ(i, 1.0, 1.0, 1.0);      // 纯白
      else c.setXYZ(i, 1.0, 0.03, 0.0);               // 高饱和红
    }
    c.needsUpdate = true;
    return angle;
  }

  return { updatePapi, disposables };
}
