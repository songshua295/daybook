/**
 * planSortSheet.ts — 计划视图的「分组 / 排序」底部面板
 *
 * 由顶栏「排序」按钮弹出，贴底、约占屏幕 1/3 高：
 * 两组胶囊（分组 / 排序）+ 一行恢复默认。
 *
 * 交互约定（与筛选托盘一致，别破例）：
 * - 点选即时生效：回调里改设置并重绘背后的列表，面板保持打开，
 *   因为分组和排序常常要连着调，选一项就关等于逼用户开两次。
 * - 不提供「完成 / 取消」暂存按钮——没有草稿态，也就没有"改了却没生效"的困惑。
 * - 取值一律用 getter 现取，不缓存快照：回调改的是 settings，
 *   缓存的话「恢复默认」之后选中态会画回旧值。
 * - 关闭方式：点面板外的遮罩，或 Esc（Obsidian Modal 自带）。
 */

import { App, Modal, setIcon } from "obsidian";
import type { PlanGroupBy, PlanSortKey } from "./settings";

/** 让 div 具备按钮的键盘可达性（与 JournalView.makeActivatable 同规则，独立以免循环依赖） */
function activatable<T extends HTMLElement>(el: T, ariaLabel: string): T {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", ariaLabel);
  el.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); el.click(); }
  });
  return el;
}

/**
 * 按顺序尝试图标名，取第一个真正渲染出 svg 的。
 * Obsidian 内置图标集随版本增删（lucide 重命名等），未知名字只会静默留空。
 */
function setAnyIcon(el: HTMLElement, names: string[]): void {
  for (const name of names) {
    setIcon(el, name);
    if (el.querySelector("svg")) return;
  }
}

/** 面板选项：文案与设置取值的对应关系集中在这里，视图层不再各写一份 */
export const PLAN_GROUP_OPTIONS: { value: PlanGroupBy; label: string; tip: string }[] = [
  { value: "created", label: "日期", tip: "按创建日期分天，同一天的任务并成一张卡片" },
  { value: "due", label: "截止日", tip: "按截止日期分桶：逾期 / 今天 / 明天 / 7 天内 / 以后" },
  { value: "priority", label: "优先级", tip: "按优先级分四象限" },
  { value: "tag", label: "标签", tip: "按任务的第一个标签分组" },
];

export const PLAN_SORT_OPTIONS: { value: PlanSortKey; label: string; tip: string }[] = [
  { value: "created", label: "创建时间", tip: "组内按创建时间，新的在前" },
  { value: "due", label: "截止日期", tip: "组内按截止日期升序，没设截止的垫底" },
  { value: "priority", label: "优先级", tip: "组内按优先级 Ⅰ → Ⅳ" },
  { value: "title", label: "标题", tip: "组内按任务文字中文升序" },
];

export interface PlanSortSheetOptions {
  /** 现取当前设置（面板不缓存快照） */
  getGroupBy: () => PlanGroupBy;
  getSortBy: () => PlanSortKey;
  /** 选中即生效：调用方写设置 + 重绘列表，面板不关闭 */
  onGroupBy: (value: PlanGroupBy) => void;
  onSortBy: (value: PlanSortKey) => void;
  /** 恢复默认（日期分组 · 优先级排序） */
  onReset: () => void;
}

export class PlanSortSheetModal extends Modal {
  private opts: PlanSortSheetOptions;
  /** 重绘选中态用：取值 → 胶囊元素 */
  private chips: { row: "group" | "sort"; value: string; el: HTMLElement }[] = [];
  private onBackdrop: ((e: MouseEvent) => void) | null = null;

  constructor(app: App, opts: PlanSortSheetOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    this.modalEl.addClass("db-plan-sort-modal");
    const content = this.contentEl;
    content.empty();
    content.addClass("db-plan-sort");
    this.chips = [];

    this.buildRow("分组", PLAN_GROUP_OPTIONS, "group", this.opts.getGroupBy(), v => {
      this.opts.onGroupBy(v as PlanGroupBy);
      this.paint();
    });
    this.buildRow("排序", PLAN_SORT_OPTIONS, "sort", this.opts.getSortBy(), v => {
      this.opts.onSortBy(v as PlanSortKey);
      this.paint();
    });

    const reset = activatable(content.createDiv({ cls: "db-plan-sort-reset" }), "恢复默认分组与排序");
    setAnyIcon(reset.createSpan({ cls: "db-plan-sort-reset-icon" }),
      ["rotate-ccw", "undo-2", "undo", "refresh-cw"]);
    reset.createSpan({ cls: "db-plan-sort-reset-text", text: "恢复默认" });
    reset.addEventListener("click", () => {
      this.opts.onReset();
      this.paint();
    });

    // 点面板外的空白处收起（不依赖 Obsidian 对遮罩的处理，桌面/安卓行为一致）
    const container = this.modalEl.parentElement;
    if (container) {
      this.onBackdrop = (e: MouseEvent) => {
        if (e.target === container) this.close();
      };
      container.addEventListener("click", this.onBackdrop);
    }
  }

  onClose(): void {
    const container = this.modalEl.parentElement;
    if (container && this.onBackdrop) container.removeEventListener("click", this.onBackdrop);
    this.onBackdrop = null;
    this.chips = [];
    this.contentEl.empty();
  }

  /** 设置改动后同步选中态（点选与恢复默认共用一条路径） */
  private paint(): void {
    const g = String(this.opts.getGroupBy());
    const s = String(this.opts.getSortBy());
    this.chips.forEach(c => c.el.toggleClass("active", (c.row === "group" ? g : s) === c.value));
  }

  private buildRow(
    label: string,
    options: { value: string; label: string; tip: string }[],
    row: "group" | "sort",
    current: string,
    pick: (value: string) => void,
  ): void {
    const r = this.contentEl.createDiv({ cls: "db-plan-sort-row" });
    r.createDiv({ cls: "db-plan-sort-label", text: label });
    const values = r.createDiv({ cls: "db-plan-sort-values" });
    options.forEach(o => {
      const on = o.value === current;
      const chip = activatable(
        values.createDiv({ cls: "db-plan-sort-chip" + (on ? " active" : "") }),
        `${o.tip}${on ? "（当前）" : ""}`,
      );
      chip.createSpan({ cls: "db-plan-sort-chip-text", text: o.label });
      chip.addEventListener("click", () => pick(o.value));
      this.chips.push({ row, value: o.value, el: chip });
    });
  }
}

/** 便捷入口：弹出分组 / 排序面板 */
export function openPlanSortSheet(app: App, opts: PlanSortSheetOptions): void {
  new PlanSortSheetModal(app, opts).open();
}
