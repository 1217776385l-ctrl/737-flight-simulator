# 内核 API 宪法（docs/kernel-api.md）

> 本文档是共享仿真内核（单元 0）对后续四个单元（驾驶舱 / 险情剧本 / 外部世界 / 音效与警告语音 / 结算）的**集成合同**。
> 内核是飞行状态的唯一事实源；仪表、剧本、结算全部只读它、只通过命令总线操控它。

---


## 航向约定（重要，2026-11-08 沉跑道修复后生效）

- 内核 `orientation.heading` 恒为**跑道局部角**：0° = 跑道轴（+x），atan2(z,x) 约定。物理（轮胎锚定/风标/VP）全部在此局部系内。
- 活动跑道的**罗盘**航向存 `state.runway.headingDeg`（整合层在开局与目的地过渡时写入）。
- 罗盘换算只发生在边界：HUD/座舱显示 = local + runway.headingDeg；MCP `ap/hdg` 输入为罗盘，由 main.js wrapBus 换算为局部；风 `windDirDeg` 为罗盘，内核消耗时按 runway.headingDeg 换算为局部；`nav.courseDeg` 为局部 0。
- 世界场景不做几何旋转（scene = 内核局部系）；`worldToAirport/airportToWorld` 为恒等映射。
- 侧风滑跑不出跑道的保证：`applyGroundForces` 轮胎横向锚定（vz→0，上限 μ_side·N）+ 低速段（<15 m/s）航迹向机头收敛供前轮转弯。禁止再引入"航迹追机头"的高速运动学收敛（会与锚定拔河出数十米漂移）。
- 任何新代码禁止把局部角当罗盘用或反向重复换算（双重换算曾把进近航向差推到 15°）。

## 飞行相位机与导航数据契约（main.js，2026-11-08 导航修复后生效）

### 相位机（src/main.js updatePhase）

相位集合与唯一允许的推进方向（单调，只进不退；候选相位需持续 ≥3 s 滞回才提交，防 vs/AGL 抖动横跳）：

```
takeoff → climb → cruise → descent → approach → landing → rollout → ended
```

| 相位 | 判定条件（rawPhase，每仿真帧） |
|---|---|
| `takeoff` | onGround 且未记录过接地（touchdown.recorded=false）；松刹车 IAS>35 即滑跑段 |
| `climb` | 离地且 vsFpm > +300；离地后的兜底段 |
| `cruise` | AGL ≥ 2400 m，或（AGL ≥ 1500 m 且 \|vsFpm\| < 300）——稳定平台；一旦进入不会被打回 climb |
| `descent` | vsFpm < -800 且 AGL > 300（真实下降；微下沉/抖动不触发） |
| `approach` | transitioned（目的地世界已建），或（待飞 <30 km 且 vsFpm < -300 且 AGL < 1800 m） |
| `landing` | AGL < 150 m 且 vsFpm < -100 且待飞 <6 km |
| `rollout` | touchdown.recorded 后 onGround（落地滑跑，绝不再判回 takeoff） |
| `ended` | 结算完成（finishFlight 置位） |

单调规则：任何 index 回跳（如 cruise→takeoff、cruise→climb）直接忽略；跨级前向允许（climb→cruise、cruise→descent、cruise→approach）。
**待飞距离口径**：过渡前（transitioned=false）world.updateNav 写的 `nav.distM/bearingDeg` 指向**出发地**机场，相位判定与导航显示一律用航线余程 `routeRemainingM`；过渡后才用 `nav.distM`。

### `state.nav.guidance`（整合层 → CDU/导航卡契约）

main.js 在 `startFlight`、`transitionToDestination` 时及每帧（6 Hz，world.update 之后）维护：

```js
state.nav.guidance = {
  destId, destName,   // 目的地 IATA 与中文名
  phase, adviceZh,    // 当前相位（上文相位机）与一句话中文建议（navAdvice，与相位严格绑定）
  distKm, brgCompass, // 待飞距离 km 与直飞罗盘方位（局部角 + runway.headingDeg，罗盘口径）
}
```

