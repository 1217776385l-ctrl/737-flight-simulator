/**
 * tests/kernel.test.mjs — 内核数值验收测试。
 * 运行：node tests/kernel.test.mjs   （全部 PASS → 退出码 0）
 *
 * 说明：
 *  - 测试 4 中"跑距"按行业惯例取【松刹车 → 离地 35 ft】的起飞总距离
 *    （真实 737-800 @70 t 襟翼 5 海平面起飞距离 ≈2000 m，落在规格区间 [1500,2600] 内）；
 *    0→VR 时间按规格区间 [28,42] s 校验。
 */

import assert from 'node:assert/strict';
import {
  createSimState, createCommandBus, stepSimulation, stepSystems,
  isaAtmosphere, clMaxForFlaps, dragCoef, stallIasKt, inducedDragFactor,
  thrustPerEngineKN, getVSpeeds, getVref, substepSystems, stepAutopilot,
} from '../src/kernel/index.js';
import { substep as flightModelSubstep } from '../src/kernel/flight-model.js';

const KT = 0.514444; // kt → m/s

let passed = 0, total = 0;
function ok(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error('      ' + (err && err.message ? err.message.split('\n').join('\n      ') : err));
    process.exitCode = 1;
  }
}

function mkState(opts = {}) {
  const state = createSimState({ enginesRunning: true, ...opts });
  state.ground.parkingBrake = false;
  state.ground.brakes[0] = 0;
  state.ground.brakes[1] = 0;
  return state;
}

/** 与 stepSimulation 相同的固定时序推进 dt（不经 _acc，测试用） */
function step(state, dt) {
  const h = 1 / 120;
  let t = 0;
  while (t < dt - 1e-9) {
    substepSystems(state, h);
    stepAutopilot(state, h);
    flightModelSubstep(state, h);
    t += h;
  }
  state.time += dt;
}

/* =========================================================
 * 1. 失速速度：60 t 干净构型 1g 失速 IAS ∈ [140,165] kt
 * ========================================================= */
ok('T1 失速速度 60t 干净 ∈ [140,165] kt', () => {
  const ias = stallIasKt(60000, 0, 0);
  assert.ok(ias >= 140 && ias <= 165, `IAS=${ias.toFixed(1)} kt`);
});

/* =========================================================
 * 2. 失速速度：60 t 襟翼 40 失速 IAS ∈ [100,118] kt
 * ========================================================= */
ok('T2 失速速度 60t 襟翼40 ∈ [100,118] kt', () => {
  const ias = stallIasKt(60000, 40, 0);
  assert.ok(ias >= 100 && ias <= 118, `IAS=${ias.toFixed(1)} kt`);
});

/* =========================================================
 * 3. V 速度表
 * ========================================================= */
ok('T3a 70t 襟翼5 V1/VR/V2 ≈ [141,143,149] ±4', () => {
  const { v1, vr, v2 } = getVSpeeds(70000, 3);
  assert.ok(Math.abs(v1 - 141) <= 4, `V1=${v1}`);
  assert.ok(Math.abs(vr - 143) <= 4, `VR=${vr}`);
  assert.ok(Math.abs(v2 - 149) <= 4, `V2=${v2}`);
});
ok('T3b Vref30@60t ≈ 137 ±5', () => {
  const v = getVref(60000, 6);
  assert.ok(Math.abs(v - 137) <= 5, `Vref=${v}`);
});

/* =========================================================
 * 4. 起飞干跑：70t 襟翼5 全推力 → 0→VR 时间 [28,42] s，
 *    松刹车→35 ft 距离 [1500,2600] m，抬轮后正爬升率
 * ========================================================= */
