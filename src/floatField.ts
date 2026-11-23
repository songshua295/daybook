import { Plugin, Platform } from "obsidian";

/**
 * floatField.ts — 移动端键盘避让（两级策略，Notion 式）
 *
 * 聚焦文本字段、软键盘弹出后字段被盖住时，按两级策略避让：
 *
 * 一级「滚动避让（抖动）」：字段所在滚动容器还有向上滚动的余地时，
 *   平滑滚动把字段带到键盘上方可见区——覆盖大多数中部字段，不打扰；
 * 二级「镜像悬浮编辑框」：滚动余地不足（内容底部最后几个元素，滚到底也
 *   到不了键盘上方）或字段位于不可滚动容器时，浮现镜像编辑卡（原字段不动），
 *   输入实时双向同步；键盘收起 / 失焦后平滑消失，内容无损保留在原字段。
 *   卡片位置优先跟随原字段：顶缘对齐原字段顶缘、白卡盖在其原位（Notion
 *   移动端属性编辑同款），底缘钳在键盘顶上方 8px、绝不没入键盘；原字段顶缘
 *   离键盘顶放不下一张最小高度的卡（字段整体被键盘盖住）时，才退为输入
 *   附件栏模式：底边贴键盘顶、高度随内容向上生长。
 *
 * 实现要点：
 * - 镜像卡挂在 body 层（position:fixed），完全避开视图 DOM 的包含块 /
 *   transform / contain 陷阱；原元素不移动、不改样式。
 * - 双向同步：镜像 input → 写回原字段并派发 input / change 事件（应用层
 *   草稿即时更新）；应用层改原字段 → 同步进镜像（syncing 标志防回环）。
 * - 键盘几何只用真实测量：视觉视口收缩 + Obsidian 容器收缩 + 布局视口收缩
 *   基线（adjustResize 机型 innerH 与 vp.height 同时收缩、差值≈0，必须用
 *   「无键盘基线 innerH」对比检测，否则永不触发）。测量护栏与 sheet 抬升
 *   底缘兜底和 ledgerPage.syncKeyboardInset 同款（真机验证过）：scale ≠ 1
 *   与键盘动画中间帧的 vp 几何不换算（否则幻影键盘线把镜像钉在屏中固定
 *   位置）；「记一笔」sheet 已抬升时其底缘即键盘顶，DOM 实测优先采纳。
 * - 弹窗 / 菜单不接管；「记一笔」sheet（.db-led-overlay，自带滚动 body、无
 *   自有字段避让）的字段同样适用；吸底操作 sheet 等其他 fixed 祖先跳过。
 * - CM6（.db-live-editor）与 contenteditable 不做镜像（自带键盘适配）。
 * - 悬浮期间捏合缩放（scale 变化）→ 提交交还；系统显示缩放导致的恒定
 *   scale≠1 不拦截（否则那类设备功能永远失效）。
 */

interface MirrorState {
  original: HTMLInputElement | HTMLTextAreaElement;
  mirror: HTMLInputElement | HTMLTextAreaElement;
  /** 单行 input：Enter 提交并交还内容 */
  singleLine: boolean;
  syncing: boolean;
  committed: boolean;
  /** 悬浮期间锚点（视口坐标） */
  left: number;
  width: number;
  /** 原字段顶缘（视口坐标，创建时快照）：实时 rect 读不到时的兜底锚点 */
  fieldTop: number;
  /** 最近一次测量的键盘遮挡线：输入长高重钉时复用 */
  line: number;
  cleanup: Array<() => void>;
}

let state: MirrorState | null = null;
/** 无键盘时的布局视口高度基线（取历史最大值：键盘收起 = 视口最高） */
let idleInnerH = 0;
let commitTimer: number | null = null;
/** 一级滚动避让后的复检定时器 */
let recheckTimer: number | null = null;
/** 镜像创建时的视觉视口缩放（捏合缩放变化时提交交还） */
let activeScale = 0;