- `world.updateNav` 不认识该字段不会覆写（它只覆写 courseDeg/distM/bearingDeg 等）；
  但 `distKm/brgCompass` 必须在 world.update 之后重算——过渡前用 routeRemainingM 与出发跑道罗盘航向（无目的地几何的诚实简化）。
- 消费方（src/cockpit/displays.js CDU）只读此块，字段缺失显示 '——'，不做二次换算。

## 0. 铁律（所有后续单元必须遵守）

1. **仪表只读 state，绝不自己推算**。空速带画 `state.velocity.ias`，N1 指针画 `state.engines[i].n1`。
   任何"仪表自己积分/估算"出来的数值都是假仪表（项目第一禁令）。
2. **操控一律走命令总线** `bus.send(name, ...args)`。禁止直接写 `state.throttle = ...`。
   （例外：世界单元写 `state.nav` / `state.terrain` / `state.touchdown.surface` 的"环境数据"字段；
   险情单元只调用 `bus.damage.*` 钩子。）
3. **内核绝不 import three.js**。渲染单元可以 import 内核，反向禁止。
4. 内部字段（`state._acc`、`state._forces`、`state._wind`、`state._iasFrozen`、`state._shearIasHistory`、
   `state._sysAcc`、`state._prevPitotAltM`、`state._wipers`、`state.ap._atThrottle`）以下划线开头，**禁止读写**。
5. 主循环固定步长 1/120 s（`stepSimulation` 内部自动切子步）。渲染帧率与仿真解耦。

---

## 1. 导入方式

```js
import {
  createSimState, createCommandBus, stepSimulation,
  getVSpeeds, getVref, stallIasKt,
  // 只读纯函数（画速度带/性能计算可用）：
  isaAtmosphere, clMaxForFlaps, liftCoef, dragCoef, inducedDragFactor,
  thrustPerEngineKN, fuelFlowPerEngineKgs, bodyAxes,
} from './kernel/index.js';
```

- `src/kernel/state.js` — 状态树定义
- `src/kernel/flight-model.js` — 气动 + 推进 + 地面 + 积分（120 Hz 子步）
- `src/kernel/systems.js` — 燃油/液压/电气/增压/皮托/结冰/引擎动力学
- `src/kernel/autopilot.js` — AP/AT（HDG SEL、ALT HOLD/SEL、VS、SPD、APP）
- `src/kernel/damage.js` — 损伤钩子（险情单元唯一入口）
- `src/kernel/input.js` — 命令总线 + 键盘映射
- `src/kernel/vspeeds.js` — V1/VR/V2/Vref 重量插值表
- `src/kernel/index.js` — 汇总导出 + `stepSimulation` 固定时序
- `src/kernel/math.js` — 单位换算与数值工具（deg2rad、kt2ms、m2ft、ms2fpm、wrap180…）

**典型主循环**（参考 `src/main.js`）：

```js
const state = createSimState();
const bus = createCommandBus(state);
const keyboard = createKeyboardInput(bus);
keyboard.attach(window);

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  keyboard.update(dt, state);       // 键盘 → 命令
  acc += dt;
  while (acc >= 1 / 120) {
    stepSimulation(state, 1 / 120, bus);
    acc -= 1 / 120;
  }
  renderCockpit(state);             // 单元 2：仪表只读 state
  requestAnimationFrame(frame);
}
```

---

## 2. stepSimulation 时序与 dt 约定

```
stepSimulation(state, dt, bus)
  └─ 按 1/120 s 固定子步循环：
       1. stepSystems(state, h)      燃油/液压/电气/增压/皮托/结冰/引擎（N1 滞后、推力）
       2. stepAutopilot(state, h)    AP/AT → 写 state.control / state.throttle
       3. flight-model 子步          气动+推进+地面 → 积分速度/位置/姿态
     然后每名义步一次：
       4. computeWarnings(state)     警告汇总（STALL/OVERSPEED/... + masterCaution/Warning）
       5. state.time += dt
```