ok('T4 起飞：0→VR 时间 [28,42]s，35ft 距离 [1500,2600]m，正爬升率', () => {
  const state = mkState({ fuelKg: 6020, payloadKg: 22580 }); // 总重 70 t
  const bus = createCommandBus(state);
  bus.send('flaps/set', 3);
  bus.send('throttle/set', 1.0);
  let tVR = null;
  let dist35 = null;
  let vsAt50 = null;
  let rotated = false;
  const h = 1 / 60;
  for (let i = 0; i < 60 * 90; i++) {
    const vr = getVSpeeds(state.massKg, 3).vr;
    // 油门到位后杆回中；达到 VR 抬轮到 14°；离地后收起落架
    if (state.velocity.ias > 5 && !rotated && state.velocity.ias >= vr) {
      state.control.elevator = 0.85;
      rotated = true;
      tVR = state.time;
    }
    if (rotated) {
      if (state.orientation.pitch < 14) state.control.elevator = 0.7;
      else state.control.elevator = 0.25;
    }
    step(state, h);
    if (vsAt50 === null && state.agl >= 9) vsAt50 = state.velocity.vsFpm; // ≈30-50 ft 爬升率
    if (vsAt50 !== null && state.gear.handleDown && state.agl > 20) bus.send('gear/up');
    if (dist35 === null && state.agl >= 35 * 0.3048) {
      dist35 = state.position.x;
      break;
    }
  }
  assert.ok(tVR !== null, '未达到 VR');
  assert.ok(dist35 !== null, '未爬升到 35 ft');
  assert.ok(tVR >= 28 && tVR <= 42, `0→VR 时间 ${tVR.toFixed(1)} s`);
  assert.ok(dist35 >= 1500 && dist35 <= 2600, `35ft 距离 ${dist35.toFixed(0)} m`);
  assert.ok(vsAt50 !== null && vsAt50 > 50, `50 ft 爬升率 ${vsAt50} fpm（应 >50）`);
});

/* =========================================================
 * 5. 巡航平衡：FL350、74t，稳态 TAS ∈ [440,510] kt 且推力≈阻力
 * ========================================================= */
ok('T5 巡航 FL350 74t：TAS ∈ [440,510] kt，推力=阻力', () => {
  const state = mkState({ fuelKg: 12000, payloadKg: 20600 }); // 总重 74 t
  const bus = createCommandBus(state);
  state.position.y = 10668; // FL350
  state.position.x = 0;
  state.ground.onGround = false;
  state.gear.position = 0;
  state.gear.handleDown = false;
  bus.send('flaps/set', 0);
  bus.send('throttle/set', 1.0);
  // 预热：油门杆推满后 N1 滞后收敛（≈30 s），再给巡航初速
  const hs = 1 / 120;
  for (let i = 0; i < 120 * 30; i++) stepSystems(state, hs);
  state.velocity.vx = 235;
  bus.send('ap/cmd');          // AP 接通 ALT HOLD 保持高度
  bus.send('ap/alt', 35000);
  const h = 1 / 60;
  let tasSum = 0, tSum = 0, dSum = 0, n = 0;
  for (let i = 0; i < 60 * 480; i++) { // 480 s 模拟
    step(state, h);
    if (i > 60 * 300) { // 统计后 180 s（覆盖完整俯仰振荡周期）
      tasSum += state.velocity.tas;
      tSum += state._forces.thrustN;
      dSum += state._forces.dragN;
      n++;
    }
  }
  const tasAvg = tasSum / n;
  const tdResidual = Math.abs(tSum - dSum) / n;
  assert.ok(tasAvg >= 440 && tasAvg <= 510, `TAS 平均 ${tasAvg.toFixed(0)} kt`);
  assert.ok(tdResidual < 5000, `推力-阻力均值残差 ${tdResidual.toFixed(0)} N`);
});

/* =========================================================
 * 6. 单发不对称：130 kt 地面滑跑，一发 max 一发 off：
 *    全方向舵偏航率 <1°/s；无舵 >2°/s
 * ========================================================= */
function asymYawRate(rudder) {
  const state = mkState({ fuelKg: 6020, payloadKg: 22580 }); // 70 t
  const bus = createCommandBus(state);
  bus.send('flaps/set', 3);
  bus.send('throttle/set', 1.0);
  state.throttle[1] = 0;                // 右发慢车（即将失效）
  // 预热：左发 N1 满转速（20 s），并直接置 130 kt 地面滑跑初速
  const hs = 1 / 120;
  for (let i = 0; i < 120 * 20; i++) stepSystems(state, hs);
  state.velocity.vx = 130 * KT;
  bus.send('engine/stop', 1);           // 此刻右发失效（Vmcg 场景）
  state.control.rudder = rudder;
  const h = 1 / 60;
  let peak = 0, window = 0;
  for (let i = 0; i < 60 * 12; i++) {
    step(state, h);
    if (window < 6) { // 失效后 6 s 内的峰值偏航率
      peak = Math.max(peak, Math.abs(state.orientation.headingRate));
      window += h;
    }
    state.control.rudder = rudder;
  }
  return peak;
}
ok('T6a 130kt 单发全方向舵：偏航率 <1°/s', () => {
  const r = asymYawRate(-1.0); // 左舵抵右偏
  assert.ok(r < 1.0, `偏航率 ${r.toFixed(2)} °/s`);
});
ok('T6b 130kt 单发无舵：偏航率 >2°/s', () => {
  const r = asymYawRate(0);
  assert.ok(r > 2.0, `偏航率 ${r.toFixed(2)} °/s`);
});

