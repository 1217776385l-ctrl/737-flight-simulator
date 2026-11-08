/**
 * displays.js — Canvas 2D 绘制的玻璃座舱仪表，导出为 THREE.CanvasTexture。
 *
 * 铁律：所有绘制只读内核 state（见 docs/kernel-api.md），本文件不做任何物理推算。
 * 唯一的"派生量"是显示级平滑（如空速趋势矢量 = state.velocity.ias 的显示端差分，
 * 由 index.js 传入 extras.iasRate），不参与任何仿真。
 *
 * 每个工厂返回 { canvas, texture, w, h, draw(state, extras) }；
 * index.js 以 ~15 Hz 调 draw 并置 texture.needsUpdate。
 */

import * as THREE from 'three';
import { INK, rr, txt, wrap180, wrap360, clamp } from './palette.js';
import { getVSpeeds, getVref, stallIasKt, glideSlopeDevDeg } from '../kernel/index.js';

const D2R = Math.PI / 180;

/** 建立带纹理的显示画布 */
function makeDisplay(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // willReadFrequently → CPU 侧画布：上传到 WebGL 纹理时永不含未栅格化瓦片
  //（headless 虚拟时间下 GPU 栅格化滞后会产生棋盘伪影；CPU 画布 15Hz 重绘开销可接受）
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = false;   // 屏幕常被斜视/缩小，禁 mipmap 保持文字可读
  texture.minFilter = THREE.LinearFilter;
  return { canvas, ctx, texture, w, h, draw: null };
}

function bg(d, color = INK.bg) {
  d.ctx.fillStyle = color;
  d.ctx.fillRect(0, 0, d.w, d.h);
}

function commit(d) {
  // 上传走 ImageData（CPU 确定性路径）：headless SwiftShader 下 CanvasTexture
  // 的增量上传会残留陈旧瓦片；ImageData 整块上传无此问题。
  d.texture.image = d.ctx.getImageData(0, 0, d.w, d.h);
  d.texture.needsUpdate = true;
}

/** 闪烁辅助：simTime 下占空比 */
function blink(t, period = 0.5, duty = 0.55) {
  return (t % period) < period * duty;
}

/* =========================================================
 * PFD 主飞行显示（机长外侧 / 副驾外侧共用同一绘制）
 * ========================================================= */

export function createPFD() {
  const d = makeDisplay(512, 512);

  d.draw = (state, extras) => {
    const c = d.ctx;
    bg(d);
    drawFMA(c, state);
    drawSpeedTape(c, state, extras);
    drawADI(c, state, extras);
    drawAltVSI(c, state);
    drawHeadingTape(c, state);
    drawPfdWarnings(c, state, extras);
    commit(d);
  };
  return d;
}

/* ----- FMA 自动飞行方式通告 ----- */
function drawFMA(c, state) {
  const ap = state.ap;
  const m = ap.modes;
  c.fillStyle = INK.bg;
  c.fillRect(0, 0, 512, 40);
  c.strokeStyle = INK.white;
  c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, 39.5); c.lineTo(512, 39.5); c.stroke();

  // 第 1 列：横滚方式
  if (m.hdgSel) txt(c, 'HDG SEL', 68, 20, 22, INK.green, '700');
  else if (m.locCaptured) txt(c, 'LOC', 68, 20, 22, INK.green, '700');
  // 第 2 列：俯仰方式
  if (m.gsCaptured) txt(c, 'G/S', 190, 20, 22, INK.green, '700');
  else if (m.vs) txt(c, 'VS', 190, 20, 22, INK.green, '700');
  else if (m.altHold) txt(c, 'ALT HOLD', 190, 20, 22, INK.green, '700');
  else if (m.altSel) txt(c, 'ALT SEL', 190, 20, 22, INK.green, '700');
  // 第 3 列：进近
  if (m.app) txt(c, 'APP', 300, 20, 22, INK.cyan, '700');
  // 第 4 列：CMD / 自动油门
  if (ap.engaged) txt(c, 'CMD', 408, 20, 22, INK.green, '700');
  if (ap.atArmed || m.spd) txt(c, 'SPD', 468, 20, 22, INK.white, '700');
}

/* ----- 空速带 ----- */
function drawSpeedTape(c, state, extras) {
  const x0 = 14, x1 = 96, y0 = 46, y1 = 432;
  const cy = 239, pxPerKt = 3.2;
  const ias = state.velocity.ias;
  const mass = state.massKg;

  c.save();
  rr(c, x0, y0, x1 - x0, y1 - y0, 6); c.clip();
  c.fillStyle = '#0b0e10'; c.fillRect(x0, y0, x1 - x0, y1 - y0);

  // 超速 barber pole（VMO 以上红色）
  const yVmo = cy - (state.aircraft.vmoKt - ias) * pxPerKt;
  if (yVmo > y0) {
    c.fillStyle = INK.red;
    c.fillRect(x1 - 14, y0, 14, Math.min(yVmo, y1) - y0);
  }
  // 失速警戒带（红 + 琥珀缓冲）
  const vstall = stallIasKt(mass, state.flaps.angle, state.ice.accumulation);
  const yAmbT = cy - (vstall * 1.18 - ias) * pxPerKt;
  const yAmbB = cy - (vstall * 1.03 - ias) * pxPerKt;
  const yRedT = cy - (vstall * 1.03 - ias) * pxPerKt;
  c.fillStyle = INK.amber;
  if (yAmbB > y0) c.fillRect(x1 - 14, Math.max(yAmbT, y0), 14, Math.min(yAmbB, y1) - Math.max(yAmbT, y0));
  c.fillStyle = INK.red;
  if (y1 > yRedT) c.fillRect(x1 - 14, Math.max(yRedT, y0), 14, y1 - Math.max(yRedT, y0));

  // 刻度：每 10 kt，标数每 20 kt
  c.strokeStyle = INK.white; c.fillStyle = INK.white;
  c.lineWidth = 2; c.textAlign = 'right'; c.textBaseline = 'middle';
  c.font = '600 15px ui-monospace, Menlo, monospace';
  const lo = Math.floor((ias - 65) / 10) * 10;
  for (let k = lo; k <= ias + 65; k += 10) {
    if (k < 0) continue;
    const y = cy - (k - ias) * pxPerKt;
    if (y < y0 || y > y1) continue;
    c.beginPath(); c.moveTo(x1 - 14, y); c.lineTo(x1, y); c.stroke();
    if (k % 20 === 0) c.fillText(String(k), x1 - 20, y);
  }

  // V 速度游标（内核 vspeeds 表）
  const vs = getVSpeeds(mass, state.flaps.index);
  const bugs = [
    { v: vs.v1, col: INK.magenta, label: 'V1' },
    { v: vs.vr, col: INK.white, label: 'VR' },
    { v: vs.v2, col: INK.cyan, label: 'V2' },
    { v: getVref(mass, 6), col: INK.green, label: 'VRf' },
  ];
  for (const b of bugs) {
    if (!b.v) continue;
    const y = clamp(cy - (b.v - ias) * pxPerKt, y0, y1);
    c.fillStyle = b.col;
    c.fillRect(x0, y - 2, 18, 4);
    txt(c, b.label, x0 + 30, y, 12, b.col, '700');
  }

  // 趋势矢量（显示端 10 s 外推）
  const trend = clamp((extras.iasRate || 0) * 10, -60, 60) * pxPerKt;
  if (Math.abs(trend) > 3) {
    const yA = cy, yB = cy - trend;
    c.fillStyle = INK.green;
    c.fillRect(x0 + 2, Math.min(yA, yB), 6, Math.abs(trend));
    c.beginPath();
    const dir = Math.sign(trend);
    c.moveTo(x0 + 2, yB); c.lineTo(x0 + 8, yB); c.lineTo(x0 + 5, yB - 10 * dir);
    c.closePath(); c.fill();
  }
  c.restore();

  // 当前空速窗
  c.fillStyle = '#000'; c.strokeStyle = INK.white; c.lineWidth = 2.5;
  rr(c, x0, cy - 21, 74, 42, 4); c.fill(); c.stroke();
  txt(c, Math.round(ias).toString(), x0 + 37, cy + 1, 28, INK.white, '700');
  if (state.velocity.mach > 0.35) {
    txt(c, '.' + (state.velocity.mach * 100).toFixed(0).padStart(2, '0'), x0 + 40, cy + 42, 18, INK.white, '600');
  }
}