- `dt` 为名义步长；内部按 1/120 s 定步长切分（`state._acc` 累积）。渲染帧可传真实帧间隔。
- 命令在 `bus.send` 时**同步生效**，与 `stepSimulation` 的调用时刻无关（下一子步即被消费）。

---

## 3. 状态树逐字段表

单位约定：速度 kt（IAS/TAS/GS）、高度 ft（显示）/m（内部 y）、升降率 fpm、角度 deg、
质量 kg、推力 kN、燃油流量 kg/s（单发）、时间 s。世界坐标：**+x 北（跑道方向）、+y 上（y=0 跑道面）、+z 东**；
航向 0°=北顺时针；姿态角全为度。

### 3.1 根字段

| 字段 | 类型 | 单位 | 语义 | 写 | 读 |
|---|---|---|---|---|---|
| `time` | number | s | 仿真累计时间 | index | 全部 |
| `dt` | number | s | 最近名义步长 | index | 调试 |
| `massKg` | number | kg | 总质量 = OEW+载荷+燃油 | systems | 性能计算 |
| `payloadKg` | number | kg | 载荷 | 初始化 | 结算 |
| `rngSeed` | number | — | 随机数种子（`createSimState({rngSeed})` 注入；默认 737800）。同种子+同样操作 ⇒ 轨迹逐帧一致，结算可复现 | 初始化 | 内核随机源 |
| `rng` | function | — | 内核统一随机源 `[0,1)`（mulberry32）。湍流/阵风/皮托漂移/失速机翼下坠全部走它。**后续单元需要随机数时也必须用它**，禁止 `Math.random` | 内核 | 内核/（只读调用） |

### 3.2 `aircraft`（只读常量）

| 字段 | 值 | 语义 |
|---|---|---|
| `type` | '737-800' | 机型 |
| `wingAreaSqm` | 125 | 翼面积 m² |
| `wingSpanM` | 35.8 | 翼展 m |
| `aspectRatio` | 10.25 | 展弦比 |
| `oewKg` / `mtowKg` / `mlwKg` | 41400 / 79000 / 66000 | 使用空重 / 最大起飞 / 最大着陆重量 kg |
| `maxFuelKg` | 20800 | 最大油量 kg |
| `maxThrustKN` | 107 | 单发最大推力 kN（CFM56-7B24） |
| `vmoKt` / `mmoMach` | 340 / 0.82 | 最大操纵速度 / 马赫（超速警告阈值） |

`runway`：`{ lengthM, widthM, headingDeg, elevFt }`（内核地面为沿 +x 的跑道面，中线 z=0）。

### 3.3 `position` / `orientation` / `velocity` / `atmosphere`

| 字段 | 类型/单位 | 语义 | 写 | 读 |
|---|---|---|---|---|
| `position.x/y/z` | m | 北/上/东 | 飞行模型 | 世界（相机）、ND |
| `agl` | m | 无线电高度（本内核 = y） | 飞行模型 | GPWS、无线电高度表 |
| `orientation.pitch/bank/heading` | deg | 俯仰/坡度/航向 | 飞行模型 | ADI、HDG、世界 |
| `orientation.pitchRate/bankRate/headingRate` | deg/s | 角速率 | 飞行模型 | 趋势显示 |
| `velocity.tas/ias/gs` | kt | 真空速/指示空速/地速 | 飞行模型（ias 可被皮托堵塞改写） | 全部仪表 |
| `velocity.mach` | — | 马赫 | 飞行模型 | 速度带 |
| `velocity.vsFpm` | fpm | 升降率（+爬/-降） | 飞行模型 | VSI |
| `velocity.vx/vy/vz` | m/s | 世界系速度分量 | 飞行模型 | 世界单元 |
| `velocity.aoa` | deg | 迎角 | 飞行模型 | 振杆/失速逻辑、AOA 指示 |
| `velocity.sideslip` | deg | 侧滑角 β | 飞行模型 | 平偏指示 |
| `atmosphere.rho/tempC/pressurePa/pressureAltFt/speedOfSound/densityRatio` | SI | ISA 推导 | 飞行模型 | 性能/音效 |

