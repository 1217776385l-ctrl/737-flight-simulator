/**
 * menu.js — 主菜单（单元 5 · 整合）。
 *
 * 两种模式：
 *  - 航线模式：出发地 × 目的地（5 座机场两两组合，同场无效）+ 起飞重量 + 时刻 + 天气；
 *    巡航中按权重随机抛出一条险情。
 *  - 险情剧本模式：在任意航线上强制触发任选的 14 条险情之一（或随机），并选触发阶段。
 *
 * 用法：
 *   const menu = createMenu(rootEl, { onStart: (config) => {...} });
 *   menu.show();   // 显示（开始飞行后 hide）
 *
 * config 结构（传给 main.js 的 startFlight）：
 *   { mode:'route'|'scenario', from, to, weight:'light'|'std'|'heavy',
 *     hour:'dawn'|'day'|'dusk'|'night', weather:'good'|'storm',
 *     scenarioId:string|null, triggerPhase:string, practice:boolean,
 *     guided:boolean, novice:boolean, routeDistKm?:number }
 */

import { AIRPORTS, AIRPORT_IDS } from '../world/airports-data.js';
import { SCENARIOS } from '../scenarios/scenarios.js';
import { injectStyle } from './style.js';

/** 时刻选项 → 世界 hour（daynight 关键帧小时） */
export const HOUR_OPTIONS = {
  dawn: { label: '黎明', hour: 6.3 },
  day: { label: '白天', hour: 12 },
  dusk: { label: '黄昏', hour: 18.6 },
  night: { label: '夜', hour: 23 },
};

/** 起飞重量选项 → 内核初始燃油/载荷 kg（OEW 41400 + 载荷 + 燃油 = 总重） */
export const WEIGHT_OPTIONS = {
  light: { label: '轻 55 t', fuelKg: 5600, payloadKg: 8000 },
  std: { label: '标准 70 t', fuelKg: 14600, payloadKg: 14000 },
  heavy: { label: '重 78 t', fuelKg: 18600, payloadKg: 18000 },
};

const PHASE_OPTIONS = [
  ['takeoff', '起飞'], ['climb', '爬升'], ['cruise', '巡航'],
  ['descent', '下降'], ['approach', '进近'],
];

/**
 * 创建主菜单。
 * @param {HTMLElement} root 挂载容器（通常 document.body）
 * @param {{onStart: (config:Object) => void}} handlers
 * @returns {{show: Function, hide: Function, isVisible: () => boolean, getConfig: () => Object}}
 */