interface KbInfo {
  open: boolean;
  /** 字段允许的最低底缘（键盘顶 / 停靠工具栏顶，视口坐标） */
  line: number;
}

/**
 * 键盘几何测量（全部真实信号，不信任 --keyboard-height）。
 * 任一信号成立即判定键盘弹出；遮挡线取各信号的最小值（最保守）：
 * - kbVp：视觉视口收缩量（pan / 覆盖式键盘）。两道护栏与
 *   ledgerPage.syncKeyboardInset 同款（真机验证过）：scale ≠ 1（捏合 / 系统
 *   显示缩放）时 vp 几何换算出的「幻影键盘线」会让镜像被钉在屏中固定线上，
 *   弃用；visibleBottom ≤ 半屏是键盘动画中间帧的瞬态异常，弃用
 * - 视图容器底：Obsidian 收缩工作区（.workspace-leaf-content / .app-container）
 * - 布局视口收缩基线：adjustResize 机型 innerH 与 vp.height 同时收缩、差值≈0，
 *   只能与「无键盘基线 idleInnerH」对比才能检出
 * - 原生输入工具栏（.mobile-toolbar）停靠在下半屏 → 其顶缘即遮挡线，
 *   且工具栏可见本身就是键盘弹出的信号
 * - sheet 已被键盘让位抬升（.db-led-overlay 写入了 bottom）→ 其底缘就是键盘
 *   顶的 DOM 实测值，比任何 vp 几何换算都可靠，sheet 内字段优先采纳
 */
function measureKeyboard(win: Window, anchor?: HTMLElement | null): KbInfo {
  const innerH = win.innerHeight;
  const vp = win.visualViewport as VisualViewport | null;
  // 基线：取历史最大 innerH（键盘收起时视口最高）
  if (innerH > idleInnerH) idleInnerH = innerH;
  let kbVp = 0;
  if (vp && vp.height > 0 && vp.scale === 1) {
    const visibleBottom = Math.round(vp.height + vp.offsetTop);
    if (visibleBottom > innerH / 2) kbVp = Math.max(0, innerH - visibleBottom);
  }
  // 视图容器底：Obsidian 收缩的是工作区 leaf 容器（与 JournalView 同一信号源）
  const viewContainer =
    (win.document.querySelector(".workspace-leaf-content") as HTMLElement | null) ??
    (win.document.querySelector(".app-container") as HTMLElement | null);
  const containerBottom = viewContainer
    ? Math.round(viewContainer.getBoundingClientRect().bottom)
    : innerH;
  let line = Math.min(containerBottom, innerH - kbVp);
  // 原生输入工具栏：可见且停靠在下半屏 → 其顶缘就是可编辑区下缘
  let toolbarDocked = false;
  const toolbar = win.document.querySelector(".mobile-toolbar") as HTMLElement | null;
  if (toolbar) {
    const tr = toolbar.getBoundingClientRect();
    if (tr.height > 4 && tr.top > innerH * 0.35 && tr.bottom <= innerH + 2) {
      toolbarDocked = true;
      if (tr.top < line) line = Math.round(tr.top);
    }
  }
  line = Math.max(line, Math.round(innerH * 0.25));
  // sheet 抬升兜底：anchor 在已抬升的「记一笔」sheet 内 → overlay 底缘即键盘顶。
  // 只在比当前估计更低（更贴近键盘）时采纳——修正幻影线偏高的情形，
  // 不覆盖工具栏顶缘这种更精确的「键盘 + 工具栏组件」上缘
  const sheetEl = anchor?.closest(".db-led-overlay") as HTMLElement | null;
  if (sheetEl && sheetEl.style.bottom) {
    const sb = Math.round(sheetEl.getBoundingClientRect().bottom);
    if (sb > innerH * 0.25 && sb < line) line = sb;
  }
  const kb = innerH - line;
  const shrink = idleInnerH > 0 ? idleInnerH - innerH : 0;
  const open = kb > 20 || shrink > 20 || toolbarDocked;
  return { open, line };
}

