/**
 * index.js — 内核汇总导出 + stepSimulation 固定时序。
 *
 * stepSimulation(state, dt, bus) 每子步（1/120 s）固定调用次序：
 *   1. stepSystems        — 燃油/液压/电气/增压/皮托/结冰/引擎动力学
 *   2. stepAutopilot      — AP/AT 写 state.control 与 state.throttle
 *   3. flight-model 子步   — 气动+推进+地面+积分（真实状态演化）
 *   4. computeWarnings    — 警告汇总（STALL/OVERSPEED/FIRE/...）
 *
 * 后续单元只 import 本文件（见 docs/kernel-api.md）。
 * 本文件不 import three.js；Node 可直接测试。
 */

export { createSimState, totalMassKg, AIRCRAFT_737_800, FLAP_NOTCHES, mulberry32, DEFAULT_RNG_SEED } from './state.js';
export {
  stepFlightModel, substep as stepFlightModelSubstep,
  isaAtmosphere, clMaxForFlaps, liftCoef, dragCoef, inducedDragFactor,
  thrustPerEngineKN, fuelFlowPerEngineKgs, stallIasKt, stallAoaRad, bodyAxes,
  engineYawMomentNm,
} from './flight-model.js';
export { stepSystems, substepSystems } from './systems.js';
export {
  stepAutopilot, apToggle, apEngage, apDisconnect, apArmApp, glideSlopeDevDeg,
} from './autopilot.js';
export {
  createDamageAPI, engineFail, engineFire, extinguishEngineFire, dualEngineFail,
  hydraulicFail, depressurize, repairPressurization, pitotBlock, fuelLeak,
  flapsJam, cabinFire, setIcingConditions, gearJam,
} from './damage.js';
export { createCommandBus, createKeyboardInput, KEYMAP } from './input.js';
export { getVSpeeds, getVref } from './vspeeds.js';
export * from './math.js';

import { substepSystems } from './systems.js';
import { stepAutopilot } from './autopilot.js';
import { substep as flightModelSubstep, stallAoaRad } from './flight-model.js';
import { rad2deg } from './math.js';

const SUB_DT = 1 / 120;

/**
 * 仿真主步进：固定调用次序 + 定步长子步循环。
 * @param {Object} state 状态树
 * @param {number} dt    名义步长 s（内部按 1/120 s 定步长切分）
 * @param {Object} [bus] 命令总线（命令在 send 时已同步生效，这里仅作约定占位）
 */
export function stepSimulation(state, dt, bus) {
  void bus;
  const clamped = Math.min(Math.max(dt, 0), 0.25);
  state._acc = Math.min((state._acc ?? 0) + clamped, 0.5);
  let guard = 0;
  while (state._acc >= SUB_DT && guard++ < 60) {
    state._acc -= SUB_DT;
    // 1. 系统 → 2. 自动驾驶 → 3. 飞行模型（固定次序）
    substepSystems(state, SUB_DT);
    stepAutopilot(state, SUB_DT);
    flightModelSubstep(state, SUB_DT);
  }
  // 4. 警告汇总（每名义步一次即可）
  computeWarnings(state);
  state.time += clamped;
  state.dt = clamped;
}

/* =========================================================
 * 警告汇总（驾驶舱单元据此点亮警告灯/触发语音）
 * ========================================================= */

/** 警告字符串枚举 */
export const WARNINGS = Object.freeze({
  STALL: 'STALL',
  OVERSPEED: 'OVERSPEED',
  ENGINE_FIRE_L: 'ENGINE FIRE L',
  ENGINE_FIRE_R: 'ENGINE FIRE R',
  DUAL_ENG_FAIL: 'DUAL ENG FAIL',
  CABIN_PRESSURE: 'CABIN PRESSURE',
  LOW_FUEL: 'LOW FUEL',
  HYD_PRESS: 'HYD PRESS',
  CONFIG: 'CONFIG',
  TERRAIN: 'TERRAIN',
  WINDSHEAR: 'WINDSHEAR',
  GPWS_SINKRATE: 'GPWS SINKRATE',
  GPWS_PULLUP: 'GPWS PULLUP',
});

