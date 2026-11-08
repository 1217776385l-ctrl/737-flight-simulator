/**
 * scoreboard.js — 结算画面（单元 5 · 整合 + 单元 C 白话化）。
 *
 * state.touchdown.recorded 后调用 scoreLanding（单元 6 数据源约定），
 * 全屏结算卡：结局徽标 / 总分大数字 + breakdown 明细 / 中文评语 / 本局事件回放摘要。
 * 单元 C：接地率四级色带词、中线偏差白话方位、verdict 下追加一句"人话总评"
 * （全部基于 breakdown 现有字段在展示层生成，不改 scoring 源文件）；
 * 新手模式白话词为主、原始数字收进次级小字，行话模式反之。
 * 按钮：重试同局 / 回主菜单。
 */

import { injectStyle } from './style.js';

/** 结局 → 中文徽标文案 + 等级（good/mid/bad） */
const OUTCOME_ZH = {
  'normal': ['正常落地', 'good'],
  'emergency-landing': ['紧急落地', 'mid'],
  'ditching': ['水面迫降', 'mid'],
  'belly': ['机腹迫降', 'mid'],
  'off-field': ['野外迫降', 'bad'],
  'crash': ['坠毁', 'bad'],
};

/**
 * 接地率四级色带词（展示层白话，与结算内核阈值一致：<100/100-300/300-600/600+，
 * 600+ 同时是内核重着陆结构罚起点）。
 */
function fpmBand(fpm) {
  if (fpm < 100) return ['轻若羽毛', 'c-good'];
  if (fpm <= 300) return ['标准', 'c-mid'];
  if (fpm <= 600) return ['偏重', 'c-warn'];
  return ['重着陆', 'c-bad'];
}

/**
 * 中线偏差白话：内核 touchdown.centerlineOffsetM 存的是绝对值（Math.abs(z)），
 * 左右方位由 main.js 传入接地时刻的 state.position.z（跑道沿 +x，+z=东=右）。
 * 跑道半宽 22.5 m（内核 touchdown.onRunway 同口径）。
 */
function centerlineWord(b, signedZM) {
  const off = b.centerlineM ?? 0;
  if (!b.onRunway) return ['冲出跑道', 'c-bad'];
  if (off < 2) return ['正中跑道', 'c-good'];
  const side = (signedZM ?? 0) >= 0 ? '偏右' : '偏左';
  return [`${side} ${off.toFixed(1)} 米（跑道内）`, off <= 8 ? 'c-mid' : 'c-warn'];
}

/** 人话总评：基于 breakdown 现有字段生成一句总评（不改 scoring 源文件） */
function plainVerdict(result, clWord) {
  const b = result.breakdown;
  const [fpmWord] = fpmBand(b.touchdownFpm);
  const parts = [];
  if (result.outcome === 'crash') {
    return '这次落地太重了，飞机没能保住——下次记得提前收油门、带杆拉平，让轮子轻轻亲一下地面。';
  }
  const fpmSay = {
    '轻若羽毛': '落地轻得像羽毛',
    '标准': '落地很平稳',
    '偏重': '落地偏重了些（乘客会"咦"一声）',
    '重着陆': '落地很重，飞机得做结构检查',
  }[fpmWord] ?? '落地完成';
  parts.push(fpmSay);
  if (clWord[0] === '正中跑道') parts.push('而且稳稳压在跑道正中');
  else if (clWord[0] === '冲出跑道') parts.push('但是冲出了跑道');
  else parts.push(`落点${clWord[0].replace('（跑道内）', '')}`);
  if (b.overspeedOnTouchdown) parts.push('接地速度比建议快了些');
  if (!b.flapsAppropriate && (result.outcome !== 'belly' && result.outcome !== 'ditching')) {
    parts.push('不过落地时襟翼没放到着陆构型');
  }
  switch (result.outcome) {
    case 'normal': parts.push(`乘客几乎没感觉到——他们为你鼓掌，得分 ${result.score} 分`); break;
    case 'emergency-landing': parts.push('带着故障把大家安全带回了地面，处置得当。'); break;
    case 'ditching': parts.push('水面迫降完成，飞机停在水面上了。'); break;
    case 'belly': parts.push('机腹贴地滑停下来，机身伤得不轻但人都没事。'); break;
    case 'off-field': parts.push('落在跑道外的野外，有惊无险。'); break;
    default: break;
  }
  return parts.join('，') + '。';
}

/**
 * 创建结算画面。
 * @param {HTMLElement} root 挂载容器
 * @returns {{
 *   show: (result:{outcome,survived,survivalRate,score,breakdown,verdict},
 *          opts:{history:Array, routeZh:string, scenarioName:string|null,
 *                novice?:boolean, centerlineZM?:number,
 *                onMenu:Function, onRetry:Function}) => void,
 *   hide: () => void,
 *   isVisible: () => boolean,
 * }}
 */
