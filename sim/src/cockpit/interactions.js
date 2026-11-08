/**
 * interactions.js — Canvas 纹理点击 → 命令总线。
 *
 * 原理：Raycaster 命中带 userData.pick 的屏幕面片后，取交点 UV 映射回
 * canvas 像素坐标，再查"屏幕区域 → 命令"映射表（buildRegionMap）。
 * 每次命中都 console.log，便于 dev 页验证；未命中区域静默。
 *
 * 铁律：只发 bus 命令，绝不直接写 state。
 */

import * as THREE from 'three';
import { wrap360 } from './palette.js';

/**
 * 区域表（px 坐标，与 displays.js 各画布布局一一对应）。
 * act(state, bus, ui, px, py) → ['命令名', ...args] 或 null。
 */
export function buildRegionMap() {
  const region = (label, x0, y0, x1, y1, act) => ({ label, x0, y0, x1, y1, act });
  const sign = (y0, y1, py) => (py < (y0 + y1) / 2 ? 1 : -1);

  const mcp = [
    region('MCP HDG ±5°', 20, 0, 250, 212, (s, b, ui, py) =>
      ['ap/hdg', wrap360(Math.round(s.ap.targets.hdg + (s.runway.headingDeg || 0)) + sign(0, 212, py) * 5)]), // 罗盘空间 ±5°
    region('MCP SPD ±5', 270, 0, 440, 212, (s, b, ui, py) =>
      ['ap/spd', Math.max(100, Math.round(s.ap.targets.ias) + sign(0, 212, py) * 5)]),
    region('MCP ALT ±100', 450, 0, 668, 212, (s, b, ui, py) =>
      ['ap/alt', Math.max(0, Math.round(s.ap.targets.alt) + sign(0, 212, py) * 100)]),
    region('MCP VS ±100', 600, 0, 800, 212, (s, b, ui, py) =>
      ['ap/vs', Math.max(-3000, Math.min(3000, Math.round(s.ap.targets.vs / 100) * 100 + sign(0, 212, py) * 100))]),
    region('MCP CMD A', 924, 10, 1012, 84, () => ['ap/cmd']),
    region('MCP CMD B', 924, 92, 1012, 162, () => ['ap/cmd']),
    region('MCP APP', 816, 92, 904, 162, () => ['ap/app']),
  ];

  const overhead = [];
  // 燃油泵 ×6（displays.js 布局：x=92/248，y=140/278/416）
  const pumps = [
    ['L FWD', 'left', 92, 140], ['L AFT', 'left', 248, 140],
    ['R FWD', 'right', 92, 278], ['R AFT', 'right', 248, 278],
    ['C L', 'center', 92, 416], ['C R', 'center', 248, 416],
  ];
  for (const [label, tank, x, y] of pumps) {
    overhead.push(region(`顶板 燃油泵 ${label}`, x - 34, y - 64, x + 34, y + 64, (s) =>
      ['fuel/pump', tank, !s.fuel.pumps[tank]]));
  }
  overhead.push(region('顶板 交输活门', 58, 430, 126, 545, (s) => ['fuel/crossfeed', !s.fuel.crossfeed]));
  overhead.push(region('顶板 备用泵（内核无此命令，仅显示）', 366, 196, 434, 330, () => null));
  overhead.push(region('顶板 APU', 596, 66, 664, 200, () => ['apu/toggle']));
  overhead.push(region('顶板 机翼防冰', 826, 66, 894, 200, () => ['antiIce/toggle', 'wings']));
  overhead.push(region('顶板 发动机防冰', 916, 66, 984, 200, () => ['antiIce/toggle', 'engine']));
  // 雨刷四档（OFF/INT/LOW/HIGH；内核 level 0..2，HIGH 与 LOW 同级饱和）
  [['OFF', 0], ['INT', 1], ['LOW', 2], ['HIGH', 2]].forEach(([label, lv], i) => {
    const x = 420 + i * 92;
    overhead.push(region(`顶板 雨刷 ${label}`, x - 34, 505, x + 34, 550, () => ['wipers', lv]));
  });

  const pedestal = [
    region('中央台 油门（点击高度=油门量）', 40, 40, 300, 310, (_s, _b, _ui, _px, py) => {
      const v = Math.min(1, Math.max(0.15, (310 - py) / 270));
      return ['throttle/set', Math.round(v * 100) / 100];
    }),
    region('中央台 反推', 290, 8, 360, 60, () => ['reverse/toggle']),
    region('中央台 襟翼（弧上半放/下半收）', 40, 330, 290, 640, (_s, _b, _ui, _px, py) =>
      [py < 560 ? 'flaps/down' : 'flaps/up']),
    region('中央台 起落架手柄', 396, 396, 544, 544, () => ['gear/toggle']),
    region('中央台 配平轮（左=鼻上/右=鼻下）', 150, 615, 490, 758, (_s, _b, _ui, px) =>
      ['trim/nudge', px < 320 ? 0.04 : -0.04]),
    region('中央台 停留刹车', 476, 636, 614, 674, () => ['brakes/park']),
  ];

  const annunc = [
    region('告警灯（点击=确认）', 0, 0, 384, 192, (_s, _b, ui) => {
      ui.ackAll();
      return null;
    }),
  ];

  return { mcp, overhead, pedestal, annunc };
}

/**
 * 给 DOM 元素挂点击处理（单元 5 集成时传 renderer.domElement）。
 * @param {HTMLElement} dom renderer.domElement
 * @param {THREE.Camera} camera 当前活动相机
 * @param {THREE.Mesh[]} clickables createCockpit 返回的可点面片（userData.pick.nameTable 已标注）
 * @param {Object} state 仿真状态（只读）
 * @param {Object} bus 命令总线
 * @param {Object} ui 驾驶舱本地 UI（告警确认位等）
 * @returns {Function} dispose() 取消监听
 */
export function attachPointer(dom, camera, clickables, state, bus, ui) {
  const tables = buildRegionMap();
  const raycaster = new THREE.Raycaster();
  raycaster.far = 60;
  const ndc = new THREE.Vector2();

  const onDown = (ev) => {
    const rect = dom.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(clickables, false);
    const hit = hits.find((h) => h.object.userData.pick && h.uv);
    if (!hit) return;
    const pick = hit.object.userData.pick;
    const disp = pick.disp;
    const px = hit.uv.x * disp.w;
    const py = (1 - hit.uv.y) * disp.h;
    const table = tables[pick.nameTable] || [];
    for (const r of table) {
      if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) {
        const out = r.act(state, bus, ui, px, py);
        if (out) {
          bus.send(out[0], ...out.slice(1));
          if (typeof ui.onCommand === 'function') ui.onCommand(out[0], out.slice(1));
          console.log(`[cockpit] ${r.label} → bus.send('${out[0]}'` +
            (out.length > 1 ? ', ' + out.slice(1).map((v) => JSON.stringify(v)).join(', ') : '') + ')');
        } else {
          console.log(`[cockpit] ${r.label}（无对应内核命令，仅记录）`);
        }
        return;
      }
    }
  };

  dom.addEventListener('pointerdown', onDown);
  return () => dom.removeEventListener('pointerdown', onDown);
}