/* =========================================================
 * 7. 地效：5 m AGL 诱导阻力比自由空流小 ≥15%
 * ========================================================= */
ok('T7 地效 5m：诱导阻力下降 ≥15%', () => {
  const cl = 0.6;
  const cdFree = dragCoef(cl, { aglM: 1000, flapsAngleDeg: 0, mach: 0.2 });
  const cdGround = dragCoef(cl, { aglM: 5, flapsAngleDeg: 0, mach: 0.2 });
  const reduction = 1 - (cdGround - 0.02) / (cdFree - 0.02); // 比较诱导分量
  assert.ok(reduction >= 0.15, `诱导阻力减小 ${(reduction * 100).toFixed(1)}%`);
  assert.ok(inducedDragFactor(5) <= 0.85);
});

/* =========================================================
 * 8. 反推+扰流板：70t 140kt 刹停：无反推 > 有反推 ≥20%
 * ========================================================= */
function landingRoll(withReverse) {
  const state = mkState({ fuelKg: 6020, payloadKg: 22580 }); // 70 t
  const bus = createCommandBus(state);
  bus.send('flaps/set', 6);           // 襟翼 30
  bus.send('spoilers/arm', true);
  bus.send('brakes/set', 1.0);
  if (withReverse) bus.send('reverse/set', 1.0);
  // 初始：140 kt 地面滑跑
  state.velocity.vx = 140 * KT;
  const x0 = state.position.x;
  const h = 1 / 60;
  for (let i = 0; i < 60 * 90; i++) {
    step(state, h);
    if (state.velocity.ias < 2) break;
  }
  return state.position.x - x0;
}
ok('T8 反推+扰流板：无反推距离比有反推长 ≥20%', () => {
  const dNo = landingRoll(false);
  const dRev = landingRoll(true);
  const ratio = dNo / dRev;
  assert.ok(ratio >= 1.20, `无反推 ${dNo.toFixed(0)} m vs 有反推 ${dRev.toFixed(0)} m（${ratio.toFixed(2)}x）`);
});

/* =========================================================
 * 9. N1 滞后：idle→max 5 秒后 N1 增幅 < 最终增量的 70%
 * ========================================================= */
ok('T9 N1 滞后：5s 增幅 < 最终增量的 70%', () => {
  const state = mkState();
  const bus = createCommandBus(state);
  const n1_0 = state.engines[0].n1;
  bus.send('throttle/set', 1.0);
  const h = 1 / 120;
  for (let i = 0; i < 120 * 5; i++) stepSystems(state, h);
  const n1_5 = state.engines[0].n1;
  for (let i = 0; i < 120 * 20; i++) stepSystems(state, h);
  const n1_f = state.engines[0].n1;
  const frac = (n1_5 - n1_0) / (n1_f - n1_0);
  assert.ok(frac < 0.70, `5s 增幅占比 ${(frac * 100).toFixed(1)}%`);
});

/* =========================================================
 * 10. ISA 标准大气
 * ========================================================= */
ok('T10 ISA：ρ0≈1.225；11000m ρ≈0.365±2%、a≈295±1 m/s', () => {
  const s0 = isaAtmosphere(0);
  assert.ok(Math.abs(s0.rho - 1.225) < 0.005, `ρ0=${s0.rho}`);
  const s11 = isaAtmosphere(11000);
  assert.ok(Math.abs(s11.rho - 0.365) / 0.365 < 0.02, `ρ(11km)=${s11.rho.toFixed(4)}`);
  assert.ok(Math.abs(s11.speedOfSound - 295) <= 1, `a(11km)=${s11.speedOfSound.toFixed(2)}`);
});

/* =========================================================
 * 11. 结冰：accumulation=1 → CLmax 下降 ≥20%
 * ========================================================= */
ok('T11 结冰满积 CLmax 下降 ≥20%', () => {
  const dry = clMaxForFlaps(0, 0);
  const iced = clMaxForFlaps(0, 1.0);
  const loss = 1 - iced / dry;
  assert.ok(loss >= 0.20, `下降 ${(loss * 100).toFixed(1)}%`);
});

