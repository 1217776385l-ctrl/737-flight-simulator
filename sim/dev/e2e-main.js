/**
 * e2e-main.js — 无人干预的完整一局自动演示（单元 5 E2E 验收 · 内核修复后 v2）。
 *
 * 复用 src/main.js（主菜单/主循环/结算）。仿真由 setInterval 驱动（headless 虚拟时间
 * 下 rAF 只渲染不推进，定时器则被虚拟时间全速泵动），rAF 仅负责渲染出画面供截图。
 *
 * 内核修复后（APU 时序/AP 俯仰积分器/ALT 捕获滞环/LOC 侧修/AP 方向舵 PI/rngSeed）
 * 脚本层驾驶补偿已全部移除，改走真实 AP 链路：
 *   起飞（脚本人工抬轮，正爬升率收轮收襟翼）→ AP CMD（HDG SEL + ALT SEL 18000ft + SPD）
 *   → ALT SEL 下降捕获 3000ft → 目的地世界过渡 → APP 预位（LOC 截获+XTK 侧修+GS 截获）
 *   → 构型计划（襟翼 15/25/30、起落架、自动刹车）→ 30m 断开人工拉平（常规机组动作）
 *   → 接地反推刹车 → 结算画面。
 *
 * URL 参数：?stopAt=节点名（停在指定节点供截图）、?plain=1（无险情正常航班，
 * 断言 normal ≥850 分；默认剧本 engine-fire@climb，断言 emergency-landing ≥500）、
 * ?step=每步仿真秒数（默认 0.25）。
 * 节点：menu / takeoff-rotate / briefing / resolved / transition / external /
 *       nav-cruise（?stopAt 专用：巡航段导航卡）/ approach-papi / short-final / touchdown / score
 */

import { getVSpeeds, glideSlopeDevDeg } from '../src/kernel/index.js';
import { SCENARIOS } from '../src/scenarios/scenarios.js';

const S = window.__sim5;
const params = new URLSearchParams(location.search);
const STOP_AT = params.get('stopAt');
const PLAIN = params.has('plain'); // 无险情正常航班（结算断言 normal ≥850）
const STEP = parseFloat(params.get('step') ?? '0.25');
const MAX_TICKS = 12000; // 仿真秒数上限 = MAX_TICKS * STEP

/* =========================================================
 * DOM 日志区
 * ========================================================= */