/** 触发 masterWarning 的警告集合 */
const MASTER_WARNING_SET = new Set([
  'STALL', 'OVERSPEED', 'ENGINE FIRE L', 'ENGINE FIRE R', 'CABIN PRESSURE',
  'CONFIG', 'TERRAIN', 'WINDSHEAR', 'GPWS PULLUP',
]);

const LOW_FUEL_TOTAL_KG = 2300;   // 双油箱合计阈值 kg
const SINKRATE_FPM = 1600;        // GPWS 下降率基准
const PULLUP_FPM = 2800;

/**
 * 每步重算 state.warnings（active 数组 + masterCaution/masterWarning/stickShaker）。
 */
export function computeWarnings(state) {
  const w = state.warnings;
  const active = [];
  const aglFt = state.agl * 3.28084;
  const vs = state.velocity.vsFpm;
  const ias = state.velocity.ias;
  const mach = state.velocity.mach ?? 0;

  // 振杆：α > 0.9·失速迎角；失速：α 超过失速迎角
  const aStallDeg = rad2deg(stallAoaRad(state.flaps.angle, state.ice.accumulation));
  const inAir = !state.ground.onGround;
  w.stickShaker = inAir && state.velocity.aoa > aStallDeg * 0.9;
  if (w.stickShaker || (inAir && state.velocity.aoa > aStallDeg)) active.push('STALL');

  if (ias > state.aircraft.vmoKt || mach > state.aircraft.mmoMach) active.push('OVERSPEED');

  if (state.engines[0].onFire) active.push('ENGINE FIRE L');
  if (state.engines[1].onFire) active.push('ENGINE FIRE R');
  if (!state.engines[0].running && !state.engines[1].running) active.push('DUAL ENG FAIL');

  if (state.pressurization.cabinAltFt > 10000) active.push('CABIN PRESSURE');

  const fuelTotal = state.fuel.left + state.fuel.right + state.fuel.center;
  if (fuelTotal < LOW_FUEL_TOTAL_KG) active.push('LOW FUEL');

  if (state.hydraulics.A < 0.35 || state.hydraulics.B < 0.35) active.push('HYD PRESS');

  // 起飞形态警告：地面上加速且构型不对
  if (state.ground.onGround && ias > 80 && ias < 180) {
    if (state.flaps.index < 1 || !state.gear.handleDown) active.push('CONFIG');
  }

  // GPWS 模式 1（下降率过大），着陆构型下放宽
  const landingConfig = state.gear.handleDown && state.flaps.index >= 5;
  if (!state.ground.onGround && aglFt > 15) {
    const sinkMargin = landingConfig ? 1.8 : 1.0;
    if (vs < -PULLUP_FPM * sinkMargin && aglFt < 2500) active.push('GPWS PULLUP');
    else if (vs < -(SINKRATE_FPM + aglFt * 1.2) * sinkMargin) active.push('GPWS SINKRATE');
    // TERRAIN：世界单元提供前视地形数据时判定
    if (state.terrain.aheadElevFt !== null &&
      state.terrain.aheadElevFt > state.position.y * 3.28084 + 100) {
      active.push('TERRAIN');
    }
  }

  // 风切变：进近阶段空速突降/突升（简化探测）
  const hist = state._shearIasHistory;
  hist.push({ t: state.time, ias });
  while (hist.length > 0 && state.time - hist[0].t > 5) hist.shift();
  if (!state.ground.onGround && aglFt < 1200 && hist.length > 10) {
    const dIas = ias - hist[0].ias;
    if (Math.abs(dIas) > 15) active.push('WINDSHEAR');
  }

  w.active = active;
  w.masterWarning = active.some((s) => MASTER_WARNING_SET.has(s));
  // masterCaution：有任何非主警告级警告即点亮（LOW FUEL / HYD PRESS / GPWS SINKRATE / DUAL ENG FAIL）
  w.masterCaution = active.some((s) => !MASTER_WARNING_SET.has(s));
}
