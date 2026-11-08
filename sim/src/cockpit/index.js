/**
 * index.js — 单元 1 驾驶舱总入口。
 *
 * ============================================================
 * 导出合同（uxA 视野修复后，2026-11 —— 供整合层使用）
 * ============================================================
 *   import { createCockpit, cameraPrefs } from './cockpit/index.js';
 *   const cockpit = createCockpit(scene, state, bus, { domElement, camera });
 *   scene.add(cockpit.group)（或挂到飞机 Object3D，见下）。
 *
 *   1) 相机参数（整合层按它建相机）：
 *        cameraPrefs = { fov: 76, near: 0.02, far: 60000 }
 *        cameraPrefs.lookDownRad = -0.20   // setLookPitch 缺省下视角
 *        cameraPrefs.lookSmoothS = 0.15    // 下视/回平平滑时间常数（秒）
 *   2) 机长眼位：cockpit.cameraAnchor（Object3D，含平视 sightline -0.17 rad）。
 *      每帧：anchor.updateWorldMatrix(true,false) 后直接用其世界矩阵驱动相机
 *      （position.setFromMatrixPosition + quaternion.setFromRotationMatrix）。
 *      眼位本身保持该平视 sightline；更深的下视用下面的 setLookPitch。
 *   3) 临时下视（"按住某键低头看仪表、松开回平视"的平滑过渡，由整合层挂键）：
 *        cockpit.setLookPitch(pitchRad)   // 开始向下看，缺省 cameraPrefs.lookDownRad ≈ -0.20
 *        cockpit.resetLookPitch()         // 平滑回平视
 *      内部以 0.15 s 指数平滑过渡叠加到 cameraAnchor 的俯仰上（眼位常量不变），
 *      每帧 cockpit.update(dt) 驱动动画。建议键位行为：keydown → setLookPitch()，keyup → resetLookPitch()。
 *   4) 座舱照明模式（内核 state 无时刻字段；world 有 hour 但对 cockpit 不可见，
 *      故由整合层按世界光照状态调用）：
 *        cockpit.setLightingMode('day' | 'dusk' | 'night')
 *      'day'   白天：日光自风挡洒入仪表台，面板有明暗层次
 *      'dusk'  黄昏：低日光 + 屏幕自发光抬升
 *      'night' 夜间：面板泛光 + 仪表自发光平衡
 *      模式间约 0.4 s 平滑过渡。光源全部是 cockpit.group 内的 SpotLight/PointLight
 *      （带距离衰减、跟随飞机，不外泄照亮世界）。
 *      只读查询：cockpit.lightingMode（当前目标模式）。
 *
 * 其余接口：
 *   createCockpit(scene, state, bus, opts?) →
 *     { group, update(dt), cameraAnchor, clickables, displays, anim,
 *       setLookPitch, resetLookPitch, setLightingMode, lightingMode, _dispose }
 *   group 局部系：+x 右翼 / +y 上 / -z 机头，原点在驾驶舱地板中线。
 *   每帧调用 cockpit.update(dtReal)（内部 15 Hz 刷新 Canvas 仪表 + 舵面/手柄/照明联动）。
 */

import * as THREE from 'three';
import { buildCockpit } from './geometry.js';
import { attachPointer } from './interactions.js';
import { clamp } from './palette.js';

const DISPLAY_HZ = 15;          // Canvas 纹理刷新限频（性能保护）
const WIPER_SWEEP_S = 2.2;      // 雨刷单摆周期

/**
 * 相机/视线参数（整合层读取；详见顶部导出合同）。
 * fov 76°：平视时地平线居画面上 ~40%、六屏+MCP+CDU 完整入画的最小广角（uxA2 2026-11）。
 */
export const cameraPrefs = Object.freeze({
  fov: 76,
  near: 0.02,
  far: 60000,
  lookDownRad: -0.20,   // setLookPitch 缺省下视角（平视已见全套仪表，扫视用于细读中央台/CDU）
  lookSmoothS: 0.15,    // 下视/回平平滑时间常数（秒）
});

