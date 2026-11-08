/**
 * airports-data.js — 单元 3（外部世界）· 五座机场数据表 + 几何查询。
 *
 * 设计原则（大师简报）："每座机场是一份参数"，多机场靠加数据而非改引擎。
 *
 * 坐标系约定（与 docs/kernel-api.md 一致，两条腿走路）：
 *  - **仿真坐标系（sim frame）**：+x 北、+y 上（y=0 为跑道面）、+z 东。
 *    内核 state.position 即此坐标系。terrainHeight(x, z, airportId) 收仿真坐标。
 *  - **机场本地坐标系（local frame）**：跑道沿 +x（入口 x=0，远端 x=runwayLength），
 *    中线 z=0，跑道以西（着陆员左手边）为 -z。
 *    仿真坐标 = 机场局部坐标（恒等，见 worldToAirport / airportToWorld；罗盘换算只在显示/输入边界）。
 *  - heading 为罗盘角：0°=北、顺时针（090=东）。本地 +x 轴在仿真系中指向 (cos h, sin h)。
 *
 * 高度约定（重要，供单元 5/6 与内核侧阅读）：
 *  - terrainHeight 返回**相对跑道面**的高度（机场平地 ≈ 0，海面/河谷为负）。
 *    内核的 state.position.y 同样以跑道面为 0（agl === y），两者同帧可直接比较，
 *    GPWS TERRAIN 判定（state.terrain.aheadElevFt）因此天然成立。
 *  - airport.elevationM 仅为"名片"数据（菜单/结算/ATIS 文案用）。内核无法表现机场标高
 *    （其地面硬编码 y=0），因此 state.nav.thresholdElevFt 必须写 0 —— 若写真实标高，
 *    内核 APP 的下滑道偏差公式 aboveThrM = y − thr/3.28084 会整体偏移标高、永远截获不了。
 *
 * @module world/airports-data
 */

const D2R = Math.PI / 180;

/**
 * 五座机场。字段语义：
 *  - id             ICAO 式代号（唯一键）
 *  - name / nameEn  中文与英文展示名
 *  - archetype      原型说明（浦东式 / 林芝式 / 马德拉式 / 旧金山式 / 吉达式）
 *  - runwayHeading  着陆方向罗盘航向 deg（进近从本地 x<0 沿 +x 进入）
 *  - runwayLength / width  m
 *  - elevationM     机场标高 m（名片数据；内核 y=0 恒为跑道面，见文件头说明）
 *  - ils            { gsDeg, freq, ident } 或 null（LPMA 无 ILS：目视 + PAPI）
 *  - terrainSeed    程序地形种子（同一 seed 高度场完全确定 → 结算可复现）
 *  - terrainType    'plain' | 'canyon' | 'island' | 'bay' | 'desert'
 *  - climate        机场气候倾向（weather.js 每帧写 state.weather 的基准值）
 *      windDirDeg  气象风向（风来的方向，罗盘角）
 *      windKts / gustKts  平均风 / 阵风幅值 kt
 *      visM        基准能见度 m（fogCycle='marine' 的机场按昼夜正弦在 minM..maxM 间波动）
 *      fogCycle    'none' | 'marine'（海湾平流雾）
 *      tempC       海平面气温 °C（随高度按 ISA 直减率 -6.5°C/km 修正）
 *      turbulence  基准湍流 0..1
 *  - waterLevelRel  水面相对跑道面高度 m（null = 无水域）
 */