/* ----- 姿态指引仪 ----- */
function drawADI(c, state, extras) {
  const cx = 248, cy = 239, halfW = 140, halfH = 190, pxPerDeg = 7;
  const pitch = state.orientation.pitch;
  const bank = state.orientation.bank;
  const o = state.orientation;

  c.save();
  rr(c, cx - halfW, cy - halfH, halfW * 2, halfH * 2, 12); c.clip();

  c.translate(cx, cy);
  c.rotate(-bank * D2R);
  const py = pitch * pxPerDeg;

  // 天空 / 地面
  c.fillStyle = INK.sky;
  c.fillRect(-260, py - 480, 520, 480);
  c.fillStyle = INK.ground;
  c.fillRect(-260, py, 520, 480);
  c.strokeStyle = INK.horizon; c.lineWidth = 3;
  c.beginPath(); c.moveTo(-260, py); c.lineTo(260, py); c.stroke();

  // 俯仰刻度
  c.lineWidth = 2.5; c.strokeStyle = INK.white; c.fillStyle = INK.white;
  c.font = '700 15px ui-monospace, Menlo, monospace';
  for (let p = -30; p <= 30; p += 2.5) {
    if (p === 0) continue;
    const y = py - p * pxPerDeg;
    const major = Math.abs(p % 10) < 0.01;
    const mid = Math.abs(p % 5) < 0.01;
    const w = major ? 60 : mid ? 40 : 18;
    c.beginPath();
    c.moveTo(-w, y); c.lineTo(w, y); c.stroke();
    if (major) {
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(String(Math.abs(p)), -w - 16, y);
      c.fillText(String(Math.abs(p)), w + 16, y);
    }
  }

  // 坡度指针（随坡度转动，画在旋转系顶部）
  c.fillStyle = INK.white;
  c.beginPath();
  c.moveTo(0, -halfH + 6); c.lineTo(-11, -halfH + 26); c.lineTo(11, -halfH + 26);
  c.closePath(); c.fill();

  // 飞行指引杆（FD 目标姿态，内核 ap.fd）
  if (state.ap.engaged || state.ap.atArmed) {
    c.fillStyle = INK.magenta;
    const fdY = clamp(py - state.ap.fd.pitch * pxPerDeg, -170, 170);
    c.fillRect(-150, fdY - 5, 110, 10);
    c.fillRect(40, fdY - 5, 110, 10);
    const fdX = clamp((state.ap.fd.bank - bank) * 3.2, -70, 70);
    c.fillRect(fdX - 5, -150, 10, 110);
    c.fillRect(fdX - 5, 40, 10, 110);
  }
  c.restore();

  // 固定飞机符号
  c.fillStyle = '#f5c400'; c.strokeStyle = '#111'; c.lineWidth = 2;
  c.save();
  c.translate(cx, cy);
  c.beginPath();
  c.moveTo(-92, 0); c.lineTo(-30, 0); c.lineTo(-30, 12); c.lineTo(-16, 12); c.lineTo(-16, 0);
  c.moveTo(92, 0); c.lineTo(30, 0); c.lineTo(30, 12); c.lineTo(16, 12); c.lineTo(16, 0);
  c.rect(-9, -9, 18, 18);
  c.fill(); c.stroke();
  c.restore();

  // 固定坡度刻度 + 侧滑指示
  c.save();
  c.translate(cx, cy);
  c.strokeStyle = INK.white; c.fillStyle = INK.white; c.lineWidth = 2.5;
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    c.save();
    c.rotate(a * D2R);
    const len = a === 0 ? 16 : Math.abs(a) % 30 === 0 ? 12 : 8;
    c.beginPath(); c.moveTo(0, -halfH); c.lineTo(0, -halfH + len); c.stroke();
    c.restore();
  }
  const slip = clamp(state.velocity.sideslip * 2.5, -30, 30);
  c.fillStyle = INK.white;
  c.beginPath();
  c.moveTo(slip - 14, -halfH + 30); c.lineTo(slip - 6, -halfH + 30);
  c.lineTo(slip + 6, -halfH + 38); c.lineTo(slip - 14, -halfH + 38);
  c.closePath(); c.fill();
  c.restore();

  // 无数据边框遮黑（窗外区域由 clip 保证）
  void extras;
}

/* ----- 高度带 + 升降速度 ----- */
function drawAltVSI(c, state) {
  const x0 = 402, x1 = 468, y0 = 46, y1 = 432;
  const cy = 239, pxPerFt = 0.4;
  const alt = state.position.y * 3.28084;

  c.save();
  rr(c, x0, y0, x1 - x0, y1 - y0, 6); c.clip();
  c.fillStyle = '#0b0e10'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
  c.strokeStyle = INK.white; c.lineWidth = 2;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  c.fillStyle = INK.white;
  c.font = '600 13px ui-monospace, Menlo, monospace';
  const lo = Math.floor((alt - 500) / 100) * 100;
  for (let a = lo; a <= alt + 500; a += 100) {
    const y = cy - (a - alt) * pxPerFt;
    if (y < y0 || y > y1) continue;
    c.beginPath(); c.moveTo(x1 - 12, y); c.lineTo(x1, y); c.stroke();
    if (a % 200 === 0) c.fillText(String(a), x1 - 16, y);
  }
  c.restore();

  // 当前高度窗（负值地面以下显示为负）
  c.fillStyle = '#000'; c.strokeStyle = INK.white; c.lineWidth = 2.5;
  rr(c, x0, cy - 21, x1 - x0 + 4, 42, 4); c.fill(); c.stroke();
  txt(c, Math.round(alt).toString(), x0 + (x1 - x0) / 2, cy + 1, 24, INK.white, '700');
  txt(c, '29.92', x0 + (x1 - x0) / 2, y1 - 14, 13, INK.gray, '600');

  // 无线电高度（低高度绿色读数）
  const raFt = state.agl * 3.28084;
  if (raFt < 2500 && raFt > 0) {
    txt(c, String(Math.round(raFt / 10) * 10), x0 + (x1 - x0) / 2, y1 - 34, 18, INK.green, '700');
  }

  // 升降速度带
  const vx0 = 476, vx1 = 504;
  c.save();
  rr(c, vx0, y0, vx1 - vx0, y1 - y0, 6); c.clip();
  c.fillStyle = '#0b0e10'; c.fillRect(vx0, y0, vx1 - vx0, y1 - y0);
  c.strokeStyle = INK.gray; c.lineWidth = 1.5;
  for (const f of [-2000, -1000, 0, 1000, 2000]) {
    const y = cy - clamp(f, -2200, 2200) / 2200 * 180;
    c.beginPath(); c.moveTo(vx0, y); c.lineTo(vx0 + 6, y); c.stroke();
  }
  const vs = clamp(state.velocity.vsFpm, -2200, 2200);
  const yv = cy - vs / 2200 * 180;
  c.fillStyle = INK.white;
  c.beginPath();
  c.moveTo(vx1 - 12, yv); c.lineTo(vx1, yv - 7); c.lineTo(vx1, yv + 7);
  c.closePath(); c.fill();
  c.restore();
  c.fillStyle = '#000'; c.strokeStyle = INK.white; c.lineWidth = 2;
  rr(c, 398, 408, 110, 26, 3); c.fill(); c.stroke();
  const vsTxt = (vs >= 0 ? '+' : '') + Math.round(state.velocity.vsFpm / 10) * 10;
  txt(c, vsTxt, 453, 422, 17, INK.green, '700');
}