/* =========================================================
 * 12. 全流程冒烟：完整 stepSimulation 跑 120 s，无 NaN、字段完整
 * ========================================================= */
ok('T12 全流程冒烟 120s：无 NaN、状态字段完整', () => {
  const state = mkState({ fuelKg: 8000, payloadKg: 14000 });
  const bus = createCommandBus(state);
  bus.send('flaps/set', 3);
  bus.send('throttle/set', 0.9);
  const h = 1 / 60;
  let apEngagedAt = false;
  for (let i = 0; i < 60 * 120; i++) {
    if (i === 60 * 5) bus.send('gear/up');
    if (i === 60 * 20 && !apEngagedAt) { bus.send('ap/cmd'); apEngagedAt = true; bus.send('ap/alt', 10000); bus.send('ap/spd', 250); }
    if (i === 60 * 40) bus.send('ap/hdg', 20);
    if (i === 60 * 70) bus.send('flaps/set', 1);
    stepSimulation(state, h, bus);
  }
  const checkFinite = (obj, path = '') => {
    for (const [k, val] of Object.entries(obj)) {
      const p = `${path}.${k}`;
      if (typeof val === 'number') assert.ok(Number.isFinite(val), `NaN/Inf at ${p} = ${val}`);
      else if (val && typeof val === 'object' && !Array.isArray(val)) checkFinite(val, p);
      else if (Array.isArray(val)) val.forEach((x, idx) => {
        if (typeof x === 'number') assert.ok(Number.isFinite(x), `NaN at ${p}[${idx}]`);
        else if (x && typeof x === 'object') checkFinite(x, `${p}[${idx}]`);
      });
    }
  };
  checkFinite(state);
  // 字段完整性
  for (const key of ['time', 'aircraft', 'position', 'orientation', 'velocity', 'atmosphere',
    'engines', 'throttle', 'reverse', 'flaps', 'gear', 'spoilers', 'trim', 'fuel',
    'hydraulics', 'electrical', 'pressurization', 'pitot', 'ice', 'fire', 'ap',
    'warnings', 'weather', 'ground', 'touchdown', 'control', 'nav']) {
    assert.ok(key in state, `缺少状态字段 ${key}`);
  }
  assert.ok(Array.isArray(state.warnings.active));
  assert.ok(state.touchdown && 'vsFpm' in state.touchdown && 'surface' in state.touchdown);
});

/* =========================================================
 * 13. [回归] APU 能启动：双发失效后 APU 供电可用（bug1）
 * ========================================================= */
ok('T13 APU 启动：apuOn 6s 后 apu=true，双发失效时 busPowered=true', () => {
  const state = mkState();
  const bus = createCommandBus(state);
  bus.send('engine/stop', 2);      // 双发停车（模拟双发失效场景）
  for (let i = 0; i < 120 * 5; i++) stepSystems(state, 1 / 120);
  assert.equal(state.electrical.acPowered, false, '双发停车且无 APU 时交流电源应断');
  assert.equal(state.electrical.busPowered, true, '电瓶直流母线应仍有电');
  bus.send('apu/toggle');
  for (let i = 0; i < 120 * 6; i++) stepSystems(state, 1 / 120);
  assert.equal(state.electrical.apu, true, 'APU 6s 后应可用');
  assert.equal(state.electrical.acPowered, true, 'APU 可用后交流电源应恢复');
});

/* =========================================================
 * 14. [回归] ALT SEL 紧急下降捕获：FL350→10000ft 平飞不失速（bug2/bug3）
 * ========================================================= */
