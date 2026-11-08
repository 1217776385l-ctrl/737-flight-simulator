/**
 * hud.js — 飞行中 HUD / 事件 UI（单元 5 · 整合 + 单元 B/C 引导与双语层）。
 *
 * 组成：
 *  - 左上状态条（双层）：新手模式 `空速/高度/航向·八方位/燃油·吨位+续航`，
 *    行话模式保持 IAS/ALT/HDG 原样（N 键切换，main.js 驱动）
 *  - 上下文提示条（屏幕下缘）：按飞行阶段给"现在最该做什么"；
 *    险情触发时优先级最高；引导首飞时呼吸闪烁；行话模式收成小标签
 *  - K 键操作指南面板：按键/动作/何时用三列分组 + 仪表速查卡；
 *    首局（引导首飞）默认展开、30 秒后渐隐为右下角小标签
 *  - J 键导航引导卡（默认显示）：航线/待飞距离/直飞航向（罗盘）/转向指示/阶段建议；
 *    险情简报激活时让位缩小（数据由 main.js 每帧喂 setNav）
 *  - 顶部警告条 / 险情简报卡（附白话行）/ QRH 处置提示卡（每步附白话括注）
 *  - toast / 暂停菜单
 *
 * 全部只读内核 state / 剧本引擎快照，自身不推算仿真量。
 * 白话映射表为通用表述，具体以简报/QRH 原文为准。
 */

import { injectStyle } from './style.js';

/** 飞行阶段 → 中文名 */
export const PHASE_ZH = {
  takeoff: '起飞', climb: '爬升', cruise: '巡航',
  descent: '下降', approach: '进近', landing: '着陆',
};

/** 八方位中文（航向新手化：0/360=北 顺时针） */
const DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
function compassZh(hdg) {
  return DIR8[Math.round((((hdg % 360) + 360) % 360) / 45) % 8];
}

/* =========================================================
 * 上下文提示条 · 阶段 → 提示文案表（key 由 main.js 按阶段/构型算出）
 * ========================================================= */
const HINTS = {
  'scenario': '【险情处置优先】先读简报卡并照做——按 H 查看 QRH 处置步骤（练习模式）',
  'to-ground': '【起飞】按 PgUp 推满油门（起飞推力 TOGA），让飞机沿跑道中线加速',
  'to-roll': '【起飞】继续加速——接近抬轮速度（约 145 kt）时准备按 ↓ 拉杆',
  'to-rotate': '【起飞】按住 ↓（下方向键）拉杆抬轮，保持俯仰 10-13°，形成正爬升率',
  'climb-gear': '【爬升】正爬升率——按 G 收起落架',
  'climb-flaps': '【爬升】按 F 逐档收襟翼',
  'climb': '【爬升】保持仰角与爬升速度；按 Ctrl+G 可接通自动驾驶',
  'cruise': '【巡航】保持航向与高度；若弹出险情简报，优先按简报处置（按 H 看 QRH）',
  'descent': '【下降】提前减速：目标进近速度约 160 kt，可按 V 放襟翼减速',
  'app-gear': '【进近】减速到进近速度：按 G 放起落架、按 V 放襟翼，对正跑道',
  'approach': '【进近】稳定进近：目视 PAPI 灯（跑道边红白灯排，两白两红=高度刚好）或跟随 ILS，低于 150 m 转入短五边',
  'final': '【短五边】盯住 PAPI 灯（跑道边红白灯排）两白两红——全白偏高、全红偏低；过跑道头轻点 ↓ 柔和拉平',
  'rollout': '【落地滑跑】按住 B 刹车、按 R 开反推，减速停稳',
};

/* =========================================================
 * 险情简报白话映射（按险情 id；通用白话，具体以简报原文为准）
 * ========================================================= */