/** 可镜像字段：真实 input / textarea（CM6 与 contenteditable 不镜像）；
 *  弹窗 / 菜单不接管；「记一笔」sheet（.db-led-overlay）允许；其他 fixed/sticky 祖先跳过 */
function mirrorableTarget(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const win = target.ownerDocument.defaultView;
  let el: HTMLElement | null = null;
  if (target instanceof HTMLTextAreaElement) el = target;
  else if (target instanceof HTMLInputElement) {
    const type = (target.getAttribute("type") || "text").toLowerCase();
    const ok = ["text", "search", "number", "tel", "url", "password", "email", ""].includes(type);
    if (!ok) return null;
    el = target;
  }
  if (!el || (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return null;
  // CM6 / 降级编辑器：自带键盘适配，不镜像
  if (el.closest(".db-live-editor")) return null;
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.matches(".modal, .menu, .suggestion-container")) return null;
    // 「记一笔」sheet 浮层：镜像卡在其层叠上下文内盖过表单内容
    if (cur.classList && cur.classList.contains("db-led-overlay")) break;
    const cs = win?.getComputedStyle(cur);
    if (cs && (cs.position === "fixed" || cs.position === "sticky")) return null;
    cur = cur.parentElement;
  }
  return el as HTMLInputElement | HTMLTextAreaElement;
}

/** 镜像卡最小高度：原字段顶缘到键盘顶低于此值时立不起卡，退回键盘顶吸附 */
const MIRROR_MIN_H = 44;

/**
 * 钉镜像卡：位置优先跟随原字段——顶缘对齐原字段顶缘（视口坐标实时读取，
 * sheet 抬升 / 宿主重排后自动跟上），白卡盖在原字段原位（Notion 移动端
 * 属性编辑同款）；底缘钳在键盘顶上方 8px，绝不没入键盘。原字段顶缘到键盘
 * 顶放不下一张最小高度的卡（字段整体被键盘盖住）时，退为输入附件栏模式：
 * 底边贴键盘顶，高度随内容向上生长。两种模式顶到可用空间后都卡内滚动。
 * 键盘高度 / 视口 / 原字段位置变化时重复调用重钉。
 */
function positionMirror(win: Window, s: MirrorState, line: number): void {
  s.line = line;
  const innerH = win.innerHeight;
  const maxBottom = line - 8;            // 键盘顶上方 8px
  const avail = Math.max(line - 16, 80); // 吸附模式的可用高度
  s.mirror.style.left = `${Math.round(s.left)}px`;
  s.mirror.style.width = `${Math.round(s.width)}px`;

  // 自然内容高度：textarea 先放开高度量 scrollHeight；单行 input 用自身布局高度
  const isTa = s.mirror instanceof HTMLTextAreaElement;
  if (isTa) s.mirror.style.height = "auto";
  const contentH = isTa
    ? Math.max(MIRROR_MIN_H, s.mirror.scrollHeight)
    : s.mirror.offsetHeight;

  // 原字段顶缘实时读取（sheet 抬升 / 重排后跟随）；读不到再用创建时快照
  let fieldTop = s.fieldTop;
  const or = s.original.getBoundingClientRect();
  if (s.original.isConnected && (or.width > 0 || or.height > 0)) fieldTop = or.top;

  // 跟随模式：原字段顶缘到键盘顶能立起一张最小高度的卡 → 盖在原字段原位
  const followMaxH = Math.max(maxBottom - fieldTop, 0);
  if (followMaxH >= Math.min(contentH, MIRROR_MIN_H)) {
    const h = Math.min(contentH, followMaxH);
    s.mirror.style.top = `${Math.round(fieldTop)}px`;
    s.mirror.style.bottom = "auto";
    s.mirror.style.height = `${Math.round(h)}px`;
    s.mirror.style.maxHeight = `${Math.round(followMaxH)}px`;
    return;
  }
  // 吸附模式：字段整体被键盘盖住 → 底边贴键盘顶上方 8px，向上生长
  s.mirror.style.top = "auto";
  s.mirror.style.bottom = `${Math.round(innerH - line + 8)}px`;
  s.mirror.style.height = `${Math.round(Math.min(contentH, avail))}px`;
  s.mirror.style.maxHeight = `${Math.round(avail)}px`;
}