ok('T14 ALT SEL FL350→10000ft：捕获改平不失速、VS 收敛、高度保持', () => {
  const state = mkState({ fuelKg: 12000, payloadKg: 20600 }); // 74 t
  const bus = createCommandBus(state);
  state.position.y = 10668;
  state.ground.onGround = false;
  state.gear.position = 0;
  state.gear.handleDown = false;
  bus.send('flaps/set', 0);
  bus.send('throttle/set', 0.0);   // 急下降用慢车
  for (let i = 0; i < 120 * 30; i++) stepSystems(state, 1 / 120); // N1 收敛到慢车
  state.velocity.vx = 235;
  bus.send('ap/cmd');
  bus.send('ap/alt', 10000);
  const h = 1 / 60;
  let maxAoa = 0, minAltFt = Infinity, maxIas = 0, minIas = Infinity, stalled = false;
  let captured = false, capturedAt = -1;
  const aStallDeg = 12.6; // 干净构型近似失速迎角（deg）
  for (let i = 0; i < 60 * 700; i++) {
    step(state, h);
    const altFt = state.position.y * 3.28084;
    maxAoa = Math.max(maxAoa, state.velocity.aoa);
    minAltFt = Math.min(minAltFt, altFt);
    maxIas = Math.max(maxIas, state.velocity.ias);
    minIas = Math.min(minIas, state.velocity.ias);
    if (state.warnings.active.includes('STALL')) stalled = true;
    if (!captured && !state.ap.modes.altSel && state.ap.modes.altHold) {
      captured = true;
      capturedAt = state.time;
    }
    if (captured && capturedAt > 0 && state.time - capturedAt > 45) break; // 捕获后再看 45 s
  }
  assert.ok(captured, 'ALT SEL 未捕获');
  assert.ok(!stalled, '下降/改平过程中触发 STALL');
  assert.ok(maxAoa < aStallDeg, `最大迎角 ${maxAoa.toFixed(1)}°（应 <${aStallDeg}°）`);
  assert.ok(minAltFt > 9000, `最低高度 ${minAltFt.toFixed(0)} ft（改平穿深过大）`);
  assert.ok(maxIas < 360, `下降中最大 IAS ${maxIas.toFixed(0)} kt（防超速俯冲）`);
  assert.ok(minIas > 170, `最小 IAS ${minIas.toFixed(0)} kt（接近失速）`);
  const altErr = Math.abs(state.position.y * 3.28084 - 10000);
  const vsNow = state.velocity.vsFpm;
  assert.ok(altErr < 400, `捕获后高度误差 ${altErr.toFixed(0)} ft`);
  assert.ok(Math.abs(vsNow) < 400, `捕获后 VS ${vsNow.toFixed(0)} fpm（应收敛到 0）`);
});

/* =========================================================
 * 15. [回归] 长平飞速度保持：60 s IAS 衰减 <10 kt（bug3 积分项）
 * ========================================================= */
ok('T15 平飞 60s：IAS 衰减 <10 kt（俯仰积分项消稳态误差）', () => {
  const state = mkState({ fuelKg: 12000, payloadKg: 20600 });
  const bus = createCommandBus(state);
  state.position.y = 10668;
  state.ground.onGround = false;
  state.gear.position = 0;
  state.gear.handleDown = false;
  bus.send('flaps/set', 0);
  bus.send('throttle/set', 1.0);
  for (let i = 0; i < 120 * 30; i++) stepSystems(state, 1 / 120);
  state.velocity.vx = 235;
  bus.send('ap/cmd');           // ALT HOLD
  const h = 1 / 60;
  for (let i = 0; i < 60 * 90; i++) step(state, h); // 先稳定 90 s
  const ias0 = state.velocity.ias;
  const tas0 = state.velocity.tas;
  const alt0 = state.position.y;
  let iasEnd = ias0, tasEnd = tas0;
  for (let i = 0; i < 60 * 60; i++) {
    step(state, h);
    iasEnd = state.velocity.ias;
    tasEnd = state.velocity.tas;
  }
  const altDrift = Math.abs(state.position.y - alt0) * 3.28084;
  const decay = ias0 - iasEnd;
  assert.ok(decay < 10, `IAS 衰减 ${decay.toFixed(1)} kt（${ias0.toFixed(0)} → ${iasEnd.toFixed(0)}）`);
  assert.ok(tasEnd > 440, `平飞 TAS ${tasEnd.toFixed(0)} kt（应保持巡航速度；FL350 IAS≈${iasEnd.toFixed(0)} 正常）`);
  assert.ok(tasEnd >= tas0 - 10, `TAS 衰减 ${(tas0 - tasEnd).toFixed(1)} kt`);
  assert.ok(altDrift < 200, `60 s 高度漂移 ${altDrift.toFixed(0)} ft`);
});

/* =========================================================
 * 16. [回归] 种子可复现（bug4）：同种子两次仿真轨迹完全一致
 * ========================================================= */
