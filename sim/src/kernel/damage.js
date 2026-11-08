/**
 * damage.js — 损伤 / 处置钩子（后续"险情剧本引擎"单元的唯一入口）。
 *
 * 用法：const damage = createDamageAPI(state); damage.engineFire(0);
 * 所有钩子只改状态，不改警告（警告由 index.js 的警告汇总每步统一判定）；
 * 只改状态，不直接改控制——处置（灭火、释压下降等）由玩家/AP 完成。
 *
 * 签名总表（详见 docs/kernel-api.md）：
 *   engineFail(i)              双发之一熄车失效
 *   engineFire(i)              发动机火警（推力 15 s 内衰减、EGT 冲高）
 *   extinguishEngineFire(i)    释放灭火瓶：灭火，但该发保持停车
 *   dualEngineFail()           双发全失效（鸟击群等）
 *   hydraulicFail('A'|'B'|'standby')
 *   depressurize()             客舱释压（外流活门全开）
 *   repairPressurization()     增压恢复
 *   pitotBlock(i, on)          皮托管堵塞/疏通
 *   fuelLeak(tank, kgPerS)     燃油泄漏（tank: 'left'|'right'|'center'|null）
 *   flapsJam(index|null)       襟翼卡阻在某档 / 解卡
 *   cabinFire(on)              客舱火警
 *   setIcingConditions(on)     结冰环境（气象）
 *   gearJam(jammed)            起落架卡阻（放不下/收不上）
 */

/**
 * 创建绑定到某状态树的损伤 API。
 * @param {Object} state createSimState() 产出的状态树
 */
export function createDamageAPI(state) {
  return {
    /** 单发失效：i = 0（左）| 1（右） */
    engineFail(i) {
      const e = state.engines[i];
      if (!e) return;
      e.running = false;
      e.startState = 'OFF';
      e.thrustKN = 0;
      e.fuelFlowKgs = 0;
      e.onFire = false;
      state.fire.engines[i] = false;
    },

    /** 发动机火警：推力衰减、EGT 冲高；需关车 + 灭火瓶 */
    engineFire(i) {
      const e = state.engines[i];
      if (!e) return;
      e.onFire = true;
      e.fireExtinguished = false;
      state.fire.engines[i] = true;
    },

    /** 灭火瓶：火焰熄灭；若发动机仍在运行则维持运行（真实处置应先关车） */
    extinguishEngineFire(i) {
      const e = state.engines[i];
      if (!e) return;
      e.onFire = false;
      e.fireExtinguished = true;
      state.fire.engines[i] = false;
    },

    /** 双发全失效（鸟击群 / 燃油耗尽外的双重失效） */
    dualEngineFail() {
      this.engineFail(0);
      this.engineFail(1);
    },

    /** 液压系统失效：sys = 'A' | 'B' | 'standby' */
    hydraulicFail(sys) {
      if (sys === 'A') { state.hydraulics.failedA = true; state.hydraulics.A = 0; }
      else if (sys === 'B') { state.hydraulics.failedB = true; state.hydraulics.B = 0; }
      else if (sys === 'standby') { state.hydraulics.standbyOn = false; state.hydraulics.standby = 0; }
    },

    /** 客舱释压：外流活门全开，舱压向巡航气压高度逼近（≈6000 fpm） */
    depressurize() {
      state.pressurization.outflowOpen = true;
      state.pressurization.outflowRateFpm = 6000;
    },

    /** 增压恢复（处置完成） */
    repairPressurization() {
      state.pressurization.outflowOpen = false;
      state.pressurization.outflowRateFpm = 0;
    },

    /** 皮托管堵塞：i = 0（左）| 1（右），on = 堵塞/疏通 */
    pitotBlock(i, on) {
      if (i === 0) state.pitot.blockedL = !!on;
      else state.pitot.blockedR = !!on;
    },

    /** 燃油泄漏：tank = 'left' | 'right' | 'center'；传 null 停止泄漏 */
    fuelLeak(tank, kgPerS) {
      if (tank === null) {
        state.fuel.leakPerSecond = 0;
        state.fuel.leakTank = null;
      } else {
        state.fuel.leakTank = tank;
        state.fuel.leakPerSecond = kgPerS;
      }
    },

    /** 襟翼卡阻：index = 卡阻档位（0..7，按当前襟翼角就近）；null = 解卡 */
    flapsJam(index) {
      if (index === null) {
        state.flaps.jam = null;
        return;
      }
      const idx = clampIndex(index);
      state.flaps.jam = idx;
      // 手柄收回到卡阻档以内（真实处置：手柄收到卡阻位）
      if (state.flaps.index > idx) state.flaps.index = idx;
    },

    /** 客舱火警 */
    cabinFire(on) {
      state.fire.cabin = !!on;
    },

    /** 结冰环境（气象条件整体切换；含低温与降水倾向） */
    setIcingConditions(on) {
      state.weather.icingConditions = !!on;
      if (on) {
        state.weather.precipitation = state.weather.precipitation === 'none' ? 'snow' : state.weather.precipitation;
        state.weather.tempC = Math.min(state.weather.tempC, -2);
      }
    },

    /** 起落架卡阻（放不下/收不上；true 时液压作动无效） */
    gearJam(jammed) {
      state.gear.jammed = !!jammed;
    },
  };
}

function clampIndex(i) {
  return Math.max(0, Math.min(7, Math.round(i)));
}

/* 便捷的独立函数形式（供偏好自由函数的调用方）——均委托 createDamageAPI */
export const engineFail = (state, i) => createDamageAPI(state).engineFail(i);
export const engineFire = (state, i) => createDamageAPI(state).engineFire(i);
export const extinguishEngineFire = (state, i) => createDamageAPI(state).extinguishEngineFire(i);
export const dualEngineFail = (state) => createDamageAPI(state).dualEngineFail();
export const hydraulicFail = (state, sys) => createDamageAPI(state).hydraulicFail(sys);
export const depressurize = (state) => createDamageAPI(state).depressurize();
export const repairPressurization = (state) => createDamageAPI(state).repairPressurization();
export const pitotBlock = (state, i, on) => createDamageAPI(state).pitotBlock(i, on);
export const fuelLeak = (state, tank, kgPerS) => createDamageAPI(state).fuelLeak(tank, kgPerS);
export const flapsJam = (state, index) => createDamageAPI(state).flapsJam(index);
export const cabinFire = (state, on) => createDamageAPI(state).cabinFire(on);
export const setIcingConditions = (state, on) => createDamageAPI(state).setIcingConditions(on);
export const gearJam = (state, jammed) => createDamageAPI(state).gearJam(jammed);
