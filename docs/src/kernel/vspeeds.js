/**
 * vspeeds.js — V1 / VR / V2 / Vref 速度表（按重量插值）。
 *
 * 基准锚点与真实 737-800 QRH 数量级一致：
 *   襟翼 5、70 t：V1 141 / VR 143 / V2 149 kt
 *   Vref30 @ 60 t：137 kt
 * 速度随重量按 √W 缩放（等 CLmax 平衡）。
 * 所有速度单位 kt（IAS）。
 */

import { clamp } from './math.js';

/** 襟翼 5 起飞速度锚点：[重量 kg, V1, VR, V2] */
const TAKOFF_FLAPS5_ANCHORS = [
  [45000, 124, 126, 132],
  [55000, 133, 135, 141],
  [65000, 140, 142, 148],
  [70000, 141, 143, 149],
  [75000, 147, 149, 155],
  [79000, 151, 153, 159],
];

/** Vref 锚点：[重量 kg, Vref30, Vref15, Vref40] kt */
const VREF_ANCHORS = [
  [45000, 118, 128, 113],
  [55000, 131, 141, 126],
  [60000, 137, 147, 132],
  [65000, 143, 153, 138],
  [70000, 148, 158, 143],
  [75000, 153, 163, 148],
  [79000, 157, 167, 152],
];

/**
 * 在锚点表中按重量线性插值。
 * @param {Array<Array<number>>} table
 * @param {number} wKg
 * @param {number} col 列索引（1 起，0 为重量列）
 * @returns {number}
 */
function interp(table, wKg, col) {
  const w = clamp(wKg, table[0][0], table[table.length - 1][0]);
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i], b = table[i + 1];
    if (w >= a[0] && w <= b[0]) {
      const t = (w - a[0]) / (b[0] - a[0]);
      return a[col] + t * (b[col] - a[col]);
    }
  }
  return table[table.length - 1][col];
}

/**
 * 起飞速度：返回 { v1, vr, v2 }（kt）。
 * 目前按襟翼 5 表给出；襟翼 1 约 +12 kt、襟翼 15 约 -10 kt（粗修），
 * 供 PFD 速度带标记与副驾驶喊话使用。
 * @param {number} weightKg 总重 kg
 * @param {number} [flapsIndex=3] 起飞襟翼档位（3 = 襟翼 5）
 * @returns {{v1:number, vr:number, v2:number}}
 */
export function getVSpeeds(weightKg, flapsIndex = 3) {
  const v1 = interp(TAKOFF_FLAPS5_ANCHORS, weightKg, 1);
  const vr = interp(TAKOFF_FLAPS5_ANCHORS, weightKg, 2);
  const v2 = interp(TAKOFF_FLAPS5_ANCHORS, weightKg, 3);
  if (flapsIndex === 3) return { v1: Math.round(v1), vr: Math.round(vr), v2: Math.round(v2) };
  // 非基准襟翼的粗略偏移（真实航线飞行以 QRH 为准）
  let d = 0;
  if (flapsIndex === 1) d = 12;
  else if (flapsIndex === 2) d = 6;
  else if (flapsIndex === 4) d = -10;
  return {
    v1: Math.round(v1 + d * 0.98),
    vr: Math.round(vr + d),
    v2: Math.round(v2 + d * 1.05),
  };
}

/**
 * 着陆参考速度 Vref（进近目标速度 ≈ Vref + 5）。
 * @param {number} weightKg 总重 kg
 * @param {number} [flapsIndex=6] 着陆襟翼档位（6 = 襟翼 30）
 * @returns {number} Vref kt
 */
export function getVref(weightKg, flapsIndex = 6) {
  const v30 = interp(VREF_ANCHORS, weightKg, 1);
  const v15 = interp(VREF_ANCHORS, weightKg, 2);
  const v40 = interp(VREF_ANCHORS, weightKg, 3);
  const map = { 4: v15, 5: (v30 + v15) / 2, 6: v30, 7: v40 };
  return Math.round(map[flapsIndex] ?? v30);
}
