/**
 * dateSelect.ts — 通用月历日期选择弹窗
 *
 * 计划输入条、任务编辑弹窗、任务菜单共用：点日历图标弹出月历，点选日期回调。
 * 移动端 / PC 同一套 Modal 交互（周一为一周起点），不依赖平台原生控件。
 */
import { Modal, moment, type App } from "obsidian";

export interface DateSelectOptions {
  /** 已选日期 YYYY-MM-DD（弹窗定位到该月并高亮） */
  value?: string;
  /** 弹窗标题 */
  title?: string;
  /** 选中回调；null = 清除截止日期 */
  onPick: (date: string | null) => void;
}

export class DateSelectModal extends Modal {
  private viewYear: number;
  private viewMonth: number; // 0-based

  constructor(app: App, private opts: DateSelectOptions) {
    super(app);
    const base = opts.value && moment(opts.value, "YYYY-MM-DD", true).isValid()
      ? moment(opts.value)
      : moment();
    this.viewYear = base.year();
    this.viewMonth = base.month();
  }

  onOpen(): void {
    this.modalEl.addClass("db-date-select-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-date-select");
    contentEl.createEl("h3", { text: this.opts.title ?? "选择截止日期" });

    // 月份切换行
    const head = contentEl.createDiv({ cls: "db-date-select-head" });
    const prev = head.createDiv({
      cls: "db-date-select-nav", text: "‹",
      attr: { role: "button", "aria-label": "上个月", tabindex: "0" },
    });
    const label = head.createSpan({ cls: "db-date-select-month" });
    const next = head.createDiv({
      cls: "db-date-select-nav", text: "›",
      attr: { role: "button", "aria-label": "下个月", tabindex: "0" },
    });

    const grid = contentEl.createDiv({ cls: "db-date-select-grid" });
    const todayStr = moment().format("YYYY-MM-DD");
    const selected = this.opts.value;

    const render = () => {
      label.setText(`${this.viewYear}年${this.viewMonth + 1}月`);
      grid.empty();
      for (const w of ["一", "二", "三", "四", "五", "六", "日"]) {
        grid.createSpan({ cls: "db-date-select-weekday", text: w });
      }
      const first = moment({ year: this.viewYear, month: this.viewMonth, day: 1 });
      // 周一为一周起点的前置空格数
      const lead = (first.isoWeekday() ?? 1) - 1;
      for (let i = 0; i < lead; i++) grid.createSpan({ cls: "db-date-select-blank" });
      for (let d = 1; d <= first.daysInMonth(); d++) {
        const dateStr = moment({ year: this.viewYear, month: this.viewMonth, day: d }).format("YYYY-MM-DD");
        const cls = ["db-date-select-day"];
        if (dateStr === todayStr) cls.push("today");
        if (dateStr === selected) cls.push("selected");
        const cell = grid.createDiv({
          cls: cls.join(" "),
          text: String(d),
          attr: { role: "button", "aria-label": dateStr, tabindex: "0" },
        });
        const pick = () => { this.close(); this.opts.onPick(dateStr); };
        cell.addEventListener("click", pick);
        cell.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); pick(); }
        });
      }
    };

    prev.addEventListener("click", () => {
      this.viewMonth--;
      if (this.viewMonth < 0) { this.viewMonth = 11; this.viewYear--; }
      render();
    });
    next.addEventListener("click", () => {
      this.viewMonth++;
      if (this.viewMonth > 11) { this.viewMonth = 0; this.viewYear++; }
      render();
    });

    // 快捷行：今天 / 明天 / 清除
    const quick = contentEl.createDiv({ cls: "db-date-select-quick" });
    const quickBtn = (text: string, date: string | null) => {
      const b = quick.createEl("button", { text });
      b.addEventListener("click", () => { this.close(); this.opts.onPick(date); });
      return b;
    };
    quickBtn("今天", todayStr);
    quickBtn("明天", moment().add(1, "day").format("YYYY-MM-DD"));
    quickBtn("清除", null);

    render();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 便捷入口：弹出月历选择日期 */
export function openDateSelect(app: App, opts: DateSelectOptions): void {
  new DateSelectModal(app, opts).open();
}