/* ----- 航向带 ----- */
// 内核 heading 为跑道局部角；显示层统一加活动跑道罗盘锚点（见 docs/kernel-api.md）
function compassHdg(state) {
  return wrap360(state.orientation.heading + (state.runway.headingDeg || 0));
}
function drawHeadingTape(c, state) {
  const y0 = 452, y1 = 508, cx = 248, pxPerDeg = 4.4;
  const hdg = compassHdg(state);

  c.fillStyle = '#0b0e10';
  c.fillRect(90, y0, 320, y1 - y0);
  c.save();
  rr(c, 90, y0, 320, y1 - y0, 4); c.clip();
  c.strokeStyle = INK.white; c.fillStyle = INK.white; c.lineWidth = 2;
  c.font = '600 14px ui-monospace, Menlo, monospace';
  c.textAlign = 'center'; c.textBaseline = 'top';
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  const lo = Math.floor((hdg - 38) / 5) * 5;
  for (let b = lo; b <= hdg + 38; b += 5) {
    const x = cx + wrap180(b - hdg) * pxPerDeg;
    if (x < 90 || x > 410) continue;
    const bb = ((b % 360) + 360) % 360;
    c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y0 + (bb % 10 === 0 ? 10 : 6)); c.stroke();
    if (bb % 10 === 0) {
      const lbl = names[bb] ?? String(bb / 10).padStart(2, '0');
      c.fillText(lbl, x, y0 + 13);
    }
  }
  // 航迹菱形
  const trk = Math.atan2(state.velocity.vz, state.velocity.vx) / D2R;
  if (state.velocity.gs > 5) {
    const xt = cx + clamp(wrap180(trk - hdg), -36, 36) * pxPerDeg;
    c.fillStyle = INK.white;
    c.save(); c.translate(xt, y0 + 4); c.rotate(Math.PI / 4); c.fillRect(-4, -4, 8, 8); c.restore();
  }
  // HDG 目标游标（Magenta）
  const xh = cx + clamp(wrap180(state.ap.targets.hdg - hdg), -36, 36) * pxPerDeg;
  c.fillStyle = INK.magenta;
  c.beginPath();
  c.moveTo(xh - 9, y1); c.lineTo(xh + 9, y1); c.lineTo(xh, y1 - 12);
  c.closePath(); c.fill();
  c.restore();

  // 指针
  c.fillStyle = INK.white;
  c.beginPath();
  c.moveTo(cx, y0 + 2); c.lineTo(cx - 8, y0 - 12); c.lineTo(cx + 8, y0 - 12);
  c.closePath(); c.fill();
  txt(c, 'HDG ' + Math.round(wrap360(hdg)).toString().padStart(3, '0'), 468, 480, 18, INK.white, '700');
}

/* ----- PFD 中央警告旗 ----- */
function drawPfdWarnings(c, state, extras) {
  const w = state.warnings;
  if (!w.active.length && !w.stickShaker) return;
  if (!blink(extras.now, 0.4, 0.65)) return;
  const label = w.stickShaker && !w.active.includes('STALL') ? 'STALL' : w.active[0];
  c.fillStyle = 'rgba(120,0,0,0.85)';
  rr(c, 148, 210, 200, 52, 6); c.fill();
  c.strokeStyle = INK.red; c.lineWidth = 3; rr(c, 148, 210, 200, 52, 6); c.stroke();
  txt(c, label, 248, 237, 28, INK.red, '800');
}

/* =========================================================
 * ND 导航显示（机长内侧）
 * ========================================================= */

export function createND() {
  const d = makeDisplay(512, 512);

  d.draw = (state, extras) => {
    const c = d.ctx;
    bg(d);
    const hdg = compassHdg(state); // 罗盘系：风向箭头/罗盘玫瑰按罗盘绘制
    const CX = 256, CY = 286, R = 196;

    // 顶部信息条
    c.fillStyle = '#0b0e10'; c.fillRect(0, 0, 512, 34);
    c.strokeStyle = INK.dimGray; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, 33.5); c.lineTo(512, 33.5); c.stroke();
    txt(c, 'GS ' + Math.round(state.velocity.gs), 66, 17, 18, INK.green, '700');
    txt(c, 'TAS ' + Math.round(state.velocity.tas), 160, 17, 18, INK.green, '700');
    txt(c, 'MAP', 256, 17, 18, INK.white, '700');
    const dmeNm = state.nav.distM / 1852;
    if (state.nav.distM < 1e6) txt(c, 'DME ' + dmeNm.toFixed(1), 448, 17, 18, INK.white, '700');

    // 风向风速
    const wd = state.weather.windDirDeg, wk = state.weather.windKts;
    if (wk > 1) {
      const ax = 62, ay = 86;
      c.save();
      c.translate(ax, ay);
      c.rotate((wd + 180 - hdg) * D2R);
      c.strokeStyle = INK.white; c.fillStyle = INK.white; c.lineWidth = 3;
      c.beginPath(); c.moveTo(0, 14); c.lineTo(0, -14); c.lineTo(-6, -6); c.moveTo(0, -14); c.lineTo(6, -6); c.stroke();
      c.restore();
      txt(c, Math.round(wd) + '/' + Math.round(wk), 62, 112, 14, INK.white, '600');
    }
    txt(c, '40 NM', 448, 70, 15, INK.white, '600');

    // 罗盘玫瑰（head-up 旋转）
    c.save();
    c.beginPath(); c.arc(CX, CY, R + 8, 0, Math.PI * 2); c.clip();
    c.strokeStyle = INK.white; c.fillStyle = INK.white;
    c.lineWidth = 2;
    c.font = '600 15px ui-monospace, Menlo, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let b = 0; b < 360; b += 5) {
      const rel = wrap180(b - hdg);
      const a = (rel - 90) * D2R;
      const rr0 = R, tick = b % 30 === 0 ? 16 : 8;
      const x0 = CX + Math.cos(a) * rr0, y0 = CY + Math.sin(a) * rr0;
      const x1 = CX + Math.cos(a) * (rr0 - tick), y1 = CY + Math.sin(a) * (rr0 - tick);
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      if (b % 30 === 0) {
        const xr = CX + Math.cos(a) * (rr0 - 32), yr = CY + Math.sin(a) * (rr0 - 32);
        const lbl = names[b] ?? String(b / 10).padStart(2, '0');
        c.fillText(lbl, xr, yr);
      }
    }
    c.restore();

    // 气象雷达回波（雷暴 / 强降水时显示，读 state.weather）
    const wx = state.weather;
    if (wx.precipitation !== 'none' || wx.turbulence > 0.25) {
      const inten = Math.max(wx.turbulence, wx.precipitation === 'none' ? 0.3 : 0.6);
      c.save();
      c.beginPath(); c.arc(CX, CY, R - 6, 0, Math.PI * 2); c.clip();
      for (let i = 0; i < 6; i++) {
        const seed = i * 17 + 3;
        const rnd = (n) => {
          const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
          return s - Math.floor(s);
        };
        const rel = (rnd(1) - 0.5) * 130;          // -65..65° 相对机头
        const dist = (0.35 + rnd(2) * 0.6) * R;
        const t = Math.floor(extras.now / 4);       // 每 4 s 缓慢演化
        const lvl = Math.floor(rnd(3) * 3 + inten * 2 + rnd(3 + t) * 1.2);
        const col = lvl > 3.2 ? INK.red : lvl > 2.2 ? INK.amber : INK.green;
        const a = (rel - 90) * D2R;
        const bx = CX + Math.cos(a) * dist, by = CY + Math.sin(a) * dist;
        const rad = 12 + rnd(4) * 22;
        c.fillStyle = col; c.globalAlpha = 0.55;
        c.beginPath(); c.ellipse(bx, by, rad * 1.5, rad, a + Math.PI / 2, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
      c.restore();
    }

    // 到目的地机场的方位箭头（读 state.nav）
    if (state.nav.distM < 1e6) {
      const rel = wrap180(state.nav.courseDeg - hdg);
      const a = (rel - 90) * D2R;
      const dNm = dmeNm;
      const rr2 = clamp(dNm / 40, 0.12, 1) * (R - 10);
      const px = CX + Math.cos(a) * rr2, pyy = CY + Math.sin(a) * rr2;
      c.strokeStyle = INK.white; c.lineWidth = 3;
      c.beginPath(); c.moveTo(CX, CY); c.lineTo(px, pyy); c.stroke();
      c.save();
      c.translate(px, pyy); c.rotate(a + Math.PI / 2);
      c.fillStyle = INK.white;
      c.beginPath(); c.moveTo(0, 10); c.lineTo(-7, -6); c.lineTo(7, -6); c.closePath(); c.fill();
      c.restore();
      // 机场符号
      c.strokeStyle = INK.white; c.lineWidth = 2.5;
      c.beginPath(); c.arc(px, pyy, 8, 0, Math.PI * 2); c.stroke();
    }

    // 航迹线
    if (state.velocity.gs > 5) {
      const rel = wrap180(Math.atan2(state.velocity.vz, state.velocity.vx) / D2R - hdg);
      const a = (rel - 90) * D2R;
      c.strokeStyle = INK.white; c.lineWidth = 2; c.setLineDash([10, 8]);
      c.beginPath(); c.moveTo(CX, CY);
      c.lineTo(CX + Math.cos(a) * (R - 12), CY + Math.sin(a) * (R - 12)); c.stroke();
      c.setLineDash([]);
    }

    // ILS：航道指针 + 偏离杆 + 下滑道点（读 nav.locValid / glideSlopeDevDeg）
    if (state.nav.locValid || state.nav.gsValid || state.ap.modes.app) {
      const relC = wrap180(state.nav.courseDeg - hdg);
      const a = (relC - 90) * D2R;
      c.save();
      c.translate(CX, CY); c.rotate(a + Math.PI / 2);
      c.strokeStyle = INK.cyan; c.lineWidth = 3.5;
      c.beginPath(); c.moveTo(0, -R + 4); c.lineTo(0, -30); c.moveTo(0, 30); c.lineTo(0, R - 4); c.stroke();
      // 箭头头部
      c.fillStyle = INK.cyan;
      c.beginPath(); c.moveTo(0, -R + 16); c.lineTo(-8, -R + 32); c.lineTo(8, -R + 32); c.closePath(); c.fill();
      c.restore();
      // 航道偏离点 + 偏离杆（横向偏角近似：机头与航向道夹角；截获后 AP 归零）
      c.save();
      c.translate(CX, CY); c.rotate(a + Math.PI / 2);
      c.strokeStyle = INK.dimGray; c.lineWidth = 2;
      for (const dx of [-2, -1, 1, 2]) {
        c.beginPath(); c.moveTo(dx * 30, 34); c.lineTo(dx * 30, 50); c.stroke();
      }
      const dev = clamp(wrap180(hdg - state.nav.courseDeg) / 2.5, -2.5, 2.5) * 30;
      c.strokeStyle = INK.magenta; c.lineWidth = 4;
      c.beginPath(); c.moveTo(dev, 30); c.lineTo(dev, 54); c.stroke();
      c.restore();
      // 下滑道点 + 指针
      c.save();
      c.translate(CX + 118, CY);
      c.strokeStyle = INK.dimGray; c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, -66); c.lineTo(0, 66); c.stroke();
      for (const dy of [-2, -1, 1, 2]) {
        c.beginPath(); c.moveTo(-7, dy * 30); c.lineTo(7, dy * 30); c.stroke();
      }
      const gsDev = clamp(glideSlopeDevDeg(state) / 0.7, -2.5, 2.5) * 30;
      c.fillStyle = INK.magenta;
      c.beginPath(); c.moveTo(-9, gsDev); c.lineTo(9, gsDev); c.lineTo(0, gsDev + (gsDev >= 0 ? -12 : 12));
      c.closePath(); c.fill();
      c.restore();
    }

    // HDG 目标游标
    {
      const rel = wrap180(state.ap.targets.hdg - hdg);
      const a = (rel - 90) * D2R;
      c.save();
      c.translate(CX, CY); c.rotate(a);
      c.fillStyle = INK.magenta;
      c.beginPath();
      c.moveTo(0, -R - 14); c.lineTo(-9, -R + 2); c.lineTo(9, -R + 2);
      c.closePath(); c.fill();
      c.restore();
    }

    // 飞机符号
    c.strokeStyle = INK.white; c.fillStyle = INK.white; c.lineWidth = 3;
    c.beginPath(); c.moveTo(CX, CY - 16); c.lineTo(CX, CY + 14); c.stroke();
    c.beginPath(); c.moveTo(CX - 22, CY + 4); c.lineTo(CX + 22, CY + 4); c.stroke();
    c.beginPath(); c.moveTo(CX - 8, CY + 16); c.lineTo(CX + 8, CY + 16); c.stroke();

    commit(d);
  };
  return d;
}

