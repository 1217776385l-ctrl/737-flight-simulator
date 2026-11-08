/**
 * geometry.js — 737-800 驾驶舱程序化 3D 几何（无外部模型）。
 *
 * 局部坐标系（unit 5 将整个 group 挂到飞机上）：
 *   +x = 右翼方向，+y = 上，-z = 机头前方；原点在驾驶舱地板、双座中线处。
 *   cameraAnchor（机长眼位）位于 (-0.36, 1.40, -0.15)，平视 sightline -0.02 rad。
 *   仪表扫视由 index.js 的 setLookPitch() 在运行时叠加（眼位本身保持平视）。
 *
 * 空间关系按"平视一屏同看外部+全套仪表"校核（76° FOV / 眼位 1.30 / pitch -0.17，uxA2 2026-11）：
 *   - glareshield 为贴风挡底缘的薄上斜板（前缘 ~-12°，不遮风挡玻璃），MCP/告警灯贴其上斜面
 *   - MCP 方式控制板改为窄斜面嵌在 glareshield 前缘下（顶边 ~-12°，平视完整可见且不切风挡）
 *   - 主仪表板整体后移+微抬（屏面距眼 ~0.70m，倾角 -0.22 迎向视线）：
 *     PFD/ND 上排顶边 ~-16°，上/下 EICAS 中央叠放至 ~-44°，平视全部完整入画
 *   - 前风挡加大下延：玻璃下缘 ~-11°（平视可见地面/跑道），上缘超出视场顶
 *   - 顶板前倾 ~58°（默认视线不可见，view=ohd 查看）
 *   - 中央台微升高，CDU 移到台面左前凸台（~-40°，平视完整可见）
 *   - 雨刷停机位贴风挡底缘横置（臂尖指向外侧窗柱），不穿视野
 *   - 座舱照明为 group 内局部光源（跟随飞机）：白天日光自风挡洒入、夜间面板泛光
 */

import * as THREE from 'three';
import { MAT, panelNoiseTexture } from './palette.js';
import {
  createPFD, createND, createUpperEICAS, createLowerEICAS,
  createMCP, createOverhead, createPedestal, createAnnunciator, createCDU,
} from './displays.js';

const std = (color, rough = 0.92, metal = 0.06) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

/* ---------- 布局常量（米，group 局部系） ---------- */
const EYE = { x: -0.36, y: 1.30, z: -0.15, pitch: -0.17 };  // 左座标准眼点（视线中心落在仪表台与风挡之间，地平线约在画面上 37%）
const PANEL = { x: 0, y: 0.84, z: -0.82, tilt: -0.22 };     // 主仪表板（后移+迎角加大：屏面距眼 ~0.70m，平视六屏完整入画）
const MCP = { x: 0, y: 1.145, z: -0.645, tilt: -0.28 };     // 方式控制板（窄斜面贴 glareshield 前缘下，平视完整可见）
const GLARE = { x: 0, y: 1.21, z: -0.66 };                  // glareshield（薄上斜板，前缘 ~-12°，不遮风挡玻璃）
const OHD = { x: 0, y: 2.02, z: -0.55, tilt: 1.02 };        // 顶板
const PED = { x: 0, y: 0.68, z: -0.40, tilt: -0.72 };       // 中央台（微升高：CDU 凸台入画，油门杆在默认视线下方）
const WSW = { y: 1.56, z: -1.02, tilt: 0.32, halfW: 0.30 }; // 前风挡（加大下延）

/**
 * 构建整个驾驶舱。
 * @returns {{group, cameraAnchor, clickables, displays, anim}}
 */