/** 镜像 → 原字段：写回并派发 input / change（应用层草稿即时更新） */
function syncToOriginal(): void {
  const s = state;
  if (!s || s.committed) return;
  if (s.original.value !== s.mirror.value) {
    s.syncing = true;
    try {
      s.original.value = s.mirror.value;
      s.original.dispatchEvent(new Event("input", { bubbles: true }));
      s.original.dispatchEvent(new Event("change", { bubbles: true }));
    } finally {
      s.syncing = false;
    }
  }
}

/**
 * 一级避让：滚动避让（抖动）——沿祖先链找所有滚动容器，把字段平滑滚到
 * 键盘上方。返回是否执行了滚动（true = 有滚动余地，等待复检）；
 * false = 滚动余地不足（底部最后几个元素），需要升级二级镜像。
 */
function scrollFieldIntoView(el: HTMLElement, line: number): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const target = line - 8;
  const needed = el.getBoundingClientRect().bottom - target;
  if (needed <= 0) return false;
  // 收集祖先链上的滚动容器（内层优先），汇总滚动余地
  const scrollers: HTMLElement[] = [];
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const cs = win.getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 1) {
      scrollers.push(cur);
    }
    cur = cur.parentElement;
  }
  let room = 0;
  for (const sc of scrollers) room += sc.scrollHeight - sc.clientHeight - sc.scrollTop;
  if (room < needed - 4) return false; // 滚动余地不足 → 二级镜像
  // 逐层滚动：内层滚满，不够再外层
  let remain = needed;
  for (const sc of scrollers) {
    if (remain <= 0) break;
    const avail = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
    const use = Math.min(remain, avail);
    if (use > 1) {
      sc.scrollTo({ top: sc.scrollTop + use, behavior: "smooth" });
      remain -= use;
    }
  }
  return remain < needed; // 至少滚动了一部分
}

