/**
 * landing-score.js — 着陆/迫降结算评分（纯函数 · 完全确定性）。
 *
 * 输入只读内核已填好的 state.touchdown（docs/kernel-api.md §3.9）与少量机况字段；
 * 同样输入 ⇒ 同样分数（无随机、无时间依赖）。
 *
 * ---- 判分维度（全部来自 state.touchdown）----
 *  接地率   vsFpm：|<60 fpm 满分；>600 fpm 重着陆结构罚；>1200 fpm 判坠毁
 *  坡度     bankDeg：>2° 开始扣，>5° 显著扣，>30° 判坠毁
 *  漂移     driftDeg（航迹与机头夹角）：>5° 开始扣（侧风修正质量）
 *  中线     centerlineOffsetM：≤3 m 满分，线性扣到 30 m 扣完
 *  跑道内   onRunway：跑道外 → 中线分归零 + 表面分按 terrain/water 计
 *  表面     surface：'runway' | 'water'（水面迫降 ditching）| 'terrain'（野外）| 'belly'（机腹）
 *  构型     flaps.angle ≥ 15°（≥襟翼 15）视为着陆构型 appropriate
 *  速度     接地 IAS 超 Vref+20 kt 记 overspeedOnTouchdown，线性扣分
 *
 * ---- 四种迫降结局判定 ----
 *  surface='water'  → ditching（姿态 10-12° 最好；vsFpm>800 视为解体）
 *  surface='belly'  → belly（速度与接地率共同决定）
 *  surface='terrain'→ off-field（可控野外迫降）或 crash（重接地）
 *  surface='runway' → normal / emergency-landing（有机况紧急语境时）
 *  crash 判据（任意表面通用）：vsFpm >1200 fpm 或坡度 >30°
 *
 * ---- survivalRate 成文规则 ----
 *  normal            1.00（>600 fpm 重着陆 0.90）
 *  emergency-landing 0.95（跑道紧急落地，疏散条件好）
 *  belly             0.85 基准；>300 fpm 线性衰减（最多 -0.50）；接地速度 >170 kt 再 -0.10
 *  ditching          姿态 8-14° 且 ≤300 fpm → 0.90；姿态 5-16° 且 ≤500 fpm → 0.75；
 *                    其余 0.55；>800 fpm 解体 → 0.30；坡度 >10° 再 ×0.8
 *  off-field         0.50 基准，随接地率线性衰减（最多 -0.30）
 *  crash             vsFpm>2000 或坡度>45° → 0；vsFpm>1200 → 0.25 线性衰减；坡度/地形坠毁 → 0.15
 */

import { clamp } from '../kernel/math.js';
import { getVref } from '../kernel/vspeeds.js';

/** 结局枚举 */
export const OUTCOMES = Object.freeze([
  'normal', 'emergency-landing', 'ditching', 'belly', 'off-field', 'crash',
]);

/** 各表面基础分（满分 150） */
const SURFACE_SCORE = Object.freeze({ runway: 150, water: 110, belly: 100, terrain: 60 });

/** 机况紧急语境检测：有火警/发动机停车/任何活动警告/氧气面罩落下 → 紧急落地 */
function detectEmergency(state) {
  if (state.fire.engines.some(Boolean) || state.fire.cabin) return true;
  if (!state.engines[0].running || !state.engines[1].running) return true;
  if ((state.warnings.active?.length ?? 0) > 0) return true;
  if (state.pressurization.o2MasksDropped) return true;
  return false;
}

/**
 * 着陆/迫降结算评分。
 * @param {Object} state 仿真状态树（接地后；读 touchdown / flaps / engines / fire / warnings 等）
 * @param {Object} [ctx]
 * @param {boolean} [ctx.emergency] 强制指定紧急落地语境（缺省按机况自动判定）
 * @param {string} [ctx.scenarioName] 触发险情名（仅用于评语文案）
 * @returns {{outcome:string, survived:boolean, survivalRate:number, score:number,
 *            breakdown:Object, verdict:string}}
 */
