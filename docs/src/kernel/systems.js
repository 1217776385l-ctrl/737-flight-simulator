/**
 * systems.js — 飞机系统仿真：燃油 / 液压 / 电气 / 增压 / 皮托 / 结冰 / 引擎动力学。
 *
 * 全部函数以 (state, h) 为签名，h 为子步长（1/120 s），
 * 由 index.js 的统一时序每子步调用一次。
 * 本文件不 import three.js。
 */

import { clamp, firstOrder, m2ft } from './math.js';
import { thrustPerEngineKN, fuelFlowPerEngineKgs, isaAtmosphere } from './flight-model.js';
import { totalMassKg, FLAP_NOTCHES } from './state.js';

const N1_IDLE = 0.20;
const N1_TAU_UP = 5.0;    // N1 增速时间常数 s
const N1_TAU_DOWN = 3.0;  // N1 减速时间常数 s
const EGT_IDLE = 380;     // 慢车 EGT °C
const EGT_MAX = 880;      // 起飞 EGT °C
const START_DURATION_S = 8;   // 启动到慢车时间 s
const GEAR_RATE_PER_S = 1 / 10;   // 起落架全行程 10 s
const GEAR_RATE_MANUAL = 1 / 25;  // 人工重力放出 25 s
const FLAPS_RATE_DEG_S = 3.0;     // 襟翼舵面速率 °/s ≈ 0.5 档/秒
const HYD_TAU = 0.5;              // 液压建压/泄压时间常数 s
const CABIN_CLIMB_RATE_FPM = 800; // 增压座舱高度最大变化率 fpm
const DEPRESS_RATE_FPM = 6000;    // 释压时客舱高度上升速率 fpm
const O2_ALT_FT = 14000;          // 氧气面罩自动落下客舱高度 ft
const PITOT_DRIFT_PER_FT = 0.012; // 皮托堵塞后每英尺高度变化的 IAS 漂移 kt
const ICE_ACCUM_RATE = 0.012;     // 结冰积速率 /s（满积 ≈83 s）
const ICE_CLEAR_RATE = 0.05;      // 防冰除冰速率 /s

/** 系统总步进（index.js 调用） */
export function stepSystems(state, dt) {
  const h = 1 / 120;
  state._sysAcc = Math.min((state._sysAcc ?? 0) + Math.min(dt, 0.25), 0.5);
  while (state._sysAcc >= h) {
    state._sysAcc -= h;
    substepSystems(state, h);
  }
}

/** 单子步 */
export function substepSystems(state, h) {
  stepEngines(state, h);
  stepFuel(state, h);
  stepHydraulics(state, h);
  stepElectrical(state, h);
  stepPressurization(state, h);
  stepPitot(state, h);
  stepIce(state, h);
  stepFlapsAndGear(state, h);
  stepSpoilers(state, h);
  state.massKg = totalMassKg(state);
}