### 3.4 `engines[2]` / `throttle` / `reverse`

| 字段 | 类型/单位 | 语义 |
|---|---|---|
| `engines[i].n1 / n2` | 0..1 | 低压/高压转子转速（n1 主导推力；1 = 100%） |
| `engines[i].egt` | °C | 排气温度（慢车≈380，起飞≈880） |
| `engines[i].fuelFlowKgs` | kg/s | 单发燃油流量 |
| `engines[i].running` | bool | 是否运行 |
| `engines[i].onFire` / `fireExtinguished` | bool | 火警 / 已灭火 |
| `engines[i].thrustKN` | kN | 当前单发推力（systems 每步更新） |
| `engines[i].startState` | 'OFF'\\|'START'\\|'RUN' | 启动时序状态 |
| `throttle[2]` | 0..1 | 油门杆（左右） |
| `reverse[2]` | 0..1 | 反推（左右） |

N1 动态：一阶滞后（增速 τ≈5 s、减速 τ≈3 s，反推响应更快）；慢车 N1=0.20；启动全程 ≈8 s。

### 3.5 操纵/构型

| 字段 | 类型/单位 | 语义 |
|---|---|---|
| `flaps.index` | 0..7 | 襟翼手柄档位（0/1/2/5/15/25/30/40） |
| `flaps.angle` | deg | 实际舵面角（移动速率 ≈0.5 档/s，气动用 angle） |
| `flaps.jam` | 0..7\\|null | 卡阻档位 |
| `gear.handleDown` | bool | 起落架手柄 |
| `gear.position` | 0..1 | 0 收上 / 1 放下锁定（全行程 10 s；人工重力 25 s） |
| `gear.manualRelease` / `gear.jammed` | bool | 人工重力放出 / 卡阻 |
| `spoilers.armed` | bool | 扰流板预位（接地自动放出） |
| `spoilers.deployed` | 0..1 | 放出量 |
| `spoilers.commandDeploy` | bool | 人工放出指令（空/地均可） |
| `trim.stabilizer` | -1..1 | 安定面配平（负=机头向下）；气动上移动中立迎角 |
| `trim.trimWheelMoving` | bool | 配平轮正在转（音效） |
| `control.elevator/aileron/rudder` | -1..1 | 操纵面指令（键盘或 AP 写入） |

### 3.6 系统

| 字段 | 类型/单位 | 语义 |
|---|---|---|
| `fuel.left/right/center` | kg | 油箱油量 |
| `fuel.pumps.{left,right,center}` | bool | 燃油泵 |
| `fuel.crossfeed` | bool | 交输活门 |
| `fuel.leakPerSecond` / `leakTank` | kg/s / 'left'\\|'right'\\|'center'\\|null | 当前泄漏 |
| `hydraulics.A / B` | 0..1 | 系统压力（0=失效无压；由对应发动机驱动泵建立） |
| `hydraulics.standby` / `standbyOn` | 0..1 / bool | 电动备用泵 |
| `hydraulics.failedA/failedB` | bool | 硬失效标志（damage 写入） |
| `electrical.genL/genR/apu` | bool | 发电机在线（按 N2 滞回：>0.45 接入、<0.35 脱开；慢车 N2≈0.55 在线）/APU 发电（apuOn 3 s 后可用） |
| `electrical.apuOn` / `battery` | bool / 0..1 | APU 开关 / 电瓶电量 |
| `electrical.acPowered` | bool | 交流电源（任一发电机或 APU）——**AP/AT 的电源条件** |
| `electrical.busPowered` | bool | 任何电源（含电瓶直流）——DC 设备/灯光用 |
| `pressurization.cabinAltFt` | ft | 客舱气压高度（FL350 正常 ≈8000） |
| `pressurization.rateOfChange` | fpm | 舱压变化率 |
| `pressurization.o2MasksDropped` | bool | 舱压 >14000 ft 自动落下 |
| `pressurization.outflowOpen` / `outflowRateFpm` | bool / fpm | 释压状态（damage 写） |
| `pitot.blockedL/blockedR` | bool | 皮托管堵塞（堵塞后 `velocity.ias` 漂移冻结/随高度爬升） |
| `ice.accumulation` | 0..1 | 结冰量（1 → CLmax -25%，废阻 +0.008） |
| `ice.antiIceOn` / `wingsAntiIce` | bool | 发动机/机翼防冰 |
| `fire.engines[2] / cargo / cabin` | bool | 火警状态 |

