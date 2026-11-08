/**
 * style.js — 单元 5（整合）共享样式。
 *
 * 统一艺术指导：深灰航空底色（与座舱 MAT.panelDark 一致）、白字、
 * 红=火警/警告、琥珀=注意、绿=正常（真实航空规范）。
 * 所有 UI（主菜单 / HUD / 简报卡 / 提示卡 / 结算卡）共用这套变量。
 */

const CSS = `
:root {
  --sim-bg: #0d1218;
  --sim-panel: #161d26;
  --sim-panel2: #1d2632;
  --sim-line: #33404f;
  --sim-text: #d8e0e8;
  --sim-dim: #8a97a5;
  --sim-green: #3ddc84;
  --sim-amber: #ffb020;
  --sim-red: #ff3b30;
  --sim-accent: #4aa3ff;
}
.sim-ui, .sim-ui * { box-sizing: border-box; }
.sim-ui {
  position: fixed; inset: 0; z-index: 40;
  color: var(--sim-text);
  font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  pointer-events: none;
}
.sim-ui button, .sim-ui select {
  font-family: inherit; color: var(--sim-text);
  background: var(--sim-panel2); border: 1px solid var(--sim-line);
  border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 14px;
}
.sim-ui button:hover { border-color: var(--sim-accent); color: #fff; }
.sim-ui select { pointer-events: auto; }

/* ---------- 主菜单 ---------- */
.sim-menu {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, rgba(8,12,17,.60), rgba(8,12,17,.88));
  pointer-events: auto; overflow: auto;
}
.sim-menu-box {
  width: min(680px, 94vw); background: var(--sim-panel);
  border: 1px solid var(--sim-line); border-radius: 12px; padding: 26px 30px 22px;
  box-shadow: 0 12px 48px rgba(0,0,0,.55);
}
.sim-menu h1 { margin: 0 0 2px; font-size: 24px; letter-spacing: 2px; color: #fff; }
.sim-menu .sub { color: var(--sim-dim); font-size: 12px; margin-bottom: 16px; }
/* 花体署名：Great Vibes（在线）→ Snell Roundhand（macOS 本地）→ 通用 cursive 回退 */
.made-by {
  margin-top: 14px; text-align: right; font-size: 15px; color: var(--sim-dim);
  font-family: 'Great Vibes', 'Snell Roundhand', 'Brush Script MT', cursive;
}
.made-by .sig {
  font-size: 26px; color: #cfe3ff; margin-left: 4px;
  text-shadow: 0 0 14px rgba(120,170,255,.35);
}
.sim-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.sim-tabs button { flex: 1; padding: 9px 0; font-size: 15px; }
.sim-tabs button.on { background: #23405e; border-color: var(--sim-accent); color: #fff; }
.sim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; margin-bottom: 12px; }
.sim-field label { display: block; font-size: 12px; color: var(--sim-dim); margin-bottom: 4px; }
.sim-field select { width: 100%; padding: 7px 8px; }
.sim-seg { display: flex; gap: 6px; flex-wrap: wrap; }
.sim-seg button { flex: 1; padding: 7px 4px; font-size: 13px; white-space: nowrap; }
.sim-seg button.on { background: #23405e; border-color: var(--sim-accent); color: #fff; }
.sim-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--sim-dim); margin: 10px 0 4px; }
.sim-check input { width: 15px; height: 15px; accent-color: var(--sim-accent); }
.sim-start {
  width: 100%; margin-top: 14px; padding: 13px 0; font-size: 17px; letter-spacing: 6px;
  background: #1d4ed8; border: none; border-radius: 8px; color: #fff;
}
.sim-start:hover { background: #2b5ce0; }
.sim-keys { margin-top: 14px; font-size: 11.5px; color: var(--sim-dim); line-height: 1.8; }
.sim-keys b { color: var(--sim-text); font-weight: 600; }

/* ---------- HUD 状态条 ---------- */
.sim-hud-status {
  position: absolute; top: 10px; left: 10px; padding: 8px 12px;
  background: rgba(13,18,24,.82); border: 1px solid var(--sim-line); border-radius: 8px;
  font: 12.5px/1.7 ui-monospace, Menlo, monospace; white-space: pre;
}
.sim-hud-warn {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  font: 700 15px/1 ui-monospace, monospace; color: var(--sim-red); letter-spacing: 2px;
  text-shadow: 0 0 8px rgba(255,59,48,.6); white-space: pre; text-align: center;
}
.sim-hud-warn.caution { color: var(--sim-amber); text-shadow: 0 0 8px rgba(255,176,32,.5); }
.sim-hud-hint {
  position: absolute; bottom: 8px; right: 12px; font-size: 11px; color: rgba(216,224,232,.55);
  font-family: ui-monospace, monospace; white-space: pre; text-align: right;
}
.sim-toast {
  position: absolute; top: 21%; left: 50%; transform: translateX(-50%);
  padding: 7px 16px; background: rgba(13,18,24,.85); border: 1px solid var(--sim-line);
  border-radius: 6px; font-size: 13.5px; transition: opacity .5s; opacity: 0;
}
.sim-toast.show { opacity: 1; }

/* ---------- 险情简报卡 ---------- */
.sim-brief {
  position: absolute; top: 25%; left: 50%; transform: translateX(-50%);
  width: min(560px, 90vw); padding: 14px 18px 12px;
  background: rgba(22,29,38,.94); border-radius: 10px;
  border: 2px solid var(--sim-amber);
  animation: sim-brief-flash 1s steps(1) infinite;
}
.sim-brief.red { border-color: var(--sim-red); }
@keyframes sim-brief-flash { 0% { box-shadow: 0 0 0 0 rgba(255,80,40,.0); border-width: 3px; }
  50% { box-shadow: 0 0 18px 2px rgba(255,80,40,.45); border-width: 2px; } }
.sim-brief h3 { margin: 0 0 6px; font-size: 17px; color: var(--sim-red); letter-spacing: 1px; }
.sim-brief:not(.red) h3 { color: var(--sim-amber); }
.sim-brief .tag { font-size: 11px; color: var(--sim-dim); margin-left: 8px; letter-spacing: 0; }
.sim-brief p { margin: 0; font-size: 14px; line-height: 1.75; color: #f2e9d8; }
.sim-brief .hint { margin-top: 8px; font-size: 11.5px; color: var(--sim-dim); }

/* ---------- 处置提示卡 ---------- */
.sim-actions {
  position: absolute; right: 12px; top: 90px; width: 300px; padding: 10px 14px 12px;
  background: rgba(22,29,38,.92); border: 1px solid var(--sim-line); border-left: 3px solid var(--sim-green);
  border-radius: 8px; font-size: 12.5px;
}
.sim-actions h4 { margin: 0 0 8px; font-size: 13px; color: var(--sim-green); }
.sim-actions ol { margin: 0; padding-left: 18px; line-height: 1.9; color: var(--sim-text); }
.sim-actions .none { color: var(--sim-dim); }

/* ---------- 暂停菜单 ---------- */
.sim-pause {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(5,8,12,.72); pointer-events: auto;
}
.sim-pause-box { background: var(--sim-panel); border: 1px solid var(--sim-line);
  border-radius: 10px; padding: 26px 34px; text-align: center; min-width: 260px; }
.sim-pause-box h2 { margin: 0 0 18px; font-size: 19px; letter-spacing: 8px; color: #fff; }
.sim-pause-box button { display: block; width: 100%; margin-top: 10px; padding: 10px 0; }

/* ---------- 结算画面 ---------- */
.sim-score-wrap {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(5,8,12,.78); pointer-events: auto; overflow: auto;
}
.sim-score {
  width: min(620px, 94vw); background: var(--sim-panel); border: 1px solid var(--sim-line);
  border-radius: 12px; padding: 24px 30px 20px; box-shadow: 0 12px 48px rgba(0,0,0,.6);
}
.sim-score .badge {
  display: inline-block; padding: 5px 16px; border-radius: 6px; font-size: 15px; letter-spacing: 3px;
  color: #fff; background: #2e7d32; margin-bottom: 4px;
}
.sim-score .badge.bad { background: #b0413e; }
.sim-score .badge.mid { background: #9a6b1f; }
.sim-score h2 { margin: 4px 0 2px; font-size: 18px; color: var(--sim-text); }
.sim-score .score-big { font: 700 54px/1.1 ui-monospace, monospace; color: #fff; margin: 8px 0 2px; }
.sim-score .score-big small { font-size: 15px; color: var(--sim-dim); font-weight: 400; }
.sim-bd { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 22px; margin: 14px 0;
  font: 12.5px/1.9 ui-monospace, Menlo, monospace; color: var(--sim-dim); }
.sim-bd b { color: var(--sim-text); font-weight: 600; float: right; }
.sim-verdict { border-top: 1px solid var(--sim-line); padding-top: 12px; font-size: 14px; line-height: 1.8; color: #f2e9d8; }
.sim-history { margin-top: 12px; border-top: 1px solid var(--sim-line); padding-top: 10px;
  font: 11.5px/1.9 ui-monospace, monospace; color: var(--sim-dim); max-height: 150px; overflow: auto; }
.sim-history .t { color: var(--sim-amber); }
.sim-history .trig { color: var(--sim-red); }
.sim-history .res { color: var(--sim-green); }
.sim-score-btns { display: flex; gap: 12px; margin-top: 18px; }
.sim-score-btns button { flex: 1; padding: 11px 0; font-size: 15px; }
.sim-score-btns button.primary { background: #1d4ed8; border: none; color: #fff; }

/* =========================================================
   单元 B/C：K 指南面板 / 上下文提示条 / 双层 HUD / 白话层
   （同体系：#2a2d31 深灰航空底、白字、红/琥珀点缀）
   ========================================================= */

/* ---------- 上下文提示条（屏幕下缘，按飞行阶段给"现在最该做什么"） ---------- */
.sim-hintbar {
  position: absolute; bottom: 36px; left: 50%; transform: translateX(-50%);
  max-width: 82vw; padding: 8px 18px;
  background: rgba(42,45,49,.92); border: 1px solid var(--sim-line);
  border-left: 3px solid var(--sim-amber); border-radius: 8px;
  font-size: 13.5px; line-height: 1.6; color: #fff; white-space: nowrap;
}
.sim-hintbar .txt { overflow: hidden; text-overflow: ellipsis; }
.sim-hintbar.mini { padding: 4px 10px; font-size: 11px; color: var(--sim-dim);
  border-left-color: var(--sim-line); }
.sim-hintbar.pulse { animation: sim-hint-pulse 1.15s ease-in-out infinite; }
@keyframes sim-hint-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,176,32,0); opacity: .82; }
  50% { box-shadow: 0 0 16px 3px rgba(255,176,32,.55); opacity: 1; }
}

/* ---------- K 指南面板 ---------- */
.sim-guide {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(1020px, 96vw); max-height: 90vh; overflow: auto;
  background: rgba(42,45,49,.97); border: 1px solid var(--sim-line);
  border-radius: 12px; padding: 18px 24px 20px; pointer-events: auto;
  box-shadow: 0 14px 52px rgba(0,0,0,.6);
}
.sim-guide h2 { margin: 0 0 2px; font-size: 19px; letter-spacing: 3px; color: #fff; }
.sim-guide .g-sub { font-size: 11.5px; color: var(--sim-dim); margin-bottom: 12px; }
.sim-guide .g-close {
  position: absolute; top: 14px; right: 16px; padding: 4px 12px; font-size: 12px;
}
.sim-guide h3 {
  margin: 14px 0 6px; font-size: 13px; letter-spacing: 2px; color: var(--sim-amber);
  border-bottom: 1px solid rgba(255,176,32,.25); padding-bottom: 4px;
}
.sim-guide .g-head, .sim-guide .g-row {
  display: grid; grid-template-columns: 150px 1.15fr 1.5fr; gap: 0 14px;
  padding: 3px 0; font-size: 12.5px; line-height: 1.55;
}
.sim-guide .g-head { color: var(--sim-dim); font-size: 11px; letter-spacing: 1px; }
.sim-guide .g-row:nth-child(even) { background: rgba(255,255,255,.03); }
.sim-guide .g-key { font-family: ui-monospace, Menlo, monospace; color: var(--sim-accent); font-weight: 600; }
.sim-guide .g-key .na { color: var(--sim-dim); font-weight: 400; font-size: 11px; }
.sim-guide .g-why { color: var(--sim-dim); }
.sim-guide .g-note { margin-top: 8px; font-size: 11px; color: var(--sim-dim); line-height: 1.7; }
.sim-guide .g-qr { font-size: 12.5px; line-height: 1.8; color: var(--sim-text); }
.sim-guide .g-qr b { color: #fff; }
.sim-guide .g-qr .abbr { font-family: ui-monospace, Menlo, monospace; color: var(--sim-accent); }

/* ---------- K 指南角落小标签（面板渐隐后常驻入口） ---------- */
.sim-guide-tag {
  position: absolute; bottom: 32px; right: 12px; padding: 5px 12px;
  background: rgba(42,45,49,.9); border: 1px solid var(--sim-line); border-radius: 6px;
  font: 11.5px ui-monospace, Menlo, monospace; color: var(--sim-text);
  pointer-events: auto; cursor: pointer; transition: opacity .8s;
}
.sim-guide-tag:hover { border-color: var(--sim-accent); color: #fff; }

/* ---------- 双层 HUD 状态条（新手/行话） ---------- */
.sim-hud-status .l-main { white-space: pre; }
.sim-hud-status .l-sub { white-space: pre; font-size: 11px; color: var(--sim-dim); margin-top: 1px; }
.sim-hud-status.novice .l-main { font-size: 14px; color: #fff; }

/* ---------- 险情简报白话行 ---------- */
.sim-brief .plain {
  margin-top: 8px; padding-top: 6px; border-top: 1px dashed rgba(138,151,165,.4);
  font-size: 12.5px; line-height: 1.7; color: #cfd8e0;
}
.sim-brief .plain b { color: var(--sim-amber); font-weight: 600; }

/* ---------- QRH 步骤白话括注 ---------- */
.sim-actions .note { color: var(--sim-dim); font-size: 11px; display: block; margin-top: 4px; }
.sim-actions li .plain-note { display: block; color: #a8b6c2; font-size: 11px; line-height: 1.6; }

/* ---------- 结算卡白话层 ---------- */
.sim-score .plain-word { font-weight: 700; }
.sim-score .raw-num { color: var(--sim-dim); font-weight: 400; }
.sim-score.novice .plain-word { font-size: 13px; }
.sim-score.novice .raw-num { font-size: 11px; }
.sim-score.pro .plain-word { font-size: 11.5px; font-weight: 500; }
.sim-score .plain-word.c-good { color: var(--sim-green); }
.sim-score .plain-word.c-mid { color: #fff; }
.sim-score .plain-word.c-warn { color: var(--sim-amber); }
.sim-score .plain-word.c-bad { color: var(--sim-red); }
.sim-verdict-plain {
  margin-top: 6px; font-size: 13.5px; line-height: 1.75; color: #f2e9d8;
}
.sim-verdict-plain b { color: var(--sim-amber); font-weight: 600; margin-right: 6px; }

/* =========================================================
   uxBC2：外部视角仪表叠加（external-hud.js）
   深灰航空风 #2a2d31 体系（与结算卡同色板）、靠屏幕边缘、半透明底
   ========================================================= */
.sim-ext {
  position: fixed; inset: 0; z-index: 39; pointer-events: none;
  font-family: ui-monospace, Menlo, monospace; color: var(--sim-text);
}
.sim-ext .panel {
  position: absolute; background: rgba(42,45,49,.82);
  border: 1px solid var(--sim-line); border-radius: 8px; padding: 7px 9px 8px;
}
.sim-ext .p-pfd { left: 12px; bottom: 12px; }
.sim-ext .p-eng { right: 12px; bottom: 64px; width: 238px; }
.sim-ext.e2e .p-pfd { bottom: 37vh; } /* e2e 页左下日志区让位，保证截图可见 */
.sim-ext .panel h5 {
  margin: 0 0 5px; font-size: 10px; font-weight: 600;
  letter-spacing: 2px; color: var(--sim-dim);
}
.sim-ext .erow {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; line-height: 1.9; white-space: nowrap;
}
.sim-ext .erow .lab { width: 44px; color: var(--sim-dim); }
.sim-ext .erow .bar {
  flex: 1; height: 8px; background: rgba(13,18,24,.9);
  border: 1px solid rgba(51,64,79,.9); border-radius: 3px; overflow: hidden;
}
.sim-ext .erow .fill { display: block; height: 100%; background: var(--sim-green); transition: width .12s linear; }
.sim-ext .erow .f-thr { background: var(--sim-accent); }
.sim-ext .erow b { width: 62px; text-align: right; font-weight: 600; font-size: 11px; }
.sim-ext .erow.kv b { flex: 1; }
.sim-ext .v-flap.amber, .sim-ext .v-gear.blue { color: #6db6ff; } /* 过渡=蓝 */
.sim-ext .v-gear.green { color: var(--sim-green); }               /* 放下=绿 */
.sim-ext .v-gear { color: var(--sim-dim); }                       /* 收上=灰 */

/* =========================================================
   uxBC2：导航引导卡（hud.js · J 键显隐，默认显示）
   位置：HUD 状态条下方左上；险情激活时让位（缩小降透明）
   ========================================================= */
.sim-navcard {
  position: absolute; top: 88px; left: 10px; width: 324px;
  padding: 7px 12px 9px;
  background: rgba(42,45,49,.92); border: 1px solid var(--sim-line);
  border-left: 3px solid var(--sim-accent); border-radius: 8px;
  font-size: 12.5px; line-height: 1.75;
  transition: opacity .3s, transform .3s; transform-origin: top left;
}
.sim-navcard.yield { opacity: .28; transform: scale(.9); } /* 险情简报优先：让位 */
.sim-navcard h5 {
  margin: 0 0 3px; font-size: 11px; letter-spacing: 2px; color: var(--sim-accent);
}
.sim-navcard h5 .k { color: var(--sim-dim); letter-spacing: 0; font-size: 10px; margin-left: 6px; }
.sim-navcard .n-route { color: #fff; font-weight: 600; }
.sim-navcard .n-grid { display: flex; gap: 16px; color: var(--sim-dim); font-size: 12px; }
.sim-navcard .n-grid b { color: var(--sim-text); font-family: ui-monospace, Menlo, monospace; }
.sim-navcard .n-turn { color: var(--sim-dim); font-size: 12px; }
.sim-navcard .n-turn .turn { color: var(--sim-amber); font-weight: 600; }
.sim-navcard .n-turn .ok { color: var(--sim-green); font-weight: 600; }
.sim-navcard .n-turn .dim { color: var(--sim-dim); }
.sim-navcard .n-advice {
  margin-top: 4px; padding-top: 5px; border-top: 1px dashed rgba(138,151,165,.4);
  color: #ffd98f; font-size: 12.5px; line-height: 1.6;
}
.sim-navcard .n-advice:empty { display: none; }
`;

/** 注入共享样式（幂等） */
export function injectStyle() {
  if (document.getElementById('sim-style')) return;
  const el = document.createElement('style');
  el.id = 'sim-style';
  el.textContent = CSS;
  document.head.appendChild(el);
}
