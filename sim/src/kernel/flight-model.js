/**
 * flight-model.js — 中度拟真飞行模型（气动 + 推进 + 地面 + 运动积分）。
 *
 * 模型结构（每 1/120 s 子步执行一次）：
 *  1. ISA 大气推导（ρ、a、温度、气压高度）
 *  2. 风矢量（气象风 + 阵风 + 湍流）
 *  3. 体轴系气流分解 → 迎角 α、侧滑角 β
 *  4. 气动系数：CL(α, 襟翼, 结冰)、CD(CD0 + 诱导 + 构型增量 + 波阻)、地效
 *  5. 推力（systems 已写入 engines[].thrustKN，含反推折减）
 *  6. 力合成 → 世界系加速度 → 速度/位置积分
 *  7. 角运动：舵面指令 + 静稳定性 + 阻尼 → 角速率（一阶滞后）→ 姿态积分
 *  8. 地面接触：法向支持、滚动摩擦、刹车（防滞）、反推、地面扰流板、
 *     不对称推力（方向舵/前轮转弯）、接地瞬间填充 state.touchdown
 *
 * 诚实简化（详见 docs/kernel-api.md）：
 *  - 角运动是"速率指令 + 静稳定一阶滞后"模型，不是全力矩方程；
 *  - 侧滑/偏航为平面线性化（Cnβ、Cnr、Cnδ 常系数）；
 *  - 失速后机翼下坠用随机扰动近似；
 *  - 地面轮胎/前轮转弯集中为等效偏航阻尼与等效转弯力矩。
 *
 * 本文件不 import three.js，Node 可直接测试。
 */

import {
  deg2rad, rad2deg, kt2ms, ms2kt, ms2fpm, clamp, wrap360, firstOrder, safeNum,
} from './math.js';
import { totalMassKg } from './state.js';

/* ================= 气动常量（真实单位） ================= */
const G = 9.80665;              // 重力加速度 m/s²
const RHO0 = 1.225;             // 海平面标准密度 kg/m³
const WING_AREA = 125;          // 机翼参考面积 m²
const WING_SPAN = 35.8;         // 翼展 m
const CL0_CLEAN = 0.2;          // 干净构型零迎角升力系数
const CL_ALPHA = 5.0;           // 三维升力线斜率 /rad
const CLMAX_CLEAN = 1.30;       // 干净 CLmax
const CLMAX_FLAPS40 = 2.60;     // 襟翼 40 CLmax
const CL0_FLAPS40_INC = 0.55;   // 襟翼 40 带来的 CL0 增量
const ICE_CLMAX_LOSS = 0.25;    // 结冰满积时 CLmax 最多下降 25%
const CD0_CLEAN = 0.020;        // 干净废阻系数
const CDI_K = 1 / (Math.PI * 10.25 * 0.8); // 诱导阻力因子 k=1/(π·AR·e), e=0.8
const CD_GEAR = 0.020;          // 起落架放下的废阻增量
const CD_FLAPS40 = 0.090;       // 襟翼 40 废阻增量
const CD_SPOILERS = 0.060;      // 扰流板全放废阻增量
const CD_ICE = 0.008;           // 结冰满积废阻增量
const WAVE_MACH_ONSET = 0.70;   // 波阻起始马赫
const WAVE_K = 2.5;             // 波阻增益：CDwave = K·(M-M_onset)²
const STALL_CL_FALLOFF = 2.5;   // 失速后升力衰减斜率 /rad
const GROUND_EFFECT_33 = 33;    // 地效经验公式系数（Wieselsberger 型）
const CY_BETA = -1.2;           // 侧力导数（侧滑产生侧向力）
const SPOILER_LIFT_KILL = 0.65; // 扰流板全放时升力损失比例

/* ================= 推进常量 ================= */
const N1_IDLE = 0.20;                 // 地面慢车 N1
const THRUST_MACH_FACTOR = -0.25;     // 前进动量阻：T ∝ (1 - 0.25·M)
const REVERSE_FRACTION = 0.55;        // 最大反推 = 50% 当前前推力（满反推 N1）
const REVERSE_MIN_SPEED_MS = 8;       // 低于该速度反推效率线性衰减到 0