### 3.7 自动驾驶与导航

| 字段 | 类型/单位 | 语义 |
|---|---|---|
| `ap.engaged` | bool | CMD 接通 |
| `ap.atArmed` | bool | 自动油门预位（AP 断开时 SPD 仍可工作） |
| `ap.modes.{hdgSel,altHold,altSel,vs,spd,app,locCaptured,gsCaptured}` | bool | MCP 方式（FMA 直接读） |
| `ap.targets.{hdg,alt,vs,ias}` | deg / ft / fpm / kt | MCP 目标窗 |
| `ap.fd.pitch / fd.bank` | deg | 飞行指引杆目标姿态（PFD 画 FD 用） |
| `nav.courseDeg` | deg | 航向道/跑道磁航向 —— **世界单元写** |
| `nav.distM` | m | 至跑道入口距离 —— **世界单元写** |
| `nav.thresholdElevFt` | ft | 入口标高 —— **世界单元写** |
| `nav.locValid / gsValid` | bool | ILS 信号有效 —— **世界单元写** |
| `nav.bearingDeg` | deg\|null | 飞机指向跑道入口的方位（进近几何下成立；可选）—— **世界单元写**。LOC 截获后 AP 用它做侧向偏差修正（xtk = -distM·sin(bearing-course)，>0 = 在航道右侧）；null = 无修正 |
| `terrain.aheadElevFt` | ft\\|null | 前视地形最高标高（GPWS TERRAIN 用）—— **世界单元写**；null=无数据 |

APP 逻辑：`ap.modes.app` 预位后，`|航向-course|<12°` 且 `distM<25000` 且 `locValid` → 截获航向道；
下滑道偏离 <0.4° → 截获下滑道；接地（几何高度<5 m）自动断开。

俯仰通道实现（积分式 + 抗饱和）：`ap._pitchCmd`（内部）按 VS 误差积分（速率限幅 0.8°/s，
距当前俯仰 ±3° 抗积分饱和），并有 VS 误差比例阻尼项；受 **AoA 保护**钳位
`γ-15° .. γ+0.9·αstall`（ALT SEL 大下降率捕获改平不失速）。捕获滞环 60 ft。
GS 通道：几何式目标 + 下滑道偏离增益（×空速因子），8 km 进近偏离 |dev| ≤ 0.05°。
横滚通道：HDG SEL 坡度限 25°；LOC 截获后叠加侧向偏差修正（见 `nav.bearingDeg`）。
航向通道：附方向舵 PI（自动抵消不对称推力偏航，单发平飞航向偏差 <1°）。
自动油门：IAS 误差积分（0.08/s per kt）。**`ap/disconnect` 同时脱离 AT**（atArmed 复位）。

### 3.8 警告（驾驶舱据此点亮告警/触发语音）

`state.warnings = { active: string[], masterCaution: bool, masterWarning: bool, stickShaker: bool }`

| 警告字符串 | 触发条件 | 级别 |
|---|---|---|
| `STALL` | α > 失速迎角（含振杆阈值 0.9·αstall） | 主警告 |
| `OVERSPEED` | IAS > 340 kt 或 M > 0.82 | 主警告 |
| `ENGINE FIRE L` / `ENGINE FIRE R` | `engines[0/1].onFire` | 主警告 |
| `DUAL ENG FAIL` | 双发均不在运行 | 注意 |
| `CABIN PRESSURE` | 客舱高度 >10000 ft | 主警告 |
| `LOW FUEL` | 总油量 <2300 kg | 注意 |
| `HYD PRESS` | A 或 B <0.35 | 注意 |
| `CONFIG` | 地面 80-180 kt 且（襟翼 0 或起落架手柄 up） | 主警告 |
| `TERRAIN` | 前视地形高于飞机 +100 ft（需世界单元写 `terrain.aheadElevFt`） | 主警告 |
| `WINDSHEAR` | <1200 ft AGL，5 s 内 IAS 变化 >15 kt | 主警告 |
| `GPWS SINKRATE` | 下降率过大（着陆构型放宽 1.8 倍） | 注意 |
| `GPWS PULLUP` | 下降率极大（<2500 ft AGL，着陆构型放宽） | 主警告 |