export function scoreLanding(state, ctx = {}) {
  const td = state.touchdown;
  const vs = clamp(td.vsFpm ?? 0, 0, 6000);
  const bank = clamp(td.bankDeg ?? 0, 0, 90);
  const drift = Math.abs(td.driftDeg ?? 0);
  const centerlineM = Math.abs(td.centerlineOffsetM ?? 0);
  const surface = td.surface ?? 'runway';
  const onRunway = td.onRunway === true;

  /* ---------- 1. 结局判定 ---------- */
  const catastrophic = vs > 1200 || bank > 30;
  let outcome;
  if (surface === 'water') {
    outcome = catastrophic ? 'crash' : 'ditching';
  } else if (surface === 'belly') {
    outcome = catastrophic ? 'crash' : 'belly';
  } else if (surface === 'terrain') {
    outcome = (catastrophic || vs > 600) ? 'crash' : 'off-field';
  } else {
    outcome = catastrophic ? 'crash'
      : ((ctx.emergency ?? detectEmergency(state)) ? 'emergency-landing' : 'normal');
  }

  /* ---------- 2. 分项（正分累加，罚分单列） ---------- */
  // 接地率 0..400：≤60 fpm 满分，60→600 线性归零
  const fpmScore = vs <= 60 ? 400 : vs >= 600 ? 0 : 400 * (600 - vs) / 540;
  // 中线 0..150：跑道外归零
  const centerlineScore = onRunway
    ? (centerlineM <= 3 ? 150 : centerlineM >= 30 ? 0 : 150 * (30 - centerlineM) / 27)
    : 0;
  // 坡度 0..100：>2° 线性扣
  const bankScore = bank <= 2 ? 100 : Math.max(0, 100 - (bank - 2) * 8);
  // 漂移 0..60：>5° 线性扣
  const driftScore = drift <= 5 ? 60 : Math.max(0, 60 - (drift - 5) * 4);
  // 表面 0..150
  const surfaceScore = SURFACE_SCORE[surface] ?? 100;
  // 襟翼构型 0..50（机腹/水面迫降不受构型约束，给中性 25）
  const flapsAppropriate = (state.flaps?.angle ?? 0) >= 15;
  const flapsScore = (outcome === 'belly' || outcome === 'ditching') ? 25 : (flapsAppropriate ? 50 : 0);
  // 接地速度 0..50：≤Vref+20 满分，线性扣
  const massKg = state.massKg ?? 60000;
  const vref = getVref(massKg, state.flaps?.index ?? 6);
  const overspeed = (td.iasKt ?? 0) > vref + 20;
  const speedScore = clamp(50 - Math.max(0, (td.iasKt ?? 0) - vref - 20) * 1.2, 0, 50);
  // 重着陆结构罚（>600 fpm 每超 1 fpm 扣 0.6，上限 250）
  const heavyPenalty = vs > 600 ? Math.min(250, (vs - 600) * 0.6) : 0;

  let score = fpmScore + centerlineScore + bankScore + driftScore +
    surfaceScore + flapsScore + speedScore - heavyPenalty;

  /* ---------- 3. 坠毁：分数只反映撞击剧烈程度 ---------- */
  if (outcome === 'crash') {
    const severity = Math.max((vs - 1000) / 12, bank * 3, surface === 'terrain' ? 120 : 60);
    score = clamp(150 - severity, 0, 150);
  }
  score = clamp(Math.round(score), 0, 1000);

  /* ---------- 4. 存活率（规则见文件头注） ---------- */
  let survivalRate;
  switch (outcome) {
    case 'normal':
      survivalRate = vs > 600 ? 0.90 : 1.0;
      break;
    case 'emergency-landing':
      survivalRate = 0.95;
      break;
    case 'belly':
      survivalRate = 0.85 * (1 - Math.min(0.5, Math.max(0, vs - 300) / 1500));
      if ((td.iasKt ?? 0) > 170) survivalRate -= 0.10;
      break;
    case 'ditching': {
      const p = td.pitchDeg ?? 0;
      if (vs > 800) survivalRate = 0.30;                          // 水面解体
      else if (p >= 8 && p <= 14 && vs <= 300) survivalRate = 0.90; // 姿态标准（10-12° 最佳）
      else if (p >= 5 && p <= 16 && vs <= 500) survivalRate = 0.75;
      else survivalRate = 0.55;
      if (bank > 10) survivalRate *= 0.8;                          // 单侧翼尖先入水
      break;
    }
    case 'off-field':
      survivalRate = 0.50 * (1 - Math.min(0.6, Math.max(0, vs - 300) / 1000));
      break;
    case 'crash':
      if (vs > 2000 || bank > 45) survivalRate = 0;
      else if (vs > 1200) survivalRate = Math.max(0, 0.25 * (1 - (vs - 1200) / 800));
      else survivalRate = 0.15; // 坡度/地形坠毁
      break;
    default:
      survivalRate = 0;
  }
  survivalRate = clamp(survivalRate, 0, 1);
  const survived = outcome !== 'crash' && survivalRate > 0.3;

  /* ---------- 5. 中文评语 ---------- */
  const parts = [];
  parts.push(`接地 ${Math.round(vs)} fpm、坡度 ${bank.toFixed(1)}°、中线偏差 ${centerlineM.toFixed(1)} m`);
  if (vs > 600 && outcome !== 'crash') parts.push('重着陆——结构检查必做');
  if (centerlineM > 15 && onRunway) parts.push('中线偏差过大');
  if (!onRunway && surface === 'terrain') parts.push('接地于跑道外地形');
  let verdict;
  switch (outcome) {
    case 'normal':
      verdict = vs <= 60
        ? `教科书式落地：${parts.join('，')}。乘客全员平安。`
        : `安全落地：${parts.join('，')}。`;
      break;
    case 'emergency-landing':
      verdict = `紧急落地完成${ctx.scenarioName ? `（${ctx.scenarioName}）` : ''}：${parts.join('，')}。乘员安全撤离。`;
      break;
    case 'ditching':
      verdict = (td.pitchDeg ?? 0) >= 8 && (td.pitchDeg ?? 0) <= 14 && vs <= 300
        ? `水面迫降姿态标准：${parts.join('，')}。机长教科书式 ditching，多数乘员获救。`
        : `水面迫降完成但姿态/接地率非理想：${parts.join('，')}。部分乘员落水。`;
      break;
    case 'belly':
      verdict = `机腹迫降完成：${parts.join('，')}。机体损伤但乘员生还率良好。`;
      break;
    case 'off-field':
      verdict = `跑道外迫降：${parts.join('，')}。野外地形着陆，乘员部分受伤。`;
      break;
    case 'crash':
      verdict = `坠毁：${parts.join('，')}。本次飞行以事故告终。`;
      break;
    default:
      verdict = parts.join('，');
  }
  if (ctx.scenarioName && outcome !== 'emergency-landing') verdict += `（险情：${ctx.scenarioName}）`;

  return {
    outcome,
    survived,
    survivalRate: Math.round(survivalRate * 1000) / 1000,
    score,
    breakdown: {
      touchdownFpm: Math.round(vs),
      bankPenalty: Math.round(100 - bankScore),
      driftPenalty: Math.round(60 - driftScore),
      centerlineM: Math.round(centerlineM * 10) / 10,
      onRunway,
      surface,
      flapsAppropriate,
      overspeedOnTouchdown: overspeed,
      heavyLandingPenalty: Math.round(heavyPenalty),
      vrefKt: vref,
    },
    verdict,
  };
}