/* ================= 引擎动力学 ================= */
function stepEngines(state, h) {
  const atm = state.atmosphere ?? isaAtmosphere(state.position.y);
  const mach = Math.max(state.velocity.mach ?? 0, 0);

  for (let i = 0; i < 2; i++) {
    const e = state.engines[i];

    // 启动时序
    if (e.startState === 'START') {
      e.startTimerS += h;
      e.n1 = firstOrder(e.n1, 0.24, 3.0, h);
      e.n2 = firstOrder(e.n2, 0.50, 4.0, h);
      e.egt = firstOrder(e.egt, 520, 2.5, h);
      e.fuelFlowKgs = 0.12;
      const hasFuel = state.fuel.left > 50 || state.fuel.right > 50 || state.fuel.center > 50;
      if (e.n1 > 0.21 && e.startTimerS > 4 && hasFuel) {
        e.startState = 'RUN';
        e.running = true;
      } else if (!hasFuel && e.startTimerS > 3) {
        e.startState = 'OFF';
      }
      e.thrustKN = thrustPerEngineKN(e.n1, mach, atm.densityRatio);
      continue;
    }

    // N1 一阶滞后（增速 τ≈5s、减速 τ≈3s）；拉反推时 N1 抬升到反推位（更快响应）
    let target = e.running ? Math.max(N1_IDLE, clamp(state.throttle[i], 0, 1)) : 0;
    let tau = target > e.n1 ? N1_TAU_UP : N1_TAU_DOWN;
    if (e.running && state.reverse[i] > 0.05) {
      target = Math.max(target, N1_IDLE + 0.78 * state.reverse[i]);
      tau = Math.min(tau, 2.5);
    }
    const prevN1 = e.n1;
    e.n1 = firstOrder(e.n1, target, tau, h);
    // N2 跟随 N1（高转子惯性更大）
    const n2Target = e.running ? N2_IDLE + N2_MAX_INC * clamp(state.throttle[i], 0, 1) : 0;
    e.n2 = firstOrder(e.n2, Math.max(n2Target, e.running ? N2_IDLE : 0), target > e.n2 ? 6.0 : 4.0, h);
    if (!e.running && e.n1 < 0.02) e.n1 = 0;

    // EGT 随 N1（起飞 850°C 量级）
    const egtTarget = e.running ? EGT_IDLE + (EGT_MAX - EGT_IDLE) * Math.pow(e.n1, 2) : 15 + e.n1 * 80;
    e.egt = firstOrder(e.egt, egtTarget, 4, h);

    // 火警：EGT 冲高、推力衰减
    if (e.onFire) {
      e.egt = Math.min(e.egt + 900 * h, 950);
      e.thrustKN *= Math.max(0, 1 - h / 15); // 15 s 内推力衰减到 0
    } else {
      e.thrustKN = e.running || e.n1 > 0.05 ? thrustPerEngineKN(e.n1, mach, atm.densityRatio) : 0;
    }

    // 燃油流量
    e.fuelFlowKgs = e.running && !e.onFire ? fuelFlowPerEngineKgs(e.n1) : (e.onFire ? 0 : e.n1 * 0.1);
    void prevN1;
  }
}

/* ================= 燃油 ================= */
function stepFuel(state, h) {
  const f = state.fuel;

  // 泄漏
  if (f.leakTank && f.leakPerSecond > 0) {
    const drain = f.leakPerSecond * h;
    f[f.leakTank] = Math.max(0, f[f.leakTank] - drain);
  }

  // 中央油箱泵 → 左右主油箱（优先供同侧）
  if (f.pumps.center && f.center > 0) {
    const rate = 1.5 * h; // kg/s 转输速率（近似）
    const toL = Math.min(f.center / 2, rate, Math.max(0, 8700 - f.left));
    const toR = Math.min(f.center / 2, rate, Math.max(0, 8700 - f.right));
    f.center -= toL + toR;
    f.left += toL;
    f.right += toR;
  }

  // 交输供油
  if (f.crossfeed) {
    const diff = f.left - f.right;
    const rate = 0.8 * h;
    const move = clamp(diff / 2, -rate, rate);
    f.left -= move;
    f.right += move;
  }

  // 发动机耗油（左发吃左、右发吃右；主油箱空则经泵吃中央/交输）
  for (let i = 0; i < 2; i++) {
    const e = state.engines[i];
    if (!e.running || e.fuelFlowKgs <= 0) continue;
    const need = e.fuelFlowKgs * h;
    const own = i === 0 ? f.left : f.right;
    const other = i === 0 ? f.right : f.left;
    if (own > 0.01) {
      const burn = Math.min(own, need);
      f[i === 0 ? 'left' : 'right'] = own - burn;
      takeFromCenter(state, need - burn, i);
    } else if (f.center > 0.01 && f.pumps.center) {
      takeFromCenter(state, need, i);
    } else if (f.crossfeed && other > 0.01) {
      f[i === 0 ? 'right' : 'left'] = other - Math.min(other, need);
    } else {
      e.running = false; // 燃油耗尽熄车
      e.startState = 'OFF';
    }
  }
  state.massKg = totalMassKg(state);
}