/** 座舱照明三态预设（几何内 4 盏局部光源的强度，three r160 物理光单位 candela） */
const LIGHT_PRESETS = {
  day:   { sunSpot: 22.0, cabinFill: 13.0, panelGlow: 1.2, nightFlood: 0.0 },
  dusk:  { sunSpot: 4.5,  cabinFill: 3.2,  panelGlow: 3.8, nightFlood: 1.6 },
  night: { sunSpot: 0.0,  cabinFill: 1.6,  panelGlow: 5.0, nightFlood: 3.0 },
};

/**
 * 创建驾驶舱。
 * @param {THREE.Scene} scene 场景（仅用于挂事件探测，几何都在返回的 group 内）
 * @param {Object} state 内核状态树（只读，docs/kernel-api.md §3）
 * @param {Object} bus 命令总线（docs/kernel-api.md §4）
 * @param {Object} [opts]
 * @param {HTMLElement} [opts.domElement] 接收点击的 DOM（默认 document.body）
 * @param {THREE.PerspectiveCamera} [opts.camera] 真实相机（点击 Raycaster 用；缺省用眼位回退相机）
 * @param {boolean} [opts.enablePointer=true] 是否挂载点击交互
 * @returns {{group: THREE.Group, update: Function, cameraAnchor: THREE.Object3D, clickables: THREE.Mesh[],
 *            displays: Object, anim: Object, setLookPitch: Function, resetLookPitch: Function,
 *            setLightingMode: Function, lightingMode: string, _dispose: Function}}
 */
