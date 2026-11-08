/**
 * input.js — 命令总线 + 键盘映射。
 *
 * 命令总线：所有对飞机的操控一律 bus.send(name, ...args)（同步生效）。
 * 后续单元（驾驶舱 MCP 面板、险情剧本、菜单）只允许通过总线操控，
 * 禁止直接改 state（除只读）。
 *
 * 命令总表（详见 docs/kernel-api.md）：
 *   throttle/set v|[l,r]        throttle/nudge dv
 *   flaps/set idx               flaps/up / flaps/down
 *   gear/up / gear/down / gear/toggle / gear/manualRelease
 *   spoilers/arm bool           spoilers/toggle
 *   reverse/set v               reverse/toggle
 *   trim/nudge dv               brakes/set v|[l,r]     brakes/park
 *   autobrake/set level         control/elevator|aileron|rudder v
 *   ap/cmd / ap/disconnect      ap/hdg deg  ap/alt ft  ap/vs fpm  ap/spd kt  ap/app
 *   engine/start i(0|1|2)       engine/stop i
 *   fuel/pump tank on           fuel/crossfeed on
 *   antiIce/toggle which        wipers level            apu/toggle
 *   fire/extinguish i
 *
 * 键盘映射（见 KEYMAP）：
 *   ↑/↓ 俯仰（↓=拉杆）  ←/→ 滚转      PgUp/PgDn 或 +/− 油门
 *   F 收襟翼一档   V 放襟翼一档   G 起落架   Shift+G 人工重力放出
 *   B 刹车（按住） Shift+B 停留刹车
 *   / 扰流板   Shift+/ 扰流板预位
 *   , 配平机头向下   . 配平机头向上（'[' ']' 同）
 *   R 反推          E 启动双发   Shift+E 关车
 *   Ctrl+G AP CMD   Z HDG SEL... （MCP 数值用 PFD 单元的旋钮，键盘给默认动作）
 *   I 发动机防冰    W 雨刷循环   Shift+A 自动刹车循环   P 暂停
 */

import { clamp, wrap360 } from './math.js';
import { apToggle, apDisconnect, apEngage, apArmApp } from './autopilot.js';
import { createDamageAPI } from './damage.js';

/* =========================================================
 * 命令总线
 * ========================================================= */

/**
 * 创建绑定状态树的命令总线。
 * @param {Object} state createSimState() 产出的状态树
 * @returns {{send:Function, has:Function, list:Function, damageAPI:Object}}
 */
