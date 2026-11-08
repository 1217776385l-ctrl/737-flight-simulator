/**
 * autopilot.js — 基础 AP / AT（MCP 面板语义）。
 *
 * 方式（modes）：
 *  - HDG SEL：滚转转到目标航向，坡度限 25°
 *  - ALT HOLD：保持目标高度（VS 收敛到 0 后平飞）
 *  - ALT SEL：按高度差生成目标 VS 爬降，|高度差|<60 ft 捕获转 ALT HOLD
 *  - VS：保持目标升降率（fpm）
 *  - SPD：自动油门保持目标 IAS（推力钳 idle..max）
 *  - APP：对准跑道（|航向差|<12° 且距离<25 km 且 nav.locValid）截获航向道，
 *          随后满足截获条件截获下滑道；落地（几何高度<5 m）自动断开
 *
 * 俯仰通道为"VS 误差积分器 + 速率限幅 + AoA 保护"：
 *  - 积分项消除稳态误差（长平飞速度不漂移）；
 *  - 俯仰目标变化率限幅 → ALT SEL 捕获时 VS 平滑收敛，无阶跃；
 *  - AoA 保护把俯仰目标钳在 γ + 0.9·αstall 以下，捕获改平不失速。
 * 横滚通道含侧向偏离修正（LOC 截获后按 nav.bearingDeg 修 XTK）；
 * 航向通道含方向舵 PI（自动抵消不对称推力偏航）。
 * AP 需要电源与液压（A 或 B>0.5），否则自动断开。
 */

import { clamp, wrap180, m2ft, ms2fpm, rad2deg, deg2rad } from './math.js';
import { stallAoaRad } from './flight-model.js';

const HDG_GAIN = 1.6;          // 航向误差 deg → 目标坡度 deg
const BANK_LIMIT = 25;         // AP 坡度限制 deg
const ROLL_GAIN = 0.10;        // 坡度误差 deg → 副翼指令
const VS_FROM_ALT_ERR = 3.0;   // 高度差 ft → 目标 VS fpm
const VS_LIMIT = 2500;         // AP 目标 VS 上限 fpm
const PITCH_INTEG = 0.0005;    // VS 误差 fpm → 俯仰目标变化率 deg/s（消稳态误差）
const PITCH_CMD_RATE = 0.8;    // 俯仰目标变化率限幅 deg/s
const VS_PROP = 0.0016;       // VS 误差 fpm → 升降舵直接比例项（阻尼长周期振荡）
const VS_PROP_MAX = 0.3;      // 比例项限幅
const ELEV_GAIN = 0.05;        // 俯仰误差 deg → 升降舵指令
const PITCH_RATE_DAMP = 0.06;  // 俯仰速率阻尼系数
const AOA_PROTECT = 0.9;       // AoA 保护：俯仰目标 ≤ γ + 0.9·αstall
const AT_IAS_GAIN = 0.08;      // IAS 误差 kt → 油门变化率 /s
const LOC_CAPTURE_DEG = 12;    // 航向道截获航向窗口 deg
const LOC_CAPTURE_DIST_M = 25000;
const GS_DEV_GAIN = 260;       // 下滑道偏离 deg → 目标 VS 修正 fpm（×空速因子）
const XTK_GAIN = 0.05;         // 侧向偏差 m → 航向修正 deg（LOC 截获后）
const XTK_MAX_DEG = 25;        // 侧向修正航向限幅 deg
const RUD_PROP = 0.012;        // 航向误差 deg → 方向舵指令
const RUD_INTEG = 0.004;       // 航向误差 deg → 方向舵积分速率 /s
const RUD_DAMP = 0.02;         // 偏航速率阻尼
const RUD_I_LIMIT = 0.5;       // 方向舵积分限幅

/** AP/AT 步进（index.js 每子步调用） */
export function stepAutopilot(state, h) {
  const ap = state.ap;

  // APP 截获逻辑（接通与否均可预位，但截获后接管）
  stepAppCapture(state);

  // 供电/液压保护
  const powerOk = state.electrical.acPowered ?? state.electrical.busPowered; // AP 需交流电源
  const hydOk = state.hydraulics.A > 0.5 || state.hydraulics.B > 0.5;
  if (ap.engaged && (!powerOk || !hydOk)) {
    apDisconnect(state, 'HYD');
    return;
  }

  stepAutothrottle(state, h);

  if (!ap.engaged) return;

  // 落地自动断开：以几何高度判定（ground.onGround 由飞行模型更新，此处读会滞后一帧）
  const radioAltM = Math.max(state.position.y, 0);
  if (radioAltM < 5) {
    apDisconnect(state);
    return;
  }

  // 目标航向（HDG SEL 或 LOC 截获后的航道 + 侧向修正）
  const targetHdg = targetHeading(state);
  const roll = apRoll(state, targetHdg);
  const pitch = apPitch(state, h);
  state.control.aileron = clamp(roll, -0.6, 0.6);
  state.control.elevator = clamp(pitch, -0.7, 0.7);
  state.control.rudder = apRudder(state, h, targetHdg);
}

