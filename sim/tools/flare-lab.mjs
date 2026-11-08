/**
 * dev/flare-lab.mjs — 拉平（flare）实验台：复现/调参用，不属于交付测试。
 * 用法：node dev/flare-lab.mjs
 */
import { createSimState, createCommandBus, substepSystems, stepAutopilot } from '../src/kernel/index.js';
import { substep as fm } from '../src/kernel/flight-model.js';
import { rad2deg, deg2rad } from '../src/kernel/math.js';

const KT = 0.514444;
export function step(state, dt) {
  const h = 1 / 120; let t = 0;
  while (t < dt - 1e-9) { substepSystems(state, h); stepAutopilot(state, h); fm(state, h); t += h; }
  state.time += dt;
}

export function flareRun({ pitchUp = 2.5, throttle = 0.78, trim = (260-145)/130, verbose = false } = {}) {
  const state = createSimState({ fuelKg: 8000, payloadKg: 15600 }); // 65 t
  const bus = createCommandBus(state);
  bus.send('flaps/set', 6);
  bus.send('throttle/set', throttle);
  state.trim.stabilizer = trim;
  state.ground.onGround = false;
  state.gear.handleDown = true; state.gear.position = 1;
  state.flaps.angle = 30;
  const V = 145 * KT, g3 = deg2rad(3);
  state.velocity.vx = V * Math.cos(g3);
  state.velocity.vy = -V * Math.sin(g3);
  state.position.x = -3000;
  state.position.y = 3000 * Math.tan(g3) + 15;
  const clNeed = state.massKg * 9.80665 / (0.5 * 1.225 * V * V * 125);
  state.orientation.pitch = -3 + ((clNeed - 0.6125) / 5.0) * 180 / Math.PI;
  let pitchTarget = state.orientation.pitch;
  // AP 接通：VS 方式保持 3° 滑道、SPD 保持 145 kt
  bus.send('ap/cmd');
  bus.send('ap/vs', -700);
  bus.send('ap/spd', 145);
  const h = 1 / 60;
  let flared = false, maxPitch = 0, vsAtFlare = null, iasAtFlare = null;
  for (let i = 0; i < 60 * 240; i++) {
    if (!flared) {
      // 稳定进近：内核 AP（VS −700 fpm ≈ 3° 滑道 + SPD 145 kt 自动油门）
      state.control.elevator = 0; state.control.aileron = 0;
    } else {
      // 人工拉平：俯仰上仰 pitchUp° 并保持（PD）+ 收油门至慢车（标准拉平技术）
      state.throttle[0] = state.throttle[1] = Math.max(0, state.throttle[0] - 0.6 * h);
      // 与 T17 一致：先上仰 pitchUp°，随后随减速带杆维持 ~-100 fpm
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
      bus.send('ap/disconnect');           // 断开 AP，转人工拉平
      pitchTarget = state.orientation.pitch;
    }
    if (verbose && i % (60 * 2) === 0) {
      console.log((i / 60).toFixed(0), 's y', state.position.y.toFixed(1), 'vs', state.velocity.vsFpm.toFixed(0),
        'ias', state.velocity.ias.toFixed(0), 'pitch', state.orientation.pitch.toFixed(2), 'aoa', state.velocity.aoa.toFixed(1),
        'elev', state.control.elevator.toFixed(2), flared ? 'FLARE' : '');
    }
    if (state.touchdown.recorded) {
      return { vsFpm: state.touchdown.vsFpm, maxPitch, pitchTarget0: pitchTarget, vsAtFlare, iasAtFlare, iasTd: state.touchdown.iasKt, ok: true };
    }
  }
  return { vsFpm: null, maxPitch, vsAtFlare, iasAtFlare, ok: false, agl: state.agl, vs: state.velocity.vsFpm, ias: state.velocity.ias };
}

// 直接运行时执行
if (process.argv[1] && process.argv[1].endsWith('flare-lab.mjs')) {
  for (const up of [2.5]) {
    const r = flareRun({ pitchUp: up, verbose: true });
    console.log(`pitchUp=${up}° →`, r.ok
      ? `接地 VS ${r.vsFpm.toFixed(0)} fpm（拉平点 VS ${r.vsAtFlare?.toFixed(0)}，IAS ${r.iasAtFlare?.toFixed(0)}，maxPitch ${r.maxPitch.toFixed(1)}°）`
      : `未接地：agl ${r.agl?.toFixed(1)} m，vs ${r.vs?.toFixed(0)}，ias ${r.ias?.toFixed(0)}`);
  }
}