export const AIRPORTS = {
  /* ---------------- 枢纽双跑道（浦东式） ---------------- */
  ZSPD: {
    id: 'ZSPD',
    name: '东海枢纽国际机场',
    nameEn: 'East Sea Hub Intl',
    archetype: '浦东式 · 枢纽双跑道',
    runwayHeading: 350,
    runwayLength: 3800,
    width: 60,
    elevationM: 4,
    ils: { gsDeg: 3.0, freq: '110.70', ident: 'IHUB' },
    terrainSeed: 101,
    terrainType: 'plain',
    climate: { windDirDeg: 320, windKts: 8, gustKts: 13, visM: 12000, fogCycle: 'none', tempC: 18, turbulence: 0.06 },
    waterLevelRel: -2.5, // 东侧海岸线外为海（本地 +z 方向约 9 km 外）
    dualRunway: true,    // 渲染第二条平行跑道（视觉，间隔 800 m）
  },

  /* ---------------- 高原峡谷（林芝式） ---------------- */
  ZULZ: {
    id: 'ZULZ',
    name: '雪原峡谷机场',
    nameEn: 'Snow Gorge Airport',
    archetype: '林芝式 · 高原峡谷',
    runwayHeading: 235,
    runwayLength: 3000,
    width: 45,
    elevationM: 2950,
    ils: { gsDeg: 3.0, freq: '109.10', ident: 'IGOR' },
    terrainSeed: 202,
    terrainType: 'canyon',
    climate: {
      windDirDeg: 260, windKts: 14, gustKts: 26,
      visM: 16000, fogCycle: 'none', tempC: 8,
      turbulence: 0.24, // 高原风切变倾向：weather.js 会随低空与侧风放大
    },
    waterLevelRel: -1.5, // 谷底河流
    dualRunway: false,
  },

  /* ---------------- 海岛短跑道（马德拉式） ---------------- */
  LPMA: {
    id: 'LPMA',
    name: '环礁海岛机场',
    nameEn: 'Atoll Island Airport',
    archetype: '马德拉式 · 海岛短跑道',
    runwayHeading: 50,
    runwayLength: 2800,
    width: 45,
    elevationM: 58,
    ils: null, // 目视进近 + PAPI（PAPI 仍完全可用）
    terrainSeed: 303,
    terrainType: 'island',
    climate: {
      windDirDeg: 150, // 与跑道 050 近正交 → 常年右侧风
      windKts: 20, gustKts: 28,
      visM: 15000, fogCycle: 'none', tempC: 20, turbulence: 0.16,
    },
    waterLevelRel: -2.5, // 入口端与东侧接海（冲出跑道即落水）
    dualRunway: false,
  },

  /* ---------------- 海湾雾城（旧金山式） ---------------- */
  KSFO: {
    id: 'KSFO',
    name: '海湾雾城机场',
    nameEn: 'Bay Fog City Airport',
    archetype: '旧金山式 · 平流雾 CAT-I ILS',
    runwayHeading: 281,
    runwayLength: 3600,
    width: 60,
    elevationM: 4,
    ils: { gsDeg: 3.0, freq: '110.90', ident: 'IFOG' },
    terrainSeed: 404,
    terrainType: 'bay',
    climate: {
      windDirDeg: 260, windKts: 12, gustKts: 18,
      visM: 900, fogCycle: 'marine', // 能见度随时刻在 200..1500 m 波动
      fogMinM: 200, fogMaxM: 1500,
      tempC: 14, turbulence: 0.08,
    },
    waterLevelRel: -2.5, // 三面环湾
    dualRunway: false,
  },

  /* ---------------- 沙漠长跑道备降场（吉达式） ---------------- */
  OEJN: {
    id: 'OEJN',
    name: '黄沙备降场',
    nameEn: 'Desert Diversion Field',
    archetype: '吉达式 · 沙漠长跑道备降场',
    runwayHeading: 345,
    runwayLength: 4000,
    width: 60,
    elevationM: 15,
    ils: { gsDeg: 3.0, freq: '109.90', ident: 'IDST' },
    terrainSeed: 505,
    terrainType: 'desert',
    climate: { windDirDeg: 320, windKts: 10, gustKts: 15, visM: 20000, fogCycle: 'none', tempC: 34, turbulence: 0.1 },
    waterLevelRel: null, // 无水域
    dualRunway: false,
  },
};

/** 机场 id 列表（菜单/单元 6 航线选择遍历用） */
export const AIRPORT_IDS = Object.keys(AIRPORTS);

/** 默认机场（枢纽） */
export const DEFAULT_AIRPORT_ID = 'ZSPD';

/* =========================================================
 * 几何查询（供本单元 / 单元 5 结算 / 单元 6 集成使用）
 * ========================================================= */

/**
 * 跑道矩形（机场本地坐标系）。
 * 内核的 touchdown.onRunway 判定用的就是同构矩形（沿 +x、中线 z=0）。
 * @param {Object} airport AIRPORTS 成员
 * @returns {{x0:number, x1:number, z0:number, z1:number, lengthM:number, widthM:number,
 *           headingDeg:number, elevM:number, elevFt:number}}
 */
export function runwayRect(airport) {
  const w = airport.width;
  return {
    x0: 0, x1: airport.runwayLength,
    z0: -w / 2, z1: w / 2,
    lengthM: airport.runwayLength, widthM: w,
    headingDeg: airport.runwayHeading,
    elevM: airport.elevationM,
    elevFt: airport.elevationM * 3.28084,
  };
}