const BRIEF_PLAIN = {
  'single-engine-fail': '一台发动机突然停了：飞机会往那边偏，先用舵稳住方向。还没起飞就直接刹车停下来；在空中就关掉坏发，用剩下的一台落地。',
  'dual-engine-fail': '两台发动机都没推力了（鸟撞）：飞机变成滑翔机——别慌，保持速度往前滑，边滑边试着重启，不行就挑个好地方迫降。',
  'engine-fire': '你的一台发动机着火了：需要把那台发动机关掉（断油）并喷灭火瓶，然后用剩下的一台发动机就近落地。',
  'cabin-press-loss': '机舱漏气了，氧气面罩已经落下：先戴好面罩，然后马上把飞机紧急下降到空气够呼吸的低高度。',
  'hydraulic-fail': '控制襟翼、起落架、刹车的一套液压系统没压力了：东西还能动但变慢变沉，按受限办法放轮、挑长跑道落地。',
  'fuel-leak': '飞机在漏油：把漏油那侧的油路隔离开，别把好油也漏光，尽快飞去最近的机场落地。',
  'airspeed-unreliable': '空速表不可靠了（测速管被堵）：别信它，按记住的俯仰角和油门位置飞，参考 GPS 地速。',
  'flaps-jam': '襟翼卡住了，收放不了：落地速度会比平时快、滑跑距离比平时长，一定要挑条长跑道。',
  'cabin-fire': '客舱里有火情/烟雾：乘务组在灭火，你要用最快的速度落地，落地后立刻撤离。',
  'windshear': '风突然反向猛吹（风切变）：在地面上就直接中断起飞；在空中就把油门推到最大、机头抬 15° 往上脱离，什么都不要收。',
  'thunderstorm-icing': '进了雷雨和结冰区：飞机在结冰、颠簸很厉害——开防冰、绕开雷暴走。',
  'crosswind-gust': '很强的横侧风：进近时机头要斜着对风抵消 drift，快接地时再摆正，接地后稳住方向。',
  'fog-cat1': '雾很大只能看清 550 米：跟着 ILS 仪表下到 200 英尺决断高，看见跑道就继续落，看不见就复飞拉起来。',
  'gear-jammed': '起落架放不下来：备用办法也放不下时，只能机腹贴地降落——挑长跑道，接地前把发动机关掉。',
};

/* =========================================================
 * QRH 步骤白话括注映射（按险情 id + 步骤序号，与 correctActions 对齐；
 * 通用白话，具体以 QRH 原文为准）
 * ========================================================= */