export function createScoreboard(root) {
  injectStyle();
  const wrap = document.createElement('div');
  wrap.className = 'sim-ui';
  wrap.style.zIndex = '70'; // 结算卡置顶：高于 HUD(41) / K 标签 / dev E2E 日志(60)，总评永不被遮挡
  wrap.innerHTML = `
    <div class="sim-score-wrap" style="display:none">
      <div class="sim-score novice">
        <span class="badge">正常落地</span>
        <h2 class="route"></h2>
        <div class="score-big"><span class="num">0</span><small> / 1000 分</small></div>
        <div class="survival" style="font-size:13px;color:var(--sim-dim)"></div>
        <div class="sim-bd"></div>
        <div class="sim-verdict"></div>
        <div class="sim-verdict-plain"></div>
        <div class="sim-history"></div>
        <div class="sim-score-btns">
          <button class="b-retry primary">重试同局</button>
          <button class="b-menu">再来一局（主菜单）</button>
        </div>
      </div>
    </div>`;
  root.appendChild(wrap);
  const $ = (cls) => wrap.querySelector(cls);
  const panel = $('.sim-score-wrap');
  const card = $('.sim-score');

  /** 明细行：novice 模式白话词为主、原始数字收小字；行话模式反之（两者都可见） */
  function row(label, word, wordCls, raw) {
    return `<div>${label} <b class="plain-word ${wordCls}">${word}</b> <small class="raw-num">${raw}</small></div>`;
  }

  /**
   * 显示结算卡。
   * history 事件行格式：{t, type:'trigger'|'timeline'|'action'|'resolve'|'fail', label}
   */
  function show(result, opts) {
    const [zh, cls] = OUTCOME_ZH[result.outcome] ?? [result.outcome, 'mid'];
    const novice = opts.novice !== false; // 缺省新手模式
    card.classList.toggle('novice', novice);
    card.classList.toggle('pro', !novice);
    const badge = $('.badge');
    badge.textContent = zh;
    badge.className = `badge ${cls}`;

    $('.route').textContent = opts.routeZh + (opts.scenarioName ? ` · 险情：${opts.scenarioName}` : '');
    $('.num').textContent = String(result.score);
    $('.survival').textContent =
      `乘客存活率 ${(result.survivalRate * 100).toFixed(0)}%` +
      (result.survived ? ' —— 机组与乘员生还' : ' —— 事故后果严重');

    const b = result.breakdown;
    const [fpmWord, fpmCls] = fpmBand(b.touchdownFpm);
    const [clWord, clCls] = centerlineWord(b, opts.centerlineZM);
    const rows = [
      row('接地率', fpmWord, fpmCls, `${b.touchdownFpm} fpm`),
      ['坡度罚分', `${b.bankPenalty}`],
      ['漂移罚分', `${b.driftPenalty}`],
      row('中线偏差', clWord, clCls, `${b.centerlineM} m`),
      ['跑道内', b.onRunway ? '是' : '否'],
      ['接地表面', surfaceZh(b.surface)],
      ['襟翼构型', b.flapsAppropriate ? '着陆构型' : '构型不足'],
      ['Vref', `${b.vrefKt} kt`],
      ['超速接地', b.overspeedOnTouchdown ? '是' : '否'],
      ['重着陆罚', String(b.heavyLandingPenalty)],
    ];
    $('.sim-bd').innerHTML = rows
      .map((r) => (Array.isArray(r) ? `<div>${r[0]} <b>${r[1]}</b></div>` : r)).join('');
    $('.sim-verdict').textContent = result.verdict;
    $('.sim-verdict-plain').innerHTML =
      `<b>人话总评</b>${escapeHtml(plainVerdict(result, clWord))}`;

    const hist = $('.sim-history');
    const lines = (opts.history ?? []).map((h) => {
      const c = h.type === 'trigger' ? 'trig' : (h.type === 'resolve' || h.type === 'action') ? 'res' : '';
      return `<div><span class="t">T+${h.t.toFixed(0)}s</span> <span class="${c}">[${h.type}]</span> ${h.label || h.scenarioId || ''}</div>`;
    });
    hist.innerHTML = lines.length
      ? `<b style="color:var(--sim-dim)">本局事件回放</b>${lines.join('')}`
      : '<b style="color:var(--sim-dim)">本局无险情事件</b>';

    $('.b-menu').onclick = () => { hide(); opts.onMenu(); };
    $('.b-retry').onclick = () => { hide(); opts.onRetry(); };
    panel.style.display = 'flex';
  }

  function surfaceZh(s) {
    return { runway: '跑道', water: '水面', terrain: '野外地形', belly: '机腹' }[s] ?? s;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function hide() { panel.style.display = 'none'; }
  return { show, hide, isVisible: () => panel.style.display === 'flex' };
}
