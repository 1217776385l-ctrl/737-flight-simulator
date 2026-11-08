/**
 * state.js — 仿真状态唯一事实源（Single Source of Truth）。
 *
 * 约定：
 *  - 内部物理计算使用 SI（米、米/秒、牛、千克、弧度）；
 *  - 对外暴露给仪表/剧本/结算的字段一律用航空单位（kt、ft、fpm、deg），
 *    每个字段的单位在 docs/kernel-api.md 逐字段注明。
 *  - 世界坐标：+x = 北（跑道方向），+y = 天（向上），+z = 东。
 *    航向 heading 为罗盘角：0°=北，顺时针增大（0→东）。
 *  - 姿态角一律为度（deg），角速率为度/秒（deg/s）。
 *  - 以下划线开头的字段（如 _acc）为内核内部状态，后续单元禁止读写。
 *
 * 本文件只负责"造出完整、合法、可 JSON 序列化的状态树"，
 * 不含任何动力学；所有演化都在 flight-model / systems / autopilot 中。
 */

/** 波音 737-800 机体常量（真实单位） */
export const AIRCRAFT_737_800 = Object.freeze({
  type: '737-800',
  wingAreaSqm: 125,        // 机翼参考面积 m²
  wingSpanM: 35.8,         // 翼展 m
  aspectRatio: 10.25,      // 展弦比 b²/S
  oewKg: 41400,            // 使用空重 kg（Operating Empty Weight）
  mtowKg: 79000,           // 最大起飞重量 kg
  mlwKg: 66000,            // 最大着陆重量 kg
  maxFuelKg: 20800,        // 最大燃油量 kg
  maxThrustKN: 107,        // 单发最大起飞推力 kN（CFM56-7B24, 24000 lbf）
  engineCount: 2,
  passengersMax: 189,
  vmoKt: 340,              // 最大操纵速度 kt
  mmoMach: 0.82,           // 最大操纵马赫
  gearTravelTimeS: 10,     // 起落架全行程时间 s
  flapsTravelDegPerS: 3.0, // 襟翼舵面角速率 °/s（≈0.5 档/秒）
});

/** 襟翼档位表：index 0..7 → 舵面偏角（度）与对应 CLmax（干净→全襟翼） */
export const FLAP_NOTCHES = Object.freeze([
  { index: 0, angleDeg: 0,  label: 'UP' },
  { index: 1, angleDeg: 1,  label: '1' },
  { index: 2, angleDeg: 2,  label: '2' },
  { index: 3, angleDeg: 5,  label: '5' },
  { index: 4, angleDeg: 15, label: '15' },
  { index: 5, angleDeg: 25, label: '25' },
  { index: 6, angleDeg: 30, label: '30' },
  { index: 7, angleDeg: 40, label: '40' },
]);

/**
 * 可复现伪随机数生成器（mulberry32）。
 * 内核所有随机源（湍流/阵风/皮托漂移/失速机翼下坠）都走 state.rng，
 * 同一种子 + 同样操作 ⇒ 完全相同的仿真轨迹（结算可复现）。
 * @param {number} seed 任意整数
 * @returns {() => number} 产生 [0,1) 的函数
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 默认种子：固定值保证"同样操作同分"；需要随机差异时由调用方传 rngSeed */
export const DEFAULT_RNG_SEED = 737800;

/**
 * 创建一份全新的仿真状态（停在跑道上、双发运行、可立即推油门起飞）。
 * @param {Object} [opts]
 * @param {number} [opts.fuelKg=8000]        初始总燃油 kg（左右翼均分）
 * @param {number} [opts.payloadKg=14000]    载荷（乘客+货物）kg
 * @param {boolean} [opts.enginesRunning=true]
 * @param {number} [opts.runwayLengthM=3600] 跑道长度（+x 方向，中心线 z=0）
 * @param {number} [opts.rngSeed=DEFAULT_RNG_SEED] 随机数种子（可复现）
 * @returns {Object} 完整状态树
 */