export function createCommandBus(state) {
  const handlers = {
    /* ---- 油门 ---- */
    'throttle/set': (v) => {
      if (Array.isArray(v)) {
        state.throttle[0] = clamp(v[0], 0, 1);
        state.throttle[1] = clamp(v[1], 0, 1);
      } else {
        state.throttle[0] = clamp(v, 0, 1);
        state.throttle[1] = clamp(v, 0, 1);
      }
      if (state.ap.modes.spd) state.ap.modes.spd = false; // 人工推油门断开 AT
    },
    'throttle/nudge': (dv) => {
      const d = clamp(dv, -0.2, 0.2);
      state.throttle[0] = clamp(state.throttle[0] + d, 0, 1);
      state.throttle[1] = clamp(state.throttle[1] + d, 0, 1);
      if (state.ap.modes.spd) state.ap.modes.spd = false;
    },

    /* ---- 襟翼 ---- */
    'flaps/set': (idx) => { state.flaps.index = clamp(Math.round(idx), 0, 7); },
    'flaps/up': () => { state.flaps.index = clamp(state.flaps.index - 1, 0, 7); },
    'flaps/down': () => { state.flaps.index = clamp(state.flaps.index + 1, 0, 7); },

    /* ---- 起落架 ---- */
    'gear/up': () => { state.gear.handleDown = false; },
    'gear/down': () => { state.gear.handleDown = true; },
    'gear/toggle': () => { state.gear.handleDown = !state.gear.handleDown; },
    'gear/manualRelease': () => { state.gear.manualRelease = true; },

    /* ---- 扰流板 ---- */
    'spoilers/arm': (on = true) => { state.spoilers.armed = !!on; },
    'spoilers/toggle': () => {
      if (state.ground.onGround) {
        state.spoilers.armed = !state.spoilers.armed;
      } else {
        state.spoilers.commandDeploy = !state.spoilers.commandDeploy;
      }
    },

    /* ---- 反推 ---- */
    'reverse/set': (v) => {
      const r = clamp(v, 0, 1);
      state.reverse[0] = r; state.reverse[1] = r;
    },
    'reverse/toggle': () => {
      const r = state.reverse[0] > 0 ? 0 : 1;
      state.reverse[0] = r; state.reverse[1] = r;
    },

    /* ---- 配平 / 刹车 ---- */
    'trim/nudge': (dv) => {
      state.trim.stabilizer = clamp(state.trim.stabilizer + clamp(dv, -0.05, 0.05), -1, 1);
      state.trim.trimWheelMoving = true;
    },
    'brakes/set': (v) => {
      if (Array.isArray(v)) {
        state.ground.brakes[0] = clamp(v[0], 0, 1);
        state.ground.brakes[1] = clamp(v[1], 0, 1);
      } else {
        state.ground.brakes[0] = clamp(v, 0, 1);
        state.ground.brakes[1] = clamp(v, 0, 1);
      }
      if (state.ground.brakes[0] > 0.05) state.ground.parkingBrake = false;
    },
    'brakes/park': () => {
      state.ground.parkingBrake = !state.ground.parkingBrake;
      if (state.ground.parkingBrake) { state.ground.brakes[0] = 1; state.ground.brakes[1] = 1; }
      else { state.ground.brakes[0] = 0; state.ground.brakes[1] = 0; }
    },
    'autobrake/set': (level) => {
      const ok = ['OFF', '1', '2', '3', '4', 'MAX'];
      state.ground.autobrake = ok.includes(level) ? level : 'OFF';
    },

    /* ---- 操纵面（-1..1） ---- */
    'control/elevator': (v) => { state.control.elevator = clamp(v, -1, 1); },
    'control/aileron': (v) => { state.control.aileron = clamp(v, -1, 1); },
    'control/rudder': (v) => { state.control.rudder = clamp(v, -1, 1); },

    /* ---- 自动驾驶 ---- */
    'ap/cmd': () => { apToggle(state); },
    'ap/disconnect': () => { apDisconnect(state); },
    'ap/engage': () => { apEngage(state); },
    'ap/hdg': (deg) => { state.ap.targets.hdg = wrap360(deg); state.ap.modes.hdgSel = true; },
    'ap/alt': (ft) => {
      state.ap.targets.alt = ft;
      state.ap.modes.altSel = true;
      state.ap.modes.altHold = false;
    },
    'ap/vs': (fpm) => {
      state.ap.targets.vs = clamp(fpm, -3000, 3000);
      state.ap.modes.vs = true;
      state.ap.modes.altHold = false;
      state.ap.modes.altSel = false;
    },
    'ap/spd': (kt) => {
      state.ap.targets.ias = clamp(kt, 100, 340);
      state.ap.modes.spd = true;
      state.ap.atArmed = true;
      state.ap._atThrottle = state.throttle[0];
    },
    'ap/app': () => { apArmApp(state); },

    /* ---- 发动机 ---- */
    'engine/start': (i = 2) => {
      const list = i === 2 ? [0, 1] : [i];
      for (const idx of list) {
        const e = state.engines[idx];
        if (e && !e.running && e.startState !== 'START' && state.electrical.busPowered) {
          e.startState = 'START';
          e.startTimerS = 0;
        }
      }
    },
    'engine/stop': (i = 2) => {
      const list = i === 2 ? [0, 1] : [i];
      for (const idx of list) {
        const e = state.engines[idx];
        if (e) { e.running = false; e.startState = 'OFF'; }
      }
    },

    /* ---- 燃油 ---- */
    'fuel/pump': (tank, on = true) => {
      if (tank in state.fuel.pumps) state.fuel.pumps[tank] = !!on;
    },
    'fuel/crossfeed': (on = true) => { state.fuel.crossfeed = !!on; },

    /* ---- 防冰 / 雨刷 / APU / 灭火 ---- */
    'antiIce/toggle': (which = 'engine') => {
      if (which === 'wings') state.ice.wingsAntiIce = !state.ice.wingsAntiIce;
      else state.ice.antiIceOn = !state.ice.antiIceOn;
    },
    'wipers': (level = 0) => { state._wipers = clamp(level, 0, 2); },
    'apu/toggle': () => { state.electrical.apuOn = !state.electrical.apuOn; },
    'fire/extinguish': (i) => {
      if (typeof i === 'number') damage.extinguishEngineFire(i);
      else if (state.fire.cabin) state.fire.cabin = false;
    },
  };

  const damage = createDamageAPI(state);

  return {
    /** 执行命令：bus.send('throttle/set', 0.8) */
    send(name, ...args) {
      const fn = handlers[name];
      if (!fn) {
        console.warn(`[bus] unknown command: ${name}`);
        return false;
      }
      fn(...args);
      return true;
    },
    has: (name) => name in handlers,
    list: () => Object.keys(handlers),
    damage, // 险情单元入口：bus.damage.engineFail(0) 等
  };
}