const logEl = document.getElementById('e2e-log');
const wallT0 = performance.now();
function log(line, cls = '') {
  const w = ((performance.now() - wallT0) / 1000).toFixed(1).padStart(6);
  const sim = S.state ? `T+${S.state.time.toFixed(0).padStart(5)}` : 'T+----';
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = `w${w} ${sim}  ${line}`;
  logEl.appendChild(div);
  while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[e2e] ${line}`);
}

/** 节点快照：写日志；?stopAt= 命中则停住仿真并改标题（供无头截图） */
let stopped = false;
window.__e2eSnapshot = (name, detail) => {
  log(`SNAPSHOT ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`, 'snap');
  if (STOP_AT && name === STOP_AT && !stopped) {
    stopped = true;
    // 冻结后再推一个零步长 tick（dtSim=0 不改状态，只让 6Hz HUD / 导航卡刷新到最终 state）：
    // 保证截图里 HUD 与外部仪表/导航卡数字严格同源一致
    try { S.api.advance(0, 0.25); } catch { /* 忽略：节点未开局时 */ }
    document.title = `STOP:${name}`;
    log(`stopAt 命中：仿真已停住（节点 ${name}）`, 'warn');
  }
};

const markerSnap = new Set();
window.addEventListener('sim5:marker', (e) => {
  const { name, t, ...rest } = e.detail;
  log(`marker ${name} @T+${t.toFixed(1)}s ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`);
  if (name === 'resolved') {
    // 单发处置收尾：APU 启动（真实时序已修复，3s 可用；恢复电源属标准检查单）
    S.bus.send('apu/toggle');
    log('处置收尾：APU 启动（恢复电源）');
  }
  if (!markerSnap.has(name)) {
    markerSnap.add(name);
    if (name === 'briefing' && S.config?.practice) S.api.toggleActions(); // 简报截图同时展开 QRH 提示卡
    window.__e2eSnapshot(name, rest);
  }
});

/* =========================================================
 * 脚本飞行员（状态机，每仿真步驱动）
 * ========================================================= */
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

const CFG = {
  mode: 'scenario',
  from: 'ZSPD', to: 'OEJN',
  weight: 'std', hour: 'day', weather: 'good',
  scenarioId: PLAIN ? null : 'engine-fire', triggerPhase: 'climb',
  practice: true,
  routeDistKm: 120, // E2E 缩短航线（诚实简化：真实航线 150-300 km，此处压缩巡航段）
};

const p = {
  stage: 'wait-start',
  flapUpAt: 0,
  disposalIdx: 0,
  disposalArmAt: null,
  flags: {},
};

function setStage(s) {
  p.stage = s;
  log(`pilot → ${s}`);
}

function flag(name, val = true) {
  if (p.flags[name]) return false;
  p.flags[name] = val;
  return true;
}

/** 活动险情的 correctCommands 逐步自动处置（5 s 一条） */
function autoDisposal() {
  const st = S.state;
  const rt = S.engine.activeRuntime();
  if (!rt) return;
  if (p.disposalArmAt === null) {
    p.disposalArmAt = st.time + 5;
    log(`开始自动处置：${rt.name}（${rt.scenarioId}）`);
  }
  const sc = SCENARIOS.find((s) => s.id === rt.scenarioId);
  if (p.disposalIdx < sc.correctCommands.length && st.time >= p.disposalArmAt) {
    const c = sc.correctCommands[p.disposalIdx];
    if (c) {
      const args = typeof c.args === 'function' ? c.args(st, rt) : (c.args ?? []);
      if (c.cmd) S.bus.send(c.cmd, ...args);
      else if (c.damage) S.bus.damage[c.damage](...args);
      log(`处置 ${p.disposalIdx + 1}/${sc.correctCommands.length}: ${c.cmd ?? c.damage} ${JSON.stringify(args)}`);
    }
    p.disposalIdx++;
    p.disposalArmAt = st.time + 5;
  }
}

function pilot() {
  const st = S.state;
  const bus = S.bus;
  if (!S.flightActive) {
    if (p.stage === 'wait-start' && p.flags.menuSnap) {
      log(`开局：${CFG.from} → ${CFG.to} · ${PLAIN ? '无险情正常航班' : '剧本 engine-fire @climb'} · step ${STEP}s`);
      S.api.setRenderOnly(true);
      S.api.setSuppressKeyboard(true); // 脚本直接发 control 命令，屏蔽键盘轴回中覆盖
      S.api.startFlight(CFG);
      setStage('takeoff-setup');
    }
    return;
  }
  if (S.ended) return;

  autoDisposal();

  // 外部视角切回（爬升段切出后任意阶段高度越过 2900m 即切回座舱）
  if (p.flags.ext1 === 1 && st.agl > 2000) {
    p.flags.ext1 = 2;
    S.api.toggleExternal();
  }

  switch (p.stage) {
    case 'takeoff-setup':
      bus.send('brakes/set', 0);
      bus.send('flaps/set', 3); // 襟翼 5
      bus.send('spoilers/arm', true);
      setStage('takeoff-roll');
      break;

    case 'takeoff-roll': {
      bus.send('throttle/set', 1); // TOGA
      const vs = getVSpeeds(st.massKg, st.flaps.index);
      if (st.velocity.ias >= vs.vr + 2) {
        window.__e2eSnapshot('takeoff-rotate', { vr: vs.vr, ias: +st.velocity.ias.toFixed(0) });
        setStage('rotate');
      }
      break;
    }

    case 'rotate': {
      const el = clamp(0.15 + (11 - st.orientation.pitch) * 0.06, 0, 0.6);
      bus.send('control/elevator', el);
      if (st.velocity.vsFpm > 500 && st.agl > 15) setStage('climbout');
      break;
    }

    case 'climbout': {
      const el = clamp(0.10 + (11 - st.orientation.pitch) * 0.05, -0.2, 0.45);
      bus.send('control/elevator', el);
      // 配平到当前爬升速度（新纵向静稳定 V_trim = 260 − 130·trim；不配平则抬头顶不住）
      const tT = clamp((260 - clamp(st.velocity.ias, 140, 250)) / 130, 0, 1);
      const dT = clamp(tT - st.trim.stabilizer, -0.03, 0.03);
      if (Math.abs(tT - st.trim.stabilizer) > 0.005) bus.send('trim/nudge', +dT.toFixed(3));
      if (st.agl > 60) bus.send('gear/up');
      if (st.agl > 140 && st.velocity.vsFpm > 800) {
        bus.send('ap/engage');
        bus.send('ap/hdg', st.orientation.heading + (st.runway.headingDeg || 0)); // 罗盘值（wrapBus 换算回局部）
        bus.send('ap/alt', 18000); // 5490 m 巡航
        p.flapUpAt = st.time + 6;
        setStage('climb');
      }
      break;
    }

    case 'climb': {
      bus.send('ap/spd', 250);
      // uxBC2 截图钩子：?stopAt=nav-cruise 提前改平 12000ft 制造巡航段（正常跑不受影响）
      if (STOP_AT === 'nav-cruise' && flag('navcAlt')) {
        bus.send('ap/alt', 12000);
        log('nav-cruise 模式：提前改平 12000ft 制造巡航段');
      }
      // 外部追机视角验证（C 键）：2500m 切外景（切回见 pilot 前置块）
      if (!p.flags.ext1 && st.agl > 1500) {
        p.flags.ext1 = 1;
        S.api.toggleExternal();
        window.__e2eSnapshot('external', { aglM: Math.round(st.agl) });
      }
      if (st.flaps.index > 0 && st.time >= p.flapUpAt && st.velocity.ias > 200) {
        bus.send('flaps/up');
        p.flapUpAt = st.time + 8;
      }
      if (S.routeRemainingM <= 80000 && STOP_AT !== 'nav-cruise') {
        bus.send('ap/alt', 3000); // ALT SEL 下降捕获 3000ft（内核修复：捕获滞环+俯仰积分器，可直接用）
        bus.send('ap/spd', 280);
        log(`TOD：开始下降（剩余 ${(S.routeRemainingM / 1000).toFixed(0)} km）`);
        setStage('descent');
      }
      // uxBC2 截图钩子：?stopAt=nav-cruise（巡航平飞段的导航引导卡）
      if (STOP_AT === 'nav-cruise' && S.phase === 'cruise' && st.agl > 2500 && flag('navc')) {
        window.__e2eSnapshot('nav-cruise', {
          aglM: Math.round(st.agl),
          distKm: Math.round(S.routeRemainingM / 1000),
        });
      }
      break;
    }

    case 'descent':
      if (S.transitioned) {
        bus.send('ap/hdg', st.nav.courseDeg + (st.runway.headingDeg || 0)); // 罗盘值（courseDeg 已是局部角）
        log(`目的地过渡完成：${S.world.airport.name} · 航道 ${st.nav.courseDeg}°`);
        setStage('approach');
      }
      break;

    case 'approach': {
      const nav = st.nav;
      const m = st.ap.modes;
      // 单发进近 +10kt（真实单发进近技术）
      const oneEng = !st.engines[0].running || !st.engines[1].running;
      const vApp = oneEng ? 155 : 160;
      if (st.time >= (p.dbgAt ?? 0)) {
        p.dbgAt = st.time + 10;
        log(`dbg 进近 d=${(nav.distM / 1000).toFixed(1)}km alt=${(st.position.y * 3.28084).toFixed(0)}ft ias=${st.velocity.ias.toFixed(0)} vs=${st.velocity.vsFpm.toFixed(0)} loc=${m.locCaptured ? 1 : 0} gs=${m.gsCaptured ? 1 : 0} dev=${glideSlopeDevDeg(st).toFixed(2)}° apEng=${st.ap.engaged ? 1 : 0} hdgErr=${(st.orientation.heading - nav.courseDeg).toFixed(1)} brg=${nav.bearingDeg != null ? nav.bearingDeg.toFixed(1) : '—'} spd=${m.spd ? 1 : 0} thr=${st.throttle[0].toFixed(2)} trim=${st.trim.stabilizer.toFixed(2)} el=${st.control.elevator.toFixed(2)}`);
      }
      if (!p.flags.app && nav.locValid && nav.distM < 20000) {
        bus.send('ap/app');
        bus.send('ap/spd', oneEng ? 165 : 160);
        flag('app');
        log('APP 预位（LOC/GS 截获窗口）');
      }
      // 配平到进近速度（真实配平技术：新纵向静稳定 V_trim = 260 − 130·trim kt，
      // 不配平则低速度严重下俯 mush）
      const trimTgt = clamp((260 - vApp) / 130, 0, 1);
      const dTrim = clamp(trimTgt - st.trim.stabilizer, -0.02, 0.02);
      if (Math.abs(trimTgt - st.trim.stabilizer) > 0.005) bus.send('trim/nudge', +dTrim.toFixed(3));
      if (nav.distM < 14000 && flag('fl15')) { bus.send('flaps/set', 4); bus.send('ap/spd', oneEng ? 155 : 150); }
      if (nav.distM < 9000 && flag('gear')) {
        bus.send('gear/down');
        bus.send('flaps/set', 5);
        bus.send('autobrake/set', '2');
        bus.send('spoilers/arm', true);
        log('起落架放下 · 襟翼 25 · 自动刹车 2');
      }
      if (S.phase === 'approach' && nav.distM < 9000 && flag('papi')) {
        window.__e2eSnapshot('approach-papi', { distM: Math.round(nav.distM) });
      }
      if (nav.distM < 5500 && flag('fl30')) { bus.send('flaps/set', 6); }
      // 全程 AP（APP/LOC/GS+AT）直到 30m 拉平点（T17 同款：ap/disconnect 后人工拉平）
      if (st.agl < 12 && st.velocity.ias > 140 && flag('flareArm')) {
        bus.send('ap/disconnect'); // 断开 AP 同时脱离 AT
        log(`拉平点（AGL ${st.agl.toFixed(0)} m · IAS ${st.velocity.ias.toFixed(0)} kt · VS ${st.velocity.vsFpm.toFixed(0)} fpm）`);
        p.pitchTarget = st.orientation.pitch;
        setStage('flare');
      }
      break;
    }

    case 'flare': {
      const nav = st.nav;
      // T17 同款人工拉平：慢车渐收（-0.6/s）＋ 上仰 ≥2.5° 保持 ＋ 带杆量随速度衰减
      // 增加维持 ~-100~-150 fpm；真实拉平技术
      // 单发拉平保留部分油门（真实单发拉平技术：用油门控制接地率）
      const oneEng = !st.engines[0].running || !st.engines[1].running;
      const bleed = Math.max(oneEng ? 0.3 : 0.18, st.throttle[0] - 0.6 * 0.25);
      bus.send('throttle/set', +bleed.toFixed(3));
      p.pitchTarget = (p.pitchTarget ?? st.orientation.pitch) +
        clamp((-70 - st.velocity.vsFpm) * 0.0015, -0.3, 1.4) * 0.25 * 2;
      const el = clamp((p.pitchTarget - st.orientation.pitch) * 0.6 - st.orientation.pitchRate * 0.18, -1, 1);
      bus.send('control/elevator', +el.toFixed(3));
      // 方向舵保持航向/侧风修正（正常脚动作；AP 方向舵 PI 已随断开退出）
      if (nav.courseDeg != null) {
        const lz = -nav.distM * Math.sin((nav.bearingDeg - nav.courseDeg) * Math.PI / 180);
        const xwKt = Math.sin((st.weather.windDirDeg - nav.courseDeg) * Math.PI / 180) * st.weather.windKts;
        const crabDeg = Math.asin(clamp(xwKt / Math.max(st.velocity.ias, 100), -0.15, 0.15)) / (Math.PI / 180);
        const tgtHdgOff = clamp(-lz * (st.agl < 150 ? 0.09 : 0.04) + crabDeg, -6, 6);
        let hdgErr = st.orientation.heading - nav.courseDeg;
        while (hdgErr > 180) hdgErr -= 360;
        while (hdgErr < -180) hdgErr += 360;
        p.rud = clamp((p.rud ?? 0) + (tgtHdgOff - hdgErr) * 0.006 - st.orientation.headingRate * 0.08, -0.6, 0.6);
        bus.send('control/rudder', +p.rud.toFixed(3));
      }
      if (st.time >= (p.dbgAt ?? 0)) {
        p.dbgAt = st.time + 1;
        log(`dbg 拉平 agl=${st.agl.toFixed(1)} ias=${st.velocity.ias.toFixed(0)} vs=${st.velocity.vsFpm.toFixed(0)} pitch=${st.orientation.pitch.toFixed(2)} pt=${(p.pitchTarget ?? 0).toFixed(2)} el=${st.control.elevator.toFixed(2)} hdg=${st.orientation.heading.toFixed(1)} hdgErr=${(st.orientation.heading - nav.courseDeg).toFixed(1)} rud=${st.control.rudder.toFixed(2)} z=${st.position.z.toFixed(1)} x=${st.position.x.toFixed(0)}`);
      }
      if (st.agl < 60 && flag('shortFinal')) window.__e2eSnapshot('short-final', { aglM: +st.agl.toFixed(1), ias: +st.velocity.ias.toFixed(0), vs: Math.round(st.velocity.vsFpm) });
      if (st.touchdown.recorded) {
        // 保持带杆 -0.45 贴地（弹回空中会重置 recorded，漂移会毁中线分）
        bus.send('reverse/set', 1);
        bus.send('brakes/set', 0.7);
        window.__e2eSnapshot('touchdown', {
          vsFpm: Math.round(st.touchdown.vsFpm),
          surface: st.touchdown.surface,
          xM: Math.round(st.position.x),
          zM: +st.position.z.toFixed(1),
        });
        setStage('rollout');
      }
      break;
    }

    case 'rollout':
      if (st.velocity.ias < 25 && flag('stopped')) {
        if (p.rud) { p.rud = 0; bus.send('control/rudder', 0); }
        bus.send('reverse/set', 0);
        bus.send('brakes/set', 0.9);
        log(`滑跑停住：IAS ${st.velocity.ias.toFixed(0)} kt · 停在跑道 x=${Math.round(st.position.x)} m`);
        setStage('done');
      }
      break;

    default:
      break;
  }
}

/* =========================================================
 * 相位序列记录与断言（导航修复防回归）：
 * 允许的转移 = 沿 takeoff→climb→cruise→descent→approach→landing→rollout→ended
 * 单调前向（允许跨级：climb→cruise、cruise→descent 等）；
 * 禁止任何向 takeoff 的回跳；cruise→climb 回跳至多 1 次；其余回跳 FAIL。
 * ========================================================= */
const PHASE_ORDER = ['takeoff', 'climb', 'cruise', 'descent', 'approach', 'landing', 'rollout', 'ended'];
const phaseSeq = ['takeoff'];

function recordPhase() {
  const ph = S.phase;
  if (!ph || ph === phaseSeq[phaseSeq.length - 1]) return;
  phaseSeq.push(ph);
  log(`phase → ${ph} @T+${S.state.time.toFixed(0)}s（序列 ${phaseSeq.join(' → ')}）`);
}

function assertPhaseSeq() {
  const bad = [];
  let cruiseClimbBack = 0;
  if (phaseSeq[0] !== 'takeoff') bad.push(`起始相位 ${phaseSeq[0]} ≠ takeoff`);
  for (let i = 1; i < phaseSeq.length; i++) {
    const a = PHASE_ORDER.indexOf(phaseSeq[i - 1]);
    const b = PHASE_ORDER.indexOf(phaseSeq[i]);
    if (b > a) continue; // 单调前向（含跨级）
    if (a === 2 && b === 1) { cruiseClimbBack++; continue; } // cruise→climb 容忍 1 次
    bad.push(`${phaseSeq[i - 1]}→${phaseSeq[i]}`);
  }
  if (cruiseClimbBack > 1) bad.push(`cruise↔climb 横跳 ${cruiseClimbBack} 次（>1）`);
  if (bad.length) {
    log(`FAIL：相位序列回跳 ${bad.join(' ; ')}（全序列 ${phaseSeq.join(' → ')}）`, 'bad');
    return false;
  }
  log(`PASS：相位序列单调无回跳：${phaseSeq.join(' → ')}`);
  return true;
}

/* =========================================================
 * 定时驱动主循环（虚拟时间全速泵动 setInterval）
 * ========================================================= */
let ticks = 0;
const timer = setInterval(() => {
  if (stopped) return;
  ticks++;
  try {
    if (!S.flightActive) {
      if (p.stage === 'wait-start' && p.flags.menuSnap) pilot();
      return;
    }
    S.api.advance(STEP, 0.02);
    recordPhase();
    pilot();
    if (ticks > MAX_TICKS && !S.ended) {
      log(`FAIL：仿真超时（${(MAX_TICKS * STEP).toFixed(0)}s 未结算，stage=${p.stage}）`, 'bad');
      assertPhaseSeq();
      stopped = true;
    }
  } catch (err) {
    log(`pilot 异常：${err.message}`, 'bad');
    console.error(err);
    stopped = true;
  }
}, 1);

/* ---------- 结算断言 ---------- */
window.addEventListener('sim5:marker', (e) => {
  if (e.detail.name !== 'score') return;
  clearInterval(timer);
  const r = S.lastResult;
  if (!r) { log('FAIL：score 事件但无 lastResult', 'bad'); return; }
  log(`结算：outcome=${r.outcome} score=${r.score} 存活率=${(r.survivalRate * 100).toFixed(0)}% fpm=${r.breakdown.touchdownFpm} 中线=${r.breakdown.centerlineM}m 表面=${r.breakdown.surface}`);
  const ok = PLAIN
    ? (r.outcome === 'normal' && r.score >= 850)
    : (r.outcome === 'emergency-landing' && r.score >= 500);
  log(ok
    ? `PASS：结局 ${r.outcome} / 分数 ${r.score}（${PLAIN ? '正常落地 ≥850' : '火警局 emergency-landing'}）`
    : `WARN：结局/分数低于预期（${r.outcome} / ${r.score}）`, ok ? '' : 'warn');
  assertPhaseSeq(); // 相位序列防回归断言（回跳 → FAIL 行）
});

/* ---------- 首帧快照（主菜单） ---------- */
requestAnimationFrame(() => requestAnimationFrame(() => {
  window.__e2eSnapshot('menu');
  p.flags.menuSnap = true;
  log(`E2E 就绪：step=${STEP}s ${PLAIN ? '(plain 无险情)' : ''} stopAt=${STOP_AT ?? '（完整跑完）'}`);
}));