/** 创建镜像框并接管焦点（光标在末尾） */
function createMirror(el: HTMLInputElement | HTMLTextAreaElement, win: Window): void {
  const doc = el.ownerDocument;
  const { line } = measureKeyboard(win, el);
  const rect = el.getBoundingClientRect();
  const innerW = win.innerWidth;
  const margin = 12;
  const width = Math.min(rect.width, innerW - margin * 2);
  const left = Math.min(Math.max(rect.left, margin), innerW - margin - width);

  const mirror = doc.createElement(el.tagName) as HTMLInputElement | HTMLTextAreaElement;
  // 复制属性（跳过 id / style / class：class 另拼，id 防重复）
  for (const attr of Array.from(el.attributes)) {
    if (["id", "style", "class", "placeholder"].includes(attr.name)) continue;
    try { mirror.setAttribute(attr.name, attr.value); } catch { /* 个别属性只读，忽略 */ }
  }
  mirror.className = el.className + " db-field-mirror";
  mirror.placeholder = el.getAttribute("placeholder") ?? "";
  mirror.value = el.value;
  mirror.setAttribute("aria-label", (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "") + "（编辑中）");
  // 挂载层：记账「记一笔」sheet 的 overlay（body 级 z49）会创建独立层叠上下文，
  // 镜像挂 body（z26）会被遮罩压暗——挂进 overlay 内部，z26 只与表单内容比较，
  // 天然盖过 sheet；其余场景挂 body。overlay 无 transform，fixed 仍按视口定位。
  const overlayHost = el.closest(".db-led-overlay") as HTMLElement | null;
  (overlayHost ?? doc.body).appendChild(mirror);

  const s: MirrorState = {
    original: el,
    mirror,
    singleLine: el instanceof HTMLInputElement,
    syncing: false,
    committed: false,
    left,
    width,
    fieldTop: rect.top,
    line,
    cleanup: [],
  };
  state = s;
  activeScale = win.visualViewport ? win.visualViewport.scale : 1;

  el.classList.add("db-field-mirroring");

  // 镜像输入 → 写回原字段，并按新内容高度重钉（跟随模式顶缘不动向下长，
  // 顶到键盘顶后卡内滚动；吸附模式底边不动向上长）
  const onMirrorInput = () => {
    syncToOriginal();
    if (state === s && !s.committed) positionMirror(win, s, s.line);
  };
  // 原字段被应用层改动 → 同步进镜像（避开自己写回触发的回环）
  const onOriginalInput = () => {
    if (state !== s || s.syncing) return;
    if (s.mirror.value !== el.value) s.mirror.value = el.value;
  };
  // 单行 input：Enter 提交并收键盘
  const onMirrorKeydown = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && s.singleLine) {
      ke.preventDefault();
      commit("enter");
      el.blur();
    }
  };
  // 镜像失焦：点到非字段处 → 稍候提交（键盘正在收起；字段间切换由 focusin 提交）
  const onMirrorFocusout = (e: FocusEvent) => {
    if (state !== s) return;
    const rel = e.relatedTarget;
    if (rel instanceof HTMLElement && mirrorableTarget(rel)) return; // 切字段，focusin 流程接管
    if (commitTimer !== null) return;
    commitTimer = win.setTimeout(() => { commitTimer = null; if (state === s) commit("blur"); }, 140);
  };
  mirror.addEventListener("input", onMirrorInput);
  mirror.addEventListener("keydown", onMirrorKeydown);
  mirror.addEventListener("focusout", onMirrorFocusout);
  el.addEventListener("input", onOriginalInput);
  s.cleanup.push(() => mirror.removeEventListener("input", onMirrorInput));
  s.cleanup.push(() => mirror.removeEventListener("keydown", onMirrorKeydown));
  s.cleanup.push(() => mirror.removeEventListener("focusout", onMirrorFocusout));
  s.cleanup.push(() => el.removeEventListener("input", onOriginalInput));

  positionMirror(win, s, line);
  // 同一轮事件里宿主可能还在改几何（pan 机型 sheet 抬升与 vp resize 同派发、
  // 且晚于本模块监听）：落定后重测遮挡线 + 按实时 rect 再钉一次，
  // 别把卡片留在抬升前 / 键盘动画中间帧的旧位置
  win.setTimeout(() => {
    if (state !== s || s.committed) return;
    positionMirror(win, s, measureKeyboard(win, s.original).line);
  }, 0);
  mirror.focus();
  try {
    const len = mirror.value.length;
    mirror.setSelectionRange(len, len);
  } catch { /* 无 selection API 的类型忽略 */ }
  // 创建后立即同步一次（原字段值可能在聚焦瞬间被应用层改过）
  onMirrorInput();
}

/** 提交并平滑移除镜像框；内容已在每次输入时实时写回，此处只收尾 */
/**
 * 提交并平滑移除镜像框；内容已在每次输入时实时写回，此处只收尾。
 * newFocus：因切到其他字段而提交时传入新聚焦元素，随补派的 focusout 的
 * relatedTarget 带出去——宿主表单靠它区分「字段间切换」（不恢复 UI，
 * 由新字段的 focusin 继续收起）与「真正离开字段」（恢复）。
 */