const ACTION_PLAIN = {
  'single-engine-fail': [
    '先看清是哪台停了，用方向舵抵住飞机往坏发那边歪，再用配平放松手上的劲',
    '速度还没到决断速度 V1 就出事：油门收到底、最大刹车，把飞机停住',
    '把坏发那边的油门杆收到慢车位',
    '拉坏发的起动手柄到断开位——等于切断它的油路',
    '打开 APU（机尾的小发电机），留个备用电源',
    '稳住速度别掉，喊 PAN PAN，找条近跑道用一台发动机落地',
  ],
  'dual-engine-fail': [
    '先开 APU，把电救回来',
    '试着把两台发动机重新点着',
    '机头压到滑翔姿态：约 220 kt，每掉 1000 英尺高度大约能往前滑 3.7 公里',
    '挑迫降点：水面（机头 10-12° 入水）或最近的跑道',
    '快落地时放襟翼 15，接地前把两台发动机关掉',
  ],
  'engine-fire': [
    '把着火那台发的油门收到慢车',
    '拉起动手柄到断开位——先断油，火才烧不大起来',
    '拔出发动机灭火手柄，旋转到 1 号位——喷灭火瓶',
    '30 秒后火警灯还亮就转到 2 号位（本模拟一次即灭）',
    '用一台发动机落地：襟翼 15、速度比 Vref 快 10 节，就近落',
  ],
  'cabin-press-loss': [
    '先给自己戴好氧气面罩再通话——人清醒才开得了飞机',
    '断开自动驾驶，油门收慢车，打开扰流板（帮助下降）',
    '紧急下降到 10000 英尺：飞机可以全速往下扎',
    '舱内压力稳住后，修复增压（关外流活门）',
    '高度稳了再恢复自动驾驶，继续去落地',
  ],
  'hydraulic-fail': [
    '确认是哪套液压失效（A 或 B），警告灯会告诉你',
    '看一眼备用液压泵的状态（本模拟备用泵受限，按受限构型继续）',
    '襟翼放不到正常角度了：速度按卡阻表多留余量',
    '起落架用人工重力放：摇手柄让轮子靠重力掉下来',
    '预位自动刹车，挑条长跑道，落地就算处置成功',
  ],
  'fuel-leak': [
    '先确认是哪边油箱在漏（看两边油量差、目视机翼）',
    '关掉交输活门——别让好油箱的油也流过去漏掉',
    '关掉漏油那侧的燃油泵——把漏的油箱隔离',
    '直飞最近的机场，一路盯着总油量',
    '油快见底就别挑了：立即落地，必要时野外迫降',
  ],
  'airspeed-unreliable': [
    '确认空速表不可靠：两边读数对不上、和地速矛盾',
    '断开自动驾驶——它在用坏数据',
    '断开自动油门，油门自己扶着',
    '按 QRH 表里"俯仰+油门"的固定组合飞，参考 GPS 地速',
    '飞出雨雪区空速恢复后，再恢复自动化',
  ],
  'flaps-jam': [
    '确认襟翼卡住：手柄位置和实际襟翼对不上',
    '把襟翼手柄收到卡住的那个位置（别再硬放）',
    '按卡住的档位算落地速度——会比平时快不少',
    '挑长跑道：着陆距离按 1.5 倍以上留',
    '接地后：反推全开 + 自动刹车 MAX + 扰流板',
  ],
  'cabin-fire': [
    '让乘务组定位火源并用海伦灭火瓶灭火',
    '驾驶舱释放客舱灭火瓶',
    '立即下降、就近落地——越快落地越好',
    '落地停稳后立刻紧急撤离',
  ],
  'windshear': [
    '识别风切变：空速/下沉率/姿态突然乱跳',
    '还没起飞就立刻中断；在空中就把油门推到最大（TOGA）',
    '机头抬到 15°，襟翼构型保持不动',
    '脱离之前：不收油门、不收襟翼、不收起落架',
  ],
  'thunderstorm-icing': [
    '打开发动机防冰（保护发动机进气道不结冰）',
    '打开机翼防冰（机翼结冰会掉升力）',
    '看气象雷达绕开雷暴，或改高度脱离结冰区',
    '襟翼少用、速度多留 10 节余量（结冰让失速速度变高）',
  ],
  'crosswind-gust': [
    '先估侧风有多大（演示限值内）',
    '五边：机头偏向风来的方向、向风侧压盘，让飞机轨迹压住跑道中线',
    '快接地时蹬舵把机头摆正，上风侧主轮先接地',
    '接地后向风侧压盘、方向舵保持方向',
  ],
  'fog-cat1': [
    '预位 APP 按钮，让自动驾驶去截获航向道和下滑道',
    '1000 英尺前把速度、构型、下滑道都稳定下来',
    '到 200 英尺决断高：看见跑道/进近灯就继续，看不见就复飞',
    '雨刷开低速档、开着陆灯',
  ],
  'gear-jammed': [
    '放下起落架手柄，盯住三个起落架的位置指示灯',
    '试备用放出系统',
    '人工重力放出：摇 25 秒手柄（本模拟依然卡住）',
    '确认放不下就机腹迫降：挑长跑道，接地前关车断电',
    '襟翼 15，机头保持 5-8° 让机腹轻触地',
  ],
};

/** 仪表速查卡（K 指南尾节）：缩写 → 白话 */
const INSTRUMENT_QR = [
  ['PFD', '主飞行显示', '你正前方的主屏：左空速带 / 中间姿态球（蓝色天空+棕色地面） / 右高度带。绿=正常，红=警告，琥珀=注意。'],
  ['ND', '导航显示', '机长侧外圈大屏：航向、航迹、导航台与跑道位置，进近时看它对正跑道。'],
  ['EICAS', '发动机与机组警告系统', '中央上屏 = N1 转速/EGT 温度等发动机参数；下屏 = 燃油/液压/电气等系统简图。指针出红区就是出问题。'],
  ['MCP', '方式控制面板', ' glareshield（遮光板）上那排玻璃面板：HDG/SPD/ALT/VS 目标窗与 CMD/APP 按钮，本模拟可直接点击旋钮。'],
  ['OHD', '顶板 Overhead', '头顶那块系统板：燃油泵、防冰、电源、雨刷等开关（本模拟可点击）。'],
  ['PEDESTAL', '中央操纵台', '两座之间：油门杆、襟翼手柄、起落架手柄、配平轮、Trim/反推。'],
];