/* ================= 操纵/角运动常量 ================= */
const PITCH_RATE_MAX = 20;      // 满舵俯仰角速率 deg/s（动压=1 时）
const ROLL_RATE_MAX = 30;       // 满舵滚转角速率 deg/s
const Q_REF = 2800;             // 操纵效率满额参考动压 Pa（≈140 kt IAS）
const PITCH_TAU = 0.40;         // 俯仰角速率一阶滞后 s
const ROLL_TAU = 0.30;          // 滚转 s
const PITCH_STAB_GAIN = 1.1;   // 纵向静稳定：α 回归配平 α 的速率 /s（×动压因子；弱化以避免参考滞后振荡与高 AoA mush）
const AOA_TRIM_GROUND_MAX = 0.035; // 地面配平基准上限 rad（≈机翼安装角：防止滑跑自我抬轮）
const AOA_TRIM_AIR_FRAC = 0.75;    // 空中配平基准上限 = 0.75·失速迎角（保留失速裕度）
const TRIM_SPEED_BASE_KT = 260;    // 配平中立点（trim=0）对应的配平速度 kt（≈巡航 IAS）
const TRIM_SPEED_SPAN_KT = 130;    // 满配平范围对应的配平速度变化 kt（trim +1 → 130 kt 进近）
const SPEED_STAB_GAIN = 3.0;       // 速度稳定性：偏离配平速度 → 俯仰速率 °/s（经典 phugoid 阻尼）
const CN_BETA = 0.11;           // 航向静稳定导数（风向标；本模型体轴约定下为正）
const CN_R = -0.30;             // 偏航阻尼导数
const CN_DELTA_R = 0.048;       // 方向舵效率（校准 Vmcg≈120 kt）
const IZ_EQ = 1.8e6;            // 等效偏航转动惯量 kg·m²
const DIHEDRAL_ROLL_GAIN = 0.8; // 侧滑引起的滚转速率 deg/s per deg β（上反效应）

/* ================= 地面常量 ================= */
const MU_ROLL = 0.030;          // 跑道滚动摩擦系数
const MU_ROLL_GRASS = 0.080;    // 草地/地形滚动摩擦
const MU_BRAKE = 0.35;          // 刹车有效摩擦系数（含防滞效应）
const MU_STATIC = 0.10;         // 静摩擦（防停机爬行）
const MU_BELLY = 0.50;          // 机腹接地等效摩擦
const TIRE_YAW_DAMP = 11.5e6;   // 地面等效偏航阻尼 N·m/(rad/s)（轮胎+前轮组合）
const TIRE_TRACK_GAIN = 1.5;    // 轮胎侧向抓地：航迹向机头收敛速率 /s
const TIRE_LAT_STIFF = 6.0;     // 轮胎侧偏刚度：侧向力 = clamp(TIRE_LAT_STIFF * v_lat * mass, ±MU_SIDE*N) /s
const MU_SIDE = 0.60;           // 轮胎侧向抓地上限（干跑道）， belly 减半
const NOSEWHEEL_V_MAX = 40;     // 前轮转弯全效速度上限 m/s（以上线性衰减）
const NOSEWHEEL_MOMENT = 1.0e6; // 前轮转弯满效偏航力矩 N·m
const WING_INCIDENCE_GROUND = 2.0; // 地面停机姿态机翼安装角 deg
const PITCH_GROUND_MIN = 0;     // 地面最小俯仰（前轮着地）
const PITCH_TAILSTRIKE = 11;    // 尾擦限制俯仰 deg
const ENG_YAW_ARM = 4.9;        // 发动机推力线到机身中线距离 m

/* ================= ISA 标准大气 ================= */
const T0 = 288.15, P0 = 101325, LAPSE = 0.0065, TROPOPAUSE_M = 11000, T_TROP = 216.65, R_AIR = 287.0528, GAMMA = 1.4;

/**
 * ISA 标准大气。
 * @param {number} altM 几何高度 m
 * @returns {{rho:number, tempC:number, pressurePa:number, pressureAltFt:number, speedOfSound:number, densityRatio:number}}
 */
export function isaAtmosphere(altM) {
  const h = clamp(altM, -500, 20000);
  let T, p;
  if (h <= TROPOPAUSE_M) {
    T = T0 - LAPSE * h;
    p = P0 * Math.pow(T / T0, G / (LAPSE * R_AIR));
  } else {
    T = T_TROP;
    const pTrop = P0 * Math.pow(T_TROP / T0, G / (LAPSE * R_AIR));
    p = pTrop * Math.exp(-(G * (h - TROPOPAUSE_M)) / (R_AIR * T_TROP));
  }
  const rho = p / (R_AIR * T);
  return {
    rho,
    tempC: T - 273.15,
    pressurePa: p,
    pressureAltFt: h * 3.28084,
    speedOfSound: Math.sqrt(GAMMA * R_AIR * T),
    densityRatio: rho / RHO0,
  };
}

/* ================= 气动系数（纯函数，供测试与内核复用） ================= */

/** 襟翼舵面角（deg）→ CLmax（0..40° 线性内插，含结冰损失） */
export function clMaxForFlaps(flapsAngleDeg, iceAccumulation = 0) {
  const t = clamp(flapsAngleDeg / 40, 0, 1);
  const clmax = CLMAX_CLEAN + t * (CLMAX_FLAPS40 - CLMAX_CLEAN);
  return clmax * (1 - ICE_CLMAX_LOSS * clamp(iceAccumulation, 0, 1));
}