function commit(reason: string, newFocus?: EventTarget | null): void {
  const s = state;
  if (!s || s.committed) return;
  s.committed = true;
  void reason;
  syncToOriginal();
  for (const fn of s.cleanup) { try { fn(); } catch { /* 忽略 */ } }
  s.cleanup = [];
  s.original.classList.remove("db-field-mirroring");
  // 镜像挂在表单之外（body 层 / sheet 浮层），它的失焦事件到不了宿主表单
  // 监听器；补派一次 focusout 通知「光标已离开」，否则移动端「光标在输入框
  // 时收起返回 / 保存条」的联动会永远等不到恢复，返回按钮卡在隐藏态
  try {
    s.original.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: newFocus ?? null }),
    );
  } catch { /* 极端环境缺 FocusEvent 构造器，忽略 */ }
  const mirror = s.mirror;
  state = null;
  // 平滑消失：150ms 透明过渡后移除（reduced-motion 立即）
  const win = mirror.ownerDocument.defaultView;
  const reduced = win ? win.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  if (reduced) { mirror.remove(); return; }
  mirror.classList.add("db-field-mirror-out");
  win?.setTimeout(() => mirror.remove(), 160);
}

/** 焦点 / 键盘变化后的统一评估：滚动避让优先，余地不足再升级镜像 */
function evaluate(win: Window): void {
  const vp = win.visualViewport as VisualViewport | null;
  // 悬浮期间用户捏合缩放：坐标基准变化，安全起见提交交还（静态的系统显示
  // 缩放 scale 恒定 ≠1，不拦截——否则那类设备上功能永远失效）
  if (state && vp && activeScale > 0 && Math.abs(vp.scale - activeScale) > 0.01) {
    commit("zoom-changed");
    return;
  }
  // 遮挡线测量带上锚点字段：已有镜像 → 原字段，否则当前聚焦字段
  // （measureKeyboard 靠它识别「记一笔」sheet 的抬升，见其文档注释）
  const ae = win.document.activeElement;
  const anchor = state?.original ?? (ae instanceof HTMLElement ? mirrorableTarget(ae) : null);
  const m = measureKeyboard(win, anchor && anchor.isConnected ? anchor : null);

  if (state) {
    // 已有镜像：键盘收起 → 提交；高度变化 → 重钉
    if (!m.open) { cancelRecheck(); commit("keyboard-closed"); return; }
    positionMirror(win, state, m.line);
    return;
  }
  if (!m.open) { cancelRecheck(); return; }
  // 键盘已弹出：评估当前聚焦字段
  const el = anchor;
  if (!el || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  const covered = rect.bottom > m.line - 6 && rect.top < win.innerHeight;
  if (!covered) { cancelRecheck(); return; }

  // 一级避让：滚动余地足够 → 平滑滚动把字段抖到键盘上方，稍后复检
  if (scrollFieldIntoView(el, m.line)) {
    scheduleRecheck(win, el, m.line);
    return;
  }
  // 二级避让：滚动到底也看不到（底部最后几个元素）→ 镜像悬浮编辑框
  createMirror(el, win);
}

function cancelRecheck(): void {
  if (recheckTimer !== null) { clearTimeout(recheckTimer); recheckTimer = null; }
}

/** 一级滚动避让后的复检：滚动完成（或余地用尽）后仍被盖 → 升级镜像 */
function scheduleRecheck(win: Window, el: HTMLElement, line: number): void {
  if (recheckTimer !== null) clearTimeout(recheckTimer);
  recheckTimer = win.setTimeout(() => {
    recheckTimer = null;
    if (state) return; // 已升级镜像
    const el2 = el.isConnected ? el : (win.document.activeElement as HTMLElement | null);
    if (!el2 || !el2.isConnected || !mirrorableTarget(el2)) return;
    const m = measureKeyboard(win, el2);
    if (!m.open) return;
    const rect = el2.getBoundingClientRect();
    if (rect.bottom > m.line - 6) createMirror(el2 as HTMLInputElement | HTMLTextAreaElement, win);
  }, 360); // 平滑滚动约 300ms，留出落定余量
}

/**
 * 安装移动端镜像悬浮编辑（幂等）。所有监听走 plugin.register*，
 * 卸载时自动清理并在卸载前提交镜像内容。
 */
export function installFloatingField(plugin: Plugin): void {
  if (!Platform.isMobile) return;
  const flag = plugin as unknown as { __dbFloatFieldInstalled?: boolean };
  if (flag.__dbFloatFieldInstalled) return;
  flag.__dbFloatFieldInstalled = true;

  // 播种「无键盘基线」：插件装载时键盘必然收起，当前 innerHeight 即基线。
  // 否则首次测量若发生在键盘弹出后，基线会被毒化成收缩值，
  // 之后 shrink 恒为 0，adjustResize 机型上永不触发。
  if (window.innerHeight > 100) idleInnerH = window.innerHeight;

  // 焦点进入：字段切换时先提交旧镜像；键盘已弹出且字段被盖住 → 立即评估
  // （键盘尚未弹出的首跳由 visualViewport resize 流程接管）
  plugin.registerDomEvent(document.body, "focusin", (e: FocusEvent) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    // 镜像框自身获得焦点：正常状态，不处理
    if (state && (t === state.mirror || state.mirror.contains(t))) return;
    if (commitTimer !== null) { clearTimeout(commitTimer); commitTimer = null; }
    cancelRecheck();
    if (state) commit("switch-field", t);
    const win = t.ownerDocument.defaultView;
    if (!win) return;
    // 焦点在字段上且键盘已弹出（如从字段 A 切到字段 B）→ 立即评估
    win.setTimeout(() => evaluate(win), 0);
  }, true);

  // 键盘尺寸变化：弹出 → 评估建镜像；收起 → 提交；高度变化 → 重钉
  const vp = window.visualViewport;
  if (vp) {
    plugin.registerDomEvent(vp as unknown as HTMLElement, "resize", () => {
      evaluate(window);
    });
    // 视觉视口滚动（pan 机型 pan 偏移漂移、sheet 抬升只发 scroll 不发 resize）：
    // 已有镜像时按实时 rect + 新遮挡线重钉，保持跟随原字段；无镜像不评估，
    // 滚动避让仍只由 resize / focusin 流程触发，避免页面滚动被带着抖动
    plugin.registerDomEvent(vp as unknown as HTMLElement, "scroll", () => {
      const s = state;
      if (!s || s.committed) return;
      if (vp && activeScale > 0 && Math.abs(vp.scale - activeScale) > 0.01) {
        commit("zoom-changed");
        return;
      }
      positionMirror(window, s, measureKeyboard(window, s.original).line);
    });
  }
  // Obsidian 键盘收起事件（Capacitor 注入）：立即提交
  const kbHide = () => { if (state) commit("keyboard-will-hide"); };
  window.addEventListener("keyboardWillHide", kbHide as EventListener);
  plugin.register(() => window.removeEventListener("keyboardWillHide", kbHide as EventListener));

  // 镜像 / 原字段被应用层移出文档（如保存后 sheet 关闭重绘）时，焦点事件不会派发，
  // 用 body 级 MutationObserver 兜底提交，避免浮卡残留在脱离的 DOM 上
  const detachMo = new MutationObserver(() => {
    const s = state;
    if (!s) return;
    if (!s.mirror.isConnected || !s.original.isConnected) commit("detached");
  });
  detachMo.observe(document.body, { childList: true, subtree: true });
  plugin.register(() => detachMo.disconnect());

  // 页面滚动不影响镜像（fixed 钉在键盘上方）；视图销毁 / 卸载兜底提交
  plugin.register(() => {
    if (commitTimer !== null) { clearTimeout(commitTimer); commitTimer = null; }
    cancelRecheck();
    commit("unload");
  });
}
