import { Plugin, Platform } from "obsidian";

/**
 * floatField.ts — 移动端键盘避让（两级策略，Notion 式）
 *
 * 聚焦文本字段、软键盘弹出后字段被盖住时，按两级策略避让：
 *
 * 一级「滚动避让（抖动）」：字段所在滚动容器还有向上滚动的余地时，
 *   平滑滚动把字段带到键盘上方可见区——覆盖大多数中部字段，不打扰；
 * 二级「镜像悬浮编辑框」：滚动余地不足（内容底部最后几个元素，滚到底也
 *   到不了键盘上方）或字段位于不可滚动容器时，在键盘上方浮现镜像编辑卡
 *   （原字段不动），输入实时双向同步；键盘收起 / 失焦后平滑消失，内容
 *   无损保留在原字段。卡片采用输入附件栏模式（iOS / Notion 移动端同款）：
 *   底边贴键盘顶、高度随内容向上生长，位置只由键盘高度决定。
 *
 * 实现要点：
 * - 镜像卡挂在 body 层（position:fixed），完全避开视图 DOM 的包含块 /
 *   transform / contain 陷阱；原元素不移动、不改样式。
 * - 双向同步：镜像 input → 写回原字段并派发 input / change 事件（应用层
 *   草稿即时更新）；应用层改原字段 → 同步进镜像（syncing 标志防回环）。
 * - 键盘几何只用真实测量：视觉视口收缩 + Obsidian 容器收缩 + 布局视口收缩
 *   基线（adjustResize 机型 innerH 与 vp.height 同时收缩、差值≈0，必须用
 *   「无键盘基线 innerH」对比检测，否则永不触发）。
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
 * - kbVp：视觉视口收缩量（pan / 覆盖式键盘）
 * - 视图容器底：Obsidian 收缩工作区（.workspace-leaf-content / .app-container）
 * - 布局视口收缩基线：adjustResize 机型 innerH 与 vp.height 同时收缩、差值≈0，
 *   只能与「无键盘基线 idleInnerH」对比才能检出
 * - 原生输入工具栏（.mobile-toolbar）停靠在下半屏 → 其顶缘即遮挡线，
 *   且工具栏可见本身就是键盘弹出的信号
 */
function measureKeyboard(win: Window): KbInfo {
  const innerH = win.innerHeight;
  const vp = win.visualViewport as VisualViewport | null;
  // 基线：取历史最大 innerH（键盘收起时视口最高）
  if (innerH > idleInnerH) idleInnerH = innerH;
  let kbVp = 0;
  if (vp && vp.height > 0) {
    kbVp = Math.max(0, innerH - Math.round(vp.height + vp.offsetTop));
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

/**
 * 把镜像框钉在键盘顶上方：底边贴键盘顶（留 8px 间距），高度随内容
 * 向上生长（autoGrow），顶到可用空间后卡内滚动。键盘高度 / 视口变化时
 * 重复调用重钉。bottom 锚定保证卡片位置只由键盘高度决定，永远紧贴
 * 键盘（iOS 输入附件栏模式），不会因原字段高度被顶到屏幕上方。
 */
function positionMirror(win: Window, s: MirrorState, line: number): void {
  const innerH = win.innerHeight;
  const avail = Math.max(line - 16, 80);
  s.mirror.style.top = "auto";
  s.mirror.style.bottom = `${Math.round(innerH - line + 8)}px`;
  s.mirror.style.left = `${Math.round(s.left)}px`;
  s.mirror.style.width = `${Math.round(s.width)}px`;
  s.mirror.style.maxHeight = `${Math.round(avail)}px`;
  autoGrow(s);
}

/** 镜像 textarea 随内容长高（bottom 锚定 → 向上生长，不超过键盘上方空间） */
function autoGrow(s: MirrorState): void {
  if (!(s.mirror instanceof HTMLTextAreaElement)) return;
  s.mirror.style.height = "auto";
  const maxH = parseFloat(s.mirror.style.maxHeight) || 400;
  const h = Math.max(44, Math.min(s.mirror.scrollHeight, maxH));
  s.mirror.style.height = `${Math.round(h)}px`;
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
  const { line } = measureKeyboard(win);
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
    cleanup: [],
  };
  state = s;
  activeScale = win.visualViewport ? win.visualViewport.scale : 1;

  el.classList.add("db-field-mirroring");

  // 镜像输入 → 写回原字段
  const onMirrorInput = () => { syncToOriginal(); autoGrow(s); };
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
  mirror.focus();
  try {
    const len = mirror.value.length;
    mirror.setSelectionRange(len, len);
  } catch { /* 无 selection API 的类型忽略 */ }
  // 创建后立即同步一次（原字段值可能在聚焦瞬间被应用层改过）
  onMirrorInput();
}

/** 提交并平滑移除镜像框；内容已在每次输入时实时写回，此处只收尾 */
function commit(reason: string): void {
  const s = state;
  if (!s || s.committed) return;
  s.committed = true;
  void reason;
  syncToOriginal();
  for (const fn of s.cleanup) { try { fn(); } catch { /* 忽略 */ } }
  s.cleanup = [];
  s.original.classList.remove("db-field-mirroring");
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
  const m = measureKeyboard(win);

  if (state) {
    // 已有镜像：键盘收起 → 提交；高度变化 → 重钉
    if (!m.open) { cancelRecheck(); commit("keyboard-closed"); return; }
    positionMirror(win, state, m.line);
    return;
  }
  if (!m.open) { cancelRecheck(); return; }
  // 键盘已弹出：评估当前聚焦字段
  const ae = win.document.activeElement;
  const el = ae instanceof HTMLElement ? mirrorableTarget(ae) : null;
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
    const m = measureKeyboard(win);
    if (!m.open) return;
    const tb = 0; void tb;
    const el2 = el.isConnected ? el : (win.document.activeElement as HTMLElement | null);
    if (!el2 || !el2.isConnected) return;
    if (!mirrorableTarget(el2)) return;
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
    if (state) commit("switch-field");
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