/** K 指南分组数据：[按键, 动作, 何时用]，已逐条对照 kernel/input.js 与 main.js 核实 */
const GUIDE_SECTIONS = [
  ['操纵', [
    ['↓ / ↑', '拉杆（机头抬起）/ 推杆（机头下压）', '起飞抬轮、空中保持姿态、落地拉平'],
    ['← / →', '向左 / 向右压杆（滚转）', '转弯、修正航向与侧风'],
    [', / .', '配平：机头向下 / 向上（[ ] 同）', '松杆后飞机自己稳住——抬轮后配平卸力最常用'],
    ['方向舵', '未绑定独立键（未实现）', '随滚转轻微联动；单发偏航请先压杆配平姿态'],
    ['Shift（按住）', '下视看仪表（平滑低头；座舱视角单元交付后自动生效）', '平飞时瞄一眼 PFD/EICAS——松开回到平视'],
  ]],
  ['油门与引擎', [
    ['PgUp / PgDn', '油门加 / 减（+ / - 同）', '起飞推满 TOGA；进近收油门控制速度'],
    ['R', '反推 开 / 收', '接地后立即开反推帮助减速'],
    ['E', '双发启动（约 8 秒时序）', '双发失效后尝试重启、冷舱开车'],
    ['Shift+E', '双发关车', '火警断油后 / 机腹迫降接地前'],
    ['I', '发动机防冰 开 / 关', '进入雨雪结冰环境时'],
  ]],
  ['构型', [
    ['F / V', '襟翼收 / 放一档', '起飞构型 5；进近逐档放到 30；爬升逐档收'],
    ['G', '起落架 收 / 放', '正爬升率收轮；进近低于 10000 ft 放轮'],
    ['Shift+G', '人工重力放出起落架', '液压失效时靠重力放轮'],
    ['B（按住）', '刹车', '中断起飞、落地滑跑减速'],
    ['Shift+B', '停留刹车', '停机位防止溜车'],
    ['A', '自动刹车档位循环', '着陆前预位（1-4/MAX），落地自动刹车'],
    ['/ 与 Shift+/', '扰流板 放出/预位', '地面=预位（接地自动放出）；空中=减速板'],
  ]],
  ['自动驾驶', [
    ['Ctrl+G', 'CMD 接通 / 断开', '爬升到安全高度后接通，减轻负担'],
    ['MCP 点击', 'HDG / SPD / ALT / VS 旋钮、CMD / APP 按钮（座舱面板可点击）', '改航向/高度/速度；进近按 APP 预位截获 ILS'],
    ['断开方式', 'Ctrl+G 或用力压杆', '人工操纵前先断开'],
  ]],
  ['视角与杂项', [
    ['C', '座舱 / 外部追机视角切换', '想看飞机全貌时（外部视角屏幕角落有仪表板）'],
    ['J', '导航引导卡 显 / 隐', '想知道"怎么飞到目的地"：待飞距离 / 直飞航向 / 阶段建议'],
    ['P / ESC', '暂停菜单', '随时可停'],
    ['M', '静音 / 恢复声音', '会议中飞行（笑）'],
    ['K', '本指南面板', '忘了按键就按 K'],
    ['N', '新手 / 行话 HUD 切换', '看不懂 IAS/ALT/HDG 时按 N'],
    ['H', '险情处置提示（QRH）', '练习模式中险情触发后'],
    ['W', '雨刷循环', '雨天/雾天'],
  ]],
];