/* ================= 目标航向与侧向修正 ================= */
function targetHeading(state) {
  const ap = state.ap;
  if (!(ap.modes.app && ap.modes.locCaptured)) return ap.targets.hdg;
  const nav = state.nav;
  let corr = 0;
  // 侧向偏离修正：nav.bearingDeg = 飞机指向跑道入口的方位（世界单元可选提供）
  if (Number.isFinite(nav.bearingDeg)) {
    // xtk > 0 = 飞机在航道右侧（需向左修）。进近几何（飞机在入口之前）下成立：
    // xtk = -distM·sin(入口方位 - 航道)
    const xtkM = -nav.distM * Math.sin(deg2rad(nav.bearingDeg - nav.courseDeg));
    corr = -clamp(xtkM * XTK_GAIN, -XTK_MAX_DEG, XTK_MAX_DEG);
  }
  return nav.courseDeg + corr;
}

/* ================= APP 截获 ================= */
function stepAppCapture(state) {
  const ap = state.ap;
  if (!ap.modes.app || ap.modes.gsCaptured) return;
  const nav = state.nav;
  if (!nav.locValid) return;
  const hdgErr = Math.abs(wrap180(state.orientation.heading - nav.courseDeg));
  if (!ap.modes.locCaptured) {
    if (nav.distM < LOC_CAPTURE_DIST_M && hdgErr < LOC_CAPTURE_DEG) {
      ap.modes.locCaptured = true;
      ap.targets.hdg = nav.courseDeg;
    }
    return;
  }
  // 航向道已截获：评估下滑道偏离（deg，>0 = 在下滑道上方）
  const gsDevDeg = glideSlopeDevDeg(state);
  if (Math.abs(gsDevDeg) < 0.4) {
    ap.modes.gsCaptured = true;
  }
}

/** 相对下滑道的偏离角 deg（>0 = 高于下滑道） */
export function glideSlopeDevDeg(state) {
  const nav = state.nav;
  const aboveThrM = state.position.y - nav.thresholdElevFt / 3.28084;
  const distM = Math.max(nav.distM, 50);
  return rad2degWrap(Math.atan2(aboveThrM, distM) - deg2rad(3.0));
}

function rad2degWrap(r) { return rad2deg(r); }

/* ================= 横滚通道 ================= */
function apRoll(state, targetHdg) {
  const ap = state.ap;
  const err = wrap180(targetHdg - state.orientation.heading);
  const targetBank = clamp(err * HDG_GAIN, -BANK_LIMIT, BANK_LIMIT);
  ap.fd.bank = targetBank;
  return (targetBank - state.orientation.bank) * ROLL_GAIN;
}

/* ================= 方向舵通道（航向保持 + 抗不对称推力） ================= */
function apRudder(state, h, targetHdg) {
  const ap = state.ap;
  const hdgErr = wrap180(targetHdg - state.orientation.heading);
  // PI 控制：积分项提供抗不对称推力的稳态方向舵
  ap._rudI = clamp((ap._rudI ?? 0) + clamp(hdgErr * RUD_INTEG, -0.05, 0.05) * h, -RUD_I_LIMIT, RUD_I_LIMIT);
  const damp = -state.orientation.headingRate * RUD_DAMP;
  return clamp(hdgErr * RUD_PROP + ap._rudI + damp, -0.8, 0.8);
}