### 3.9 环境 / 地面 / 接地结算

| 字段 | 类型/单位 | 语义 |
|---|---|---|
| `weather.windDirDeg` | deg | 气象风向（风来的方向；0=北风） |
| `weather.windKts / gustKts` | kt | 平均风 / 阵风幅值 |
| `weather.turbulence` | 0..1 | 湍流强度（操纵/姿态扰动） |
| `weather.visibilityM` | m | 能见度 |
| `weather.precipitation` | 'none'\\|'rain'\\|'snow' | 降水 |
| `weather.tempC` / `icingConditions` | °C / bool | 气温 / 结冰环境（damage 可写） |
| `ground.onGround / noseOnGround / mainOnGround` | bool | 接地状态 |
| `ground.brakes[2]` | 0..1 | 刹车（防滞限制 μ≈0.35） |
| `ground.parkingBrake` | bool | 停留刹车 |
| `ground.autobrake` | 'OFF'\\|'1'\\|'2'\\|'3'\\|'4'\\|'MAX' | 自动刹车档位 |
| `touchdown.recorded` | bool | 已记录接地（每次离地→接地置 true 一次） |
| `touchdown.vsFpm` | fpm | 接地垂直速度（正=下降；>600 判重着陆参考） |
| `touchdown.bankDeg` / `pitchDeg` | deg | 接地坡度 / 俯仰 |
| `touchdown.driftDeg` | deg | 漂移角（航迹与机头夹角，侧风判分） |
| `touchdown.centerlineOffsetM` | m | 距跑道中线横向偏差 |
| `touchdown.iasKt` / `time` | kt / s | 接地空速 / 时刻 |
| `touchdown.onRunway` | bool | 是否在跑道面内（|z|≤22.5 且 0≤x≤length） |
| `touchdown.surface` | 'runway'\\|'water'\\|'terrain'\\|'belly' | 接地表面：机腹（gear<0.5 接地）/跑道内/跑道外；**海岸线落水由世界单元改写为 'water'** |

结算单元读 `touchdown` 判分；机腹迫降 = `surface==='belly'`（姿态/速度/接地率 + vsFpm 共同决定结果）。

---

## 4. 命令总线全表（`bus.send(name, ...args)`）