/* =========================================================
 * 上 EICAS：N1 / EGT / 燃油 / 滑油
 * ========================================================= */

export function createUpperEICAS() {
  const d = makeDisplay(640, 512);

  d.draw = (state, extras) => {
    const c = d.ctx;
    bg(d, '#0a0c0e');

    // 火警红色构型（该发参数区）
    const fire = [state.engines[0].onFire, state.engines[1].onFire];
    for (let i = 0; i < 2; i++) {
      const fx = i === 0 ? 56 : 268;
      if (fire[i]) {
        c.strokeStyle = INK.red; c.lineWidth = 3;
        if (blink(extras.now, 0.5)) {
          rr(c, fx, 60, 200, 300, 10); c.stroke();
          txt(c, 'FIRE', fx + 100, 372, 26, INK.red, '800');
        }
      }
    }

    drawN1Dial(c, 156, 158, 78, state.engines[0].n1, '1');
    drawN1Dial(c, 368, 158, 78, state.engines[1].n1, '2');
    drawEgtDial(c, 156, 320, 58, state.engines[0].egt);
    drawEgtDial(c, 368, 320, 58, state.engines[1].egt);

    // 右列：燃油流量 / 滑油（内核无滑油字段，按 running 派生显示值）
    const box = (x, y, w, h, label, val, col) => {
      c.fillStyle = '#000'; c.strokeStyle = INK.dimGray; c.lineWidth = 1.5;
      rr(c, x, y, w, h, 4); c.fill(); c.stroke();
      txt(c, label, x + 8, y + h / 2, 14, INK.gray, '600', 'left');
      txt(c, val, x + w - 10, y + h / 2, 20, col, '700', 'right');
    };
    for (let i = 0; i < 2; i++) {
      const e = state.engines[i];
      const x = 492, y = 66 + i * 148;
      box(x, y, 134, 40, 'FF KG/H', e.running ? Math.round(e.fuelFlowKgs * 3600).toLocaleString() : '----', INK.white);
      const oilP = e.running ? 58 + Math.round(e.n1 * 12) : 0;
      const oilT = e.running ? Math.round(72 + e.egt * 0.02) : Math.round(15);
      box(x, y + 44, 134, 34, 'OIL PSI', e.running ? String(oilP) : '0', oilP > 20 ? INK.white : INK.amber);
      box(x, y + 82, 134, 34, 'OIL °C', e.running ? String(oilT) : '----', INK.white);
    }
    txt(c, 'N2 ' + Math.round(state.engines[0].n2 * 100) + ' / ' + Math.round(state.engines[1].n2 * 100) + ' %',
      560, 380, 16, INK.gray, '600');

    // 底部燃油量
    c.fillStyle = '#0a0c0e'; c.fillRect(0, 400, 640, 112);
    c.strokeStyle = INK.dimGray;
    c.beginPath(); c.moveTo(10, 399.5); c.lineTo(630, 399.5); c.stroke();
    const f = state.fuel;
    const lowFuel = state.warnings.active.includes('LOW FUEL');
    const fbox = (x, label, val) => {
      c.fillStyle = '#000'; c.strokeStyle = lowFuel ? INK.amber : INK.dimGray; c.lineWidth = 2;
      rr(c, x, 416, 160, 56, 5); c.fill(); c.stroke();
      txt(c, 'FUEL ' + label, x + 80, 432, 14, INK.gray, '600');
      txt(c, Math.round(val).toLocaleString(), x + 80, 456, 24, lowFuel ? INK.amber : INK.green, '700');
    };
    fbox(30, 'L', f.left);
    fbox(240, 'C', f.center);
    fbox(450, 'R', f.right);
    txt(c, 'TOT ' + Math.round(f.left + f.center + f.right).toLocaleString() + ' KG', 320, 492, 16, INK.gray, '600');

    commit(d);
  };
  return d;
}

/** 圆弧 N1 表 */
function drawN1Dial(c, x, y, r, n1, idx) {
  const a0 = 135, sweep = 270, max = 110;
  c.strokeStyle = '#3a3f42'; c.lineWidth = 10;
  c.beginPath(); c.arc(x, y, r, a0 * D2R, (a0 + sweep) * D2R); c.stroke();
  // 红线区 100..110
  c.strokeStyle = INK.red;
  c.beginPath(); c.arc(x, y, r, (a0 + (100 / max) * sweep) * D2R, (a0 + sweep) * D2R); c.stroke();
  // 刻度
  c.strokeStyle = INK.white; c.fillStyle = INK.white; c.lineWidth = 2;
  c.font = '600 12px ui-monospace, Menlo, monospace';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let v = 0; v <= 100; v += 20) {
    const a = (a0 + (v / max) * sweep) * D2R;
    const c1 = Math.cos(a), s1 = Math.sin(a);
    c.beginPath(); c.moveTo(x + c1 * (r - 6), y + s1 * (r - 6)); c.lineTo(x + c1 * (r + 8), y + s1 * (r + 8)); c.stroke();
    c.fillText(String(v), x + c1 * (r + 22), y + s1 * (r + 22));
  }
  // 指针
  const a = (a0 + clamp(n1, 0, 1.1) * 100 / max * sweep) * D2R;
  c.strokeStyle = INK.white; c.lineWidth = 4;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * (r - 14), y + Math.sin(a) * (r - 14)); c.stroke();
  c.fillStyle = INK.white;
  c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
  txt(c, 'N1 ' + idx, x, y - r - 26, 18, INK.white, '700');
  txt(c, (n1 * 100).toFixed(1), x, y + r + 22, 20, INK.green, '700');
}