/** 升力系数：线性段 + 失速后陡降。aoa 单位 rad */
export function liftCoef(aoaRad, flapsAngleDeg = 0, iceAccumulation = 0) {
  const cl0 = CL0_CLEAN + CL0_FLAPS40_INC * clamp(flapsAngleDeg / 40, 0, 1);
  const clmax = clMaxForFlaps(flapsAngleDeg, iceAccumulation);
  const aStall = (clmax - cl0) / CL_ALPHA;
  if (aoaRad <= aStall) return Math.max(CL0_CLEAN * -2, Math.min(cl0 + CL_ALPHA * aoaRad, clmax));
  // 失速后：升力陡降并趋于残值
  const drop = STALL_CL_FALLOFF * (aoaRad - aStall);
  return Math.max(clmax * (1 - drop), 0.25 * clmax);
}

/** 失速迎角 rad（给定襟翼角与结冰） */
export function stallAoaRad(flapsAngleDeg = 0, iceAccumulation = 0) {
  const cl0 = CL0_CLEAN + CL0_FLAPS40_INC * clamp(flapsAngleDeg / 40, 0, 1);
  return (clMaxForFlaps(flapsAngleDeg, iceAccumulation) - cl0) / CL_ALPHA;
}

/** 地效因子：诱导阻力乘子（自由流→1，近地显著减小） */
export function inducedDragFactor(aglM, wingSpanM = WING_SPAN) {
  const x = Math.max(aglM, 0.01) / wingSpanM;
  return (GROUND_EFFECT_33 * x * x) / (1 + GROUND_EFFECT_33 * x * x);
}

/**
 * 全阻力系数。
 * @param {number} cl  当前升力系数
 * @param {object} cfg { flapsAngleDeg, gearDown, spoilersDeployed, mach, aglM, iceAccumulation, wingSpanM }
 */
export function dragCoef(cl, cfg = {}) {
  let cd = CD0_CLEAN;
  cd += CD_FLAPS40 * clamp((cfg.flapsAngleDeg ?? 0) / 40, 0, 1);
  if (cfg.gearDown) cd += CD_GEAR;
  cd += CD_SPOILERS * clamp(cfg.spoilersDeployed ?? 0, 0, 1);
  cd += CD_ICE * clamp(cfg.iceAccumulation ?? 0, 0, 1);
  const kInd = CDI_K * inducedDragFactor(cfg.aglM ?? 1000, cfg.wingSpanM ?? WING_SPAN);
  cd += kInd * cl * cl;
  const mach = cfg.mach ?? 0;
  if (mach > WAVE_MACH_ONSET) cd += WAVE_K * (mach - WAVE_MACH_ONSET) ** 2;
  return cd;
}

/** 推进：单发推力 kN = 107 × N1^2.6 × σ^0.85 × (1 - 0.25·M)。 */
export function thrustPerEngineKN(n1, mach = 0, densityRatio = 1) {
  const n = clamp(n1, 0, 1);
  if (n < 0.05) return 0;
  const g = Math.pow(n / 1.0, 2.6);
  const lambda = Math.pow(clamp(densityRatio, 0.05, 1.1), 0.85) *
    (1 + THRUST_MACH_FACTOR * clamp(mach, 0, 0.95));
  return 107 * g * lambda;
}

/** 单发燃油流量 kg/s：海平面满 N1 ≈1.65，巡航双发合计 ≈2500-2700 kg/h */
export function fuelFlowPerEngineKgs(n1) {
  const n = clamp(n1, 0, 1);
  return 1.65 * (0.10 + 0.90 * Math.pow(n, 3));
}

/** 1g 平飞失速 IAS（kt）—— 供速度带下限与数值测试使用 */
export function stallIasKt(massKg, flapsAngleDeg = 0, iceAccumulation = 0) {
  const clmax = clMaxForFlaps(flapsAngleDeg, iceAccumulation);
  return ms2kt(Math.sqrt((2 * massKg * G) / (RHO0 * WING_AREA * clmax)));
}

/* ================= 体轴几何 ================= */