function takeFromCenter(state, amount, engineIndex) {
  const f = state.fuel;
  if (amount <= 0 || f.center <= 0) return;
  // 中央油箱实际通过歧管供双侧；此处按就近原则扣减
  const burn = Math.min(f.center, amount);
  f.center -= burn;
  // 若中央不足，从另一侧主油箱补（近似交输管路）
  const rest = amount - burn;
  if (rest > 0.0001) {
    const otherKey = engineIndex === 0 ? 'right' : 'left';
    f[otherKey] = Math.max(0, f[otherKey] - rest);
  }
}

/* ================= 液压 ================= */
function stepHydraulics(state, h) {
  const hy = state.hydraulics;
  // 737：每台发动机驱动泵给一套系统；备用泵可电动供压
  const targetA = hy.failedA ? 0 : (state.engines[0].running ? 1 : 0);
  const targetB = hy.failedB ? 0 : (state.engines[1].running ? 1 : 0);
  hy.A = firstOrder(hy.A, targetA, HYD_TAU, h);
  hy.B = firstOrder(hy.B, targetB, HYD_TAU, h);
  const standbyTarget = hy.standbyOn && state.electrical.busPowered && !hy.failedB ? 0.85 : 0;
  hy.standby = firstOrder(hy.standby, standbyTarget, 1.0, h);
  // 备用系统补偿：给 A/B 无压侧部分供压（简化）
  if (hy.standby > 0.5) {
    if (hy.A < 0.3 && !hy.failedA) hy.A = Math.max(hy.A, hy.standby * 0.8);
    if (hy.B < 0.3 && !hy.failedB) hy.B = Math.max(hy.B, hy.standby * 0.8);
  }
}

/* ================= 电气 ================= */
const GEN_ON_N2 = 0.45;   // 发电机接入阈值（按 N2，带滞回；慢车 N2≈0.55 在线）
const GEN_OFF_N2 = 0.35;  // 发电机脱开阈值
const APU_START_S = 3;    // APU 启动到可用时间 s
const N2_IDLE = 0.55;     // 慢车 N2
const N2_MAX_INC = 0.43;  // N1 满转时 N2 增量（≈0.98）

function genLogic(on, n2) {
  return on ? n2 > GEN_OFF_N2 : n2 > GEN_ON_N2; // 滞回，防阈值抖动
}

function stepElectrical(state, h) {
  const el = state.electrical;
  el.genL = genLogic(el.genL, state.engines[0].n2);
  el.genR = genLogic(el.genR, state.engines[1].n2);
  // APU 启动：计时到 APU_START_S 后可用（apuOn 关闭即复位）
  if (el.apuOn) {
    el._apuTimer = (el._apuTimer ?? 0) + h;
    if (el._apuTimer >= APU_START_S) el.apu = true;
  } else {
    el._apuTimer = 0;
    el.apu = false;
  }
  const anyGen = el.genL || el.genR || el.apu;
  el.acPowered = anyGen;                       // 交流电：AP/AT 的电源条件
  el.busPowered = anyGen || el.battery > 0.05; // 直流母线（含电瓶）
  if (!anyGen) {
    el.battery = Math.max(0, el.battery - 0.01 * h); // 仅电瓶：缓慢放电
  } else {
    el.battery = Math.min(1, el.battery + 0.02 * h); // 发电时充电
  }
}

/* ================= 增压 ================= */
function stepPressurization(state, h) {
  const pz = state.pressurization;
  const pressAltFt = m2ft(state.position.y);
  let target;
  let maxRate;
  if (pz.outflowOpen) {
    target = pressAltFt;
    maxRate = pz.outflowRateFpm || DEPRESS_RATE_FPM;
  } else {
    // 座舱增压控制器：巡航 FL350 时舱压约 8000 ft
    target = Math.max(0, pressAltFt * 0.25 - 500);
    maxRate = CABIN_CLIMB_RATE_FPM;
  }
  const prev = pz.cabinAltFt;
  const diff = target - prev;
  const step = clamp(diff * (pz.outflowOpen ? 0.4 : 0.08), -maxRate * h / 60, maxRate * h / 60);
  pz.cabinAltFt = Math.max(0, prev + step);
  pz.rateOfChange = (pz.cabinAltFt - prev) / h * 60;
  if (!pz.o2MasksDropped && pz.cabinAltFt > O2_ALT_FT) pz.o2MasksDropped = true;
}