/** 圆弧 EGT 表 */
function drawEgtDial(c, x, y, r, egt) {
  const a0 = 150, sweep = 240, max = 1000, redline = 925;
  c.strokeStyle = '#3a3f42'; c.lineWidth = 8;
  c.beginPath(); c.arc(x, y, r, a0 * D2R, (a0 + sweep) * D2R); c.stroke();
  c.strokeStyle = INK.red;
  c.beginPath(); c.arc(x, y, r, (a0 + (redline / max) * sweep) * D2R, (a0 + sweep) * D2R); c.stroke();
  const a = (a0 + clamp(egt, 0, max) / max * sweep) * D2R;
  c.strokeStyle = INK.amber; c.lineWidth = 3.5;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * (r - 10), y + Math.sin(a) * (r - 10)); c.stroke();
  const col = egt > redline ? INK.red : egt > 850 ? INK.amber : INK.green;
  txt(c, Math.round(egt).toString(), x, y + r + 16, 17, col, '700');
  txt(c, 'EGT °C', x, y - r - 14, 14, INK.gray, '600');
}

/* =========================================================
 * 下 EICAS：襟翼 / 起落架 / 液压
 * ========================================================= */

export function createLowerEICAS() {
  const d = makeDisplay(640, 480);

  d.draw = (state) => {
    const c = d.ctx;
    bg(d, '#0a0c0e');

    // --- 襟翼曲柄表（737 经典扇面）---
    txt(c, 'FLAPS', 150, 34, 20, INK.white, '700');
    const px = 150, pyy = 250, pr = 158;
    const a0 = -125, sweep = 250; // 档位角范围
    const notchAngle = (ang) => (a0 + (ang / 40) * sweep) * D2R;
    c.strokeStyle = '#3a3f42'; c.lineWidth = 14;
    c.beginPath(); c.arc(px, pyy, pr, a0 * D2R, (a0 + sweep) * D2R); c.stroke();
    const labels = ['UP', '1', '2', '5', '15', '25', '30', '40'];
    const notchDeg = [0, 1, 2, 5, 15, 25, 30, 40];
    c.font = '700 14px ui-monospace, Menlo, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 8; i++) {
      const a = notchAngle(notchDeg[i]);
      const c1 = Math.cos(a), s1 = Math.sin(a);
      c.strokeStyle = i === 0 ? INK.white : INK.white; c.lineWidth = 3;
      c.beginPath(); c.moveTo(px + c1 * (pr - 9), pyy + s1 * (pr - 9)); c.lineTo(px + c1 * (pr + 9), pyy + s1 * (pr + 9)); c.stroke();
      c.fillStyle = INK.white;
      c.fillText(labels[i], px + c1 * (pr + 30), pyy + s1 * (pr + 30));
    }
    // 舵面实际位置指针（读 state.flaps.angle）
    const na = notchAngle(clamp(state.flaps.angle, 0, 40));
    c.strokeStyle = INK.white; c.lineWidth = 5;
    c.beginPath(); c.moveTo(px, pyy);
    c.lineTo(px + Math.cos(na) * (pr - 16), pyy + Math.sin(na) * (pr - 16)); c.stroke();
    c.fillStyle = '#000'; c.strokeStyle = INK.white; c.lineWidth = 2;
    rr(c, px - 34, pyy - 22, 68, 40, 5); c.fill(); c.stroke();
    txt(c, labels[state.flaps.index], px, pyy - 2, 22, INK.white, '700');
    if (state.flaps.jam !== null) txt(c, 'FLAPS JAM', px, pyy + 44, 15, INK.amber, '700');

    // --- 起落架三灯 ---
    txt(c, 'GEAR', 388, 34, 20, INK.white, '700');
    const names2 = ['L', 'N', 'R'];
    for (let i = 0; i < 3; i++) {
      const gx = 300 + i * 62, gy = 90;
      txt(c, names2[i], gx + 26, gy - 14, 16, INK.white, '700');
      c.fillStyle = '#000'; c.lineWidth = 2;
      const p = state.gear.position;
      if (p > 0.95) {
        c.fillStyle = '#003b12'; c.strokeStyle = INK.green;
        rr(c, gx, gy, 52, 56, 4); c.fill(); c.stroke();
        txt(c, 'DOWN', gx + 26, gy + 28, 13, INK.green, '800');
      } else if (p > 0.02) {
        c.strokeStyle = INK.amber;
        rr(c, gx, gy, 52, 56, 4); c.stroke();
        c.save(); rr(c, gx, gy, 52, 56, 4); c.clip();
        c.strokeStyle = INK.amber; c.lineWidth = 5;
        for (let k = -2; k < 6; k++) {
          c.beginPath(); c.moveTo(gx + k * 16, gy + 60); c.lineTo(gx + k * 16 + 24, gy - 4); c.stroke();
        }
        c.restore();
      } else {
        c.strokeStyle = INK.dimGray;
        rr(c, gx, gy, 52, 56, 4); c.stroke();
      }
    }
    txt(c, state.gear.manualRelease ? 'ALTN EXT' : (state.gear.jammed ? 'GEAR JAM' : ''),
      388, 180, 15, INK.amber, '700');

    // --- 液压 A/B 压力条 ---
    txt(c, 'HYD PSI', 560, 34, 20, INK.white, '700');
    const hydBar = (y, label, val, failed) => {
      c.fillStyle = '#000'; c.strokeStyle = INK.dimGray; c.lineWidth = 2;
      rr(c, 474, y, 172, 30, 4); c.fill(); c.stroke();
      const w = clamp(val, 0, 1) * 168;
      c.fillStyle = val < 0.35 ? INK.amber : INK.green;
      if (w > 0) c.fillRect(476, y + 2, w, 26);
      txt(c, label, 460, y + 16, 18, INK.white, '700', 'right');
      txt(c, failed ? 'FAIL' : String(Math.round(val * 3000)), 560, y + 16, 15, failed ? INK.red : INK.white, '700');
    };
    hydBar(80, 'A', state.hydraulics.A, state.hydraulics.failedA);
    hydBar(124, 'B', state.hydraulics.B, state.hydraulics.failedB);
    hydBar(168, 'S', state.hydraulics.standby, false);
    txt(c, 'STANDBY ' + (state.hydraulics.standbyOn ? 'ON' : 'OFF'), 560, 216, 14, INK.gray, '600');

    // 底部：扰流板 / 刹车状态
    c.strokeStyle = INK.dimGray;
    c.beginPath(); c.moveTo(10, 246.5); c.lineTo(630, 246.5); c.stroke();
    txt(c, 'SPEEDBRAKE ' + (state.spoilers.armed ? 'ARMED' : state.spoilers.deployed > 0.02 ? 'UP' : 'DOWN'),
      150, 280, 17, state.spoilers.armed ? INK.green : INK.white, '700');
    txt(c, 'AUTOBRAKE ' + state.ground.autobrake, 388, 280, 17, INK.white, '700');
    if (state.ground.parkingBrake) txt(c, 'PARKING BRAKE SET', 388, 316, 17, INK.amber, '700');
    txt(c, 'SPOILER ' + Math.round(state.spoilers.deployed * 100) + ' %', 150, 316, 15, INK.gray, '600');

    commit(d);
  };
  return d;
}

/* =========================================================
 * MCP 方式控制板（可点击）
 * ========================================================= */