| 命令 | 参数 | 语义 |
|---|---|---|
| `throttle/set` | v 0..1 或 [l,r] | 设油门（自动断开 SPD 方式） |
| `throttle/nudge` | dv（如 ±0.05） | 增减油门 |
| `flaps/set` | index 0..7 | 襟翼手柄档位 |
| `flaps/up` / `flaps/down` | — | 收/放一档 |
| `gear/up` / `gear/down` / `gear/toggle` | — | 起落架手柄 |
| `gear/manualRelease` | — | 人工重力放出 |
| `spoilers/arm` | on=true | 扰流板预位 |
| `spoilers/toggle` | — | 地面切预位；空中切人工放出 |
| `reverse/set` | v 0..1 | 反推 |
| `reverse/toggle` | — | 反推收/全开 |
| `trim/nudge` | dv（如 ±0.02） | 配平（正=机头向上） |
| `brakes/set` | v 或 [l,r] | 刹车（按住 B 时持续发 1） |
| `brakes/park` | — | 停留刹车切换 |
| `autobrake/set` | 'OFF'\\|'1'..'4'\\|'MAX' | 自动刹车 |
| `control/elevator` / `control/aileron` / `control/rudder` | v -1..1 | 操纵面（+elevator=拉杆、+aileron=右压杆、+rudder=右蹬舵） |
| `ap/cmd` | — | CMD 接通/断开 |
| `ap/engage` / `ap/disconnect` | — | 接通 / 断开 |
| `ap/hdg` | deg | HDG SEL 目标航向 |
| `ap/alt` | ft | ALT SEL 目标高度（|差|<40 ft 自动转 ALT HOLD） |
| `ap/vs` | fpm | VS 方式（-3000..3000） |
| `ap/spd` | kt | SPD 自动油门目标 IAS |
| `ap/app` | — | APP 预位（读 `state.nav`） |
| `engine/start` | i（0\\|1\\|2=双发） | 启动（需 busPowered；≈8 s 时序） |
| `engine/stop` | i | 关车 |
| `fuel/pump` | tank 'left'\\|'right'\\|'center', on | 燃油泵 |
| `fuel/crossfeed` | on | 交输 |
| `antiIce/toggle` | which 'engine'\\|'wings' | 防冰 |
| `wipers` | level 0..2 | 雨刷 |
| `apu/toggle` | — | APU 启停（3 s 后 `electrical.apu=true`，可作交流备份电源） |
| `fire/extinguish` | i（发动机）\\|无参（客舱） | 灭火瓶 |

`bus.has(name)` / `bus.list()` 可枚举。**`bus.damage`** 为险情钩子集合（见下节）。

## 5. damage 钩子（险情单元唯一入口）

```js
const d = bus.damage;              // = createDamageAPI(state)
d.engineFail(i)                    // i=0 左 / 1 右：熄车失效
d.engineFire(i)                    // 火警：EGT 冲高、推力 15 s 衰减到 0
d.extinguishEngineFire(i)          // 灭火瓶：火灭，该发保持停车
d.dualEngineFail()                 // 双发全失效
d.hydraulicFail('A'|'B'|'standby') // 液压硬失效（备用=关断备用泵）
d.depressurize()                   // 释压：舱压 ≈6000 fpm 逼近巡航气压高度
d.repairPressurization()           // 增压恢复
d.pitotBlock(i, on)                // 皮托堵塞/疏通 → IAS 漂移
d.fuelLeak('left'|'right'|'center'|null, kgPerS) // 泄漏；null 停止
d.flapsJam(index|null)             // 卡阻在档位（手柄自动收回卡阻位）/ 解卡
d.cabinFire(on)                    // 客舱火警
d.setIcingConditions(on)           // 结冰环境（并倾向低温+降雪）
d.gearJam(jammed)                  // 起落架卡阻
```

语义：钩子只改系统状态；警告由内核每步汇总（险情无需自己点亮警告灯）；
处置路径示例：火警 → `engine/stop i` + `fire/extinguish i`；释压 → 紧急下降（`ap/vs -3000` 或人工俯冲）+ `repairPressurization`。

## 6. 键盘映射（`createKeyboardInput`）

| 键 | 动作 | 键 | 动作 |
|---|---|---|---|
| ↑ / ↓ | 推杆 / 拉杆（↓=拉杆，摇杆惯例） | ← / → | 左 / 右压杆 |
| PgUp / PgDn（或 + / -） | 油门 + / − | F / V | 襟翼收 / 放一档 |
| G | 起落架收放 | Shift+G | 人工重力放出 |
| B（按住） | 刹车 | Shift+B | 停留刹车 |
| / | 扰流板（地=预位，空=放出） | Shift+/ | 扰流板预位 |
| , / . （或 [ / ]） | 配平 机头向下 / 向上 | R | 反推切换 |
| E / Shift+E | 双发启动 / 关车 | Ctrl+G | AP CMD |
| I | 发动机防冰 | W | 雨刷循环 |
| A | 自动刹车循环 | P | 暂停 |

持续键的操纵轴带接近速率惯性（2.5/s 压杆、3.0/s 回中）。AP 接通时人工压杆超过阈值自动断开 AP；
人工推油门自动断开 SPD 方式。

---