/** 由欧拉角（deg）计算体轴单位矢量（世界系：x北 y上 z东；heading 顺时针 0=北） */
export function bodyAxes(pitchDeg, bankDeg, headingDeg) {
  const th = deg2rad(pitchDeg), ph = deg2rad(bankDeg), ps = deg2rad(headingDeg);
  const cth = Math.cos(th), sth = Math.sin(th), cps = Math.cos(ps), sps = Math.sin(ps);
  const fwd = [cps * cth, sth, sps * cth];
  const rot = (v) => {
    const c = Math.cos(ph), s = Math.sin(ph);
    const dot = fwd[0] * v[0] + fwd[1] * v[1] + fwd[2] * v[2];
    const cr = [
      fwd[1] * v[2] - fwd[2] * v[1],
      fwd[2] * v[0] - fwd[0] * v[2],
      fwd[0] * v[1] - fwd[1] * v[0],
    ];
    return [
      v[0] * c + cr[0] * s + fwd[0] * dot * (1 - c),
      v[1] * c + cr[1] * s + fwd[1] * dot * (1 - c),
      v[2] * c + cr[2] * s + fwd[2] * dot * (1 - c),
    ];
  };
  const right = rot([-sps, 0, cps]);
  const up = rot([-cps * sth, cth, -sps * sth]);
  return { fwd, right, up };
}

/* ================= 主入口 ================= */

/**
 * 定步长飞行模型：内部以 1/120 s 固定子步推进（dt 累积）。
 * @param {Object} state  createSimState() 产出的状态树（原地修改）
 * @param {number} dt     外部名义步长 s
 */
export function stepFlightModel(state, dt) {
  const h = 1 / 120;
  state._acc = Math.min(state._acc + Math.min(dt, 0.25), 0.5);
  let guard = 0;
  while (state._acc >= h && guard++ < 60) {
    state._acc -= h;
    substep(state, h);
  }
}