/**
 * 创建 HUD。
 * @param {HTMLElement} root 挂载容器
 * @returns {{
 *   setStatus: (s:{phaseZh:string, distKm:number|null, fuelKg:number, timeS:number,
 *                  iasKt:number, altFt:number, hdgDeg:number, viewZh:string, speed:number,
 *                  fuelFlowKgs?:number}) => void,
 *   setWarnings: (active:string[], masterWarning:boolean, masterCaution:boolean) => void,
 *   showBriefing: (snap:{id,name,briefing,category,forced,elapsedS}|null) => void,
 *   setActions: (snap:{id,correctActions:string[]}|null, visible:boolean) => void,
 *   setPhaseHint: (key:string|null) => void,
 *   setGuideHint: (msg:string|null) => void,
 *   setNovice: (on:boolean) => void,
 *   setNav: (d:{route:string, distKm:number|null, brgDeg:number|null, hdgDeg:number,
 *               advice:string, alert:boolean}) => void,
 *   setNavVisible: (on:boolean) => void,
 *   get novice: boolean,
 *   toggleGuide: (force?:boolean) => boolean,
 *   openGuideTemporarily: (ms?:number) => void,
 *   toast: (msg:string, ms?:number) => void,
 *   showPause: (on:boolean, handlers:{onResume:Function,onMenu:Function,onMute:Function}) => void,
 *   reset: () => void,
 * }}
 */