## 7. 数值基准（测试锚点，`node tests/kernel.test.mjs`）

| 项目 | 数值 |
|---|---|
| 1g 失速 IAS | 60t 干净 149.5 kt；60t 襟翼40 105.7 kt |
| 70t 襟翼5 | V1 141 / VR 143 / V2 149；Vref30@60t 137 |
| 起飞 70t 襟翼5 满推力 | 0→VR ≈37 s；松刹车→35 ft ≈2200 m |
| 巡航 FL350 74t 满N1 | TAS 453 kt（M 0.784），推力=阻力（<1% 残差） |
| 单发 Vmcg | ≈120 kt（模型校准值；130 kt 全舵偏航率 <1°/s，无舵 >2°/s） |
| 地效 | 5 m AGL 诱导阻力 -61% |
| 燃油流量 | 巡航双发合计 ≈2500-2900 kg/h（随 N1） |
| 反推+扰流板 | 刹停距离比无反推短 ≥20% |
| 拉平（T17） | 65t 襟翼30 145kt 稳定进近，30 m 拉平（上仰 ≥2.5°+收慢车+带杆调制）→ 接地 VS ≈130-200 fpm |

## 8. 诚实简化清单（评审与后续单元须知）

1. **角运动是"速率指令 + 一阶滞后"模型**，不是六自由度力矩方程。纵向静稳定实现为"迎角回归配平基准迎角"：
   配平基准 = 配平速度（由配平轮位置映射）下 1g 平飞所需迎角，叠加经典速度稳定性阻尼
   （偏离配平速度 → 抬/低头）。该设计保证进近高 AoA 段升降舵保有完整迎角/升力操纵功效（拉平不 mush），
   松杆收敛回配平速度。注意：拉平中**保持俯仰姿态不动**而速度衰减时，下沉率会缓慢回升
   （1g 所需迎角随速度上升）——真实拉平需随减速继续带杆，这是物理正确的行为。
2. **偏航为平面线性化**（常系数 Cnβ/Cnr/Cnδ + 等效偏航转动惯量）；Vmcg 校准值 ≈120 kt（规格"≈110"）。
3. 地面轮胎集总为：滚动摩擦 + 刹车摩擦（防滞）+ 静摩擦（水平面双轴钳制：推力/风力/地面反推不突破上限时飞机整体停住，含侧向）+ 等效偏航阻尼 + 航迹向机头收敛的侧向抓地，无轮胎物理模型。摩擦/刹车方向按世界系水平地速（非体轴气流方向），侧风不会让停机/滑行飞机横滑出跑道。
4. 失速后机翼下坠用随机滚转扰动近似，非气动力建模。
5. 备用液压以 0.8 倍压力补偿 A/B（真实 737 备用系统只供部分用户）。发电机逻辑按 N2 滞回近似（真实为 CSD/IDG 附加离合器逻辑）。APU 启动 3 s 简化、不仿真引气。AP 电源条件按"交流母线"（`electrical.acPowered`）判定。
6. 皮托堵塞的 IAS 漂移是经验公式（+0.012 kt/ft 高度变化 + 微小随机漂移），非管路气压仿真。
7. 增压舱压目标是经验公式（FL350 → 8000 ft 舱高），非外流活门气动仿真。
8. 启动时序 ≈8 s 简化，不要求 APU 引气（仅要求 busPowered）。
9. 接地表面 `water` 判定留给世界单元（海岸线数据在内核中不存在）。
10. T4 测试中"跑距"按行业惯例取**松刹车→离地 35 ft 的起飞总距离**（真实 737-800@70t ≈2000 m 量级），非纯地面滑跑段。
11. 湍流/阵风为随机过程（默认 0，保证测试确定性）。
12. 没有做：燃油不平衡极限逻辑、发动机起动需 APU 引气、真正的外流活门机构、ICE 对 CD0 的分翼面建模。
13. AP 方向舵通道是航向 PI（非真实脚蹬力模型）；LOC 侧向修正依赖世界单元提供 `nav.bearingDeg`，缺省无修正。