/** 单子步（1/120 s）：由 stepFlightModel 与 index.js 的统一时序调用 */
export function substep(state, h) {
  const mass = totalMassKg(state);
  const ac = state.aircraft;

  /* 1. 大气 */
  const atm = isaAtmosphere(state.position.y);
  state.atmosphere = atm;

  /* 2. 风矢量（气象风 + 阵风 + 湍流） */
  const gust = state.weather.gustKts * (state.rng() - 0.5);
  const windKt = Math.max(0, state.weather.windKts + gust);
  // windDirDeg 为罗盘角（世界/剧本写入）；内核局部系按活动跑道罗盘锚点换算
  const toDir = deg2rad(state.weather.windDirDeg - (state.runway.headingDeg || 0) + 180);
  const wind = [kt2ms(windKt) * Math.cos(toDir), 0, kt2ms(windKt) * Math.sin(toDir)];
  if (state.weather.turbulence > 0) {
    const tb = state.weather.turbulence * kt2ms(8);
    wind[0] += tb * (state.rng() - 0.5);
    wind[1] += tb * 0.5 * (state.rng() - 0.5);
    wind[2] += tb * (state.rng() - 0.5);
  }
  state._wind = wind;

  /* 3. 气流分解 */
  const vel = [state.velocity.vx, state.velocity.vy, state.velocity.vz];
  const airVel = [vel[0] - wind[0], vel[1] - wind[1], vel[2] - wind[2]];
  const V = Math.max(Math.hypot(airVel[0], airVel[1], airVel[2]), 0.01);
  const axes = bodyAxes(state.orientation.pitch, state.orientation.bank, state.orientation.heading);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const u = dot(airVel, axes.fwd);
  const vB = dot(airVel, axes.right);
  const wB = dot(airVel, axes.up);
  const onGround = state.ground.onGround;
  const groundIncidence = onGround && state.gear.position > 0.5 ? deg2rad(WING_INCIDENCE_GROUND) : 0;
  // 近静止时气流沿跑道水平方向：迎角 = 俯仰（体轴）
  const aoa = (onGround && u < 2)
    ? deg2rad(state.orientation.pitch)
    : Math.atan2(-wB, Math.max(u, 0.5));
  const beta = Math.asin(clamp(vB / V, -1, 1));
  state.velocity.aoa = rad2deg(aoa);
  state.velocity.sideslip = rad2deg(beta);

  const q = 0.5 * atm.rho * V * V;
  const mach = clamp(u / atm.speedOfSound, 0, 1.2); // 供 dragCoef 波阻与 mach 导出

  /* 4. 气动系数 */
  const flapsAngle = state.flaps.angle;
  const ice = state.ice.accumulation;
  const aStall = stallAoaRad(flapsAngle, ice);
  const aeroAoa = aoa + groundIncidence; // 机翼安装角计入气动迎角
  const stalled = !onGround && aeroAoa > aStall * 1.02;
  let cl = liftCoef(aeroAoa, flapsAngle, ice);
  // 扰流板减升
  cl *= 1 - SPOILER_LIFT_KILL * clamp(state.spoilers.deployed, 0, 1);
  const cd = dragCoef(cl, {
    flapsAngleDeg: flapsAngle,
    gearDown: state.gear.position > 0.1,
    spoilersDeployed: state.spoilers.deployed,
    mach, aglM: Math.max(state.position.y, 0),
    iceAccumulation: ice, wingSpanM: ac.wingSpanM,
  });
  const liftN = q * WING_AREA * cl;
  const dragN = q * WING_AREA * cd;
  const sideN = q * WING_AREA * CY_BETA * beta;

  /* 5. 推力（thrustKN 由 systems 更新；反推折减与地面反推力在此处理） */
  let thrustN = 0;
  let reverseN = 0;
  for (let i = 0; i < 2; i++) {
    const e = state.engines[i];
    const rev = clamp(state.reverse[i], 0, 1);
    thrustN += e.thrustKN * 1000 * (1 - 0.9 * rev);
    if (rev > 0 && onGround && e.thrustKN > 1) {
      const eff = clamp((Math.abs(u) - 1) / REVERSE_MIN_SPEED_MS, 0, 1); // 低速反推效率衰减
      reverseN += -Math.sign(u || 1) * rev * REVERSE_FRACTION * e.thrustKN * 1000 * eff;
    }
  }

  /* 6. 力合成 */
  const F = [0, -mass * G, 0];
  const vHat = [airVel[0] / V, airVel[1] / V, airVel[2] / V];
  // 升力/侧力方向取体轴方向在垂直于气流的平面内的投影
  // （否则升力会带 L·sin(α) 的伪后向分量，造成虚假减速）
  const projPerp = (a) => {
    const d = a[0] * vHat[0] + a[1] * vHat[1] + a[2] * vHat[2];
    const out = [a[0] - d * vHat[0], a[1] - d * vHat[1], a[2] - d * vHat[2]];
    const n = Math.hypot(out[0], out[1], out[2]) || 1;
    return [out[0] / n, out[1] / n, out[2] / n];
  };
  const liftDir = projPerp(axes.up);
  const sideDir = projPerp(axes.right);
  for (let k = 0; k < 3; k++) {
    F[k] += thrustN * axes.fwd[k]
      - dragN * vHat[k]
      + liftN * liftDir[k]
      + sideN * sideDir[k];
  }
  if (onGround) applyGroundForces(state, F, u, mass, liftN, reverseN, h);

  state._forces = { liftN, dragN, thrustN, sideN };

  /* 失速后机翼下坠扰动（随机近似） */
  if (stalled) {
    const sev = clamp((aeroAoa - aStall) / 0.08, 0, 2);
    state.orientation.bankRate += (state.rng() - 0.5) * 40 * sev * h;
  }

  /* 积分线运动 */
  state.velocity.vx = safeNum(state.velocity.vx + (F[0] / mass) * h, 0);
  state.velocity.vy = safeNum(state.velocity.vy + (F[1] / mass) * h, 0);
  state.velocity.vz = safeNum(state.velocity.vz + (F[2] / mass) * h, 0);
  state.position.x += state.velocity.vx * h;
  state.position.y += state.velocity.vy * h;
  state.position.z += state.velocity.vz * h;

  /* 7. 角运动 */
  stepRotational(state, h, q, aeroAoa, beta, u, mass);

  /* 8. 地面接触/姿态约束/接地检测 */
  stepGroundContact(state, mass);

  /* 9. 导出速度标量 */
  const vg = Math.hypot(state.velocity.vx, state.velocity.vz);
  state.velocity.tas = ms2kt(V);
  state.velocity.ias = ms2kt(V * Math.sqrt(atm.rho / RHO0));
  state.velocity.mach = u / atm.speedOfSound;
  state.velocity.gs = ms2kt(vg);
  state.velocity.vsFpm = ms2fpm(state.velocity.vy);
  state.agl = Math.max(state.position.y, 0);
}

