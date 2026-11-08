/**
 * math.js — 内核共享的纯数学工具（无副作用）。
 */

/** 角度 → 弧度 */
export const deg2rad = (d) => (d * Math.PI) / 180;
/** 弧度 → 角度 */
export const rad2deg = (r) => (r * 180) / Math.PI;
/** kt → m/s */
export const kt2ms = (k) => k * 0.514444;
/** m/s → kt */
export const ms2kt = (m) => m / 0.514444;
/** m → ft */
export const m2ft = (m) => m * 3.28084;
/** ft → m */
export const ft2m = (f) => f / 3.28084;
/** m/s → ft/min */
export const ms2fpm = (m) => m * 196.85;
/** ft/min → m/s */
export const fpm2ms = (f) => f / 196.85;

/** 区间截断 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 把角度规范到 [0, 360) */
export function wrap360(d) {
  return ((d % 360) + 360) % 360;
}

/** 把角度差规范到 (-180, 180]：a - b 的最短角差 */
export function wrap180(d) {
  let x = wrap360(d);
  if (x > 180) x -= 360;
  return x;
}

/** 一阶滞后：向目标逼近（帧率无关） */
export function firstOrder(current, target, tau, dt) {
  if (tau <= 0) return target;
  const alpha = 1 - Math.exp(-dt / tau);
  return current + (target - current) * alpha;
}

/** 数值安全：NaN/Infinity → fallback */
export function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}