/**
 * 仿真坐标 → 机场本地坐标（平面旋转，y 不变）。
 * @param {Object} airport
 * @param {number} x 仿真系北向 m
 * @param {number} z 仿真系东向 m
 * @returns {{lx:number, lz:number}}
 */
export function worldToAirport(airport, x, z) {
  // 仿真系 = 机场局部系（世界场景不再绕 runwayHeading 旋转，罗盘只在显示/输入边界换算），
  // 此处为恒等映射；保留函数以兼容既有调用点。
  return { lx: x, lz: z };
}

/**
 * 机场本地坐标 → 仿真坐标。
 * @returns {{x:number, z:number}}
 */
export function airportToWorld(airport, lx, lz) {
  // 恒等映射（同 worldToAirport：仿真系 = 机场局部系）
  return { x: lx, z: lz };
}

/**
 * 3° 下滑道在距入口 distM 处的标称高度（相对跑道面，m）。
 * PAPI / ILS / 单元 6 摆初始位置共用，保证三套系统说同一句话。
 * @param {number} distM 距入口水平距离 m
 * @param {number} [gsDeg=3]
 */
export function glideslopeHeightM(distM, gsDeg = 3.0) {
  return Math.tan(gsDeg * D2R) * Math.max(distM, 0);
}

/**
 * PAPI 灯组位置（机场本地坐标）。
 * 位于入口后 330 m、跑道左侧（-z）外 15 m，四灯沿 z 排开、间距 6 m。
 * @returns {{x:number, z:number, spacingM:number}} 基准灯位与间距
 */
export function papiPosition(airport) {
  return { x: 330, z: -(airport.width / 2 + 15), spacingM: 6 };
}

/**
 * 水面判定（迫降表面用）。
 * 输入**仿真坐标**；海岛/海湾机场的近岸水域、峡谷机场的河面返回 true。
 * 地形模块以同一套水域函数渲染水面，所见即所判。
 * @param {Object} airport
 * @param {number} x 仿真系北向
 * @param {number} z 仿真系东向
 * @returns {boolean}
 */
export function waterCheck(airport, x, z) {
  const fn = WATER_REGIONS[airport.terrainType];
  if (!fn || airport.waterLevelRel === null) return false;
  const { lx, lz } = worldToAirport(airport, x, z);
  return fn(lx, lz, airport);
}

/**
 * 各地形类型的水域判定（本地坐标）。terrain.js 渲染/雕塑水下地形使用同一函数，
 * 保证"视觉上是水 → waterCheck 为真 → 结算判 water"三者一致。
 * @type {Object<string, (lx:number, lz:number, airport:Object) => boolean>}
 */
const WATER_REGIONS = {
  // 枢纽：东海在本地 +z 方向 9 km 外
  plain(lx, lz, a) {
    const coast = 9000 + 1800 * coastNoise(lx, a, 11);
    return lz > coast;
  },
  // 峡谷：谷底蜿蜒河流（|z − riverZ| < 60）
  canyon(lx, lz, a) {
    const rz = 140 * Math.sin(lx / 4200) + 120 * coastNoise(lx, a, 9);
    return Math.abs(lz - rz) < 60;
  },
  // 海岛：入口端（x < 海岸线）与东侧（z > 海岸线）为海
  island(lx, lz, a) {
    const cx = -1100 + 1000 * coastNoise(lz, a, 21);
    const cz = 1500 + 1800 * coastNoise(lx, a, 22);
    return lx < cx || lz > cz;
  },
  // 海湾：|z| 超出陆地半宽，或两端超出陆地边界
  bay(lx, lz, a) {
    const half = 2600 + 1400 * coastNoise(lx, a, 31);
    if (Math.abs(lz) > half) return true;
    return lx < -5000 + 800 * coastNoise(lz, a, 32) || lx > a.runwayLength + 5500 + 800 * coastNoise(lz, a, 33);
  },
  desert() { return false; },
};

/** 海岸线噪声：0..1、确定性、C1 连续（机场种子派生） */
function coastNoise(x, a, salt) {
  let h = Math.imul(Math.round(x * 0.002) | 0, 374761393) ^ Math.imul(a.terrainSeed + salt, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * 跑道号（ painted number，由着陆航向推算，如 350 → '35'，对端 '17'）。
 * @param {Object} airport
 * @param {boolean} [reciprocal=false] true 返回对端跑道号
 */
export function runwayNumber(airport, reciprocal = false) {
  let h = airport.runwayHeading + (reciprocal ? 180 : 0);
  h = ((Math.round(h / 10) - 1) % 36 + 36) % 36 + 1;
  return String(h);
}