export function createHud(root) {
  injectStyle();
  const wrap = document.createElement('div');
  wrap.className = 'sim-ui';
  wrap.style.zIndex = '41'; // HUD 高于主菜单背景：K 指南在菜单页也可呼出置顶
  wrap.innerHTML = `
    <div class="sim-hud-status novice" style="display:none">
      <div class="l-main"></div>
      <div class="l-sub"></div>
    </div>
    <div class="sim-navcard" style="display:none">
      <h5>导航引导<span class="k">J 显/隐</span></h5>
      <div class="n-route"></div>
      <div class="n-grid">
        <span>待飞 <b class="n-dist">——</b></span>
        <span>直飞航向 <b class="n-brg">——</b></span>
      </div>
      <div class="n-turn">转向 <span class="n-turnv"></span></div>
      <div class="n-advice"></div>
    </div>
    <div class="sim-hud-warn" style="display:none"></div>
    <div class="sim-brief" style="display:none">
      <h3><span class="name"></span><span class="tag"></span></h3>
      <p class="text"></p>
      <div class="plain"></div>
      <div class="hint"></div>
    </div>
    <div class="sim-actions" style="display:none">
      <h4>处置提示（QRH）</h4>
      <ol class="list"></ol>
      <span class="note">括注为通用白话，具体以 QRH 原文为准</span>
    </div>
    <div class="sim-hintbar" style="display:none"><span class="txt"></span></div>
    <div class="sim-guide-tag" style="display:none">K 指南</div>
    <div class="sim-guide" style="display:none"></div>
    <div class="sim-toast"></div>
    <div class="sim-hud-hint" style="display:none"></div>
    <div class="sim-pause" style="display:none">
      <div class="sim-pause-box">
        <h2>已 暂 停</h2>
        <button class="p-resume">继续飞行（P / ESC）</button>
        <button class="p-mute">切换静音（M）</button>
        <button class="p-menu">回到主菜单</button>
      </div>
    </div>`;
  root.appendChild(wrap);
  const $ = (cls) => wrap.querySelector(cls);

  const statusEl = $('.sim-hud-status');
  const statusMain = statusEl.querySelector('.l-main');
  const statusSub = statusEl.querySelector('.l-sub');
  const warnEl = $('.sim-hud-warn');
  const briefEl = $('.sim-brief');
  const actionsEl = $('.sim-actions');
  const hintbarEl = $('.sim-hintbar');
  const hintbarTxt = hintbarEl.querySelector('.txt');
  const guideEl = $('.sim-guide');
  const guideTagEl = $('.sim-guide-tag');
  const toastEl = $('.sim-toast');
  const hintEl = $('.sim-hud-hint');
  const pauseEl = $('.sim-pause');

  let toastTimer = null;
  let actionsVisible = false;
  let novice = true;          // 默认新手模式（N 切换）
  let lastHintKey = null;     // 同一阶段提示不重复刷新
  let lastGuideHint = null;
  let guideFadeTimer = null;

  /* ---------- 双层状态条 ---------- */
  function setStatus(s) {
    statusEl.style.display = '';
    const fuelT = (s.fuelKg / 1000).toFixed(1);
    // 续航估算：用 main.js 平滑后的近期平均油流外推（油门瞬变不跳）；
    // 粗粒度取整（分钟取 10 分钟、小时取 0.5 小时），数字只在真实变化时走动
    let endurance = '';
    if (s.fuelFlowKgs && s.fuelFlowKgs > 0.15) {
      const h = s.fuelKg / (s.fuelFlowKgs * 3600);
      if (h >= 1) endurance = `（约可飞 ${Math.round(h * 2) / 2} 小时）`;
      else if (h >= 0.2) endurance = `（约可飞 ${Math.round(h * 6) * 10} 分钟）`;
    }
    if (novice) {
      statusMain.textContent =
        `空速 ${s.iasKt.toFixed(0)}   高度 ${s.altFt.toFixed(0)}   航向 ${s.hdgDeg.toFixed(0)}°·${compassZh(s.hdgDeg)}   燃油 ${fuelT} 吨${endurance}`;
      statusSub.textContent =
        `阶段 ${s.phaseZh} · 距目的地 ${s.distKm === null ? '——' : s.distKm.toFixed(0)} km · T+${fmtTime(s.timeS)}` +
        (s.speed > 1 ? ` · [${s.speed}×]` : '') + (s.viewZh ? ` · 视角:${s.viewZh}` : '');
    } else {
      statusMain.textContent =
        `T+${fmtTime(s.timeS)}   IAS ${s.iasKt.toFixed(0)} kt   ALT ${s.altFt.toFixed(0)} ft   HDG ${s.hdgDeg.toFixed(0)}°` +
        (s.speed > 1 ? `   [${s.speed}×]` : '') + (s.viewZh ? `   视角:${s.viewZh}` : '');
      statusSub.textContent =
        `阶段 ${s.phaseZh}   目的地 ${s.distKm === null ? '——' : s.distKm.toFixed(0)} km   燃油 ${Math.round(s.fuelKg).toLocaleString()} kg`;
    }
    hintEl.style.display = '';
    hintEl.textContent = 'P 暂停 · H 提示 · K 指南 · N 新手/行话 · C 视角 · J 导航 · M 静音';
  }

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function setNovice(on) {
    novice = !!on;
    statusEl.classList.toggle('novice', novice);
    hintbarEl.classList.toggle('mini', !novice);
    if (!novice && lastHintKey) {
      // 行话模式：提示条收成小标签
      hintbarTxt.textContent = '提示';
    }
  }

  /* ---------- 导航引导卡（J 键显隐，默认显示；数据由 main.js 喂） ---------- */
  const navEl = $('.sim-navcard');
  const navRefs = {
    route: navEl.querySelector('.n-route'),
    dist: navEl.querySelector('.n-dist'),
    brg: navEl.querySelector('.n-brg'),
    turn: navEl.querySelector('.n-turnv'),
    advice: navEl.querySelector('.n-advice'),
  };
  let navOn = true;      // J 切换（默认显示）
  let navData = null;    // main.js setNav 喂的最新数据
  function setNav(d) {
    navData = d;
    renderNav();
  }
  function setNavVisible(on) {
    navOn = !!on;
    renderNav();
  }
  function renderNav() {
    if (!navOn || !navData) { navEl.style.display = 'none'; return; }
    navEl.style.display = '';
    navEl.classList.toggle('yield', !!navData.alert); // 险情简报激活：让位（缩小降透明）
    const d = navData;
    navRefs.route.textContent = d.route ?? '——';
    navRefs.dist.textContent = d.distKm == null ? '——' : `${d.distKm.toFixed(0)} km`;
    navRefs.brg.textContent = d.brgDeg == null ? '——' : `${String(Math.round(d.brgDeg) % 360).padStart(3, '0')}°`;
    // 转向指示：直飞航向（罗盘）与当前罗盘航向差
    if (d.brgDeg != null && d.hdgDeg != null) {
      let diff = d.brgDeg - d.hdgDeg;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      if (Math.abs(diff) <= 3) navRefs.turn.innerHTML = '<span class="ok">对正 ✓</span>';
      else if (diff < 0) navRefs.turn.innerHTML = `<span class="turn">◄ 左转 ${Math.round(-diff)}°</span>`;
      else navRefs.turn.innerHTML = `<span class="turn">右转 ${Math.round(diff)}° ►</span>`;
    } else {
      navRefs.turn.innerHTML = '<span class="dim">——</span>';
    }
    navRefs.advice.textContent = d.advice ?? '';
  }

  /* ---------- 上下文提示条 ---------- */
  function setPhaseHint(key) {
    if (!key) {
      // 引导首飞呼吸提示正在闪时不要收条（呼吸优先级更高），只清阶段记忆
      if (hintbarEl.classList.contains('pulse')) { lastHintKey = null; return; }
      hintbarEl.style.display = 'none';
      hintbarEl.classList.remove('pulse');
      lastHintKey = null;
      return;
    }
    hintbarEl.style.display = '';
    if (key === lastHintKey) return; // 同一阶段不重复弹
    lastHintKey = key;
    hintbarTxt.textContent = novice
      ? (HINTS[key] ?? '')
      : '提示';
  }

  /** 引导首飞：呼吸闪烁提示（msg=null 收起）。优先级高于阶段提示（main.js 侧保证后调用） */
  function setGuideHint(msg) {
    if (msg === lastGuideHint) return;
    lastGuideHint = msg;
    if (!msg) {
      hintbarEl.classList.remove('pulse');
      if (lastHintKey) hintbarTxt.textContent = novice ? (HINTS[lastHintKey] ?? '') : '提示';
      else hintbarEl.style.display = 'none';
      return;
    }
    hintbarEl.style.display = '';
    hintbarTxt.textContent = msg;
    hintbarEl.classList.add('pulse');
  }

  /* ---------- K 指南面板 ---------- */
  function buildGuide() {
    const html = [
      '<h2>操作指南</h2>',
      '<button class="g-close">关闭（K）</button>',
      '<div class="g-sub">737-800 · 按键 → 动作 → 何时用（全部对照内核键位表核实；未实现的已标注）</div>',
    ];
    for (const [title, rows] of GUIDE_SECTIONS) {
      html.push(`<h3>${title}</h3>`);
      html.push('<div class="g-head"><span>按键</span><span>动作</span><span>何时用</span></div>');
      for (const [key, act, why] of rows) {
        html.push(
          `<div class="g-row"><span class="g-key">${key}</span>` +
          `<span>${act}</span><span class="g-why">${why}</span></div>`);
      }
    }
    html.push('<h3>仪表速查（看得懂屏幕上的英文缩写）</h3>');
    html.push('<div class="g-qr">');
    for (const [abbr, zh, desc] of INSTRUMENT_QR) {
      html.push(`<div><span class="abbr">${abbr}</span>＝<b>${zh}</b>：${desc}</div>`);
    }
    html.push('</div>');
    html.push('<div class="g-note">仪表文字保持航空英文惯例；本面板与 HUD 新手层负责翻译。绿=正常 / 红=警告 / 琥珀=注意。</div>');
    guideEl.innerHTML = html.join('');
    guideEl.querySelector('.g-close').onclick = () => toggleGuide(false);
  }
  buildGuide();

  function toggleGuide(force) {
    const show = force !== undefined ? !!force : guideEl.style.display === 'none';
    guideEl.style.display = show ? '' : 'none';
    guideTagEl.style.display = show ? 'none' : (guideEl.dataset.retired === '1' ? '' : 'none');
    clearTimeout(guideFadeTimer);
    return show;
  }

  /** 首局默认展开：ms 后渐隐为右下角"K 指南"小标签（此后标签常驻可点回） */
  function openGuideTemporarily(ms = 30000) {
    toggleGuide(true);
    guideFadeTimer = setTimeout(() => {
      guideEl.style.display = 'none';
      guideEl.dataset.retired = '1';
      guideTagEl.style.display = '';
      guideTagEl.style.opacity = '0.85';
    }, ms);
  }
  guideTagEl.onclick = () => toggleGuide(true);

  /* ---------- 警告条 ---------- */
  function setWarnings(active, masterWarning, masterCaution) {
    if (active.length === 0) { warnEl.style.display = 'none'; return; }
    warnEl.style.display = '';
    warnEl.textContent = active.join('  ');
    warnEl.classList.toggle('caution', !masterWarning && masterCaution);
  }

  /* ---------- 险情简报卡（附白话行） ---------- */
  function showBriefing(snap) {
    if (!snap) { briefEl.style.display = 'none'; return; }
    briefEl.style.display = '';
    briefEl.classList.toggle('red', snap.category === 'mechanical');
    briefEl.querySelector('.name').textContent = snap.name;
    briefEl.querySelector('.tag').textContent =
      `${snap.category === 'mechanical' ? '机械故障' : '气象险情'} · ${snap.forced ? '剧本强制' : '随机遭遇'} · T+${Math.round(snap.elapsedS)}s`;
    briefEl.querySelector('.text').textContent = snap.briefing;
    briefEl.querySelector('.plain').innerHTML =
      `<b>白话：</b>${BRIEF_PLAIN[snap.id] ?? ''}`;
    briefEl.querySelector('.hint').textContent = '按 H 查看 QRH 处置提示（练习模式）';
  }

  /* ---------- 处置提示卡（每步附白话括注） ---------- */
  function setActions(snap, visible) {
    actionsVisible = visible;
    if (!snap || !visible) { actionsEl.style.display = 'none'; return; }
    actionsEl.style.display = '';
    const list = actionsEl.querySelector('.list');
    list.innerHTML = '';
    const steps = snap.correctActions;
    const plain = ACTION_PLAIN[snap.id] ?? [];
    if (!steps || steps.length === 0) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = '纯操纵处置：按简报执行飞行技术动作';
      list.appendChild(li);
      return;
    }
    steps.forEach((a, i) => {
      const li = document.createElement('li');
      li.innerHTML = `${escapeHtml(a)}${plain[i] ? `<span class="plain-note">（${escapeHtml(plain[i])}）</span>` : ''}`;
      list.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** H 键切换提示卡（练习模式） */
  function toggleActions() {
    actionsEl.style.display = actionsVisible ? 'none' : '';
    actionsVisible = !actionsVisible;
    return actionsVisible;
  }

  /* ---------- toast ---------- */
  function toast(msg, ms = 3500) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  /* ---------- 暂停菜单 ---------- */
  function showPause(on, handlers) {
    pauseEl.style.display = on ? 'flex' : 'none';
    if (!on) return;
    pauseEl.querySelector('.p-resume').onclick = handlers.onResume;
    pauseEl.querySelector('.p-menu').onclick = handlers.onMenu;
    pauseEl.querySelector('.p-mute').onclick = handlers.onMute;
  }

  function reset() {
    statusEl.style.display = 'none';
    navData = null;
    navEl.style.display = 'none';
    navEl.classList.remove('yield');
    warnEl.style.display = 'none';
    briefEl.style.display = 'none';
    actionsEl.style.display = 'none';
    hintEl.style.display = 'none';
    pauseEl.style.display = 'none';
    hintbarEl.style.display = 'none';
    hintbarEl.classList.remove('pulse');
    toggleGuide(false);
    guideTagEl.style.display = 'none';
    actionsVisible = false;
    lastHintKey = null;
    lastGuideHint = null;
  }

  return {
    setStatus, setWarnings, showBriefing, setActions, toggleActions,
    setPhaseHint, setGuideHint, setNovice, toggleGuide, openGuideTemporarily,
    setNav, setNavVisible,
    toast, showPause, reset,
    get actionsVisible() { return actionsVisible; },
    get novice() { return novice; },
  };
}