export function createMCP() {
  const d = makeDisplay(1024, 212);

  d.draw = (state) => {
    const c = d.ctx;
    bg(d, '#26282a');
    c.strokeStyle = '#0f1011'; c.lineWidth = 3;
    rr(c, 4, 4, 1016, 204, 10); c.stroke();

    // 顶排常亮 FMA 行（评审指令：THR TOGA / LVL CHG / 目标速度；SPD 方式接通时显示 THR SPD）
    const fmaThr = 'THR ' + (state.ap.modes.spd ? 'SPD' : 'TOGA');
    txt(c, fmaThr, 350, 17, 18, INK.green, '700');
    txt(c, 'LVL CHG', 555, 17, 18, INK.green, '700');
    txt(c, Math.round(state.ap.targets.ias) + ' KT', 664, 17, 18, INK.green, '700');
    c.strokeStyle = '#3c4043'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(286, 30.5); c.lineTo(740, 30.5); c.stroke();

    const win = (x, y, w, h, val, digits) => {
      c.fillStyle = '#000'; c.strokeStyle = '#3c4043'; c.lineWidth = 3;
      rr(c, x, y, w, h, 5); c.fill(); c.stroke();
      txt(c, val, x + w / 2, y + h / 2 + 1, h * 0.62, INK.green, '700');
    };
    const knob = (x, y, r, angDeg) => {
      c.fillStyle = '#3a3d40'; c.strokeStyle = '#17181a'; c.lineWidth = 3;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.stroke();
      c.strokeStyle = INK.white; c.lineWidth = 4;
      c.beginPath();
      c.moveTo(x - Math.cos(angDeg * D2R) * r * 0.7, y - Math.sin(angDeg * D2R) * r * 0.7);
      c.lineTo(x + Math.cos(angDeg * D2R) * r * 0.7, y + Math.sin(angDeg * D2R) * r * 0.7);
      c.stroke();
    };
    const label = (s, x, y) => txt(c, s, x, y, 17, INK.white, '700');

    // HDG
    label('HDG', 130, 44);
    win(70, 62, 120, 52, String(Math.round(wrap360(state.ap.targets.hdg + (state.runway.headingDeg || 0)))).padStart(3, '0'), 3);
    knob(52, 158, 26, state.ap.targets.hdg);
    knob(208, 158, 26, state.ap.targets.hdg * 2);

    // SPD / ALT / V/S
    label('SPD', 350, 44);
    win(296, 62, 108, 52, String(Math.round(state.ap.targets.ias)), 3);
    knob(280, 158, 26, -90);
    label('ALT', 555, 44);
    win(468, 62, 174, 52, String(Math.round(state.ap.targets.alt)).padStart(5, '0'), 5);
    knob(452, 158, 26, -90);
    knob(658, 158, 26, -90);
    label('V/S', 690, 44);
    win(614, 62, 100, 52, Math.abs(state.ap.targets.vs).toString(), 4);
    // VS 垂直滚轮
    c.fillStyle = '#3a3d40'; c.strokeStyle = '#17181a'; c.lineWidth = 3;
    rr(c, 730, 56, 40, 116, 8); c.fill(); c.stroke();
    c.strokeStyle = INK.white; c.lineWidth = 3;
    const vy = 114 - clamp(state.ap.targets.vs / 3000, -1, 1) * 36;
    c.beginPath(); c.moveTo(736, vy); c.lineTo(764, vy); c.stroke();

    // 按钮：CMD A / CMD B / V NAV(暗) / APP
    const btn = (x, y, name, lit, col, dim) => {
      c.fillStyle = dim ? '#1b1c1e' : '#333639';
      c.strokeStyle = '#17181a'; c.lineWidth = 3;
      rr(c, x, y, 88, 62, 6); c.fill(); c.stroke();
      c.fillStyle = lit ? col : '#0c0d0e';
      rr(c, x + 8, y + 8, 72, 18, 3); c.fill();
      txt(c, name, x + 44, y + 46, 19, dim ? INK.dimGray : INK.white, '700');
    };
    btn(924, 18, 'CMD A', state.ap.engaged, INK.green);
    btn(924, 96, 'CMD B', state.ap.engaged, INK.green);
    btn(816, 18, 'V NAV', false, INK.green, true); // 装饰位（内核无 VNAV 方式，不可点）
    btn(816, 96, 'APP', state.ap.modes.app, INK.cyan);

    commit(d);
  };
  return d;
}

/* =========================================================
 * FMC/CDU（中央台前段，双页：PROG 1/2 + RTE 2/2）
 * —— 只读内核 state；导航引导数据读整合层契约 state.nav.guidance
 *    { destId, destName, phase, adviceZh, distKm, brgCompass }（罗盘口径、中文），
 *    字段缺失时显示 '——' 占位，不做二次换算。
 * —— 翻页：行选键在 3D 纹理上不可点（无拾取路径），改为每 8s 自动轮播，
 *    页眉标注 AUTO 8s、草稿栏注明"不可手动翻页"（诚实简化）。
 * ========================================================= */

export function createCDU() {
  const d = makeDisplay(424, 320);

  // 小屏可读性：荧光绿高对比 + 加粗 + 加大行距（canvas 424x320 映射 ~0.10m 屏宽）
  const GRN = '#9fe06e';
  const DIM = '#566056';
  // 中文字形回退：adviceZh/phase 为中文，等宽栈后接系统中文黑体
  const t = (s, x, y, size, color, weight = '700', align = 'left') => {
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.font = `${weight} ${size}px ui-monospace, Menlo, Consolas, "PingFang SC", "Hiragino Sans GB", monospace`;
    c.fillText(s, x, y);
  };
  // CJK 按字符折行（最多 2 行，超长以 … 截断）
  const wrapZh = (s, maxW, size) => {
    c.font = `700 ${size}px "PingFang SC", monospace`;
    const lines = [''];
    for (const ch of String(s)) {
      const li = lines.length - 1;
      if (lines[li] && c.measureText(lines[li] + ch).width > maxW) {
        if (lines.length >= 2) { lines[1] += '…'; break; }
        lines.push(ch);
      } else {
        lines[li] += ch;
      }
    }
    return lines;
  };

  let c; // 绘制上下文（d.draw 内赋值）

  d.draw = (state, extras) => {
    c = d.ctx;
    bg(d, '#141612');
    c.strokeStyle = '#2c302c'; c.lineWidth = 3;
    rr(c, 3, 3, 418, 314, 4); c.stroke();

    const now = (extras && extras.now) || 0;
    // 每 8s 自动轮播：PROG 1/2 ↔ RTE 2/2
    const page = Math.floor(now / 8) % 2;

    const gs = Math.round(state.velocity.gs);
    const tas = Math.round(state.velocity.tas);
    const alt = Math.round(state.position.y * 3.28084);
    const vs = Math.round(state.velocity.vsFpm / 10) * 10;
    const hdg = String(Math.round(compassHdg(state))).padStart(3, '0');

    // ---- guidance 契约字段（逐项存在性判断，缺省 '——'）----
    const g = (state.nav && state.nav.guidance) || {};
    const dash = '——';
    const gName = g.destName || g.destId;                 // 中文目的地名
    const gDistKm = Number.isFinite(g.distKm) ? g.distKm : undefined;
    const gBrg = Number.isFinite(g.brgCompass) ? g.brgCompass : undefined;
    const gPhase = typeof g.phase === 'string' && g.phase ? g.phase : undefined;
    const gAdvice = typeof g.adviceZh === 'string' && g.adviceZh ? g.adviceZh : undefined;

    // PROG 页 DEST 行：优先契约；缺省回落内核 nav（罗盘口径 = local + runway.headingDeg）
    let destVal, destCol = GRN;
    if (gName || gDistKm !== undefined || gBrg !== undefined) {
      const nm = gName ? gName + ' ' : '';
      const dist = gDistKm !== undefined
        ? (gDistKm >= 10 ? Math.round(gDistKm) : gDistKm.toFixed(1)) + ' km'
        : dash;
      const brg = gBrg !== undefined ? String(Math.round(gBrg)).padStart(3, '0') + '°' : dash;
      destVal = nm + dist + ' / ' + brg;
    } else if (state.nav && state.nav.distM < 1e6) {
      destVal = (state.nav.distM / 1000).toFixed(1) + ' km / ' +
        String(Math.round(wrap360(state.nav.courseDeg + (state.runway.headingDeg || 0)))).padStart(3, '0') + '°';
    } else {
      destVal = dash;
      destCol = DIM;
    }

    // ---- 页眉 ----
    t(page === 0 ? 'PROG 1/2' : 'RTE 2/2', 20, 19, 22, INK.cyan, '800');
    t('AUTO 8s', 404, 20, 13, DIM, '600', 'right');
    c.strokeStyle = '#3a3f3a'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(8, 34.5); c.lineTo(416, 34.5); c.stroke();

    // ---- PROG 1/2 ----
    if (page === 0) {
      const row = (y, label, val, col) => {
        t(label, 22, y, 20, INK.white, '600');
        t(val, 128, y, 20, col ?? GRN, '800');
        t('-----', 404, y, 13, '#39413a', '600', 'right');
      };
      row(58, 'GS', gs + ' KT');
      row(94, 'TAS', tas + ' KT');
      row(130, 'ALT', alt.toLocaleString() + ' FT');
      row(166, 'V/S', (vs >= 0 ? '+' : '') + vs + ' FPM', Math.abs(vs) > 300 ? GRN : INK.white);
      row(202, 'HDG', hdg + '°');
      row(244, 'DEST', destVal, destCol);   // 加粗强化行
    }

    // ---- RTE 2/2（导航页）----
    if (page === 1) {
      const w = state.warnings || { active: [] };
      const qrh = (w.active && w.active.length > 0) || w.masterWarning || w.masterCaution;
      let y = 56;
      if (qrh) {
        t('* QRH ACTIVE *', 212, y, 19, INK.amber, '800', 'center');
        y += 30;
      }
      const row = (label, val, col) => {
        t(label, 22, y, 20, INK.white, '600');
        t(val, 128, y, 20, col ?? GRN, '800');
        t('-----', 404, y, 13, '#39413a', '600', 'right');
        y += 34;
      };
      row('DEST', (gName || dash) + (g.destId && g.destName ? ' ' + g.destId : ''));
      row('DIST',
        (gDistKm !== undefined ? (gDistKm >= 10 ? Math.round(gDistKm) : gDistKm.toFixed(1)) + ' km' : dash) +
        '   BRG ' + (gBrg !== undefined ? String(Math.round(gBrg)).padStart(3, '0') + '°' : dash));
      row('PHASE', gPhase || dash);
      t('GUID', 22, y, 20, INK.white, '600');
      if (gAdvice) {
        const lines = wrapZh(gAdvice, 270, 17);
        lines.forEach((ln, i) => t(ln, 128, y + i * 24, 17, GRN, '700'));
      } else {
        t(dash, 128, y, 20, DIM, '800');
      }
      // 一眼可读的小字重复：GS/TAS/ALT
      t('GS ' + gs + '  TAS ' + tas + '  ALT ' + alt.toLocaleString() + ' FT',
        22, 274, 14, INK.white, '600');
    }

    // ---- 草稿栏（scratchpad）+ 翻页诚实说明 ----
    c.strokeStyle = '#3a3f3a'; c.lineWidth = 1.5;
    rr(c, 8, 292, 408, 22, 2); c.stroke();
    t('自动轮播 8s · 行选键不可点（无拾取）', 212, 303, 13, DIM, '600', 'center');

    commit(d);
  };
  return d;
}