/* ================= 皮托（空速不可靠） ================= */
function stepPitot(state, h) {
  const p = state.pitot;
  const blocked = p.blockedL || p.blockedR;
  if (blocked) {
    // 堵塞后 IAS 不再跟踪真实空速：
    //  - 爬升时 trapped pressure 使读数增大（+0.012 kt/ft）
    //  - 附带缓慢随机漂移
    const dAltFt = (state.position.y - (state._prevPitotAltM ?? state.position.y)) * 3.28084;
    const drift = dAltFt * PITOT_DRIFT_PER_FT + (state.rng() - 0.5) * 0.05;
    state.velocity.ias += drift;
    state._prevPitotAltM = state.position.y;
  } else {
    state._prevPitotAltM = state.position.y;
  }
  void h;
}

/* ================= 结冰 ================= */
function stepIce(state, h) {
  const ice = state.ice;
  const cold = state.weather.icingConditions ||
    (state.weather.precipitation !== 'none' && state.atmosphere.tempC < 5);
  const protected_ = ice.antiIceOn || ice.wingsAntiIce;
  if (cold && !protected_ && !state.ground.onGround) {
    ice.accumulation = clamp(ice.accumulation + ICE_ACCUM_RATE * h, 0, 1);
  } else if (protected_) {
    ice.accumulation = clamp(ice.accumulation - ICE_CLEAR_RATE * h, 0, 1);
  }
}

/* ================= 襟翼 / 起落架 ================= */
function notchAngle(index) {
  const n = FLAP_NOTCHES[clamp(index, 0, 7)];
  return n ? n.angleDeg : 0;
}

function stepFlapsAndGear(state, h) {
  const fl = state.flaps;
  // 目标角：受卡阻限制——不能越过卡阻档位
  let cmdIndex = clamp(fl.index, 0, 7);
  if (fl.jam !== null) {
    const jamAngle = notchAngle(fl.jam);
    cmdIndex = notchAngle(cmdIndex) > jamAngle ? fl.jam : cmdIndex;
    // 已在卡阻角之外时也不允许继续向更大角运动
    if (fl.angle > jamAngle + 0.01 && notchAngle(cmdIndex) > fl.angle) cmdIndex = fl.jam;
  }
  const target = notchAngle(cmdIndex);
  const rate = FLAPS_RATE_DEG_S * (state.hydraulics.A < 0.35 && state.hydraulics.B < 0.35 ? 0.4 : 1);
  const step = clamp(target - fl.angle, -rate * h, rate * h);
  fl.angle = clamp(fl.angle + step, 0, 40);

  const gr = state.gear;
  if (!gr.jammed) {
    const down = gr.handleDown || gr.manualRelease;
    const rate2 = gr.manualRelease && !gr.handleDown ? GEAR_RATE_MANUAL : GEAR_RATE_PER_S;
    gr.position = clamp(gr.position + (down ? rate2 : -rate2) * h, 0, 1);
  }
  if (gr.position >= 0.999) gr.manualRelease = false;
}

/* ================= 扰流板 ================= */
function stepSpoilers(state, h) {
  const sp = state.spoilers;
  let target = sp.commandDeploy ? 1 : 0;
  if (state.ground.onGround) {
    if (sp.armed && state.velocity.ias > 40) target = 1;
    if (state.throttle[0] > 0.5 || state.throttle[1] > 0.5) target = 0; // 起飞推地收回
  }
  sp.deployed = clamp(sp.deployed + clamp(target - sp.deployed, -4 * h, 4 * h), 0, 1);
}