/* =========================================================
 * 键盘输入
 * ========================================================= */

/** 按键 → 语义动作表（持续按住的键走轴更新；单发键走命令） */
export const KEYMAP = Object.freeze({
  ArrowUp: 'pitch:push',        // 推杆（机头向下）
  ArrowDown: 'pitch:pull',      // 拉杆（机头向上）
  ArrowLeft: 'roll:left',
  ArrowRight: 'roll:right',
  PageUp: 'throttle:up',
  PageDown: 'throttle:down',
  '+': 'throttle:up',
  '=': 'throttle:up',
  '-': 'throttle:down',
  _: 'throttle:down',
  f: 'flaps:up',
  F: 'flaps:up',
  v: 'flaps:down',
  V: 'flaps:down',
  g: 'gear:toggle',
  G: 'gear:manual',
  b: 'brakes:hold',
  B: 'brakes:park',
  '/': 'spoilers:toggle',
  '?': 'spoilers:arm',
  ',': 'trim:down',
  '.': 'trim:up',
  '[': 'trim:down',
  ']': 'trim:up',
  r: 'reverse:toggle',
  R: 'reverse:toggle',
  e: 'engine:start',
  E: 'engine:stop',
  i: 'antiIce:toggle',
  I: 'antiIce:toggle',
  w: 'wipers:cycle',
  W: 'wipers:cycle',
  a: 'autobrake:cycle',
  A: 'autobrake:cycle',
  p: 'pause',
  P: 'pause',
});