/* =========================================================
 * 顶板（可点击）：燃油泵×6 / 液压 / 电源 / 防冰 / 雨刷
 * ========================================================= */

export function createOverhead() {
  const d = makeDisplay(1024, 560);

  d.draw = (state, extras) => {
    const c = d.ctx;
    bg(d, '#343a34');
    c.strokeStyle = '#1c201c'; c.lineWidth = 3;
    rr(c, 4, 4, 1016, 552, 8); c.stroke();

    const section = (x, y, w, h, title) => {
      c.strokeStyle = '#565e56'; c.lineWidth = 2;
      rr(c, x, y, w, h, 8); c.stroke();
      txt(c, title, x + w / 2, y + 22, 19, '#cfd4cf', '700');
    };
    // 电门绘制：竖直拨动开关 + 灯
    const toggle = (x, y, on, lampCol, lampOn) => {
      c.fillStyle = '#101210'; c.strokeStyle = '#565e56'; c.lineWidth = 2;
      rr(c, x - 15, y - 38, 30, 76, 6); c.fill(); c.stroke();
      c.fillStyle = on ? '#d9ded9' : '#7a807a';
      rr(c, x - 11, on ? y - 34 : y - 2, 22, 36, 4); c.fill();
      c.beginPath(); c.arc(x, y - 50, 9, 0, Math.PI * 2);
      c.fillStyle = lampOn ? lampCol : '#1a1c1a';
      c.fill();
      c.strokeStyle = '#101210'; c.lineWidth = 1.5; c.stroke();
    };
    const lab = (s, x, y) => txt(c, s, x, y, 13, '#cfd4cf', '600');

    // ---- 燃油区 ----
    section(20, 44, 300, 500, 'FUEL');
    const p = state.fuel.pumps;
    const pumps = [
      { label: 'L FWD', on: p.left, cmd: 'left' }, { label: 'L AFT', on: p.left, cmd: 'left' },
      { label: 'R FWD', on: p.right, cmd: 'right' }, { label: 'R AFT', on: p.right, cmd: 'right' },
      { label: 'C L', on: p.center, cmd: 'center' }, { label: 'C R', on: p.center, cmd: 'center' },
    ];
    pumps.forEach((pm, i) => {
      const x = 92 + (i % 2) * 156, y = 140 + Math.floor(i / 2) * 138;
      toggle(x, y, pm.on, INK.green, pm.on);
      lab(pm.label, x, y + 62);
    });
    const cf = state.fuel.crossfeed;
    toggle(92, 470, cf, INK.amber, cf);
    lab('CROSSFEED', 92, 512);
    lab('LEAK ' + (state.fuel.leakTank ? state.fuel.leakTank.toUpperCase() : 'NONE'),
      240, 512, );

    // ---- 液压区 ----
    section(340, 44, 210, 380, 'HYD');
    const hyd = state.hydraulics;
    const lamp = (x, y, on, col) => {
      c.beginPath(); c.arc(x, y, 13, 0, Math.PI * 2);
      c.fillStyle = on ? col : '#161816'; c.fill();
      c.strokeStyle = '#101210'; c.lineWidth = 2; c.stroke();
    };
    lamp(400, 108, hyd.A > 0.9, hyd.A < 0.35 ? INK.amber : INK.green);
    lab('SYS A', 400, 136);
    txt(c, Math.round(hyd.A * 3000) + '', 400, 160, 15, hyd.failedA ? INK.amber : '#cfd4cf', '600');
    lamp(490, 108, hyd.B > 0.9, hyd.B < 0.35 ? INK.amber : INK.green);
    lab('SYS B', 490, 136);
    txt(c, Math.round(hyd.B * 3000) + '', 490, 160, 15, hyd.failedB ? INK.amber : '#cfd4cf', '600');
    toggle(400, 260, hyd.standbyOn, INK.green, hyd.standbyOn);
    lab('STDBY PUMP', 400, 312);
    txt(c, 'ELECTRIC', 490, 250, 13, '#9aa09a', '600');
    txt(c, 'ENGINE DRIVEN', 490, 272, 13, '#9aa09a', '600');
    if (hyd.failedA) txt(c, 'A FAIL', 445, 348, 17, INK.amber, '800');
    if (hyd.failedB) txt(c, 'B FAIL', 445, 372, 17, INK.amber, '800');

    // ---- 电源区 ----
    section(570, 44, 210, 380, 'ELEC');
    const el = state.electrical;
    toggle(630, 130, el.apuOn, '#3fa7ff', el.apu);
    lab('APU', 630, 182);
    lamp(730, 100, !el.genL, INK.amber); lab('GEN OFF L', 730, 126);
    lamp(730, 160, !el.genR, INK.amber); lab('GEN OFF R', 730, 186);
    lamp(630, 250, el.busPowered, INK.green); lab('BUS PWR', 630, 276);
    lamp(730, 250, el.battery > 0.5, INK.green); lab('BAT', 730, 276);
    txt(c, el.battery > 0 ? 'BAT ' + Math.round(el.battery * 100) + ' %' : 'BAT 0 %', 670, 330, 15, '#cfd4cf', '600');
    txt(c, el.apuOn && !el.apu ? 'APU START' : '', 670, 360, 15, '#3fa7ff', '700');

    // ---- 防冰区 ----
    section(800, 44, 204, 380, 'ANTI-ICE');
    toggle(860, 130, state.ice.wingsAntiIce, INK.amber, state.ice.wingsAntiIce);
    lab('WING', 860, 182);
    toggle(950, 130, state.ice.antiIceOn, INK.amber, state.ice.antiIceOn);
    lab('ENG 1/2', 950, 182);
    if (state.weather.icingConditions && state.ice.accumulation > 0.05) {
      txt(c, 'ICE ' + Math.round(state.ice.accumulation * 100) + ' %', 902, 240, 17, INK.amber, '800');
    }
    txt(c, 'OAT ' + Math.round(state.weather.tempC) + '°C', 902, 272, 14, '#cfd4cf', '600');

    // ---- 雨刷（底部，跟随本地 wiperLevel + bus）----
    section(340, 440, 440, 104, 'WINDSHIELD WIPERS');
    const wlv = extras.wiperLevel || 0;
    const wpos = ['OFF', 'INT', 'LOW', 'HIGH'];
    for (let i = 0; i < 4; i++) {
      const x = 420 + i * 92;
      c.fillStyle = i === wlv ? '#d9ded9' : '#1a1c1a';
      rr(c, x - 30, 516, 60, 24, 4); c.fill();
      txt(c, wpos[i], x, 529, 14, i === wlv ? '#101210' : '#8a908a', '700');
    }
    lab('SELECT', 716, 529);

    commit(d);
  };
  return d;
}