/* ================= 角运动 ================= */
function stepRotational(state, h, q, aeroAoa, beta, u, mass) {
  const o = state.orientation;
  const qFac = clamp(q / Q_REF, 0, 1.3);
  const rudder = clamp(state.control.rudder, -1, 1);

  // 纵向：满舵速率 + 速度稳定性（静稳定回归基准 = 当前速度/重量下 1g 平飞所需迎角 + 配平偏移）。
  // 旧实现用固定 aTrim，会在进近高 AoA 段把迎角"锁死"在配平基准上——俯仰输入只改变航迹
  // 不产生升力响应（mush）。改为 aoa_1g 基准后，升降舵始终保有完整俯仰/升力操纵功效，
  // 且松杆时飞机自然收敛到当前速度的 1g 飞行（经典速度稳定性）。
  // 静稳定项按 qFac 缩放（气动力矩 ∝ 动压；静止/滑行时无俯仰力矩）。
  // 配平基准迎角：由配平轮映射的"配平速度"唯一确定（配平速度 = 260 − 130·trim kt），
  // aTrim = 该速度下 1g 平飞所需迎角。基准在机动中恒定 → 升降舵始终保有完整迎角/升力
  // 操纵功效（进近拉平不 mush）；松杆时飞机经经典速度稳定性收敛回配平速度。
  // 不依赖当前动压（无滤波滞后），不会把下沉漂移固化进航迹。
  const flapsAngleTrim = state.flaps.angle;
  const cl0Trim = CL0_CLEAN + CL0_FLAPS40_INC * clamp(flapsAngleTrim / 40, 0, 1);
  const vTrimKt = TRIM_SPEED_BASE_KT - TRIM_SPEED_SPAN_KT * clamp(state.trim.stabilizer, -1, 1);
  const rho = state.atmosphere ? state.atmosphere.rho : 1.225;
  const vTrimMs = vTrimKt * 0.514444; // kt → m/s
  const qTrim = 0.5 * rho * vTrimMs * vTrimMs;
  const clNeeded = (mass * G) / Math.max(qTrim * WING_AREA, 1);
  const aoa1gRaw = (clNeeded - cl0Trim) / CL_ALPHA;
  // 地面：基准钳在安装角附近（起落架撑住飞机，静稳定不得自行抬轮）；
  // 空中：钳在 0.75·失速迎角（保失速裕度），进近 1g 迎角不被截断（否则产生 mush）。
  const aTrimMax = state.ground.onGround ? AOA_TRIM_GROUND_MAX : AOA_TRIM_AIR_FRAC * stallAoaRad(flapsAngleTrim, state.ice.accumulation);
  const aTrim = clamp(aoa1gRaw, -0.02, aTrimMax);
  let pitchCmd = state.control.elevator * PITCH_RATE_MAX * qFac
    + PITCH_STAB_GAIN * qFac * rad2deg(aTrim - aeroAoa);
  // 速度稳定性（经典 phugoid 阻尼）：快于配平速度 → 抬头减速，慢于 → 低头加速
  const Vnow = Math.hypot(state.velocity.vx, state.velocity.vy, state.velocity.vz);
  pitchCmd += SPEED_STAB_GAIN * qFac * clamp((Vnow - vTrimMs) / vTrimMs, -0.3, 0.3);
  o.pitchRate = firstOrder(o.pitchRate, clamp(pitchCmd, -25, 25), PITCH_TAU, h);

  // 横向：滚转速率 + 上反效应（空中）。地面滚转自由度被机轮约束：
  // 不累积滚转速率（侧风/上反都不能让停机或滑行飞机倾斜），坡度由地面约束段回正。
  const rollCmd = state.ground.onGround ? 0
    : state.control.aileron * ROLL_RATE_MAX * qFac - DIHEDRAL_ROLL_GAIN * rad2deg(beta);
  o.bankRate = firstOrder(o.bankRate, clamp(rollCmd, -45, 45), 0.30, h);

  // 航向：力矩法。CN_BETA 为正（本模型约定：β>0 = 相对风自右来 → 机头向右风标偏转）
  const qSb = q * WING_AREA * WING_SPAN;
  const Vp = Math.max(u, 30);
  const rNow = deg2rad(o.headingRate);
  // 地面：机轮擦地大幅削弱气动风标力矩（轮胎握住飞机）；并加轮胎对正气矩——
  // 机头偏离地速方向（track）时主轮产生回正力矩，侧风不再把机头甩出跑道轴。
  const gsTrack = Math.hypot(state.velocity.vx, state.velocity.vz);
  const trackErr = (state.ground.onGround && gsTrack > 1)
    ? clamp(Math.atan2(state.velocity.vz, state.velocity.vx) - deg2rad(o.heading), -0.12, 0.12)
    : 0;
  const N_rud_beta = qSb * (CN_DELTA_R * rudder + CN_BETA * beta)
  const N_damp = qSb * CN_R * (rNow * WING_SPAN / (2 * Vp));
  const N_eng = engineYawMomentNm(state);

  if (state.ground.onGround) {
    // 地面：偏航率稳态 = 净偏航力矩 /（轮胎 + 气动阻尼），一阶收敛
    const dampCoef = TIRE_YAW_DAMP + qSb * Math.abs(CN_R) * WING_SPAN / (2 * Vp);
    const gs = Math.hypot(state.velocity.vx, state.velocity.vz);
    const nwEff = Math.pow(clamp(1 - gs / NOSEWHEEL_V_MAX, 0, 1), 2);
    const N_nw = rudder * NOSEWHEEL_MOMENT * nwEff;
    const rTarget = (N_rud_beta + N_eng + N_nw) / dampCoef;
    o.headingRate = rad2deg(firstOrder(rNow, clamp(rTarget, -0.6, 0.6), 0.15, h));
  } else {
    // 空中：力矩积分（含气动阻尼）
    let yawRate = rNow + ((N_rud_beta + N_damp + N_eng) / IZ_EQ) * h;
    o.headingRate = rad2deg(clamp(yawRate, -1.2, 1.2));
  }

  // 欧拉角积分（ZYX 惯例）
  const th = deg2rad(o.pitch), ph = deg2rad(o.bank);
  const p = deg2rad(o.bankRate), qr = deg2rad(o.pitchRate), r = deg2rad(o.headingRate);
  const cosTh = Math.max(Math.cos(th), 0.2);
  const thDot = qr * Math.cos(ph) - r * Math.sin(ph);
  const phDot = p + (qr * Math.sin(ph) + r * Math.cos(ph)) * Math.tan(th);
  const psDot = (qr * Math.sin(ph) + r * Math.cos(ph)) / cosTh;
  o.pitch += rad2deg(thDot) * h;
  o.bank = wrap360(o.bank + rad2deg(phDot) * h);
  if (o.bank > 180) o.bank -= 360;
  o.heading = wrap360(o.heading + rad2deg(psDot) * h);

  // 地面姿态硬约束
  if (state.ground.onGround) {
    if (o.pitch < PITCH_GROUND_MIN) { o.pitch = PITCH_GROUND_MIN; o.pitchRate = Math.max(o.pitchRate, 0); }
    if (o.pitch > PITCH_TAILSTRIKE) { o.pitch = PITCH_TAILSTRIKE; o.pitchRate = Math.min(o.pitchRate, 0); }
    // 机轮回正：坡度向 0 收敛（≈6°/s，接地单轮着陆 ~1 s 内摆平），停机不得持续倾斜
    const right = 6 * h;
    if (o.bank > 0) o.bank = Math.max(0, o.bank - Math.min(o.bank, right));
    else if (o.bank < 0) o.bank = Math.min(0, o.bank + Math.min(-o.bank, right));
    if (o.bank > 6) { o.bank = 6; o.bankRate = Math.min(o.bankRate, 0); }
    if (o.bank < -6) { o.bank = -6; o.bankRate = Math.max(o.bankRate, 0); }
  }
}

