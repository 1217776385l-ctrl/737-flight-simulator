/**
 * external-hud.js — 外部视角仪表叠加（单元 5 · uxBC2 任务 1）。
 *
 * 用户需求：切到第三人称外部视角时，在屏幕空余区域用仪表方式呈现关键数据。
 *
 * 组成（面板靠屏幕边缘、半透明深灰航空底 #2a2d31 体系，避开中央机体与既有提示条）：
 *  - 左下 MINI PFD（canvas）：航向刻度条 + 数字（罗盘值）、姿态球（俯仰/坡度）、
 *    空速 / 高度 / 升降率 / 地速 / 无线电高数字块
 *  - 右下 引擎与构型面板（DOM）：N1 左右双数字条、油门、襟翼档位、
 *    起落架三态（蓝=过渡 / 绿=放下 / 灰=收上）、配平
 *
 * 数据只读内核 state（铁律 1：不自己推算）；罗盘换算遵守 docs/kernel-api.md 航向约定：
 * 罗盘航向 = state.orientation.heading + state.runway.headingDeg（本文件唯一换算点）。
 * 重绘 10 Hz 限频（性能：外部视角不必要每帧重画 2D 仪表）。
 */

const M2FT = 3.28084;
const wrap360 = (d) => ((d % 360) + 360) % 360;
/** 襟翼手柄档位 → 度数标签（flaps.index 0..7） */
const FLAP_LEVER = ['0', '1', '2', '5', '15', '25', '30', '40'];

const CARD = ['北', '03', '06', '东', '12', '15', '南', '21', '24', '西', '30', '33'];

/** CSS 尺寸（canvas 内部按 dpr 放大） */
const CV_W = 296;
const CV_H = 186;