/** 键盘控制器：createKeyboardInput(bus) → { attach, detach, update, paused } */
export function createKeyboardInput(bus) {
  const held = new Set();
  let paused = false;
  let wipersLevel = 0;
  const AUTOBRAKE_LEVELS = ['OFF', '1', '2', '3', '4', 'MAX'];
  let abIdx = 0;
  // 轴平滑值（手感惯性）
  const axes = { elevator: 0, aileron: 0, rudder: 0 };

  function onKey(e, down) {
    const key = e.key;
    // Ctrl+G = AP CMD（在 keydown 分支单独处理）
    if (down && key === 'g' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      bus.send('ap/cmd');
      return;
    }
    const action = KEYMAP[key];
    if (!action) return;
    e.preventDefault();
    if (action === 'brakes:hold') {
      if (down) bus.send('brakes/set', 1);
      else bus.send('brakes/set', 0);
      return;
    }
    if (action === 'pause') { if (down) paused = !paused; return; }
    if (down) held.add(action);
    else held.delete(action);

    if (!down) return;
    // 单发命令
    switch (action) {
      case 'flaps:up': bus.send('flaps/up'); break;
      case 'flaps:down': bus.send('flaps/down'); break;
      case 'gear:toggle': bus.send('gear/toggle'); break;
      case 'gear:manual': bus.send('gear/manualRelease'); break;
      case 'brakes:park': bus.send('brakes/park'); break;
      case 'spoilers:toggle': bus.send('spoilers/toggle'); break;
      case 'spoilers:arm': bus.send('spoilers/arm'); break;
      case 'reverse:toggle': bus.send('reverse/toggle'); break;
      case 'engine:start': bus.send('engine/start', 2); break;
      case 'engine:stop': bus.send('engine/stop', 2); break;
      case 'antiIce:toggle': bus.send('antiIce/toggle', 'engine'); break;
      case 'wipers:cycle': wipersLevel = (wipersLevel + 1) % 3; bus.send('wipers', wipersLevel); break;
      case 'autobrake:cycle': {
        abIdx = (abIdx + 1) % AUTOBRAKE_LEVELS.length;
        bus.send('autobrake/set', AUTOBRAKE_LEVELS[abIdx]);
        break;
      }
      default: break; // 轴类动作由 update() 处理
    }
  }

  const onKeyDown = (e) => onKey(e, true);
  const onKeyUp = (e) => onKey(e, false);
  const onBlur = () => { held.clear(); bus.send('brakes/set', 0); };

  return {
    /** 绑定到 window（默认）或指定目标 */
    attach(target = window) {
      target.addEventListener('keydown', onKeyDown);
      target.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    },
    detach(target = window) {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
    /** 每帧调用：持续键 → 操纵轴（带接近速率的手感惯性） */
    update(dt, state) {
      const RATE = 2.5;   // 轴值变化速率 /s
      const RELEASE = 3.0; // 松键回中速率 /s
      const target = { elevator: 0, aileron: 0, rudder: 0 };
      if (held.has('pitch:pull')) target.elevator = 1;
      if (held.has('pitch:push')) target.elevator = -1;
      if (held.has('roll:right')) target.aileron = 1;
      if (held.has('roll:left')) target.aileron = -1;
      if (held.has('throttle:up') || held.has('throttle:down')) {
        const d = (held.has('throttle:up') ? 1 : -1) * 0.4 * dt;
        bus.send('throttle/nudge', d);
      }
      if (held.has('trim:up')) bus.send('trim/nudge', 0.06 * dt);
      if (held.has('trim:down')) bus.send('trim/nudge', -0.06 * dt);
      // 向目标逼近（手感惯性）
      for (const k of ['elevator', 'aileron']) {
        const t = target[k];
        const cur = axes[k];
        const rate = t === 0 ? RELEASE : RATE;
        axes[k] = cur + clamp(t - cur, -rate * dt, rate * dt);
      }
      // 方向舵键盘：未绑定独立键，随滚转轻微联动（简化，蹬舵可由 Z/X 扩展）
      if (state && !state.ap.engaged) {
        bus.send('control/elevator', axes.elevator);
        bus.send('control/aileron', axes.aileron);
      } else if (state) {
        // AP 接通时人工压杆 → 断开 AP（真实感受）
        if (Math.abs(axes.elevator) > 0.25 || Math.abs(axes.aileron) > 0.25) {
          bus.send('ap/disconnect');
          bus.send('control/elevator', axes.elevator);
          bus.send('control/aileron', axes.aileron);
        }
      }
    },
    get paused() { return paused; },
    set paused(v) { paused = v; },
  };
}