export function createCockpit(scene, state, bus, opts = {}) {
  void scene;
  const built = buildCockpit();
  const { group, cameraAnchor, eyePitch, clickables, displays, anim, lights } = built;

  /* ---------- 告警确认（本地 UI 位；内核无 acknowledge 命令，点击只熄灯不改仿真） ---------- */
  const ack = Object.create(null);
  let wiperLevel = 0; // 内核 wipers 状态在下划线内部字段（禁止读），本地跟踪自己发出的命令
  const ui = {
    ackAll() {
      if (state.warnings.masterWarning) ack.masterWarning = state.time;
      if (state.warnings.masterCaution) ack.masterCaution = state.time;
      for (const w of state.warnings.active) ack[w] = state.time;
      console.log('[cockpit] 告警确认（仅熄灯，不改仿真状态）');
    },
    onCommand(cmd, args) {
      if (cmd === 'wipers') wiperLevel = args[0] ?? 0;
    },
  };
  const extras = { iasRate: 0, now: 0, wiperLevel: 0, acc: 0, ack };

  /* ---------- 点击交互（需要真实相机做 Raycaster；未提供则用眼位处的回退相机） ---------- */
  const dom = opts.domElement ?? (typeof document !== 'undefined' ? document.body : null);
  const rayCamera = opts.camera ?? new THREE.PerspectiveCamera(cameraPrefs.fov, 16 / 9, cameraPrefs.near, 60);
  let usingFallbackCam = !opts.camera;
  let disposePointer = null;
  if (dom && opts.enablePointer !== false && typeof dom.addEventListener === 'function') {
    disposePointer = attachPointer(dom, rayCamera, clickables, state, bus, ui);
  }

  /* ---------- 显示端派生量（仅用于趋势矢量，不回写仿真） ---------- */
  let prevIas = state.velocity.ias;
  let iasRate = 0;

  /* ---------- 本地动画状态 ---------- */
  let wiperPhase = 0;
  let lastTrim = state.trim.stabilizer;
  let trimSpin = 0;

  /* ---------- 临时下视（setLookPitch）：平滑叠加在平视 sightline 上 ---------- */
  let lookTarget = 0;
  let lookCur = 0;

  /* ---------- 座舱照明模式（day/dusk/night，0.4 s 平滑过渡） ---------- */
  let lightMode = 'day';
  let lightCur = { ...LIGHT_PRESETS.day };

  /** 开始临时下视（缺省 cameraPrefs.lookDownRad ≈ -0.28 rad）。 */
  function setLookPitch(pitchRad = cameraPrefs.lookDownRad) {
    lookTarget = clamp(pitchRad, -0.9, 0.35);
  }
  /** 平滑回平视。 */
  function resetLookPitch() {
    lookTarget = 0;
  }
  /**
   * 设置座舱照明模式。
   * @param {'day'|'dusk'|'night'} mode
   */
  function setLightingMode(mode) {
    lightMode = LIGHT_PRESETS[mode] ? mode : 'day';
  }

  /* =========================================================
   * 每帧更新：仪表限频刷新 + 操纵/手柄/告警灯/视线/照明联动
   * ========================================================= */
  function update(dt) {
    const dtc = Math.min(Math.max(dt, 0), 0.25);
    extras.now += dtc;

    // --- 仪表刷新（15 Hz） ---
    let refreshed = false;
    if (dtc > 0) {
      const inst = (state.velocity.ias - prevIas) / dtc;
      iasRate = iasRate * 0.7 + inst * 0.3;   // 显示平滑
      prevIas = state.velocity.ias;
    }
    extras.acc = (extras.acc ?? 0) + dtc;
    extras.wiperLevel = wiperLevel;
    if (extras.acc >= 1 / DISPLAY_HZ) {
      extras.acc = 0;
      refreshed = true;
      extras.iasRate = iasRate;
      displays.pfd.draw(state, extras);
      displays.pfdFO.draw(state, extras);
      displays.nd.draw(state, extras);
      displays.ndFO.draw(state, extras);
      displays.upper.draw(state, extras);
      displays.lower.draw(state, extras);
      displays.mcp.draw(state, extras);
      displays.overhead.draw(state, extras);
      displays.pedestal.draw(state, extras);
      displays.cdu.draw(state, extras);
      displays.annL.draw(state, extras);
      displays.annR.draw(state, extras);
    }

    /* ---------- 临时下视平滑（眼位 pitch 常量 + 叠加偏移） ---------- */
    if (dtc > 0) {
      lookCur += (lookTarget - lookCur) * (1 - Math.exp(-dtc / cameraPrefs.lookSmoothS));
    }
    cameraAnchor.rotation.x = eyePitch + lookCur;

    /* ---------- 座舱照明平滑过渡 ---------- */
    const preset = LIGHT_PRESETS[lightMode];
    if (dtc > 0) {
      const k = 1 - Math.exp(-dtc / 0.4);
      for (const key of Object.keys(lightCur)) {
        lightCur[key] += (preset[key] - lightCur[key]) * k;
      }
    }
    lights.sunSpot.intensity = lightCur.sunSpot;
    lights.cabinFill.intensity = lightCur.cabinFill;
    lights.panelGlow.intensity = lightCur.panelGlow;
    lights.nightFlood.intensity = lightCur.nightFlood;

    /* ---------- 操纵杆：随 control 输入俯仰/滚转 ---------- */
    const ail = clamp(state.control.aileron, -1, 1);
    const ele = clamp(state.control.elevator, -1, 1);
    anim.yokeC.wheel.rotation.z = -ail * 1.6;
    anim.yokeC.col.rotation.x = ele * 0.22;
    anim.yokeF.wheel.rotation.z = -ail * 1.6;
    anim.yokeF.col.rotation.x = ele * 0.22;

    /* ---------- 油门杆 / 反推手柄（随 throttle / reverse 移动） ---------- */
    const thr = (state.throttle[0] + state.throttle[1]) / 2;
    const idleA = 0.95, fullA = -0.30;
    const ang = idleA - clamp(thr, 0, 1) * (idleA - fullA);
    anim.throttleL.rotation.x += (ang - anim.throttleL.rotation.x) * Math.min(1, dtc * 10);
    anim.throttleR.rotation.x = anim.throttleL.rotation.x;
    const rev = clamp((state.reverse[0] + state.reverse[1]) / 2, 0, 1);
    anim.reverseHandle.rotation.x = -0.5 - rev * 0.5;
    anim.reverseHandle.position.z = 0.035 + rev * 0.018;

    /* ---------- 襟翼手柄（档位联动） ---------- */
    const flapAng = 0.35 + (state.flaps.index / 7) * 1.25;
    anim.flapLever.rotation.x += (flapAng - anim.flapLever.rotation.x) * Math.min(1, dtc * 8);

    /* ---------- 起落架手柄（三绿位置） ---------- */
    const gearAng = state.gear.handleDown ? 1.5 : -0.6;
    anim.gearLever.rotation.x += (gearAng - anim.gearLever.rotation.x) * Math.min(1, dtc * 8);

    /* ---------- 配平轮（随 trim.stabilizer 变化滚动） ---------- */
    const dTrim = state.trim.stabilizer - lastTrim;
    lastTrim = state.trim.stabilizer;
    trimSpin += dTrim * 14;
    anim.trimWheelL.rotation.x = trimSpin;
    anim.trimWheelR.rotation.x = trimSpin;

    /* ---------- 雨刷（停机位贴风挡底缘横置、臂尖指向外侧窗柱；档位本地跟踪） ---------- */
    const PARK_L = 1.63, PARK_R = -1.63; // 停机位：臂沿玻璃底缘横置（π/2 微垂，贴缘不穿视野）
    if (wiperLevel > 0) {
      const speed = wiperLevel === 1 ? 0.45 : 1.0; // INT 慢摆 / LOW-HIGH 连续
      wiperPhase += dtc * speed * Math.PI * 2 / WIPER_SWEEP_S;
      const a = Math.sin(wiperPhase) * 0.70;
      anim.wiperL.rotation.z = PARK_L + a;
      anim.wiperR.rotation.z = PARK_R - a;
    } else {
      anim.wiperL.rotation.z += (PARK_L - anim.wiperL.rotation.z) * Math.min(1, dtc * 4);
      anim.wiperR.rotation.z += (PARK_R - anim.wiperR.rotation.z) * Math.min(1, dtc * 4);
    }

    /* ---------- 告警灯（主警告红 / 主注意琥珀，闪烁 + 确认后常灭） ---------- */
    const blinkOn = (extras.now % 0.5) < 0.3;
    const mwOn = state.warnings.masterWarning && (ack.masterWarning === undefined || blinkOn);
    const mcOn = state.warnings.masterCaution && (ack.masterCaution === undefined || blinkOn);
    anim.lampW[0].color.setHex(mwOn ? 0xff2418 : 0x1a0505);
    anim.lampW[1].color.setHex(mcOn ? 0xffa018 : 0x1a1205);
    // 警告解除后自动复位确认位
    if (!state.warnings.masterWarning) ack.masterWarning = undefined;
    if (!state.warnings.masterCaution) ack.masterCaution = undefined;
    for (const k of Object.keys(ack)) {
      if (k !== 'masterWarning' && k !== 'masterCaution' && !state.warnings.active.includes(k)) {
        delete ack[k];
      }
    }

    /* ---------- 回退点击相机同步到机长眼位 ---------- */
    if (usingFallbackCam) {
      cameraAnchor.updateWorldMatrix(true, false);
      rayCamera.matrixWorld.copy(cameraAnchor.matrixWorld);
      rayCamera.matrix.copy(cameraAnchor.matrixWorld);
      const aspect = dom && dom.clientWidth ? dom.clientWidth / Math.max(1, dom.clientHeight) : 16 / 9;
      if (Math.abs(rayCamera.aspect - aspect) > 0.01) {
        rayCamera.aspect = aspect;
        rayCamera.updateProjectionMatrix();
      } else {
        rayCamera.updateMatrixWorld();
      }
    }
  }

  return {
    group, update, cameraAnchor, clickables,
    displays, anim,
    setLookPitch, resetLookPitch, setLightingMode,
    get lightingMode() { return lightMode; },
    _dispose: () => disposePointer && disposePointer(),
  };
}
