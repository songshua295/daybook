/**
 * scrollTopButton.ts — 移动端长页「回到顶部」悬浮钮。
 *
 * 首页内容（今日记录流懒加载、记账 / 追剧列表等）在 .db-journal-root 里可以滚很长，
 * 手机上滚深了再回顶很费指头。本钮锚在视图内容容器（containerEl）右下角——
 * 绝对定位挂容器、不进滚动容器（absolute 放进滚动容器会被拉成整页内容高度），
 * 底部让位 --db-bottom-inset（导航栏 / 手势条；JournalView.applyViewportSize 把同一个值
 * 在 root 和容器上各写一份，按钮在 root 外也能读到）。
 *
 * 显隐逻辑（方向感知 + 停手驻留）：
 * - 深处（滚过约 1.5 屏）向上滑 → 淡入；方向判定带滞回：累计反向滚满 20px 才换向，
 *   缓慢拖动（每事件 1~2px）靠累计识别，事件级抖动不会漏判、翻转；
 * - 出现后停手 / 惯性滑行 → 保持显示，等用户点按（隐没阈值在半屏深处，
 *   惯性把页面带上一点不会把它抽走）；
 * - 出现后有下滑动作 → 立即隐没；回到距顶部约半屏内 → 无条件隐没（太浅没必要）；
 * - 点按 = 平滑回顶：点下即隐，动画期间的滚动事件不参与判定，
 *   手指一碰就打断动画，深处会重新亮出。
 * 二级页 / 键盘 / 编辑态由 isSuppressed 强制隐藏。
 * 仅移动端挂载（Platform.isMobileApp）：桌面端滚轮回顶毫无压力，不添乱。
 */
import { Platform, setIcon } from "obsidian";

/** 滚过多深才有出现资格：约 1.5 屏 */
const SHOW_AT_SCREENS = 1.5;
/** 一旦出现，回到距顶部约半屏内才无条件隐没（比出现阈值浅得多，途中不抽走） */
const HIDE_AT_SCREENS = 0.5;
/** 方向滞回：累计反向滚满该距离才认定换向（抵消事件级抖动 / 缓速拖动） */
const DIR_SWITCH_PX = 20;
/** 贴顶判定：scrollTop 小于该值视为在页顶（回顶动画结束用） */
const TOP_EPS = 2;

export class ScrollTopButton {
  private el: HTMLElement | null = null;
  /** 绑了 scroll / pointerdown 监听的滚动容器（root 元素稳定，正常只绑一次） */
  private boundEl: HTMLElement | null = null;
  /** 当前是否处于显示态（与 is-shown 类同步，别反查 DOM） */
  private shown = false;
  /** 程序化回顶进行中：滚动事件不参与判定，贴顶后交还 */
  private gliding = false;
  /** 最近一次滚动基准（算 delta 用） */
  private lastTop = 0;
  /** 滚动方向：1 下滑 / -1 上滑（滞回，靠累计位移换向） */
  private dir: 1 | -1 = 1;
  private upRun = 0;
  private downRun = 0;

  constructor(
    private container: HTMLElement,
    private getScroller: () => HTMLElement | null,
    private isSuppressed: () => boolean,
  ) {}