export function createMenu(root, handlers) {
  injectStyle();
  const wrap = document.createElement('div');
  wrap.className = 'sim-ui';
  wrap.innerHTML = `
    <div class="sim-menu" style="display:none">
      <div class="sim-menu-box">
        <h1>737-800 飞行模拟器</h1>
        <div class="sub">第一人称客机模拟 · 险情剧本与完整航线 · 内核状态实时驱动仪表</div>
        <div class="sim-tabs">
          <button data-tab="route" class="on">航线模式</button>
          <button data-tab="scenario">险情剧本模式</button>
        </div>
        <div class="sim-grid">
          <div class="sim-field"><label>出发地</label><select id="m-from"></select></div>
          <div class="sim-field"><label>目的地</label><select id="m-to"></select></div>
          <div class="sim-field scen-only" style="display:none"><label>险情</label><select id="m-scen"></select></div>
          <div class="sim-field scen-only" style="display:none"><label>触发阶段</label><select id="m-phase"></select></div>
          <div class="sim-field"><label>起飞重量</label><div class="sim-seg" id="m-weight"></div></div>
          <div class="sim-field"><label>时刻</label><div class="sim-seg" id="m-hour"></div></div>
          <div class="sim-field"><label>天气</label><div class="sim-seg" id="m-weather"></div></div>
          <div class="sim-field"><label>HUD 术语</label><div class="sim-seg" id="m-lang"></div></div>
        </div>
        <label class="sim-check"><input type="checkbox" id="m-practice" checked />
          练习模式（险情触发后按 H 可查看 QRH 处置提示；取消勾选为严格模式）</label>
        <label class="sim-check"><input type="checkbox" id="m-guided" checked />
          引导首飞（第一局逐步提示关键动作；飞行中随时按 K 看完整操作指南）</label>
        <button class="sim-start" id="m-start">开 始 飞 行</button>
        <div class="sim-keys">
          <b>P / ESC</b> 暂停 · <b>K</b> 操作指南 · <b>N</b> 新手/行话 HUD · <b>H</b> 处置提示 ·
          <b>C</b> 切换外部视角 · <b>J</b> 导航卡 · <b>M</b> 静音 ·
          <b>↑↓←→</b> 杆 · <b>PgUp/PgDn</b> 油门 · <b>F / V</b> 襟翼 · <b>G</b> 起落架 ·
          <b>B</b> 刹车 · <b>R</b> 反推 · <b>E</b> 双发启动 · <b>Ctrl+G</b> 自动驾驶
        </div>
        <div class="made-by">made by <span class="sig">LYU</span></div>
      </div>
    </div>`;
  root.appendChild(wrap);
  const $ = (id) => wrap.querySelector('#' + id);

  /* ---------- 下拉与分段选择 ---------- */
  for (const id of AIRPORT_IDS) {
    for (const sel of [$('m-from'), $('m-to')]) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `${AIRPORTS[id].name}（${id} · ${AIRPORTS[id].archetype.split('·')[1]?.trim() || ''}）`;
      sel.appendChild(o);
    }
  }
  $('m-from').value = 'ZSPD';
  $('m-to').value = 'OEJN';

  const scenSel = $('m-scen');
  {
    const o = document.createElement('option');
    o.value = 'random';
    o.textContent = '随机（按阶段权重）';
    scenSel.appendChild(o);
  }
  for (const s of SCENARIOS) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.name}（${s.category === 'mechanical' ? '机械' : '气象'}）`;
    scenSel.appendChild(o);
  }
  scenSel.value = 'engine-fire';
  for (const [v, label] of PHASE_OPTIONS) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    $('m-phase').appendChild(o);
  }
  $('m-phase').value = 'climb';

  /** 分段按钮组 */
  function seg(el, options, initial, onPick) {
    let cur = initial;
    for (const [v, label] of options) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { cur = v; refresh(); onPick?.(v); };
      b.dataset.v = v;
      el.appendChild(b);
    }
    function refresh() {
      for (const b of el.children) b.classList.toggle('on', b.dataset.v === cur);
    }
    refresh();
    return { get value() { return cur; } };
  }

  const weight = seg($('m-weight'), Object.entries(WEIGHT_OPTIONS).map(([k, v]) => [k, v.label]), 'std');
  const hour = seg($('m-hour'), Object.entries(HOUR_OPTIONS).map(([k, v]) => [k, v.label]), 'day');
  const weather = seg($('m-weather'), [['good', '好天'], ['storm', '雷暴']], 'good');
  const lang = seg($('m-lang'), [['novice', '新手模式'], ['pro', '行话模式']], 'novice');

  /* ---------- 模式页签 ---------- */
  let mode = 'route';
  for (const b of wrap.querySelectorAll('.sim-tabs button')) {
    b.onclick = () => {
      mode = b.dataset.tab;
      for (const x of wrap.querySelectorAll('.sim-tabs button')) x.classList.toggle('on', x === b);
      for (const el of wrap.querySelectorAll('.scen-only')) el.style.display = mode === 'scenario' ? '' : 'none';
    };
  }

  /* ---------- 同场无效：出发地 = 目的地时自动错开 ---------- */
  function fixDuplicate(changed) {
    if ($('m-from').value !== $('m-to').value) return;
    const ids = AIRPORT_IDS.filter((i) => i !== $('m-from').value);
    const other = changed === 'from' ? 'to' : 'from';
    $(other === 'from' ? 'm-from' : 'm-to').value = ids[0];
  }
  $('m-from').onchange = () => fixDuplicate('from');
  $('m-to').onchange = () => fixDuplicate('to');

  /* ---------- 对外 ---------- */
  function getConfig() {
    return {
      mode,
      from: $('m-from').value,
      to: $('m-to').value,
      weight: weight.value,
      hour: hour.value,
      weather: weather.value,
      scenarioId: mode === 'scenario' ? (scenSel.value === 'random' ? null : scenSel.value) : null,
      triggerPhase: $('m-phase').value,
      practice: $('m-practice').checked,
      guided: $('m-guided').checked,
      novice: lang.value === 'novice',
    };
  }

  $('m-start').onclick = () => { menuEl.style.display = 'none'; handlers.onStart(getConfig()); };

  const menuEl = wrap.querySelector('.sim-menu');
  return {
    show() { menuEl.style.display = 'flex'; },
    hide() { menuEl.style.display = 'none'; },
    isVisible: () => menuEl.style.display !== 'none',
    getConfig,
  };
}