/** 不对称推力偏航力矩 N·m（右发推力大 → 机头向右 = 正） */
export function engineYawMomentNm(state) {
  const tL = state.engines[0].thrustKN * 1000 * (1 - 0.9 * clamp(state.reverse[0], 0, 1));
  const tR = state.engines[1].thrustKN * 1000 * (1 - 0.9 * clamp(state.reverse[1], 0, 1));
  // 左发推力在前左 → 机头向右偏（正）；右发同理向左（负）
  return (tL - tR) * ENG_YAW_ARM;
}

/* ================= 地面模型 ================= */

/**
 * 地面附加力：法向支持已含在约束中；这里叠加
 * 滚动摩擦 / 刹车（防滞）/ 静摩擦防爬行（含侧向钳制）/ 机腹擦地阻力。
 * 摩擦方向以"机轮相对地面的运动"（世界系水平地速）为准，而非体轴气流方向：
 * 旧实现只沿世界 x 施加摩擦且方向取 sign(u)（气流），侧风会把停机/滑行飞机
 * 横着推得滑出跑道（用户实测"什么都没动就出错"的根因）。
 */
function applyGroundForces(state, F, u, mass, liftN, reverseN, h) {
  const g = state.ground;
  const onRunway = Math.abs(state.position.z) <= state.runway.widthM / 2 &&
    state.position.x >= 0 && state.position.x <= state.runway.lengthM;
  const belly = state.gear.position < 0.5;
  const N = Math.max(mass * G - liftN, 0);
  const mu = belly ? MU_BELLY : (onRunway ? MU_ROLL : MU_ROLL_GRASS);
  const brakeInput = Math.max(g.brakes[0], g.brakes[1], g.parkingBrake ? 1 : 0);
  const brakeF = belly ? 0 : MU_BRAKE * N * brakeInput;

  // 地面反推力并入水平外力（停机时轮胎同样把它钳住）
  if (reverseN !== 0) F[0] += reverseN;

  const vx = state.velocity.vx, vz = state.velocity.vz;
  const gs = Math.hypot(vx, vz);
  if (gs < 0.5) {
    // 近静止：静摩擦可钳住的水平外力上限（含刹车增压）
    const limit = MU_STATIC * N + brakeF;
    const Fh = Math.hypot(F[0], F[2]);
    if (Fh <= limit) {
      // 轮胎钳住飞机：推力/风力/地面反推的水平分量整体抵消（含侧向）
      F[0] = 0;
      F[2] = 0;
    } else {
      // 即将突破静摩擦：动摩擦沿水平外力反方向
      const decel = mu * N + brakeF;
      F[0] -= (F[0] / Fh) * decel;
      F[2] -= (F[2] / Fh) * decel;
    }
  } else {
    // 滚动/刹车摩擦：沿水平地速反方向（x、z 双分量 → 轮胎侧向抓地）。
    // 上限钳制防止单子步内摩擦把速度推过零（抖振）。
    const decel = Math.min(mu * N + brakeF, (mass * gs) / h);
    F[0] -= (vx / gs) * decel;
    F[2] -= (vz / gs) * decel;

    // 轮胎侧偏力（真实修复）：机轮不允许沿轮轴方向滑动——内核局部系 z 即跑道横向，
    // 直接锚定 vz→0（强刚度回正，上限 μ_side·N，突破才侧滑）。没有它，滑跑中的
    // 飞机会被侧风当冰面一样横着推出跑道（实测 60 秒漂移数百米）。
    const muSide = belly ? MU_SIDE * 0.5 : MU_SIDE;
    const latMax = muSide * N;
    F[2] += clamp(-TIRE_LAT_STIFF * vz * mass, -latMax, latMax);
  }
}