export function createSimState(opts = {}) {
  const fuelKg = opts.fuelKg ?? 8000;
  const payloadKg = opts.payloadKg ?? 14000;
  const enginesRunning = opts.enginesRunning ?? true;
  const runwayLengthM = opts.runwayLengthM ?? 3600;
  const rngSeed = opts.rngSeed ?? DEFAULT_RNG_SEED;

  const mkEngine = (running) => ({
    n1: running ? 0.20 : 0.0,       // 低压转子转速 0..1（1 = 100%）
    n2: running ? 0.55 : 0.0,
    egt: running ? 380 : 15,        // 排气温度 °C
    fuelFlowKgs: running ? 0.18 : 0, // 燃油流量 kg/s（单发）
    running,
    onFire: false,
    fireExtinguished: false,
    thrustKN: running ? 17 : 0,     // 当前推力 kN（由 systems 每步更新）
    startState: running ? 'RUN' : 'OFF', // 'OFF' | 'START' | 'RUN'
    startTimerS: 0,
  });

  const state = {
    /** 仿真累计时间 s（自状态创建起） */
    time: 0,
    /** 最近一次 stepSimulation 的名义步长 s */
    dt: 0,

    /* ---------- 可复现随机 ---------- */
    /** 随机数种子（createSimState({rngSeed}) 注入；默认 DEFAULT_RNG_SEED） */
    rngSeed,
    /** 内核统一随机源 [0,1)：湍流/阵风/皮托漂移/失速机翼下坠全部走它 */
    rng: mulberry32(rngSeed),

    /* ---------- 机体与质量 ---------- */
    aircraft: { ...AIRCRAFT_737_800 },
    // headingDeg = 活动跑道的罗盘航向（整合层在开局/目的地过渡时写）；内核 heading 为跑道局部角
    runway: { lengthM: runwayLengthM, widthM: 45, headingDeg: 0, elevFt: 0 },
    /** 总质量 kg = OEW + payload + 燃油（systems 每步重算） */
    massKg: AIRCRAFT_737_800.oewKg + payloadKg + fuelKg,
    payloadKg,

    /* ---------- 位置与姿态 ---------- */
    /** 世界坐标 m：x 北（沿跑道）、y 天（y=0 为跑道表面）、z 东 */
    position: { x: 0, y: 0, z: 0 },
    /** 无线电高度（离地）m —— 本内核地面为 y=0 平面，agl === y */
    agl: 0,
    orientation: {
      pitch: 0, bank: 0, heading: 0,          // deg
      pitchRate: 0, bankRate: 0, headingRate: 0, // deg/s（本步实际值）
    },
    velocity: {
      tas: 0,   // 真空速 kt
      ias: 0,   // 指示空速 kt（皮托堵塞时会被 systems 改写为漂移值）
      mach: 0,
      gs: 0,    // 地速 kt（含风）
      vsFpm: 0, // 升降率 ft/min
      vx: 0, vy: 0, vz: 0, // 世界系速度 m/s（vx 北、vy 上、vz 东）
      aoa: 0,   // 迎角 deg
      sideslip: 0, // 侧滑角 deg（β）
    },
    /** ISA 大气（flight-model 每步推导） */
    atmosphere: { rho: 1.225, tempC: 15, pressurePa: 101325, pressureAltFt: 0, speedOfSound: 340.3, densityRatio: 1 },

    /* ---------- 动力与操纵 ---------- */
    engines: [mkEngine(enginesRunning), mkEngine(enginesRunning)],
    /** 油门杆位置 0..1（左、右） */
    throttle: [0, 0],
    /** 反推 0..1（左、右） */
    reverse: [0, 0],

    flaps: {
      index: 0,        // 手柄档位 0..7（档位角见 FLAP_NOTCHES）
      angle: 0,        // 实际舵面角 deg（有移动速率）
      jam: null,       // 卡阻档位 0..7 或 null
    },
    gear: {
      handleDown: true,
      position: 1,       // 0=收上 1=放下锁定
      manualRelease: false, // 人工重力放出
      jammed: false,
    },
    spoilers: { armed: false, deployed: 0, commandDeploy: false }, // deployed 0..1；commandDeploy=人工放出指令（空/地面均可）
    trim: { stabilizer: 0, trimWheelMoving: false }, // stabilizer -1..1（负=机头向下配平）

    /* ---------- 系统 ---------- */
    fuel: {
      left: fuelKg / 2, right: fuelKg / 2, center: 0, // kg
      pumps: { left: true, right: true, center: true },
      crossfeed: false,
      leakPerSecond: 0,     // 当前泄漏率 kg/s
      leakTank: null,       // 'left' | 'right' | 'center' | null
    },
    hydraulics: {
      A: enginesRunning ? 1 : 0,  // 0..1（0=失效无压）
      B: enginesRunning ? 1 : 0,
      standby: 0,                  // 0..1 备用系统当前输出
      standbyOn: false,
      failedA: false, failedB: false, // damage 钩子写入的硬失效标志
    },
    electrical: {
      genL: enginesRunning, genR: enginesRunning, // 发电机在线
      apu: false,          // APU 发电
      apuOn: false,
      battery: 1,          // 电量 0..1
      acPowered: enginesRunning, // 交流电源（发电机或 APU）——AP/AT 需要
      busPowered: enginesRunning, // 任何电源（含电瓶直流）
    },
    pressurization: {
      cabinAltFt: 0,        // 客舱气压高度 ft
      rateOfChange: 0,      // 变化率 fpm
      o2MasksDropped: false,
      outflowOpen: false,   // 释压（外流活门全开）
      outflowRateFpm: 0,    // 释压下客舱高度逼近速率 fpm
    },
    pitot: { blockedL: false, blockedR: false },
    ice: {
      accumulation: 0,      // 0..1（1 = CLmax -25%）
      antiIceOn: false,     // 发动机防冰
      wingsAntiIce: false,  // 机翼防冰
    },
    fire: { engines: [false, false], cargo: false, cabin: false },

    /* ---------- 自动驾驶 ---------- */
    ap: {
      engaged: false,
      atArmed: false,          // 自动油门预位（允许 AP 断开时保持 SPD）
      modes: {
        hdgSel: false, altHold: false, altSel: false,
        vs: false, spd: false, app: false,
        locCaptured: false, gsCaptured: false,
      },
      targets: { hdg: 0, alt: 0, vs: 0, ias: 250 }, // hdg deg, alt ft, vs fpm, ias kt
      fd: { pitch: 0, bank: 0 },   // 飞行指引杆目标姿态（deg，供 PFD 画 FD）
    },
    /** 导航/ILS 数据 —— 世界单元（单元 4）负责写入，AP APP 模式读取 */
    nav: {
      courseDeg: 0,        // 跑道/航向道磁航向
      distM: 1e7,          // 至跑道入口距离 m（1e7 ≈ 无有效数据）
      thresholdElevFt: 0,  // 跑道入口标高 ft
      locValid: false, gsValid: false,
      bearingDeg: null,    // 飞机指向跑道入口的方位 deg（可选；LOC 截获后用于侧向偏差修正）
    },
    /** 地形前视信息 —— 世界单元写入，GPWS TERRAIN 读取 */
    terrain: { aheadElevFt: null, closureFpm: 0 },

    /* ---------- 警告 ---------- */
    warnings: {
      /** 当前活动警告字符串数组，枚举见 docs/kernel-api.md */
      active: [],
      masterCaution: false,
      masterWarning: false,
      stickShaker: false,
    },

    /* ---------- 环境 ---------- */
    weather: {
      windDirDeg: 0,   // 气象风（风来的方向）
      windKts: 0,
      gustKts: 0,
      turbulence: 0,   // 0..1
      visibilityM: 20000,
      precipitation: 'none', // 'none' | 'rain' | 'snow'
      tempC: 15,
      icingConditions: false,
    },

    /* ---------- 地面 ---------- */
    ground: {
      onGround: true,
      noseOnGround: true, mainOnGround: true,
      brakes: [0, 0],        // 刹车 0..1
      parkingBrake: true,
      autobrake: 'OFF',      // 'OFF'|'1'|'2'|'3'|'4'|'MAX'
    },

    /* ---------- 接地结算（着陆瞬间由飞行模型填充一次） ---------- */
    touchdown: {
      recorded: false,
      time: 0,
      vsFpm: 0,            // 接地垂直速度 fpm（正=下降）
      bankDeg: 0,
      pitchDeg: 0,
      driftDeg: 0,         // 侧风漂移角 deg（航迹与机头夹角）
      centerlineOffsetM: 0,// 距跑道中线横向偏差 m
      iasKt: 0,
      onRunway: true,      // 是否在跑道面内
      surface: 'runway',   // 'runway' | 'water' | 'terrain' | 'belly'
    },

    /* ---------- 操纵面指令（-1..1，键盘或 AP 写入） ---------- */
    control: { elevator: 0, aileron: 0, rudder: 0 },

    /* ---------- 内部（禁止外部读写） ---------- */
    _acc: 0,
    _forces: { liftN: 0, dragN: 0, thrustN: 0, sideN: 0 }, // 最近子步受力（测试/调试）
    _wind: { vx: 0, vy: 0, vz: 0 },
    _iasFrozen: null,
    _shearIasHistory: [],
  };

  state.ap.targets.hdg = 0;
  state.ap.targets.alt = 0;
  return state;
}

/** 当前总质量 kg（每次调用实时计算，供飞行模型使用） */
export function totalMassKg(state) {
  return state.aircraft.oewKg + state.payloadKg +
    state.fuel.left + state.fuel.right + state.fuel.center;
}
