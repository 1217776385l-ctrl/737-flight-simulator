/**
 * palette.js — 驾驶舱统一色彩与绘图工具。
 *
 * 艺术指导：波音灰哑光舱内（#2a2d31 系）+ 真实航空告警色（红=警告 / 琥珀=注意 / 绿=正常），
 * 屏幕自发光、面板不反光。所有仪表绘制共用此表，杜绝各屏配色漂移。
 */

import * as THREE from 'three';

/** 仪表屏幕配色（EICAS/EFIS 标准色） */
export const INK = {
  bg: '#07090b',            // 屏幕底色（近黑）
  bezel: '#101214',
  white: '#e8ecec',
  green: '#4dff6e',
  magenta: '#ff5cf0',
  cyan: '#39d7e8',
  amber: '#ffb400',
  red: '#ff2e1f',
  gray: '#7d8489',
  dimGray: '#4a5054',
  sky: '#2f7fd6',           // ADI 天空
  ground: '#8a5a2e',        // ADI 地面
  horizon: '#f2f2f2',
};

/** 舱内结构材质色（哑光塑料 / 金属边框 / 顶板军绿灰） */
export const MAT = {
  panelDark: 0x2a2d31,      // 主仪表板波音灰（评审锚定色）
  panelMid: 0x26292d,       // 中央台 / 侧壁
  panelLight: 0x2e3236,     // 面板边框
  overhead: 0x3a4038,       // 顶板经典灰绿
  metal: 0x555a5e,          // 金属边框
  bezelHi: 0x5a6066,        // 屏幕嵌装高光边
  black: 0x0c0d0f,          // 遮光板 / 操纵杆
  glare: 0x141517,          // glareshield
};

/**
 * 细噪点面板纹理（波音灰底 + 1px 颗粒，用于哑光塑料材质防"均匀灰平面"感）。
 * @param {string} base 底色 hex（默认波音灰）
 * @param {number} repeat UV 平铺次数
 * @returns {THREE.CanvasTexture}
 */
export function panelNoiseTexture(base = '#2a2d31', repeat = 3) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2400; i++) {
    const v = 30 + (Math.random() * 22) | 0;
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.25 + Math.random() * 0.3})`;
    g.fillRect((Math.random() * size) | 0, (Math.random() * size) | 0, 1, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 圆角矩形路径（不填充，由调用方 fill/stroke）。
 * @param {CanvasRenderingContext2D} c
 */
export function rr(c, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + k, y);
  c.arcTo(x + w, y, x + w, y + h, k);
  c.arcTo(x + w, y + h, x, y + h, k);
  c.arcTo(x, y + h, x, y, k);
  c.arcTo(x, y, x + w, y, k);
  c.closePath();
}

/**
 * 居中绘制文字。
 * @param {string} weight css 字重
 */
export function txt(c, s, x, y, size, color, weight = '500', align = 'center') {
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.font = `${weight} ${size}px ui-monospace, Menlo, Consolas, monospace`;
  c.fillText(s, x, y);
}

/** 角度归一化到 0..360 */
export function wrap360(d) {
  return ((d % 360) + 360) % 360;
}

/** 角度差归一化到 -180..180 */
export function wrap180(d) {
  return ((d + 540) % 360) - 180;
}

export function clamp(v, a, b) {
  return Math.min(Math.max(v, a), b);
}