/** 地面接触判定、姿态/速度约束、扰流板与自动刹车逻辑、接地记录 */
function stepGroundContact(state, mass) {
  const g = state.ground;
  const wasOnGround = g.onGround;
  // 轮胎侧向抓地：仅在低速滑行段让航迹向机头收敛（前轮转弯趋势）。
  // 高速滑跑段不做运动学收敛——它会与 applyGroundForces 的跑道横向锚定（vz→0）
  // 拔河：收敛每子步直接旋转速度向量，力量级的锚定追不上，妥协出数十米残余漂移
  //（实测 z=-72m）。高速段机头可因侧风微微顶风，地速由锚定保持沿跑道轴。
  if (g.onGround) {
    const gs = Math.hypot(state.velocity.vx, state.velocity.vz);
    if (gs > 0.5 && gs < 15) {
      const track = Math.atan2(state.velocity.vz, state.velocity.vx);
      const hdg = deg2rad(state.orientation.heading);
      let dTrack = hdg - track;
      while (dTrack > Math.PI) dTrack -= 2 * Math.PI;
      while (dTrack < -Math.PI) dTrack += 2 * Math.PI;
      const dTr = clamp(dTrack, -0.4, 0.4) * TIRE_TRACK_GAIN * 0.016; // 每子步
      const cos = Math.cos(dTr), sin = Math.sin(dTr);
      const vx = state.velocity.vx, vz = state.velocity.vz;
      state.velocity.vx = vx * cos - vz * sin;
      state.velocity.vz = vx * sin + vz * cos;
    }
  }
  if (state.position.y <= 0.001) {
    if (!wasOnGround) recordTouchdown(state, mass);
    g.onGround = true;
    g.mainOnGround = true;
    g.noseOnGround = state.orientation.pitch <= 1.0;
    state.position.y = 0;
    if (state.velocity.vy < 0) state.velocity.vy = 0;
    // 地面扰流板自动放出 / 起飞推地收回
    if (state.spoilers.armed && state.velocity.ias > 40) state.spoilers.deployed = 1;
    if (state.throttle[0] > 0.5 || state.throttle[1] > 0.5) state.spoilers.deployed = 0;
    // 自动刹车
    if (g.autobrake !== 'OFF' && state.spoilers.deployed > 0.5 && state.velocity.ias > 10) {
      const lv = { '1': 0.20, '2': 0.35, '3': 0.50, '4': 0.70, 'MAX': 1.0 }[g.autobrake] ?? 0;
      g.brakes[0] = Math.max(g.brakes[0], lv);
      g.brakes[1] = Math.max(g.brakes[1], lv);
    }
  } else if (state.position.y > 0.05) {
    g.onGround = false;
    g.noseOnGround = false;
    g.mainOnGround = false;
    state.touchdown.recorded = false; // 离地：下一次接地重新记录
  }
}

/** 接地瞬间：填充 touchdown 结算字段（险情/结算单元读取） */
function recordTouchdown(state, mass) {
  const td = state.touchdown;
  const onRunway = Math.abs(state.position.z) <= state.runway.widthM / 2 &&
    state.position.x >= 0 && state.position.x <= state.runway.lengthM;
  const belly = state.gear.position < 0.5;
  td.recorded = true;
  td.time = state.time;
  td.vsFpm = Math.max(-state.velocity.vsFpm, 0);
  td.bankDeg = Math.abs(state.orientation.bank);
  td.pitchDeg = state.orientation.pitch;
  td.driftDeg = state.velocity.sideslip;
  td.centerlineOffsetM = Math.abs(state.position.z);
  td.iasKt = state.velocity.ias;
  td.onRunway = onRunway;
  if (belly) {
    td.surface = 'belly';
  } else if (onRunway) {
    td.surface = 'runway';
  } else {
    // 内核只知道"不在跑道面"；世界单元（海岸线数据）可改写为 'water'
    td.surface = 'terrain';
  }
  void mass;
}