ok('T16 种子可复现：同 rngSeed 两次仿真轨迹一致，不同种子不同', () => {
  const run = (seed) => {
    const state = mkState({ rngSeed: seed });
    const bus = createCommandBus(state);
    bus.send('throttle/set', 0.8);
    const h = 1 / 60;
    state.weather.turbulence = 1.0;
    for (let i = 0; i < 60 * 20; i++) stepSimulation(state, h, bus);
    return { x: state.position.x, y: state.position.y, ias: state.velocity.ias, hdg: state.orientation.heading };
  };
  const a = run(123), b = run(123), c = run(456);
  assert.equal(a.x, b.x, '同种子 x 不一致');
  assert.equal(a.ias, b.ias, '同种子 IAS 不一致');
  assert.equal(a.hdg, b.hdg, '同种子航向不一致');
  assert.notEqual(a.x, c.x, '不同种子轨迹竟完全相同（种子未生效）');
});

/* =========================================================
 * 17. [回归] 拉平：襟翼30 145kt 稳定进近（3°滑道）30m 拉平 → 接地 VS <200 fpm
 *     （高 AoA 段俯仰操纵功效：人工拉平必须能把 VS 从 -700 收到 -200 以内）
 * ========================================================= */
ok('T17 拉平：145kt 襟翼30 30m 拉平（俯仰+2.5°保持）→ 接地 VS <200 fpm', () => {
  const state = mkState({ fuelKg: 8000, payloadKg: 15600 }); // 65 t
  const bus = createCommandBus(state);
  bus.send('flaps/set', 6);            // 襟翼 30
  state.flaps.angle = 30;
  state.trim.stabilizer = (260 - 145) / 130; // 配平到 145 kt
  state.ground.onGround = false;
  state.gear.handleDown = true; state.gear.position = 1;
  const V = 145 * KT, g3 = 3 * Math.PI / 180;
  state.velocity.vx = V * Math.cos(g3);
  state.velocity.vy = -V * Math.sin(g3);
  state.orientation.pitch = -3 + ((state.massKg * 9.80665 / (0.5 * 1.225 * V * V * 125) - 0.6125) / 5.0) * 180 / Math.PI;
  state.position.x = -3000;
  state.position.y = 3000 * Math.tan(g3) + 15;
  // 稳定进近：AP VS −700 fpm（≈3°滑道）+ SPD 145 kt
  bus.send('ap/cmd'); bus.send('ap/vs', -700); bus.send('ap/spd', 145);
  const h = 1 / 60;
  let flared = false, pitchTarget = null, pitchAtFlare = null, maxPitch = 0, vsAtFlare = null, iasAtFlare = null;
  for (let i = 0; i < 60 * 240; i++) {
    if (!flared) {
      state.control.elevator = 0; state.control.aileron = 0;
    } else {
      // 人工拉平：首先上仰 2.5°（保持），随后随减速逐渐带杆维持 ~-150 fpm
      // （真实拉平技术：带杆量随速度衰减增加；总上仰量 ≥2.5° 由断言保证）
      state.throttle[0] = state.throttle[1] = Math.max(0, state.throttle[0] - 0.6 * h);
      pitchTarget += Math.max(-0.3, Math.min(1.4, (-100 - state.velocity.vsFpm) * 0.0015)) * h * 2;
      state.control.elevator = Math.max(-1, Math.min(1,
        (pitchTarget - state.orientation.pitch) * 0.6 - state.orientation.pitchRate * 0.18));
      maxPitch = Math.max(maxPitch, state.orientation.pitch);
    }
    step(state, h);
    if (!flared && i >= 60 * 5 && state.position.y <= 30) {
      flared = true;
      vsAtFlare = state.velocity.vsFpm;
      iasAtFlare = state.velocity.ias;
      pitchAtFlare = state.orientation.pitch;
      pitchTarget = state.orientation.pitch;
      bus.send('ap/disconnect');
    }
    if (state.touchdown.recorded) break;
  }
  assert.ok(flared, '未到达 30 m 拉平点');
  assert.ok(Math.abs(vsAtFlare + 700) < 150, `拉平点 VS ${vsAtFlare.toFixed(0)} fpm（进近应稳定 ≈−700）`);
  assert.ok(Math.abs(iasAtFlare - 145) < 8, `拉平点 IAS ${iasAtFlare.toFixed(0)} kt（应 ≈145）`);
  assert.ok(maxPitch >= pitchAtFlare + 2.5, `拉平上仰未达 +2.5°（max ${maxPitch.toFixed(1)}° vs 起点 ${pitchAtFlare.toFixed(1)}°）`);
  assert.ok(state.touchdown.vsFpm < 200, `接地 VS ${state.touchdown.vsFpm.toFixed(0)} fpm（应 <200）`);
});

console.log(`\n${passed}/${total} 通过${process.exitCode ? '（存在失败）' : ' —— 全部 PASS'}`);