export function createExternalHud(root) {
  const wrap = document.createElement('div');
  wrap.className = 'sim-ext';
  wrap.style.display = 'none';
  wrap.innerHTML = `
    <div class="panel p-pfd">
      <h5>外部仪表 · MINI PFD</h5>
      <canvas class="pfd-cv"></canvas>
    </div>
    <div class="panel p-eng">
      <h5>引擎与构型</h5>
      <div class="erow"><span class="lab">N1 左</span><span class="bar"><i class="fill f-n1l"></i></span><b class="v-n1l">--</b></div>
      <div class="erow"><span class="lab">N1 右</span><span class="bar"><i class="fill f-n1r"></i></span><b class="v-n1r">--</b></div>
      <div class="erow"><span class="lab">油门</span><span class="bar"><i class="fill f-thr"></i></span><b class="v-thr">--</b></div>
      <div class="erow kv"><span class="lab">襟翼</span><b class="v-flap">--</b></div>
      <div class="erow kv"><span class="lab">起落架</span><b class="v-gear">--</b></div>
      <div class="erow kv"><span class="lab">配平</span><b class="v-trim">--</b></div>
    </div>`;
  root.appendChild(wrap);
  // e2e 页左下有日志区（#e2e-log，宽 46% / 高 34%）：整体上移让位，保证截图可见
  if (document.getElementById('e2e-log')) wrap.classList.add('e2e');

  const cv = wrap.querySelector('.pfd-cv');
  const ctx = cv.getContext('2d');
  const $ = (cls) => wrap.querySelector(cls);
  const els = {
    n1l: $('.v-n1l'), n1r: $('.v-n1r'), thr: $('.v-thr'),
    flap: $('.v-flap'), gear: $('.v-gear'), trim: $('.v-trim'),
    fN1l: $('.f-n1l'), fN1r: $('.f-n1r'), fThr: $('.f-thr'),
  };

  let visible = false;
  let lastDraw = -1e9;

  function setVisible(on) {
    on = !!on;
    if (on === visible) return;
    visible = on;
    wrap.style.display = on ? '' : 'none';
  }

  /* ================= DOM：引擎与构型（只读 state） ================= */
  function updateEnginePanel(st) {
    const n1l = st.engines[0].n1, n1r = st.engines[1].n1;
    els.n1l.textContent = `${(n1l * 100).toFixed(0)}%`;
    els.n1r.textContent = `${(n1r * 100).toFixed(0)}%`;
    els.fN1l.style.width = `${Math.min(100, n1l * 100)}%`;
    els.fN1r.style.width = `${Math.min(100, n1r * 100)}%`;
    const tAvg = (st.throttle[0] + st.throttle[1]) / 2;
    els.thr.textContent = `L ${(st.throttle[0] * 100).toFixed(0)} / R ${(st.throttle[1] * 100).toFixed(0)}%`;
    els.fThr.style.width = `${Math.min(100, tAvg * 100)}%`;
    // 襟翼：手柄档位（度数）+ 实际舵面角在移动中标注
    const lever = FLAP_LEVER[st.flaps.index] ?? '--';
    const moving = Math.abs(st.flaps.angle - Number(lever)) > 0.6;
    els.flap.textContent = `档位 ${lever}${moving ? '（移动中）' : ''}`;
    els.flap.className = `v-flap${moving ? ' amber' : ''}`;
    // 起落架三态：绿=放下锁定 / 蓝=过渡 / 灰=收上
    let gearTxt, gearCls;
    if (st.gear.position >= 1) { gearTxt = '放下'; gearCls = 'green'; }
    else if (st.gear.position <= 0) { gearTxt = '收上'; gearCls = ''; }
    else { gearTxt = st.gear.handleDown ? '放出中' : '收上中'; gearCls = 'blue'; }
    els.gear.textContent = gearTxt;
    els.gear.className = `v-gear ${gearCls}`;
    // 配平：负=机头向下（内核约定）
    const tr = st.trim.stabilizer;
    els.trim.textContent = Math.abs(tr) < 0.005 ? '中立'
      : `${tr > 0 ? '机头向上' : '机头向下'} ${Math.abs(tr).toFixed(2)}`;
  }

  /* ================= Canvas：MINI PFD ================= */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function box(x, y, w, h, label, value, color) {
    ctx.fillStyle = 'rgba(13,18,24,.85)';
    roundRect(x, y, w, h, 4); ctx.fill();
    ctx.strokeStyle = 'rgba(51,64,79,.9)'; ctx.stroke();
    ctx.fillStyle = '#8a97a5';
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(label, x + 6, y + 3);
    ctx.fillStyle = color;
    ctx.font = '700 15px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText(value, x + 6, y + h - 2);
  }

  function drawPfd(st) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== CV_W * dpr) {
      cv.width = CV_W * dpr; cv.height = CV_H * dpr;
      cv.style.width = `${CV_W}px`; cv.style.height = `${CV_H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CV_W, CV_H);
    ctx.fillStyle = 'rgba(20,26,33,.55)';
    roundRect(0, 0, CV_W, CV_H, 6); ctx.fill();

    const hdgC = wrap360((st.orientation.heading || 0) + (st.runway.headingDeg || 0)); // 罗盘值（唯一换算点）
    const pitch = st.orientation.pitch || 0;
    const bank = st.orientation.bank || 0;

    /* ---- 航向刻度条（罗盘值） ---- */
    const tapeY = 4, tapeH = 24, cx0 = CV_W / 2, pxPerDeg = 2.1;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, CV_W, tapeY + tapeH); ctx.clip();
    ctx.fillStyle = 'rgba(13,18,24,.85)';
    ctx.fillRect(0, 0, CV_W, tapeY + tapeH);
    ctx.textAlign = 'center';
    const t0 = Math.ceil((hdgC - 70) / 5) * 5;
    for (let t = t0; t <= hdgC + 70; t += 5) {
      const x = cx0 + (t - hdgC) * pxPerDeg;
      const v = wrap360(t);
      const major = v % 30 === 0;
      ctx.strokeStyle = major ? '#d8e0e8' : '#5a6a78';
      ctx.beginPath(); ctx.moveTo(x, tapeY + tapeH); ctx.lineTo(x, tapeY + tapeH - (major ? 8 : 4)); ctx.stroke();
      if (major) {
        ctx.fillStyle = '#d8e0e8';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(CARD[Math.round(v / 30) % 12], x, tapeY + 1);
      }
    }
    // 中心数字窗 + 指针
    ctx.fillStyle = '#1d2632';
    roundRect(cx0 - 24, 0, 48, 17, 3); ctx.fill();
    ctx.strokeStyle = '#4aa3ff'; ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '700 12px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${String(Math.round(hdgC) % 360).padStart(3, '0')}°`, cx0, 9);
    ctx.fillStyle = '#4aa3ff';
    ctx.beginPath();
    ctx.moveTo(cx0, tapeY + tapeH); ctx.lineTo(cx0 - 5, tapeY + tapeH - 7); ctx.lineTo(cx0 + 5, tapeY + tapeH - 7);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    /* ---- 姿态球 ---- */
    const acx = 74, acy = 116, r = 56, pxPerPitch = 2.6;
    ctx.save();
    ctx.beginPath(); ctx.arc(acx, acy, r, 0, Math.PI * 2); ctx.clip();
    ctx.translate(acx, acy);
    ctx.rotate(-bank * Math.PI / 180);
    const horizonY = pitch * pxPerPitch; // 俯仰抬头 → 地平线在球内下移
    ctx.fillStyle = '#2f6fb3';                       // 天
    ctx.fillRect(-r * 2, -r * 2 - 100, r * 4, r * 2 + 100 + horizonY);
    ctx.fillStyle = '#7a4f26';                       // 地
    ctx.fillRect(-r * 2, horizonY, r * 4, r * 3);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-r * 2, horizonY); ctx.lineTo(r * 2, horizonY); ctx.stroke();
    // 俯仰刻度（±10/20°）
    ctx.lineWidth = 1;
    ctx.font = '8px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const a of [-20, -10, 10, 20]) {
      const y = horizonY - a * pxPerPitch;
      const wHalf = a % 20 === 0 ? 22 : 13;
      ctx.strokeStyle = '#e8ecef';
      ctx.beginPath(); ctx.moveTo(-wHalf, y); ctx.lineTo(wHalf, y); ctx.stroke();
      ctx.fillText(String(Math.abs(a)), wHalf + 8, y);
      ctx.fillText(String(Math.abs(a)), -wHalf - 8, y);
    }
    ctx.restore();
    // 坡度刻度（固定）+ 坡度指针（随 bank 转）
    ctx.save();
    ctx.translate(acx, acy);
    ctx.strokeStyle = '#d8e0e8'; ctx.lineWidth = 1.5;
    for (const a of [-60, -45, -30, 0, 30, 45, 60]) {
      const rad = (a - 90) * Math.PI / 180;
      const len = a % 30 === 0 ? 8 : 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(rad) * r, Math.sin(rad) * r);
      ctx.lineTo(Math.cos(rad) * (r - len), Math.sin(rad) * (r - len));
      ctx.stroke();
    }
    ctx.rotate(-bank * Math.PI / 180);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(0, -r + 2); ctx.lineTo(-5, -r + 11); ctx.lineTo(5, -r + 11);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // 外圈 + 机体系（固定）
    ctx.strokeStyle = 'rgba(51,64,79,.95)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(acx, acy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(acx - 30, acy); ctx.lineTo(acx - 10, acy); ctx.lineTo(acx - 5, acy + 6);
    ctx.moveTo(acx + 30, acy); ctx.lineTo(acx + 10, acy); ctx.lineTo(acx + 5, acy + 6);
    ctx.stroke();
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(acx - 1.5, acy - 1.5, 3, 3);

    /* ---- 数字读出块 ---- */
    const ias = st.velocity.ias, altFt = st.position.y * M2FT, vs = st.velocity.vsFpm;
    box(148, 34, CV_W - 154, 32, '空速 IAS', `${ias.toFixed(0)} kt`, '#3ddc84');
    box(148, 70, CV_W - 154, 32, '高度 ALT', `${altFt.toFixed(0)} ft`, '#fff');
    box(148, 106, CV_W - 154, 32, '升降 VS',
      `${vs >= 0 ? '+' : ''}${Math.round(vs)} fpm`, vs >= 0 ? '#3ddc84' : '#ffb020');
    box(148, 142, (CV_W - 154 - 6) / 2, 32, '地速 GS', `${st.velocity.gs.toFixed(0)} kt`, '#d8e0e8');
    box(148 + (CV_W - 148) / 2 + 3, 142, (CV_W - 154 - 6) / 2, 32, '无线电高 RA', `${Math.max(0, st.agl).toFixed(0)} m`, '#d8e0e8');
  }

  /* ================= 入口：main.js 每帧调（内部 10 Hz 限频） ================= */
  function update(st) {
    if (!visible || !st) return;
    const now = performance.now();
    if (now - lastDraw < 100) return; // 10 Hz
    lastDraw = now;
    updateEnginePanel(st);
    drawPfd(st);
  }

  return { setVisible, update };
}