export function buildCockpit() {
  const group = new THREE.Group();
  const clickables = [];

  // 波音灰 + 细噪点（评审指令 ②：杜绝均匀哑光灰平面）
  const matPanel = new THREE.MeshStandardMaterial({
    map: panelNoiseTexture('#2a2d31', 3), roughness: 0.9, metalness: 0.05,
  });
  const matMid = new THREE.MeshStandardMaterial({
    map: panelNoiseTexture('#26292d', 4), roughness: 0.92, metalness: 0.05,
  });
  const matBlack = std(MAT.black, 0.95);
  const matMetal = std(MAT.metal, 0.38, 0.75);
  const matGlare = std(MAT.glare, 0.9);
  const matBezelHi = std(MAT.bezelHi, 0.45, 0.6); // 嵌装高光边

  /** 快捷方块 */
  const box = (w, h, dp, mat, x, y, z, parent = group) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  /**
   * 嵌装屏幕：黑色外框 + 内凹腔体 + 1px 金属高光边，屏面下沉（评审指令 ②）。
   * nameTable 指向 interactions.buildRegionMap 的键（点击面片=屏面 Plane 本体）。
   */
  const screen = (disp, w, h, x, y, z, parent, nameTable = null) => {
    const t = 0.015;   // 外框宽
    const hi = 0.005;  // 高光边宽
    const dp = 0.020;  // 框深
    // 背板（腔体底，哑光深黑）
    box(w + 0.004, h + 0.004, 0.004, matBlack, x, y, z - dp / 2, parent);
    // 黑色外框（四条）
    box(w + 2 * t, t, dp, matBlack, x, y + h / 2 + t / 2, z, parent);
    box(w + 2 * t, t, dp, matBlack, x, y - h / 2 - t / 2, z, parent);
    box(t, h, dp, matBlack, x - w / 2 - t / 2, y, z, parent);
    box(t, h, dp, matBlack, x + w / 2 + t / 2, y, z, parent);
    // 高光金属边（贴屏缘一圈，略凸出形成受光棱线）
    box(w + 2 * hi, hi, dp + 0.002, matBezelHi, x, y + h / 2 + hi / 2, z, parent);
    box(w + 2 * hi, hi, dp + 0.002, matBezelHi, x, y - h / 2 - hi / 2, z, parent);
    box(hi, h, dp + 0.002, matBezelHi, x - w / 2 - hi / 2, y, z, parent);
    box(hi, h, dp + 0.002, matBezelHi, x + w / 2 + hi / 2, y, z, parent);
    // 屏面（相对框正面下沉 ~6mm）
    const mat = new THREE.MeshBasicMaterial({ map: disp.texture, toneMapped: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(x, y, z + dp / 2 - 0.006);
    parent.add(m);
    if (nameTable) {
      m.userData.pick = { disp, w, h, nameTable };
      clickables.push(m);
    }
    return m;
  };

  /* ================= 主仪表板（六屏 + 边条） ================= */
  const panel = new THREE.Group();
  panel.position.set(PANEL.x, PANEL.y, PANEL.z);
  panel.rotation.x = PANEL.tilt;
  group.add(panel);
  box(1.80, 0.56, 0.03, matPanel, 0, 0, -0.02, panel);
  // 膝位板（板下延续到腿部）
  box(1.80, 0.30, 0.028, matMid, 0, -0.43, -0.05, panel);

  const pfd = createPFD();
  const nd = createND();
  const upper = createUpperEICAS();
  const lower = createLowerEICAS();
  const pfdFO = createPFD();   // 副驾外侧：同一 state 源的真实复制
  const ndFO = createND();

  // 上排：PFD/ND（外→内）×2 侧 + 中央上 EICAS（屏面距眼 ~0.70m，放大补偿广角视野）
  // 机长排 y 0.09；副驾排 y 0.07——顶边须低于 MCP 底缘视线（右排否则被 MCP 右下角切边）。
  // PFD 0.20 / ND 0.17 / 上 EICAS 0.23（canvas 比例 1:1 / 1:1 / 1.25）
  screen(pfd, 0.20, 0.20, -0.455, 0.09, 0.012, panel);
  screen(nd, 0.17, 0.17, -0.275, 0.09, 0.012, panel);
  screen(upper, 0.23, 0.184, 0.02, 0.065, 0.012, panel);
  screen(ndFO, 0.17, 0.17, 0.275, 0.07, 0.012, panel);
  screen(pfdFO, 0.17, 0.17, 0.455, 0.07, 0.012, panel);
  // 中央下 EICAS（canvas 1.333，叠放在上 EICAS 之下；底边须留在画面内）
  screen(lower, 0.225, 0.169, 0.02, -0.105, 0.012, panel);

  // 底部一排装饰电门（避开中央屏区）
  for (const x of [-0.79, -0.63, -0.47, -0.31, 0.29, 0.43, 0.57, 0.71]) {
    box(0.012, 0.05, 0.012, matMetal, x, -0.245, 0.012, panel);
  }

  /* ================= MCP 方式控制板（glareshield 前缘下的窄斜面，平视完整可见） ================= */
  const mcpDisp = createMCP();
  const mcp = new THREE.Group();
  mcp.position.set(MCP.x, MCP.y, MCP.z);
  mcp.rotation.x = MCP.tilt;
  group.add(mcp);
  box(0.44, 0.05, 0.06, matPanel, 0, 0, -0.025, mcp); // 薄壳：屏面凸出壳体前表面
  screen(mcpDisp, 0.39, 0.081, 0, 0, 0.004, mcp, 'mcp');

  /* ================= Glareshield（薄上斜板）+ 告警灯区 ================= */
  const glare = new THREE.Group();
  glare.position.set(GLARE.x, GLARE.y, GLARE.z);
  group.add(glare);
  const glareTop = box(1.90, 0.03, 0.12, matGlare, 0, 0.005, -0.02, glare);
  glareTop.rotation.x = 0.30; // 上表面朝飞行员上翻（MCP/告警灯贴装面）
  // 告警灯屏贴装在 glareshield 上斜面（随板面倾斜，正对飞行员低视线角）
  const annG = new THREE.Group();
  annG.position.set(0, 0.02, -0.008);
  annG.rotation.x = 0.30;
  glare.add(annG);
  const annL = createAnnunciator();
  const annR = createAnnunciator();
  screen(annL, 0.17, 0.085, -0.60, 0, 0.006, annG, 'annunc');
  screen(annR, 0.17, 0.085, 0.60, 0, 0.006, annG, 'annunc');
  // 主警告/主注意独立圆灯（MCP 两侧各一对）
  const lampMatW = new THREE.MeshBasicMaterial({ color: 0x1a0505, toneMapped: false });
  const lampMatC = new THREE.MeshBasicMaterial({ color: 0x1a1205, toneMapped: false });
  const lampW = new THREE.Mesh(new THREE.CircleGeometry(0.015, 20), lampMatW);
  const lampC = new THREE.Mesh(new THREE.CircleGeometry(0.015, 20), lampMatC);
  lampW.position.set(-0.33, -0.008, 0.012); lampC.position.set(-0.272, -0.008, 0.012);
  annG.add(lampW); annG.add(lampC);
  const lampW2 = lampW.clone(); lampW2.position.x = 0.272;
  const lampC2 = lampC.clone(); lampC2.position.x = 0.33;
  annG.add(lampW2); annG.add(lampC2);

  /* ---------- 防眩板：glareshield 到风挡下缘的上斜面板 ---------- */
  const antiGlare = box(1.90, 0.02, 0.20, matGlare, 0, 1.19, -0.84);
  antiGlare.rotation.x = 0.18;
  // glareshield 与仪表板顶端之间的封闭板（防止漏光缝隙；置于屏面之后不切屏）
  box(1.90, 0.10, 0.04, matPanel, 0, 1.165, -0.855);

  /* ---------- 遮光板（两片，收起位贴风挡顶） ---------- */
  const shade = new THREE.Group();
  shade.position.set(0, 1.965, -0.88);
  shade.rotation.x = 0.38;
  group.add(shade);
  box(0.44, 0.012, 0.14, matBlack, -0.27, 0, 0, shade);
  box(0.44, 0.012, 0.14, matBlack, 0.27, 0, 0, shade);

  /* ================= 顶板 ================= */
  const ohdDisp = createOverhead();
  const ohd = new THREE.Group();
  ohd.position.set(OHD.x, OHD.y, OHD.z);
  ohd.rotation.x = OHD.tilt; // 前倾 ~58°
  group.add(ohd);
  box(0.86, 0.50, 0.03, std(MAT.overhead), 0, 0, -0.016, ohd);
  screen(ohdDisp, 0.82, 0.449, 0, 0, 0.002, ohd, 'overhead');

  /* ================= 中央台（微升高，台面加宽承载 CDU） ================= */
  const pedDisp = createPedestal();
  const ped = new THREE.Group();
  ped.position.set(PED.x, PED.y, PED.z);
  ped.rotation.x = PED.tilt; // 后倾（顶边接仪表板下沿，往后下斜）
  group.add(ped);
  box(0.56, 0.47, 0.03, matPanel, 0, 0, -0.016, ped);
  screen(pedDisp, 0.30, 0.36, 0, 0, 0.002, ped, 'pedestal');
  // 台体基座
  box(0.42, 0.30, 0.62, matMid, 0, 0.42, -0.24);

  /* ---------- FMC/CDU（中央台左前凸台：平视视线 ~-40°，完整入画；canvas 比例 1.325） ---------- */
  box(0.16, 0.03, 0.14, matPanel, -0.30, 0.843, -0.55);   // CDU 凸台
  const cduDisp = createCDU();
  const cdu = new THREE.Group();
  cdu.position.set(-0.30, 0.905, -0.60);
  cdu.rotation.x = -0.50;
  group.add(cdu);
  box(0.14, 0.11, 0.018, matPanel, 0, 0, -0.006, cdu);    // 壳体
  screen(cduDisp, 0.10, 0.0755, 0, 0.004, 0.004, cdu);

  // --- 油门杆 ×2（canvas 油门弧中心 (150,240) → 局部 (-0.096, +0.081)）---
  const mkLever = (h) => {
    const g = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, h, 8), matMetal);
    rod.position.y = h / 2;
    g.add(rod);
    const knob = box(0.02, 0.032, 0.05, matBlack, 0, h, 0, g);
    void knob;
    return g;
  };
  const throttleL = mkLever(0.10); throttleL.position.set(-0.100, 0.081, 0.03); ped.add(throttleL);
  const throttleR = mkLever(0.10); throttleR.position.set(-0.062, 0.081, 0.03); ped.add(throttleR);
  const reverseHandle = mkLever(0.06); reverseHandle.position.set(-0.081, 0.145, 0.035); ped.add(reverseHandle);

  // --- 襟翼手柄（弧心 (150,560) → (-0.096, -0.098)）---
  const flapLever = mkLever(0.085);
  flapLever.position.set(-0.096, -0.098, 0.03);
  ped.add(flapLever);

  // --- 起落架手柄（(470,470) → (+0.084, -0.048)）---
  const gearLever = new THREE.Group();
  const gRod = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.07, 8), matMetal);
  gRod.position.y = 0.035; gearLever.add(gRod);
  const gKnob = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 10), matBlack);
  gKnob.position.y = 0.07; gearLever.add(gKnob);
  gearLever.position.set(0.084, -0.048, 0.03);
  ped.add(gearLever);

  // --- 配平轮 ×2（canvas (320,688) → y=-0.170）---
  const mkTrimWheel = (x) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.024, 20), matBlack);
    m.rotation.z = Math.PI / 2; // 轴沿 x
    const g = new THREE.Group();
    g.add(m);
    // 轮辐
    for (let i = 0; i < 3; i++) {
      const sp = box(0.05, 0.004, 0.004, matMetal, 0, 0, 0, g);
      sp.rotation.x = (i * Math.PI) / 3;
    }
    g.position.set(x, -0.170, 0.045);
    ped.add(g);
    return g;
  };
  const trimWheelL = mkTrimWheel(-0.022);
  const trimWheelR = mkTrimWheel(0.022);

  /* ================= 操纵杆（737 轮式杆：立柱钢管 + 横弓 + 垂直握柄；机长侧可动）================= */
  const mkYoke = () => {
    const col = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.038, 0.03, 12), matMetal);
    base.position.y = 0.015;
    col.add(base);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 0.30, 10), matMetal);
    shaft.position.y = 0.17;
    col.add(shaft);
    const wheel = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.0075, 10, 28), matBlack);
    bow.rotation.x = Math.PI / 2;
    wheel.add(bow);
    box(0.028, 0.045, 0.028, matBlack, 0, 0.006, 0, wheel);   // 中央立柱轴套
    box(0.104, 0.012, 0.022, matBlack, 0, 0, 0, wheel);        // 横梁
    for (const s of [-1, 1]) {
      box(0.016, 0.052, 0.026, matBlack, s * 0.052, 0.02, 0, wheel); // 垂直握柄
    }
    wheel.position.y = 0.32;
    col.add(wheel);
    return { col, wheel };
  };
  const yokeC = mkYoke();
  yokeC.col.position.set(-0.36, 0.52, -0.48);
  group.add(yokeC.col);
  const yokeF = mkYoke();
  yokeF.col.position.set(0.36, 0.52, -0.48);
  group.add(yokeF.col);

  /* ================= 座椅（简化轮廓：坐垫/靠背/头枕/扶手）================= */
  for (const s of [-1, 1]) {
    box(0.36, 0.07, 0.38, matMid, s * 0.36, 0.52, 0.30);       // 坐垫
    const back = box(0.36, 0.55, 0.07, matMid, s * 0.36, 0.83, 0.50);
    back.rotation.x = 0.10;                                     // 靠背
    box(0.22, 0.15, 0.06, matMid, s * 0.36, 1.14, 0.55);        // 头枕
    for (const a of [-1, 1]) {
      box(0.08, 0.025, 0.30, matBlack, s * 0.36 + a * 0.20, 0.665, 0.32); // 扶手
      box(0.02, 0.11, 0.02, matMetal, s * 0.36 + a * 0.20, 0.60, 0.42);   // 支架
    }
  }

  /* ================= 舱体 / 挡风玻璃框 ================= */
  box(2.0, 0.05, 2.4, matMid, 0, -0.02, -0.2);                       // 地板
  box(2.0, 0.05, 2.2, matMid, 0, 2.16, -0.3);                        // 顶棚
  for (const s of [-1, 1]) {
    // 侧壁（外移 + 前缘外撇收拢：机身前段收窄锥度，左/右前方不再被平直侧壁遮死，
    // 侧前方便从侧窗 #2 透入天地线）
    const wall = box(0.05, 2.1, 2.2, matMid, s * 1.10, 1.05, -0.25);
    wall.rotation.z = s * 0.10;
    wall.rotation.y = -s * 0.16;
  }
  box(2.0, 0.5, 0.05, matMid, 0, 1.2, 0.75);                         // 后隔框
  // glareshield 两端的侧向装饰板（舷窗下沿到台面）
  for (const s of [-1, 1]) {
    box(0.05, 0.30, 0.55, matMid, s * 0.90, 1.14, -0.62);
  }

  // 挡风玻璃：前风挡 #1 左右（加大下延：下缘 ~-12° 保证平视见地面；顶边后掠 0.32 rad）+ 侧窗 #2/#3
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x8fa8b8, transparent: true, opacity: 0.10, roughness: 0.05,
    metalness: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  const windshield = (x) => {
    const g = new THREE.Group();
    g.position.set(x, WSW.y, WSW.z);
    g.rotation.x = WSW.tilt;
    group.add(g);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.78), glassMat);
    g.add(pane);
    const fw = 0.57, fh = 0.80, t = 0.026;
    box(fw, t, 0.05, matBlack, 0, fh / 2, 0, g);
    box(fw, t, 0.05, matBlack, 0, -fh / 2, 0, g);
    box(t, fh, 0.05, matBlack, -fw / 2, 0, 0, g);
    box(t, fh, 0.05, matBlack, fw / 2, 0, 0, g);
    return g;
  };
  windshield(-WSW.halfW);
  windshield(WSW.halfW);

  // 侧窗 #2（每侧一大块，前移外扩：占据风挡框外的侧前视区，天地线从这里透入）
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.76, 1.66, -0.82);
    g.rotation.y = s * -0.60;
    g.rotation.z = s * -0.05;
    group.add(g);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.62), glassMat);
    g.add(pane);
    const fw = 0.68, fh = 0.64, t = 0.028;
    box(fw, t, 0.04, matMid, 0, fh / 2, 0, g);
    box(fw, t, 0.04, matMid, 0, -fh / 2, 0, g);
    box(t, fh, 0.04, matMid, -fw / 2, 0, 0, g);
    box(t, fh, 0.04, matMid, fw / 2, 0, 0, g);
  }
  // 侧窗 #3（后侧小窗，装饰）
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.88, 1.64, -0.10);
    g.rotation.y = s * -1.05;
    group.add(g);
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.44), glassMat);
    g.add(pane);
    const fw = 0.42, fh = 0.46, t = 0.035;
    box(fw, t, 0.04, matMid, 0, fh / 2, 0, g);
    box(fw, t, 0.04, matMid, 0, -fh / 2, 0, g);
    box(t, fh, 0.04, matMid, -fw / 2, 0, 0, g);
    box(t, fh, 0.04, matMid, fw / 2, 0, 0, g);
  }
  // 中央窗柱（两块前风挡之间，随玻璃后掠；评审轮 2 再砍半：0.034→0.02，视觉总宽≈真机）
  const centerPost = box(0.02, 0.80, 0.03, matBlack, 0, WSW.y, WSW.z + 0.02);
  centerPost.rotation.x = WSW.tilt;
  // 挡风斜柱（#1 与侧窗 #2 之间，减薄）
  for (const s of [-1, 1]) {
    const post = box(0.04, 0.84, 0.05, matBlack, s * 0.60, 1.56, -0.90);
    post.rotation.y = s * 0.38;
    post.rotation.x = WSW.tilt;
  }
  // 侧窗 #2 下缘的窗台封板（低矮、靠后外侧：只封窗台以下的窄条，不挡侧前视区）
  for (const s of [-1, 1]) {
    const sill = box(0.05, 0.14, 0.40, matMid, s * 0.86, 1.30, -0.92);
    sill.rotation.y = s * -0.55;
  }

  /* ================= 雨刷（停机位：贴风挡底缘横置、臂尖指向外侧窗柱；随命令摆动） ================= */
  const mkWiper = (x) => {
    const g = new THREE.Group();
    g.position.set(x, 1.20, -0.90);   // 铰点贴玻璃下缘
    g.rotation.x = WSW.tilt;          // 臂贴着风挡平面
    group.add(g);
    box(0.011, 0.34, 0.008, matBlack, 0, 0.17, 0.010, g);  // 臂
    box(0.015, 0.30, 0.004, matBlack, 0, 0.15, 0.016, g);  // 刮片
    return g;
  };
  const wiperL = mkWiper(-0.10);
  const wiperR = mkWiper(0.10);

  /* ================= 座舱照明（group 内局部光源，跟随飞机） =================
   * 全部用 SpotLight/PointLight（带 distance 衰减）而非 Directional/Hemisphere，
   * 避免方向光/半球光外泄影响世界。强度基准三态见 index.js 的 LIGHT_PRESETS。
   *   sunSpot    日光自风挡洒入仪表台（白天主光，前上→后下，面板有迎光/背光层次）
   *   cabinFill  座舱柔和补光（地板/座椅/侧壁不漆黑）
   *   panelGlow  屏幕自发光对外泄光（夜间为主，青绿色调贴玻璃屏氛围）
   *   nightFlood 夜间面板泛光灯（暖白，低强度）
   */
  const mkSpot = () => {
    const s = new THREE.SpotLight(0xfff3e0, 0, 7, 1.15, 0.75, 1.2);
    s.position.set(0.3, 2.35, -1.55);
    const t = new THREE.Object3D();
    t.position.set(0, 0.80, -0.50);
    group.add(t);
    s.target = t;
    group.add(s);
    return s;
  };
  const sunSpot = mkSpot();
  const cabinFill = new THREE.PointLight(0xdfe6ee, 0, 6, 1.4);
  cabinFill.position.set(0, 1.95, 0.15);
  group.add(cabinFill);
  const panelGlow = new THREE.PointLight(0x8fd0c0, 0, 1.6, 1.8);
  panelGlow.position.set(0, 1.05, -0.50);
  group.add(panelGlow);
  const nightFlood = new THREE.PointLight(0xffe8c8, 0, 2.4, 1.8);
  nightFlood.position.set(0, 1.98, -0.15);
  group.add(nightFlood);
  const cockpitLights = { sunSpot, cabinFill, panelGlow, nightFlood };

  /* ================= 机长眼位 ================= */
  const cameraAnchor = new THREE.Object3D();
  cameraAnchor.position.set(EYE.x, EYE.y, EYE.z);
  cameraAnchor.rotation.x = EYE.pitch; // 平视 sightline（扫视偏移由 index.js 运行时叠加）
  group.add(cameraAnchor);

  return {
    group,
    cameraAnchor,
    eyePitch: EYE.pitch,
    clickables,
    lights: cockpitLights,
    displays: { pfd, nd, upper, lower, pfdFO, ndFO, mcp: mcpDisp, overhead: ohdDisp, pedestal: pedDisp, cdu: cduDisp, annL, annR },
    anim: {
      throttleL, throttleR, reverseHandle, flapLever, gearLever,
      trimWheelL, trimWheelR, yokeC, yokeF, wiperL, wiperR,
      lampW: [lampMatW, lampMatC],
    },
  };
}