/* ================= 俯仰通道 ================= */
function apPitch(state, h) {
  const ap = state.ap;
  const altFt = m2ft(state.position.y);
  const altErr = ap.targets.alt - altFt;
  let vsTarget;

  if (ap.modes.vs) {
    vsTarget = ap.targets.vs;
  } else if (ap.modes.altSel) {
    vsTarget = clamp(altErr * VS_FROM_ALT_ERR, -VS_LIMIT, VS_LIMIT);
  } else if (ap.modes.app && ap.modes.gsCaptured) {
    // 下滑道跟踪：由几何求所需 VS（几何式已含全部偏离修正）
    const aboveThrM = state.position.y - state.nav.thresholdElevFt / 3.28084;
    const distM = Math.max(state.nav.distM, 50);
    const gamma = Math.atan2(aboveThrM, distM);
    const vMs = Math.max(Math.hypot(state.velocity.vx, state.velocity.vy, state.velocity.vz), 60);
    // 几何式目标 + 低速段下滑道偏离增益（防止下沉漂移固化；dev<0 = 低于滑道 → 抬 VS 修正）
    const devGain = GS_DEV_GAIN * clamp(vMs / 70, 0.6, 1.4);
    vsTarget = clamp(-ms2fpm(vMs * Math.tan(gamma)) - glideSlopeDevDeg(state) * devGain, -2500, 400);
  } else {
    // ALT HOLD（含 ALT SEL 捕获后）：VS 收敛到 0 平飞
    vsTarget = 0;
    if (Math.abs(altErr) > 60) vsTarget = clamp(altErr * VS_FROM_ALT_ERR, -VS_LIMIT, VS_LIMIT);
  }

  // ALT SEL 捕获（滞环 60 ft，防边界抖动）→ ALT HOLD
  if (ap.modes.altSel && Math.abs(altErr) <= 60) {
    ap.modes.altSel = false;
    ap.modes.altHold = true;
    ap.targets.alt = altFt;
  }

  // VS 误差积分器：俯仰目标以限幅速率向消差方向移动（无稳态误差、无阶跃）
  const vsErr = clamp(vsTarget - state.velocity.vsFpm, -4000, 4000);
  let pitchCmd = (ap._pitchCmd ?? state.orientation.pitch) +
    clamp(vsErr * PITCH_INTEG, -PITCH_CMD_RATE, PITCH_CMD_RATE) * h;

  // AoA 保护：俯仰目标钳在 [γ-15°, γ+0.9·αstall]
  const vMs = Math.max(Math.hypot(state.velocity.vx, state.velocity.vy, state.velocity.vz), 50);
  const gammaDeg = rad2deg(Math.asin(clamp(state.velocity.vy / vMs, -1, 1)));
  const aStallDeg = rad2deg(stallAoaRad(state.flaps.angle, state.ice.accumulation));
  const pitchMin = gammaDeg - 15;
  const pitchMax = Math.max(pitchMin, gammaDeg + AOA_PROTECT * aStallDeg);
  pitchCmd = clamp(pitchCmd, pitchMin, pitchMax);
  // 抗积分饱和：俯仰目标距当前俯仰不超过 ±3°（防止积分器远离植物可实现的姿态，
  // 造成大幅回卷振荡）
  pitchCmd = clamp(pitchCmd, state.orientation.pitch - 3, state.orientation.pitch + 3);

  ap._pitchCmd = pitchCmd;
  ap.fd.pitch = pitchCmd;

  const pitchErr = ap.fd.pitch - state.orientation.pitch;
  const damp = -state.orientation.pitchRate * PITCH_RATE_DAMP;
  const vsProp = clamp(vsErr * VS_PROP, -VS_PROP_MAX, VS_PROP_MAX);
  return pitchErr * ELEV_GAIN + damp + vsProp;
}

/* ================= 自动油门 ================= */
function stepAutothrottle(state, h) {
  const ap = state.ap;
  if (!ap.modes.spd) return;
  if (!(ap.engaged || ap.atArmed)) return;
  const err = ap.targets.ias - state.velocity.ias; // kt
  ap._atThrottle = clamp((ap._atThrottle ?? state.throttle[0]) + err * AT_IAS_GAIN * h, 0, 1);
  state.throttle[0] = ap._atThrottle;
  state.throttle[1] = ap._atThrottle;
}

/* ================= 接通 / 断开 ================= */

/** CMD 电门：接通（捕获当前航向/高度）或断开 */
export function apToggle(state) {
  if (state.ap.engaged) apDisconnect(state);
  else apEngage(state);
}

export function apEngage(state) {
  const ap = state.ap;
  if (ap.engaged) return;
  if (!(state.electrical.acPowered ?? state.electrical.busPowered)) return;
  if (!(state.hydraulics.A > 0.5 || state.hydraulics.B > 0.5)) return;
  ap.engaged = true;
  ap.targets.hdg = state.orientation.heading;
  ap.targets.alt = m2ft(state.position.y);
  ap.modes.hdgSel = true;
  ap.modes.altHold = true;
  ap.modes.vs = false;
  ap.modes.altSel = false;
  ap._pitchCmd = state.orientation.pitch; // 无扰动接管
  ap._rudI = 0;
  state.control.aileron = 0;
  state.control.elevator = 0;
  state.control.rudder = 0;
}

export function apDisconnect(state) {
  const ap = state.ap;
  ap.engaged = false;
  ap.atArmed = false;   // 断开 AP 同时脱离自动油门（重新预位需再发 ap/spd）
  ap._atThrottle = undefined;
  ap.modes.hdgSel = false;
  ap.modes.altHold = false;
  ap.modes.altSel = false;
  ap.modes.vs = false;
  ap.modes.app = false;
  ap.modes.locCaptured = false;
  ap.modes.gsCaptured = false;
  ap.fd.pitch = 0;
  ap.fd.bank = 0;
  ap._pitchCmd = undefined;
  ap._rudI = 0;
  // 断开时操纵面回中，避免保持断开前的 AP 指令
  state.control.aileron = 0;
  state.control.elevator = 0;
  state.control.rudder = 0;
}

/** APP 电门：预位进近方式 */
export function apArmApp(state) {
  const ap = state.ap;
  ap.modes.app = true;
  ap.modes.locCaptured = false;
  ap.modes.gsCaptured = false;
  if (!ap.engaged) apEngage(state);
}