  /** 建钮 + 绑监听；重复调用幂等。非移动端不挂。 */
  mount(): void {
    if (!Platform.isMobileApp || this.el?.isConnected) return;
    if (getComputedStyle(this.container).position === "static") {
      this.container.style.position = "relative";
    }
    const el = this.container.createDiv({
      cls: "db-scrolltop",
      attr: { role: "button", tabindex: "0", "aria-label": "回到顶部", title: "回到顶部" },
    });
    setIcon(el, "arrow-up");
    el.addEventListener("click", () => this.glideToTop());
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); this.glideToTop(); }
    });
    this.el = el;
    this.bindScroller();
  }

  /**
   * 外部状态变化（开合二级页 / 键盘弹出收起 / 进出编辑态）后重算：
   * 被压制就立即隐没；否则以当前滚动位置重取基准（换页 / 显隐内容可能滚过或复位过），
   * 方向记忆一并清零，等下一次手势重新判定。
   */
  sync(): void {
    this.bindScroller();
    const el = this.el;
    if (!el) return;
    if (this.isSuppressed()) {
      this.gliding = false;
      this.shown = false;
      this.apply(el, false);
      return;
    }
    const scroller = this.getScroller();
    if (scroller) {
      this.lastTop = scroller.scrollTop;
      this.dir = 1;
      this.upRun = 0;
      this.downRun = 0;
    }
  }

  destroy(): void {
    this.unbindScroller();
    this.el?.remove();
    this.el = null;
  }

  private bindScroller(): void {
    const scroller = this.getScroller();
    if (!scroller || scroller === this.boundEl) return;
    this.unbindScroller();
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    // 回顶动画中手指一碰就打断（capture：赶上惯性滚动也收得到）
    scroller.addEventListener("pointerdown", this.onPointerDown, true);
    this.boundEl = scroller;
    this.lastTop = scroller.scrollTop;
  }

  private unbindScroller(): void {
    if (!this.boundEl) return;
    this.boundEl.removeEventListener("scroll", this.onScroll);
    this.boundEl.removeEventListener("pointerdown", this.onPointerDown, true);
    this.boundEl = null;
  }

  private onPointerDown = () => {
    if (!this.gliding) return;
    // 打断回顶动画：恢复正常判定，深处（方向记忆还是上滑）立即重新亮出，别让用户点空
    this.gliding = false;
    const scroller = this.getScroller();
    if (scroller) this.applyState(scroller.scrollTop);
  };

  private onScroll = () => {
    const el = this.el;
    const scroller = this.getScroller();
    if (!el || !scroller) return;
    const top = scroller.scrollTop;

    if (this.gliding) {
      // 回顶动画中：只记账不判定（动画的滚动不算方向），贴顶后交还
      this.lastTop = top;
      if (top <= TOP_EPS) this.gliding = false;
      return;
    }
    if (this.isSuppressed()) {
      this.lastTop = top;
      if (this.shown) { this.shown = false; this.apply(el, false); }
      return;
    }

    const delta = top - this.lastTop;
    this.lastTop = top;
    // 方向滞回：累计反向滚满 DIR_SWITCH_PX 才认定换向
    // （缓慢拖动每个滚动事件只有 1~2px，靠累计识别；抖动不会来回翻转）
    if (delta > 0) {
      this.upRun = 0;
      this.downRun += delta;
      if (this.downRun >= DIR_SWITCH_PX) this.dir = 1;
    } else if (delta < 0) {
      this.downRun = 0;
      this.upRun += -delta;
      if (this.upRun >= DIR_SWITCH_PX) this.dir = -1;
    }
    this.applyState(top);
  };

  /** 按方向记忆 + 当前深度落定显隐；停手 / 方向未明的小幅滚动维持现状 */
  private applyState(top: number): void {
    const el = this.el;
    const scroller = this.getScroller();
    if (!el || !scroller) return;
    const hideAt = scroller.clientHeight * HIDE_AT_SCREENS;
    const showAt = scroller.clientHeight * SHOW_AT_SCREENS;
    if (top <= hideAt) {
      // 回到顶部附近：无条件隐没（这里的滚动不需要按钮）
      if (this.shown) { this.shown = false; this.apply(el, false); }
    } else if (this.dir < 0 && !this.shown && top > showAt) {
      // 深处上滑：出现
      this.shown = true;
      this.apply(el, true);
    } else if (this.dir > 0 && this.shown) {
      // 出现后有下滑动作：隐没
      this.shown = false;
      this.apply(el, false);
    }
    // 其余情况（停手后静止、半屏~1.5 屏之间的继续上滑）：维持现状
  }

  /** 点按回顶：点下即隐；gliding 期间滚动事件不再把它闪出来 */
  private glideToTop(): void {
    const scroller = this.getScroller();
    const el = this.el;
    if (!scroller || !el) return;
    this.gliding = true;
    this.shown = false;
    this.apply(el, false);
    scroller.scrollTo({ top: 0, behavior: "smooth" });
  }

  private apply(el: HTMLElement, shown: boolean): void {
    el.toggleClass("is-shown", shown);
  }
}