/* =========================================================
 * 中央台面板（可点击区域 + 3D 手柄的刻度底图）
 * ========================================================= */

export function createPedestal() {
  const d = makeDisplay(640, 768);

  d.draw = (state) => {
    const c = d.ctx;
    bg(d, '#232527');
    c.strokeStyle = '#101112'; c.lineWidth = 3;
    rr(c, 4, 4, 632, 760, 8); c.stroke();

    // --- 油门弧刻度 ---
    txt(c, 'THR', 96, 40, 17, '#cfd4cf', '700');
    const a0 = -35, sweep = 80;
    c.strokeStyle = '#8a908a'; c.fillStyle = '#cfd4cf'; c.lineWidth = 2.5;
    c.font = '700 13px ui-monospace, Menlo, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const marks = [
      { v: 0.18, label: 'IDLE' }, { v: 0.62, label: 'CLB' }, { v: 0.95, label: 'TO/GA' },
    ];
    for (const m of marks) {
      const a = (a0 + m.v * sweep) * D2R;
      const cxp = 150, cyp = 240, rp = 190;
      const x0 = cxp + Math.sin(a) * rp, y0 = cyp - Math.cos(a) * rp;
      c.beginPath(); c.arc(cxp, cyp, rp, a - 0.03, a + 0.03); c.stroke();
      c.fillText(m.label, cxp + Math.sin(a) * (rp + 26), cyp - Math.cos(a) * (rp + 26));
    }
    // 反推标识
    txt(c, 'REV', 320, 30, 15, state.reverse[0] > 0.05 ? INK.amber : '#8a908a', '700');

    // --- 襟翼闸位 ---
    txt(c, 'FLAPS', 96, 330, 17, '#cfd4cf', '700');
    const fl = ['UP', '1', '2', '5', '15', '25', '30', '40'];
    for (let i = 0; i < 8; i++) {
      const a = (-40 + (i / 7) * 110) * D2R;
      const cxp = 150, cyp = 560, rp = 210;
      const x = cxp + Math.sin(a) * (rp + 24), y = cyp - Math.cos(a) * (rp + 24);
      c.strokeStyle = '#8a908a'; c.lineWidth = 2;
      c.beginPath(); c.arc(cxp, cyp, rp, a - 0.02, a + 0.02); c.stroke();
      c.fillStyle = state.flaps.index === i ? INK.white : '#8a908a';
      c.fillText(fl[i], x, y);
    }

    // --- 起落架手柄区 ---
    txt(c, 'GEAR', 470, 330, 17, '#cfd4cf', '700');
    c.strokeStyle = '#8a908a'; c.lineWidth = 2.5;
    c.beginPath(); c.arc(470, 470, 60, 0, Math.PI * 2); c.stroke();
    txt(c, 'UP', 470, 418, 15, '#8a908a', '700');
    txt(c, 'DN', 470, 524, 15, state.gear.handleDown ? INK.green : '#8a908a', '700');
    txt(c, 'OFF', 540, 470, 15, '#8a908a', '700');

    // --- 配平轮区 ---
    txt(c, 'STAB TRIM', 320, 610, 17, '#cfd4cf', '700');
    c.save();
    c.translate(320, 688);
    c.strokeStyle = '#8a908a'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-130, -34); c.lineTo(-130, 34); c.moveTo(130, -34); c.lineTo(130, 34); c.stroke();
    txt(c, 'NOSE UP', -150, 0, 14, '#cfd4cf', '700', 'right');
    txt(c, 'NOSE DN', 150, 0, 14, '#cfd4cf', '700', 'left');
    // 配平指示
    const tv = state.trim.stabilizer;
    c.fillStyle = '#101112';
    rr(c, -60, -12, 120, 24, 4); c.fill();
    c.fillStyle = tv > 0 ? INK.white : '#8a908a';
    c.fillRect(-60 + (tv * 0.5 + 0.5) * 120 - 3, -18, 6, 36);
    c.restore();
    if (state.trim.stabilizer < -0.55) txt(c, 'NOSE DN TRIM', 320, 742, 14, INK.amber, '700');
    if (state.trim.stabilizer > 0.55) txt(c, 'NOSE UP TRIM', 320, 742, 14, INK.amber, '700');

    // --- 停留刹车 ---
    c.fillStyle = state.ground.parkingBrake ? INK.amber : '#1a1c1a';
    rr(c, 480, 640, 130, 30, 6); c.fill();
    txt(c, 'PARK BRK', 545, 656, 15, state.ground.parkingBrake ? '#101210' : '#8a908a', '700');

    commit(d);
  };
  return d;
}

/* =========================================================
 * 告警灯组件（glareshield 主警告/主注意 + 系统告示牌）
 * ========================================================= */

export function createAnnunciator() {
  const d = makeDisplay(384, 192);

  d.draw = (state, extras) => {
    const c = d.ctx;
    bg(d, '#101112');
    const w = state.warnings;
    const ack = extras.ack || {};
    const tile = (x, y, label, on, col) => {
      c.fillStyle = on ? col : '#1a1b1c';
      rr(c, x, y, 116, 56, 5); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 2; rr(c, x, y, 116, 56, 5); c.stroke();
      txt(c, label, x + 58, y + 28, label.length > 6 ? 15 : 18, on ? '#101210' : '#4a4d4f', '800');
    };
    const mw = w.masterWarning && !ack.masterWarning && blink(extras.now, 0.5);
    const mc = w.masterCaution && !ack.masterCaution && blink(extras.now, 0.7);
    const steady = (name) => w.active.includes(name) && (!ack[name] || blink(extras.now, 0.8, 0.8));
    tile(8, 8, 'MASTER', mw, INK.red);
    tile(132, 8, 'WARNING', mw, INK.red);
    tile(256, 8, 'FIRE', steady('ENGINE FIRE L') || steady('ENGINE FIRE R') || state.fire.cabin, INK.red);
    tile(8, 128 - 56, 'CAUTION', mc, INK.amber);
    tile(132, 128 - 56, 'STALL', steady('STALL') || w.stickShaker, INK.red);
    tile(256, 128 - 56, 'OVSPD', steady('OVERSPEED'), INK.red);
    // 第二排补充
    const tile2 = (x, y, label, on, col) => {
      c.fillStyle = on ? col : '#1a1b1c';
      rr(c, x, y, 76, 52, 5); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 2; rr(c, x, y, 76, 52, 5); c.stroke();
      txt(c, label, x + 38, y + 26, 12, on ? '#101210' : '#4a4d4f', '800');
    };
    tile2(8, 134, 'GPWS', steady('GPWS PULLUP') || steady('GPWS SINKRATE') || steady('TERRAIN'), INK.red);
    tile2(92, 134, 'CABIN', steady('CABIN PRESSURE'), INK.red);
    tile2(176, 134, 'CONFIG', steady('CONFIG'), INK.red);
    tile2(260, 134, 'W/S', steady('WINDSHEAR'), INK.red);
    commit(d);
  };
  return d;
}
