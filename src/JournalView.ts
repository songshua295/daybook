import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, Menu, setIcon, debounce } from "obsidian";
import type DaybookPlugin from "./main";
import { appendToSection, resolveSectionPath } from "./fileManager";
import { appendTodoCompletionInfo, createPriorityBadge, effectivePriority, getCompletedFieldName, moveTodoSubtree, PRIORITY_EMOJI, PRIORITY_META, readAllJournalEntries, shouldShowPriorityBadge, type PriorityLevel } from "./fileReader";
import { getVisibleSections, type SectionConfig, type MoodOption } from "./settings";
import { ConfirmModal, TodayPanel } from "./TodayPanel";
import { FilterPanel } from "./FilterPanel";
import {
  activeDimensions,
  collectExpenseCategories,
  collectTags,
  emptyFilter,
  isFilterActive,
  matchHabit,
  type SectionFilter,
  type StatusFilter,
} from "./filters";
import type { TodoItem } from "./fileReader";
import { attachMemoEditor } from "./memoEditor";
import { createLiveEditor, type LiveEditor, type LiveEditorOptions } from "./liveEditor";
import {
  buildExpenseContent,
  parseAmountInput,
  formatMoney,
  type ExpenseKind,
} from "./expenseManager";
import {
  loadHabits,
  readHabitFile,
  createHabitFile,
  updateHabitConfig,
  deleteHabitFile,
  checkinHabit,
  deleteCheckinAt,
  clearDayCheckins,
  skipDay,
  removeSkip,
  setCheckinNote,
  computeHabitStats,
  weeksHeatData,
  dayCheckins,
  daySkipped,
  isExecuteDay,
  trendBuckets,
  shiftAnchor,
  type CheckinRow,
  type HeatCell,
  type HabitConfig,
  type HabitData,
  type TrendDimension,
} from "./habitManager";

export const VIEW_TYPE_JOURNAL = "daybook-view";

function isMobile(): boolean { return activeWindow.innerWidth < 600; }

/** 让 div 伪按钮键盘可访问：补 role/tabindex，Enter/Space 触发 click */
export function makeActivatable<T extends HTMLElement>(el: T, ariaLabel?: string): T {
  if (!el.getAttribute("role")) el.setAttribute("role", "button");
  if (!el.getAttribute("tabindex")) el.setAttribute("tabindex", "0");
  if (ariaLabel && !el.getAttribute("aria-label")) el.setAttribute("aria-label", ariaLabel);
  el.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
      e.preventDefault();
      el.click();
    }
  });
  return el;
}

function extractInlineTags(text: string): string[] {
  const regex = /(^|[\s\u3000"'`([{<\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001\uFF08\uFF09\u3010\u3011\u300A\u300B\u300C\u300D\u300E\u300F,.;!?])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
  const tags: string[] = [];
  let m;
  while ((m = regex.exec(text)) !== null) { tags.push(m[2]); }
  return [...new Set(tags)];
}

/**
 * 从混合文本中自动提取日期关键词
 * 如"本周五完成计划的制定" → { date: "2026-05-23", text: "完成计划的制定", keyword: "本周五" }
 * 如果文本中有独立的截止日期输入框值，则优先使用 parseSmartDate 解析
 */
function extractDateFromText(input: string): { date: string | undefined; text: string; keyword?: string } {
  const today = moment();
  const trimmed = input.trim();

  // 日期关键词列表（按优先级：越精确的越靠前，长的在前）
  const patterns: { regex: RegExp; calc: (match: RegExpMatchArray) => string | undefined; keyword: string }[] = [
    // 明天/大后天/后天（长的在前，避免"大后天"被匹配成"后天"）
    { regex: /(明天)/, calc: () => today.clone().add(1, "day").format("YYYY-MM-DD"), keyword: "明天" },
    { regex: /(大后天)/, calc: () => today.clone().add(3, "day").format("YYYY-MM-DD"), keyword: "大后天" },
    { regex: /(后天)/, calc: () => today.clone().add(2, "day").format("YYYY-MM-DD"), keyword: "后天" },
    // N天后
    { regex: /(\d+)天后/, calc: (m) => today.clone().add(parseInt(m[1]), "day").format("YYYY-MM-DD"), keyword: "N天后" },
    // 本周X
    { regex: /本周([一二三四五六日天])/, calc: (m) => {
      const wm: Record<string, number> = { "\u4E00": 1, "\u4E8C": 2, "\u4E09": 3, "\u56DB": 4, "\u4E94": 5, "\u516D": 6, "\u65E5": 0, "\u5929": 0 };
      const t = wm[m[1]]; if (t === undefined) return undefined;
      let d = t - today.day(); if (d < 0) d += 7;
      return today.clone().add(d, "day").format("YYYY-MM-DD");
    }, keyword: "本周X" },
    // 下周X
    { regex: /下周([一二三四五六日天])/, calc: (m) => {
      const wm: Record<string, number> = { "\u4E00": 1, "\u4E8C": 2, "\u4E09": 3, "\u56DB": 4, "\u4E94": 5, "\u516D": 6, "\u65E5": 0, "\u5929": 0 };
      const t = wm[m[1]]; if (t === undefined) return undefined;
      return today.clone().add(t - today.day() + 7, "day").format("YYYY-MM-DD");
    }, keyword: "下周X" },
    // 今天（作为截止日期）
    { regex: /(今天)/, calc: () => today.format("YYYY-MM-DD"), keyword: "今天" },
    // YYYY-MM-DD
    { regex: /(\d{4}-\d{2}-\d{2})/, calc: (m) => moment(m[1]).isValid() ? m[1] : undefined, keyword: "ISO日期" },
    // M月D日
    { regex: /(\d{1,2})月(\d{1,2})日/, calc: (m) => today.format("YYYY") + "-" + String(parseInt(m[1])).padStart(2, "0") + "-" + String(parseInt(m[2])).padStart(2, "0"), keyword: "月日" },
  ];

  for (const p of patterns) {
    const match = trimmed.match(p.regex);
    if (match) {
      const date = p.calc(match);
      if (date) {
        // 从文本中移除日期关键词部分
        const cleanText = trimmed.replace(p.regex, "").trim().replace(/^[，。、\s]+/, "").replace(/[，。、\s]+$/, "").trim();
        return { date, text: cleanText || trimmed, keyword: match[0] };
      }
    }
  }

  return { date: undefined, text: trimmed };
}

function formatDueDate(dateStr: string): string {
  const due = moment(dateStr).startOf("day");
  const diff = due.diff(moment().startOf("day"), "day");
  if (diff === 0) return "\u4ECA\u5929";
  if (diff === 1) return "\u660E\u5929";
  if (diff < 0) return `${Math.abs(diff)}\u5929\u524D`;
  if (diff <= 7) return `${diff}\u5929\u540E`;
  return `${due.month() + 1}月${due.date()}日`;
}

/** 习惯打卡备注输入弹窗 */
export class HabitNoteModal extends Modal {
  private habit: HabitConfig;
  private date: string;
  private initialNote: string;
  private onSave: (note: string) => Promise<void>;

  constructor(
    app: any,
    habit: HabitConfig,
    date: string,
    initialNote: string,
    onSave: (note: string) => Promise<void>
  ) {
    super(app);
    this.habit = habit;
    this.date = date;
    this.initialNote = initialNote;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-habit-note-modal");
    contentEl.createEl("h3", { text: `${this.habit.icon} ${this.habit.name} · 备注` });
    const input = contentEl.createEl("textarea", {
      cls: "db-habit-note-input",
      attr: { placeholder: "今日备注（可选）", rows: "3" },
    });
    input.value = this.initialNote;
    const btnRow = contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const clearBtn = btnRow.createEl("button", { text: "清除" });
    clearBtn.addEventListener("click", () => { input.value = ""; });
    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { cls: "mod-cta", text: "保存" });
    saveBtn.addEventListener("click", async () => {
      await this.onSave(input.value.trim());
      this.close();
    });
    activeWindow.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 习惯编辑弹窗的表单数据 */
export interface HabitDraft {
  name: string;
  icon: string;
  color: string;
  timesPerDay: number;
  executeDays: number[];   // 1=周一…7=周日；全勾 = 每天
}

const PRESET_HABIT_COLORS = ["#4caf50", "#ff9800", "#9c27b0", "#2196f3", "#e91e63", "#607d8b", "#f44336", "#3f51b5"];
const WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"];
type Moment = ReturnType<typeof moment>;

/** 新建 / 编辑习惯弹窗（在主界面使用，不进设置页） */
export class HabitEditModal extends Modal {
  constructor(
    app: any,
    private habit: HabitConfig | null,
    private onSave: (data: HabitDraft) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-habit-edit-modal");
    contentEl.createEl("h3", { text: this.habit ? `${this.habit.icon} 编辑习惯` : "新建习惯" });

    let color = this.habit?.color ?? PRESET_HABIT_COLORS[0];
    let times = this.habit?.timesPerDay ?? 1;
    let executeDays = new Set<number>(this.habit?.executeDays ?? [1, 2, 3, 4, 5, 6, 7]);

    const row1 = contentEl.createDiv({ cls: "db-habit-edit-field" });
    const iconInput = row1.createEl("input", {
      cls: "db-habit-edit-emoji",
      attr: { type: "text", maxlength: "4", "aria-label": "习惯图标（emoji）", placeholder: "💧" },
    });
    iconInput.value = this.habit?.icon ?? "";
    const nameInput = row1.createEl("input", {
      cls: "db-habit-edit-name",
      attr: { type: "text", "aria-label": "习惯名称", placeholder: "习惯名称，如：喝水" },
    });
    nameInput.value = this.habit?.name ?? "";

    const colorRow = contentEl.createDiv({ cls: "db-habit-edit-field" });
    colorRow.createDiv({ cls: "db-habit-edit-label", text: "颜色" });
    const swatches = colorRow.createDiv({ cls: "db-habit-color-row" });
    PRESET_HABIT_COLORS.forEach(c => {
      const sw = makeActivatable(swatches.createDiv({
        cls: `db-habit-color-swatch${c === color ? " selected" : ""}`,
        attr: { "aria-label": `使用颜色 ${c}` },
      }), `使用颜色 ${c}`);
      sw.style.background = c;
      sw.addEventListener("click", () => {
        color = c;
        swatches.querySelectorAll(".db-habit-color-swatch").forEach(s => s.removeClass("selected"));
        sw.addClass("selected");
      });
    });

    const timesRow = contentEl.createDiv({ cls: "db-habit-edit-field" });
    timesRow.createDiv({ cls: "db-habit-edit-label", text: "每日目标次数" });
    const stepper = timesRow.createDiv({ cls: "db-habit-stepper" });
    const minus = makeActivatable(stepper.createDiv({ cls: "db-habit-step-btn", text: "−" }), "减少次数");
    const val = stepper.createDiv({ cls: "db-habit-step-val", text: String(times) });
    const plus = makeActivatable(stepper.createDiv({ cls: "db-habit-step-btn", text: "+" }), "增加次数");
    const setTimes = (v: number) => {
      times = Math.min(20, Math.max(1, v));
      val.setText(String(times));
    };
    minus.addEventListener("click", () => setTimes(times - 1));
    plus.addEventListener("click", () => setTimes(times + 1));

    // 执行日：七个圆形复选框（全勾 = 每天）
    const dayRow = contentEl.createDiv({ cls: "db-habit-edit-field" });
    dayRow.createDiv({ cls: "db-habit-edit-label", text: "执行日" });
    const dayToggles = dayRow.createDiv({ cls: "db-weekday-toggle-row" });
    const syncDayHint = () => {
      dayHint.setText(executeDays.size === 7
        ? "每天执行"
        : executeDays.size === 0
          ? "请至少勾选一天（否则每天都可打卡）"
          : `每周 ${[...executeDays].sort((a, b) => a - b).map(d => WEEKDAY_CN[d - 1]).join("、")} 执行`);
    };
    ["一", "二", "三", "四", "五", "六", "日"].forEach((w, i) => {
      const d = i + 1;
      const circle = makeActivatable(dayToggles.createDiv({
        cls: `db-weekday-toggle${executeDays.has(d) ? " on" : ""}`,
        text: w,
        attr: { "aria-label": `周${w}${executeDays.has(d) ? "（已勾选）" : ""}`, "aria-pressed": String(executeDays.has(d)) },
      }), `切换周${w}执行`);
      circle.addEventListener("click", () => {
        if (executeDays.has(d)) executeDays.delete(d);
        else executeDays.add(d);
        circle.toggleClass("on", executeDays.has(d));
        circle.setAttribute("aria-pressed", String(executeDays.has(d)));
        circle.setAttribute("aria-label", `周${w}${executeDays.has(d) ? "（已勾选）" : ""}`);
        syncDayHint();
      });
    });
    const dayHint = contentEl.createDiv({ cls: "db-habit-edit-hint" });
    syncDayHint();

    contentEl.createDiv({
      cls: "db-habit-edit-hint",
      text: "1 次 = 每天打一次卡；大于 1 次 = 支持一天多次打卡，每次都会记录时间",
    });

    const btns = contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = btns.createEl("button", { cls: "mod-cta", text: "保存" });
    save.addEventListener("click", async () => {
      await this.onSave({
        name: nameInput.value.trim() || "新习惯",
        icon: iconInput.value.trim() || "🎉",
        color,
        timesPerDay: times,
        executeDays: [...executeDays].sort((a, b) => a - b),
      });
      this.close();
    });
    activeWindow.setTimeout(() => nameInput.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 单日打卡明细弹窗：逐条撤销 / 取消跳过（入口 = 热力图格子点击） */
export class HabitDayDetailModal extends Modal {
  constructor(
    app: any,
    private habit: HabitConfig,
    private date: string,
    private onChanged?: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-habit-day-modal");
    contentEl.createEl("h3", { text: `${this.habit.icon} ${this.date} · 打卡明细` });
    const list = contentEl.createDiv({ cls: "db-habit-day-list" });
    const render = () => {
      void (async () => {
        list.empty();
        list.createDiv({ cls: "db-habit-day-loading", text: "加载中…" });
        let rows: CheckinRow[] = [];
        try {
          rows = (await readHabitFile(this.app, this.habit)).rows.filter(r => r.date === this.date);
        } catch (e) {
          if (!list.isConnected) return;
          list.setText("读取失败");
          return;
        }
        if (!list.isConnected) return;
        list.empty();
        const checks = dayCheckins(rows, this.habit.id, this.date);
        const skip = rows.find(r => r.skipped);
        if (checks.length === 0 && !skip) {
          list.createDiv({ cls: "db-habit-day-empty", text: "这一天还没有打卡记录" });
        }
        checks.forEach(r => {
          const row = list.createDiv({ cls: "db-habit-day-row" });
          row.createSpan({ cls: "db-habit-day-time", text: r.time ?? "打卡" });
          row.createSpan({ cls: "db-habit-day-note", text: r.note ?? "" });
          const del = makeActivatable(row.createDiv({
            cls: "db-habit-day-del",
            attr: { "aria-label": `撤销 ${r.time ?? "这次"} 打卡` },
          }), "撤销这次打卡");
          setIcon(del, "x");
          del.addEventListener("click", async () => {
            await deleteCheckinAt(this.app, this.habit, this.date, r.time);
            new Notice(`↩️ 已撤销 ${r.time ?? "这次"} 打卡`);
            this.onChanged?.();
            render();
          });
        });
        if (skip) {
          const row = list.createDiv({ cls: "db-habit-day-row skipped" });
          row.createSpan({ cls: "db-habit-day-time", text: "已跳过" });
          row.createSpan({ cls: "db-habit-day-note", text: skip.note ?? "" });
          const undo = row.createEl("button", { text: "取消跳过" });
          undo.addEventListener("click", async () => {
            await removeSkip(this.app, this.habit, this.date);
            this.onChanged?.();
            render();
          });
        }
      })();
    };
    render();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 习惯详情弹窗（三卡）：
 * 1) 概览卡：连续/最佳/累计统计
 * 2) 活跃度热力图卡：GitHub 贡献图风格，年份 + 月份切换，蓝色高亮，
 *    悬浮格子看打卡时间明细，点击格子 → 当日明细（逐条撤销）
 * 3) 历史记录趋势卡：周/月/年维度切换 + 日期范围翻页 + 蓝色柱状图
 */
export class HabitDetailModal extends Modal {
  private data: HabitData | null = null;
  private heatEnd = moment().format("YYYY-MM-DD");   // 热力图窗口右端（默认今天）
  private trendDim: TrendDimension = "week";
  private trendAnchor = moment().format("YYYY-MM-DD");

  constructor(
    app: any,
    private plugin: DaybookPlugin,
    private habit: HabitConfig,
    private onChanged?: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-detail-modal");
    contentEl.createEl("h3", { text: `${this.habit.icon} ${this.habit.name} · 打卡详情` });
    this.body = contentEl.createDiv({ cls: "db-detail-body" });
    // 窗口/屏幕宽度变化（旋转、分屏、桌面拖拽）时按新宽度重排列数
    this.onResize = debounce(() => {
      if (this.contentEl.isConnected) this.render();
    }, 200, true);
    activeWindow.addEventListener("resize", this.onResize);
    void this.reload();
  }

  private onResize: () => void = () => {};

  private body!: HTMLElement;

  private async reload() {
    this.body.createDiv({ cls: "db-heatmap-loading", text: "加载中…" });
    try {
      const data = await readHabitFile(this.app, this.habit);
      if (!this.contentEl.isConnected) return;
      this.data = data;
      this.habit = data.config;
      this.render();
    } catch (e) {
      if (!this.body.isConnected) return;
      this.body.empty();
      this.body.setText("读取打卡记录失败，请检查日记目录设置");
    }
  }

  private render() {
    const body = this.body;
    body.empty();
    this.renderOverview(body);
    this.renderHeatmap(body);
    this.renderTrend(body);
  }

  private renderOverview(body: HTMLElement) {
    const rows = this.data?.rows ?? [];
    const todayStr = moment().format("YYYY-MM-DD");
    const stats = computeHabitStats(rows, this.habit, todayStr);
    const card = this.makeCard(body, "总览", "db-detail-overview");
    const items: [string, string][] = [
      ["当前连续", `${stats.currentStreak} 天`],
      ["最长连续", `${stats.bestStreak} 天`],
      ["今日", this.todayText(stats.todayCount)],
      ["累计打卡", `${stats.totalCheckins} 次`],
    ];
    const wrap = card.createDiv({ cls: "db-detail-overview-items" });
    items.forEach(([label, value]) => {
      const it = wrap.createDiv({ cls: "db-detail-overview-item" });
      it.createDiv({ cls: "db-detail-overview-value", text: value });
      it.createDiv({ cls: "db-detail-overview-label", text: label });
    });
  }

  /** 统一的卡片外壳：标题行（标题左 / 控件右），返回放内容的卡片本身 */
  private makeCard(body: HTMLElement, title: string, cls: string, controls?: (head: HTMLElement) => void): HTMLElement {
    const card = body.createDiv({ cls: `db-detail-card ${cls}` });
    const head = card.createDiv({ cls: "db-detail-card-head" });
    head.createDiv({ cls: "db-detail-card-title", text: title });
    if (controls) controls(head);
    return card;
  }

  private todayText(count: number): string {
    if (!isExecuteDay(this.habit, moment().format("YYYY-MM-DD"))) return "今日休息";
    const target = Math.max(1, this.habit.timesPerDay || 1);
    return count >= target ? "已达标" : `${count}/${target} 次`;
  }

  /* ── 热力图卡 ── */

  private renderHeatmap(body: HTMLElement) {
    const rows = this.data?.rows ?? [];
    const todayStr = moment().format("YYYY-MM-DD");
    const target = Math.max(1, this.habit.timesPerDay || 1);
    const weeks = this.visibleWeeks();
    const cells = weeksHeatData(rows, this.habit.id, weeks, this.heatEnd, {
      executeDays: this.habit.executeDays,
      timesPerDay: target,
    });
    // 每列恰好一周（周一~周日），无空位
    const cols: HeatCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

    const card = this.makeCard(body, "活跃度热力图", "db-detail-heatmap", (head) => {
      this.renderHeatmapNav(head, weeks, todayStr, cells[0]?.date ?? this.heatEnd);
    });

    // 网格：GitHub 风格小方格，纵轴周一~周日，横轴为最近 N 周
    const main = card.createDiv({ cls: "db-heatmap-main" });
    const grid = main.createDiv({ cls: "db-heatmap-grid" });
    const scale = grid.createDiv({ cls: "db-heatmap-row db-heatmap-scale" });
    scale.createSpan({ cls: "db-heatmap-weekday", text: "" });
    cols.forEach(col => {
      // 刻度：常规列显示周一的日期；包含某月 1 日的列改为显示月份
      const firstOfMonth = col.find(c => c.date.slice(8) === "01");
      const label = firstOfMonth
        ? `${Number(firstOfMonth.date.slice(5, 7))}月`
        : String(Number(col[0].date.slice(8)));
      scale.createSpan({ cls: `db-heatmap-scale-cell${firstOfMonth ? " month" : ""}`, text: label });
    });
    for (let w = 0; w < 7; w++) {
      const row = grid.createDiv({ cls: "db-heatmap-row" });
      row.createSpan({ cls: "db-heatmap-weekday", text: WEEKDAY_CN[w] });
      cols.forEach(col => {
        const cell = col[w];
        const isFuture = cell.date > todayStr;
        const ratio = cell.count / target;
        let level = 0;
        if (!isFuture && cell.count > 0) {
          level = ratio >= 1.5 ? 4 : ratio >= 1 ? 3 : ratio >= 0.5 ? 2 : 1;
        }
        const cls = ["db-heatmap-cell"];
        if (level > 0) cls.push(`lv${level}`);
        else if (isFuture) cls.push("future");
        if (cell.skipped && cell.count === 0) cls.push("skipped");
        if (cell.rest && cell.count === 0 && !cell.skipped) cls.push("rest");
        if (cell.date === todayStr) cls.push("today");
        const el = makeActivatable(row.createDiv({ cls: cls.join(" ") }), `${cell.date} 打卡明细`);
        // 悬浮提示：打卡时间明细
        let tip: string;
        const dayTimes = dayCheckins(rows, this.habit.id, cell.date);
        if (dayTimes.length > 0) {
          tip = `${cell.date} · ` + dayTimes
            .map(r => [r.time, r.note].filter(Boolean).join(" ") || "打卡")
            .join(" · ");
        } else if (cell.skipped) tip = `${cell.date} · 已跳过`;
        else if (cell.rest) tip = `${cell.date} · 休息日`;
        else tip = `${cell.date} · 未打卡`;
        el.setAttribute("data-tooltip", tip);
        el.setAttribute("data-tooltip-position", "top");
        el.addEventListener("click", () => {
          new HabitDayDetailModal(this.app, this.habit, cell.date, () => {
            void this.reload();
            this.onChanged?.();
          }).open();
        });
      });
    }

    // 右侧：窗口内统计 + 图例
    const past = cells.filter(c => c.date <= todayStr);
    const doneDays = past.filter(c => !c.rest && c.count >= target).length;
    const totalCount = past.reduce((n, c) => n + c.count, 0);
    const maxCount = past.reduce((n, c) => Math.max(n, c.count), 0);
    const side = main.createDiv({ cls: "db-heatmap-side" });
    const metrics = side.createDiv({ cls: "db-heatmap-metrics" });
    ([["达标", `${doneDays} 天`], ["打卡", `${totalCount} 次`], ["单日最多", `${maxCount} 次`]] as [string, string][])
      .forEach(([label, value]) => {
        const row = metrics.createDiv({ cls: "db-heatmap-metric" });
        row.createSpan({ cls: "db-heatmap-metric-label", text: label });
        row.createSpan({ cls: "db-heatmap-metric-value", text: value });
      });

    const legend = side.createDiv({ cls: "db-heatmap-legend" });
    legend.createSpan({ text: "少" });
    for (let l = 1; l <= 4; l++) {
      legend.createDiv({
        cls: `db-heatmap-cell lv${l} mini`,
        attr: { "data-tooltip": `完成度 ${l * 25}% 以上`, "data-tooltip-position": "top" },
      });
    }
    legend.createSpan({ text: "多" });
    legend.createDiv({ cls: "db-heatmap-cell skipped mini", attr: { "data-tooltip": "跳过", "data-tooltip-position": "top" } });
    legend.createDiv({ cls: "db-heatmap-cell rest mini", attr: { "data-tooltip": "休息日", "data-tooltip-position": "top" } });
  }

  /** 依弹窗内容宽决定可见周数：每列约 19px，另留星期轴与右侧统计栏的空间 */
  private visibleWeeks(): number {
    const width = this.contentEl?.clientWidth ?? 0;
    if (width <= 0) return 10;   // 布局未完成时的回退
    return Math.max(5, Math.min(26, Math.floor((width - 145) / 19)));
  }

  /** 热力图标题行右侧的翻页：‹ 范围 ›，按可见周数整段平移，不能翻到未来 */
  private renderHeatmapNav(head: HTMLElement, weeks: number, todayStr: string, rangeStart: string) {
    const nav = head.createDiv({ cls: "db-heatmap-range" });
    const fmt = (ds: string) => moment(ds, "YYYY-MM-DD").format("M月D日");
    nav.createDiv({ cls: "db-heatmap-range-label", text: `${fmt(rangeStart)} - ${fmt(this.heatEnd)}` });

    const shift = (dir: 1 | -1) => {
      this.heatEnd = moment(this.heatEnd, "YYYY-MM-DD").add(dir * weeks, "weeks").format("YYYY-MM-DD");
      this.render();
    };
    const prev = makeActivatable(nav.createDiv({
      cls: "db-heatmap-arrow",
      attr: { "aria-label": "前一段记录" },
    }), "前一段记录");
    setIcon(prev, "chevron-left");
    prev.addEventListener("click", () => shift(-1));

    const atToday = this.heatEnd >= todayStr;
    const next = makeActivatable(nav.createDiv({
      cls: `db-heatmap-arrow${atToday ? " disabled" : ""}`,
      attr: { "aria-label": "后一段记录" },
    }), "后一段记录");
    setIcon(next, "chevron-right");
    if (!atToday) next.addEventListener("click", () => shift(1));
  }

  /* ── 趋势卡 ── */

  private renderTrend(body: HTMLElement) {
    const today = moment();
    const card = this.makeCard(body, "历史记录趋势", "db-detail-trend", (head) => {
      // 维度切换标签（标题行右侧）
      const tabs = head.createDiv({ cls: "db-trend-tabs" });
      ([["week", "周"], ["month", "月"], ["year", "年"]] as [TrendDimension, string][]).forEach(([dim, label]) => {
        const tab = makeActivatable(tabs.createDiv({
          cls: `db-trend-tab${this.trendDim === dim ? " active" : ""}`,
          text: label,
          attr: { "aria-label": `按${label}查看趋势`, "aria-pressed": String(this.trendDim === dim) },
        }), `按${label}查看趋势`);
        tab.addEventListener("click", () => {
          this.trendDim = dim;
          this.trendAnchor = today.format("YYYY-MM-DD");
          this.renderTrendOnly(card);
        });
      });
    });

    // 范围 + 翻页 + 柱状图
    this.renderTrendRange(card);
  }

  private renderTrendOnly(card: HTMLElement) {
    card.querySelectorAll(".db-trend-range, .db-trend-chart, .db-trend-axis").forEach(el => el.remove());
    this.renderTrendRange(card);
  }

  private renderTrendRange(card: HTMLElement) {
    const rows = this.data?.rows ?? [];
    const today = moment();
    const result = trendBuckets(rows, this.habit, this.trendDim, this.trendAnchor);

    const rangeRow = card.createDiv({ cls: "db-trend-range" });
    const prev = makeActivatable(rangeRow.createDiv({ cls: "db-heatmap-arrow" }), "上一段时间");
    setIcon(prev, "chevron-left");
    prev.addEventListener("click", () => {
      this.trendAnchor = shiftAnchor(this.trendAnchor, this.trendDim, -1);
      this.renderTrendOnly(card);
    });
    rangeRow.createSpan({ cls: "db-trend-range-label", text: result.rangeLabel });
    const next = makeActivatable(rangeRow.createDiv({ cls: "db-heatmap-arrow" }), "下一段时间");
    setIcon(next, "chevron-right");
    const nextAnchor = shiftAnchor(this.trendAnchor, this.trendDim, 1);
    if (moment(nextAnchor, "YYYY-MM-DD").isAfter(today, "day")) next.addClass("disabled");
    next.addEventListener("click", () => {
      if (moment(nextAnchor, "YYYY-MM-DD").isAfter(today, "day")) return;
      this.trendAnchor = nextAnchor;
      this.renderTrendOnly(card);
    });

    const chart = card.createDiv({ cls: "db-trend-chart" });
    const axis = card.createDiv({ cls: "db-trend-axis" });
    const thin = result.buckets.length > 14;
    result.buckets.forEach(b => {
      const col = chart.createDiv({ cls: "db-trend-col" });
      const bar = col.createDiv({ cls: "db-trend-bar-wrap" });
      const h = b.count === 0 ? 3 : Math.max(10, Math.round(b.rate * 100));
      const cls = ["db-trend-bar"];
      if (b.rest) cls.push("rest");
      else if (b.met) cls.push("met");
      else if (b.count > 0) cls.push("partial");
      else cls.push("zero");
      const barEl = bar.createDiv({ cls: cls.join(" ") });
      barEl.style.height = `${h}%`;
      barEl.setAttribute("data-tooltip",
        this.trendDim === "year"
          ? `${b.fullLabel} · 打卡 ${b.count} 次 · 达标率 ${Math.round(b.rate * 100)}%`
          : b.rest
            ? `${b.fullLabel} · 休息日`
            : `${b.fullLabel} · ${b.count}/${b.target} 次 · 完成 ${Math.round(b.rate * 100)}%`
      );
      const lab = axis.createDiv({ cls: `db-trend-label${thin ? " thin" : ""}` });
      if (!thin || b.label === "1" || Number(b.label) % 5 === 0) lab.setText(b.label);
      void col;
    });
  }

  onClose() {
    activeWindow.removeEventListener("resize", this.onResize);
    this.contentEl.empty();
  }
}

/** 心情长按编辑弹窗 */
class MoodEditModal extends Modal {
  private mood: MoodOption;
  private index: number;
  private onSave: (index: number, emoji: string, label: string) => void;
  private onDelete: (index: number) => void;
  private canDelete: boolean;

  constructor(
    app: any,
    mood: MoodOption,
    index: number,
    canDelete: boolean,
    onSave: (index: number, emoji: string, label: string) => void,
    onDelete: (index: number) => void
  ) {
    super(app);
    this.mood = mood;
    this.index = index;
    this.canDelete = canDelete;
    this.onSave = onSave;
    this.onDelete = onDelete;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-mood-edit-modal");

    contentEl.createEl("h3", { text: "编辑心情" });

    const form = contentEl.createDiv({ cls: "db-mood-modal-form" });

    const emojiRow = form.createDiv({ cls: "db-mood-modal-row" });
    emojiRow.createEl("label", { text: "表情" });
    const emojiInput = emojiRow.createEl("input", {
      cls: "db-mood-modal-emoji-input",
      attr: { type: "text", maxlength: "4", placeholder: "😄" },
    });
    emojiInput.value = this.mood.emoji;

    const labelRow = form.createDiv({ cls: "db-mood-modal-row" });
    labelRow.createEl("label", { text: "含义" });
    const labelInput = labelRow.createEl("input", {
      cls: "db-mood-modal-label-input",
      attr: { type: "text", placeholder: "开心" },
    });
    labelInput.value = this.mood.label;

    const btnRow = contentEl.createDiv({ cls: "db-mood-modal-btns" });

    if (this.canDelete) {
      const delBtn = btnRow.createEl("button", {
        cls: "db-mood-modal-del-btn",
        text: "删除",
      });
      delBtn.addEventListener("click", () => {
        this.onDelete(this.index);
        this.close();
      });
    }

    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = btnRow.createEl("button", {
      cls: "mod-cta",
      text: "保存",
    });
    saveBtn.addEventListener("click", () => {
      const emoji = emojiInput.value.trim();
      const label = labelInput.value.trim();
      if (emoji && label) {
        this.onSave(this.index, emoji, label);
        this.close();
      } else {
        new Notice("表情和含义都不能为空");
      }
    });

    // 回车保存
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });
    emojiInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") labelInput.focus();
    });

    activeWindow.setTimeout(() => labelInput.focus(), 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class DaybookView extends ItemView {
  plugin: DaybookPlugin;
  private selectedMood: string | null = null; // emoji 作为选中标识
  private activeSectionId: string = "memos";
  private todoItems: TodoItem[] = [];
  // 合一视图：顶栏（左上角章节下拉）+ 单列页面（输入区 → 今日记录流）
  private todayPanel: TodayPanel | null = null;
  private todayHostEl: HTMLElement | null = null;
  private _vpResizeHandler: (() => void) | null = null;
  // 录音相关
  private mediaRecorder: any = null;
  private audioChunks: Blob[] = [];
  private _currentSection?: SectionConfig;
  private isRecording = false;
  // 计划优先级
  private currentPriority: PriorityLevel | null = null;
  // 子任务添加目标（编辑视图，index 指向顶级任务）
  private subtaskTarget: number | null = null;
  // 当前页面上的内嵌实时渲染编辑器（buildUI 重建/onClose 时统一销毁）
  private liveEditors = new Set<LiveEditor>();
  // 内容筛选：每个章节各自保留一份条件（视图会话内有效，不持久化）
  private sectionFilters: Record<string, SectionFilter> = {};
  private filterPanel: FilterPanel | null = null;
  private filterOpen = false;
  private filterHostEl: HTMLElement | null = null;
  private filterBtnEl: HTMLElement | null = null;
  private todayHeadEl: HTMLElement | null = null;
  // 顶栏（memos 式三区）：右区操作按钮 + 「＋」溢出菜单，窄屏由 fitTopbar 折叠
  private topbarEl: HTMLElement | null = null;
  private topbarRightEl: HTMLElement | null = null;
  private topbarMoreEl: HTMLElement | null = null;
  private topbarActions: { icon: string; label: string; run: () => void; el?: HTMLElement }[] = [];
  // 习惯章节：筛选只作用于习惯列表，重渲染入口由 renderHabitsTab 登记
  private habitsRerender: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DaybookPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_JOURNAL; }
  getDisplayText(): string { return "Daybook"; }
  getIcon(): string { return "book-open"; }

  async onOpen() {
    this.buildUI();
    this.setupViewportAdapter();
  }

  async onClose() {
    this.teardownViewportAdapter();
    this.destroyLiveEditors();
    this.todayPanel?.destroy();
    this.todayPanel = null;
    // 停止录音并释放资源
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop();
      } catch (e) { /* ignore */ }
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
  }

  private setupViewportAdapter() {
    const vp = activeWindow.visualViewport;
    if (!vp) return;
    this._vpResizeHandler = () => {
      const root = this.containerEl.children[1] as HTMLElement;
      if (!root) return;
      const h = Math.round(vp.height);
      root.style.height = h + "px";
      root.style.maxHeight = h + "px";
      root.scrollTop = root.scrollHeight;
      this.applyTopbarInset();
      this.fitTopbar();
    };
    vp.addEventListener("resize", this._vpResizeHandler);
    // 工作区尺寸变化（分栏拖拽、旋转屏幕、原生头部显隐）时重算避让与折叠
    this.registerEvent(this.app.workspace.on("resize", () => {
      this.applyTopbarInset();
      this.fitTopbar();
    }));
  }

  private teardownViewportAdapter() {
    const vp = activeWindow.visualViewport;
    if (vp && this._vpResizeHandler) {
      vp.removeEventListener("resize", this._vpResizeHandler);
      this._vpResizeHandler = null;
    }
  }

  /** 销毁所有内嵌编辑器（buildUI 全量重建/视图关闭前调用） */
  private destroyLiveEditors() {
    this.liveEditors.forEach(ed => {
      try { ed.destroy(); } catch (e) { /* ignore */ }
    });
    this.liveEditors.clear();
  }

  /**
   * 创建内嵌 Live Preview 编辑器并登记生命周期。
   * 文件上下文取当前章节对应的日记文件（双链/附件路径解析用）。
   */
  private makeEditor(parent: HTMLElement, opts: LiveEditorOptions, extraCls = ""): LiveEditor {
    let sourceFile: TFile | null = null;
    try {
      const sectionPath = resolveSectionPath(this.plugin.settings, this._currentSection);
      const af = this.app.vault.getAbstractFileByPath(sectionPath);
      if (af instanceof TFile) sourceFile = af;
    } catch (e) { /* ignore */ }
    const editor = createLiveEditor(this.app, parent, opts, extraCls, sourceFile);
    this.liveEditors.add(editor);
    return editor;
  }

  buildUI() {
    const root = this.containerEl.children[1] as HTMLElement;
    this.destroyLiveEditors();
    this.todayPanel?.destroy();
    this.todayPanel = null;
    root.empty();
    root.setAttribute("class", "db-journal-root db-notion");
    root.style.height = "";
    root.style.maxHeight = "";

    const sections = getVisibleSections(this.plugin.settings);
    const active = sections.find(s => s.id === this.activeSectionId) ?? sections[0] ?? null;
    if (active) {
      this.activeSectionId = active.id;
      this._currentSection = active;
    }

    // 顶栏：左上角章节下拉 + 筛选 + 右侧操作
    this.renderTopBar(root, sections, active);

    // 筛选面板宿主（顶栏与正文之间，就地展开）
    this.filterPanel = null;
    this.habitsRerender = null;
    this.filterHostEl = root.createDiv({ cls: "db-filter-host" });

    // 单列页面：输入区 → 今日记录流
    const scroll = root.createDiv({ cls: "db-scroll" });
    const page = scroll.createDiv({ cls: "db-page" });

    if (!active) {
      page.createDiv({ cls: "db-page-empty", text: "所有记录类型都已关闭，去设置里开启一个章节吧～" });
      return;
    }

    const composer = page.createDiv({ cls: "db-composer" });
    this.renderTabContent(composer, active);

    // 今日记录区标题（含条数徽标）
    const todayHead = page.createDiv({ cls: "db-today-head" });
    todayHead.createSpan({ cls: "db-today-label", text: "今日记录" });
    todayHead.createSpan({ cls: "db-today-count" });
    this.todayHeadEl = todayHead;
    this.todayHostEl = page.createDiv({ cls: "db-today-host" });
    this.todayPanel = new TodayPanel(this.todayHostEl, this.plugin, todayHead);
    this.todayPanel.filter = this.getFilter(active.id);
    this.todayPanel.onResult = (count, days) => this.filterPanel?.setCount(count, days);
    this.syncHabitStreamVisibility();
    void this.todayPanel.refresh(active.id);

    // 视图重建后恢复已展开的筛选面板
    if (this.filterOpen) this.openFilterPanel();
  }

  /** 顶栏（memos 式三区）：左=筛选、中=章节切换标题、右=操作；窄屏溢出折进「＋」菜单 */
  private renderTopBar(root: HTMLElement, sections: SectionConfig[], active: SectionConfig | null) {
    const bar = root.createDiv({ cls: "db-topbar" });
    this.topbarEl = bar;

    /* ── 左区：本章节内容筛选入口 ── */
    const left = bar.createDiv({ cls: "db-topbar-zone db-topbar-left" });
    const filterBtn = left.createEl("button", {
      cls: "db-topbar-btn db-filter-toggle",
      attr: { type: "button", "aria-label": "筛选本章节内容", "aria-expanded": "false", title: "筛选" },
    });
    setIcon(filterBtn, "list-filter");
    filterBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleFilterPanel();
    });
    this.filterBtnEl = filterBtn;
    this.updateFilterBadge();

    /* ── 中区标题：章节切换（点击弹出原生菜单） ── */
    const center = bar.createDiv({ cls: "db-topbar-center" });
    const trigger = center.createEl("button", {
      cls: "db-section-trigger",
      attr: { type: "button", "aria-haspopup": "menu", "aria-label": "切换章节", title: "切换章节" },
    });
    trigger.createSpan({ cls: "db-section-trigger-emoji", text: active?.emoji ?? "📔" });
    trigger.createSpan({ cls: "db-section-trigger-label", text: active?.label ?? "Daybook" });
    const chev = trigger.createSpan({ cls: "db-section-trigger-chev" });
    setIcon(chev, "chevron-down");
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = new Menu();
      sections.forEach(sec => {
        menu.addItem(item => {
          item.setTitle(`${sec.emoji} ${sec.label}`);
          if (active && sec.id === active.id) item.setIcon("check");
          item.onClick(() => {
            if (this.activeSectionId === sec.id) return;
            // 离开计划章节时清空未保存草稿
            if (this._currentSection?.type === "plans") {
              this.todoItems = [];
              this.subtaskTarget = null;
              this.currentPriority = null;
            }
            this.activeSectionId = sec.id;
            this.buildUI();
          });
        });
      });
      // 固定锚定在标题下方（键盘 Enter 触发时 click 坐标为 0，不能直接用鼠标位置）
      const rect = trigger.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left + 10, y: rect.bottom + 4 });
    });

    /* ── 右区：快捷操作（真实 <button>；宽度不足时由 fitTopbar 折叠） ── */
    const right = bar.createDiv({ cls: "db-topbar-zone db-topbar-actions" });
    this.topbarRightEl = right;
    const specs: { icon: string; label: string; run: () => void; el?: HTMLElement }[] = [
      { icon: "file-text", label: "打开今日日记原文", run: () => this.revealTodayFile() },
      { icon: "layout-dashboard", label: "打开统计面板", run: () => void this.plugin.activateDashboard() },
      {
        icon: "settings", label: "打开设置", run: () => {
          const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
          if (setting) { setting.open(); setting.openTabById(this.plugin.manifest.id); }
        },
      },
    ];
    specs.forEach(a => {
      const el = right.createEl("button", {
        cls: "db-topbar-btn",
        attr: { type: "button", "aria-label": a.label, title: a.label },
      });
      setIcon(el, a.icon);
      el.addEventListener("click", () => a.run());
      a.el = el;
    });
    this.topbarActions = specs;

    const moreBtn = right.createEl("button", {
      cls: "db-topbar-btn db-topbar-more is-folded",
      attr: { type: "button", "aria-label": "更多操作", title: "更多操作" },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", e => {
      e.stopPropagation();
      const menu = new Menu();
      this.topbarActions.forEach(a => {
        if (a.el?.hasClass("is-folded") && a.el !== moreBtn) {
          menu.addItem(item => item.setTitle(a.label).setIcon(a.icon).onClick(() => a.run()));
        }
      });
      const rect = moreBtn.getBoundingClientRect();
      menu.showAtPosition({ x: Math.max(8, rect.right - 180), y: rect.bottom + 4 });
    });
    this.topbarMoreEl = moreBtn;

    this.fitTopbar();
    this.applyTopbarInset();
    activeWindow.requestAnimationFrame(() => {
      this.applyTopbarInset();
      this.fitTopbar();
    });
  }

  /**
   * 顶栏避让原生 view-header（安卓端头部悬浮在内容区上方）。
   * 实测重叠量后把顶栏的静态位置（margin-top）与吸顶位置（sticky top）
   * 都下移到原生按钮下缘——避让而非遮盖，原生 ⋮ / × 等功能保持可点。
   * 无重叠（桌面端/头部随文档流）时归零，安全区避让回落到 CSS 负责。
   */
  private applyTopbarInset(): void {
    const bar = this.topbarEl;
    const root = this.containerEl.children[1] as HTMLElement | null;
    if (!bar || !root) return;
    const header = this.containerEl.querySelector(".view-header") as HTMLElement | null;
    let inset = 0;
    if (header && header.offsetHeight > 0) {
      const hBottom = header.getBoundingClientRect().bottom;
      const rTop = root.getBoundingClientRect().top;
      inset = Math.max(0, Math.ceil(hBottom - rTop));
    }
    const on = inset > 0;
    bar.toggleClass("is-inset", on);
    bar.style.top = on ? `${inset}px` : "";
    bar.style.marginTop = on ? `${inset}px` : "";
  }

  /**
   * 右区宽度不足时，将操作按钮从左到右折入「＋」溢出菜单。
   * 与 memos 的「窄屏隐藏按钮」不同：折叠保留功能入口，安卓竖屏也能全部点到。
   */
  private fitTopbar(): void {
    const right = this.topbarRightEl;
    const more = this.topbarMoreEl;
    if (!right || !more) return;
    const gap = 6;
    const visible = () => this.topbarActions.filter(a => a.el && !a.el.hasClass("is-folded"));
    const foldedCount = () => this.topbarActions.length - visible().length;
    const unit = () => {
      const w = visible()[0]?.el?.offsetWidth ?? 0;
      // 尚未布局（offsetWidth=0）时按 44px 保守估算，rAF 复测会纠正
      return w > 0 ? w : 44;
    };
    const need = () => {
      const items = visible().length + (foldedCount() > 0 ? 1 : 0);
      return items === 0 ? 0 : items * unit() + (items - 1) * gap;
    };
    let guard = 8;
    while (guard-- > 0 && need() > right.clientWidth + 1) {
      const next = visible()[0];
      if (!next?.el) break;
      next.el.addClass("is-folded");
    }
    guard = 8;
    while (guard-- > 0) {
      const folded = this.topbarActions.filter(a => a.el?.hasClass("is-folded"));
      if (!folded.length) break;
      const last = folded[folded.length - 1];
      last.el!.removeClass("is-folded");
      if (need() > right.clientWidth + 1) { last.el!.addClass("is-folded"); break; }
    }
    more.toggleClass("is-folded", foldedCount() === 0);
  }

  /* ── 内容筛选 ── */

  /** 取该章节的筛选条件（首次访问时建一份空条件；按章节各自保留） */
  private getFilter(sectionId: string): SectionFilter {
    if (!this.sectionFilters[sectionId]) this.sectionFilters[sectionId] = emptyFilter();
    return this.sectionFilters[sectionId];
  }

  private toggleFilterPanel(): void {
    if (this.filterOpen) this.closeFilterPanel();
    else void this.openFilterPanel();
  }

  private closeFilterPanel(): void {
    this.filterOpen = false;
    this.filterPanel?.destroy();
    this.filterPanel = null;
    this.filterHostEl?.empty();
    this.updateFilterBadge();
  }

  /** 就地展开筛选面板：先取该章节的标签/分类候选，再渲染 */
  private async openFilterPanel(): Promise<void> {
    const section = this._currentSection;
    const host = this.filterHostEl;
    if (!section || !host) return;
    this.filterOpen = true;
    this.filterPanel = null;
    host.empty();

    let tags: { tag: string; count: number }[] = [];
    let categories: string[] = [];
    try {
      const groups = await readAllJournalEntries(this.app, this.plugin.settings, new Set([section.id]));
      const all = groups.flatMap(g => g.entries);
      tags = collectTags(all);
      categories = collectExpenseCategories(all);
    } catch { /* 读不到历史时只给静态维度（心情/分类/优先级等仍可用） */ }
    if (!this.filterOpen || !host.isConnected) return;

    host.empty();
    this.filterPanel = new FilterPanel({
      host,
      plugin: this.plugin,
      section,
      filter: this.getFilter(section.id),
      tags,
      categories,
      onChange: () => this.applyFilter(),
      onRequestClose: () => this.closeFilterPanel(),
    });
    this.updateFilterBadge();
    // 习惯章节重渲染列表以回填结果数；其余章节重跑记录流刷新计数
    if (section.type === "habits") this.habitsRerender?.();
    else void this.todayPanel?.refresh(section.id);
  }

  /** 条件变化 → 重跑本章节筛选（记录流 or 习惯列表） */
  private applyFilter(): void {
    const section = this._currentSection;
    if (!section) return;
    const filter = this.getFilter(section.id);
    this.updateFilterBadge();
    if (section.type === "habits") {
      this.habitsRerender?.();
      return;
    }
    if (this.todayPanel) {
      this.todayPanel.filter = filter;
      void this.todayPanel.refresh(section.id);
    }
  }

  /** 筛选按钮的状态：展开高亮 + 已启用维度数徽标 */
  private updateFilterBadge(): void {
    const btn = this.filterBtnEl;
    if (!btn) return;
    const section = this._currentSection;
    const n = section ? activeDimensions(this.getFilter(section.id)).length : 0;
    btn.toggleClass("is-active", this.filterOpen);
    btn.toggleClass("has-filter", n > 0);
    btn.setAttribute("aria-expanded", this.filterOpen ? "true" : "false");
    btn.setAttribute("aria-label", n > 0 ? `筛选本章节内容，已启用 ${n} 项` : "筛选本章节内容");
    let badge = btn.querySelector<HTMLElement>(".db-filter-badge");
    if (n > 0) {
      if (!badge) badge = btn.createDiv({ cls: "db-filter-badge" });
      badge.setText(String(n));
    } else badge?.remove();
  }

  /** 习惯章节的数据在 habits/*.md 里，不展示日记的今日记录流 */
  private syncHabitStreamVisibility(): void {
    const hide = this._currentSection?.type === "habits";
    this.todayHeadEl?.toggleClass("is-hidden", hide);
    this.todayHostEl?.toggleClass("is-hidden", hide);
  }

  /** 打开今日章节对应的日记文件 */
  private revealTodayFile() {
    try {
      const path = resolveSectionPath(this.plugin.settings, this._currentSection);
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile) {
        void this.app.workspace.getLeaf("tab").openFile(af);
      } else {
        new Notice("今日文件还未创建，先写一条记录吧～");
      }
    } catch (e) {
      new Notice("无法打开今日文件");
    }
  }

  /** 保存后局部刷新今日记录流（不重建输入区，保留草稿与滚动位置） */
  private refreshToday() {
    void this.todayPanel?.refresh(this.activeSectionId);
  }

  private renderTabContent(container: HTMLElement, section: SectionConfig) {
    if (section.type === "plans") this.renderPlansTab(container, section);
    else if (section.type === "habits") this.renderHabitsTab(container, section);
    else if (section.type === "expenses") this.renderExpensesTab(container, section);
    else this.renderMemosTab(container, section);
  }

  /** 习惯打卡：主界面增删改 + 单次/多次打卡 + 休息日态（时间在详情页悬浮显示） */
  private async renderHabitsTab(container: HTMLElement, section: SectionConfig) {
    container.empty();
    container.addClass("db-habits-tab");

    const todayStr = moment().format("YYYY-MM-DD");
    const rerender = () => { void this.renderHabitsTab(container, section); };
    this.habitsRerender = rerender;
    const f = this.getFilter(section.id);

    // 头部：标题 + 新建习惯入口
    const head = container.createDiv({ cls: "db-habits-head" });
    head.createSpan({ cls: "db-habits-head-title", text: "习惯打卡" });

    let data: HabitData[] = [];
    try {
      data = await loadHabits(this.app, this.plugin.settings);
      // 视图可能已重建（容器被替换），延迟回调前校验
      if (!container.isConnected) return;
    } catch (e) {
      container.createDiv({ cls: "db-habits-empty", text: "读取习惯文件失败，请检查日记目录设置" });
      return;
    }

    const addBtn = makeActivatable(head.createDiv({
      cls: "db-habits-add",
      attr: { "aria-label": "新建习惯" },
    }), "新建习惯");
    setIcon(addBtn.createSpan({ cls: "db-habits-add-icon" }), "plus");
    addBtn.createSpan({ text: "新建习惯" });
    addBtn.addEventListener("click", () => {
      if (data.filter(d => !d.config.archived).length >= 8) {
        new Notice("最多添加 8 个习惯");
        return;
      }
      new HabitEditModal(this.app, null, async (draft) => {
        try {
          await createHabitFile(this.app, this.plugin.settings, draft);
        } catch (e) {
          new Notice("创建习惯失败，请检查日记目录设置");
          return;
        }
        rerender();
      }).open();
    });

    // 默认只列进行中的习惯；筛选面板里可切到「已归档 / 全部」
    const status: StatusFilter = f.status === "all" && !isFilterActive(f) ? "active" : f.status;
    const rowsOf = (id: string) => data.find(d => d.config.id === id)?.rows ?? [];
    const habits = data
      .map(d => d.config)
      .filter(h => matchHabit(h, rowsOf(h.id), { ...f, status }, todayStr));
    this.filterPanel?.setCount(habits.length, 0);
    if (habits.length === 0) {
      container.createDiv({
        cls: "db-habits-empty",
        text: isFilterActive(f)
          ? "没有符合筛选条件的习惯，放宽状态或日期试试～"
          : "还没有习惯，点右上角「新建习惯」添加第一个吧～",
      });
      return;
    }

    const list = container.createDiv({ cls: "db-habits-list" });

    const refreshAll = () => {
      void (async () => {
        try {
          data = await loadHabits(this.app, this.plugin.settings);
          if (!list.isConnected) return;
          renderAll();
        } catch (e) { /* ignore */ }
      })();
    };

    const nextExecuteLabel = (habit: HabitConfig): string => {
      for (let i = 1; i <= 7; i++) {
        const d = moment().add(i, "days");
        if (isExecuteDay(habit, d.format("YYYY-MM-DD"))) {
          return i === 1 ? "明天（周" + WEEKDAY_CN[d.isoWeekday() - 1] + "）"
            : `周${WEEKDAY_CN[d.isoWeekday() - 1]}`;
        }
      }
      return "下个执行日";
    };

    const renderAll = () => {
      list.empty();
      habits.forEach(habitConfig => {
        const habit = habitConfig;
        const rows = data.find(d => d.config.id === habit.id)?.rows ?? [];
        const target = Math.max(1, habit.timesPerDay || 1);
        const times = dayCheckins(rows, habit.id, todayStr);
        const count = times.length;
        const done = count >= target;
        const skipped = daySkipped(rows, habit.id, todayStr);
        const resting = !isExecuteDay(habit, todayStr);
        const todayRows = rows.filter(r => r.habitId === habit.id && r.date === todayStr);
        const note = todayRows[todayRows.length - 1]?.note;

        const card = list.createDiv({
          cls: `db-habit-row${done ? " checked" : ""}${skipped ? " skipped" : ""}${resting ? " rest-day" : ""}`,
        });
        card.style.setProperty("--habit-color", habit.color);

        // 左侧信息区：点击打开习惯详情（热力图 + 趋势）
        const left = makeActivatable(card.createDiv({ cls: "db-habit-row-left" }), `查看 ${habit.name} 的打卡详情`);
        left.createDiv({ cls: "db-habit-row-icon", text: habit.icon });
        const nameWrap = left.createDiv({ cls: "db-habit-row-name-wrap" });
        nameWrap.createSpan({ cls: "db-habit-row-name", text: habit.name });
        nameWrap.createSpan({
          cls: "db-habit-row-target",
          text: resting
            ? `今日休息 · ${(habit.executeDays ?? []).map(d => "周" + WEEKDAY_CN[d - 1]).join("/")}执行`
            : target > 1
              ? `每日 ${target} 次 · 今日 ${count}/${target}`
              : `每日 1 次 · ${done ? "已打卡" : skipped ? "今日跳过" : "未打卡"}`,
        });
        left.addEventListener("click", () => {
          new HabitDetailModal(this.app, this.plugin, habit, refreshAll).open();
        });

        // 打卡按钮：休息日提示；单次=圆圈切换，多次=+1 计数
        const check = makeActivatable(card.createDiv({
          cls: `db-habit-check${done ? " done" : ""}`,
          attr: { "aria-label": resting ? `${habit.name} 今日休息` : target === 1 ? (done ? "取消今日打卡" : "今日打卡") : `为 ${habit.name} 再打一次卡` },
        }));
        if (target === 1) {
          check.createSpan({ cls: "db-habit-check-dot" });
        } else {
          check.createSpan({ cls: "db-habit-check-plus", text: "+1" });
          check.createSpan({ cls: "db-habit-check-count", text: `${count}/${target}` });
        }
        check.addEventListener("click", async () => {
          if (resting) {
            new Notice(`🌙 ${habit.name} 今日休息，下个执行日是${nextExecuteLabel(habit)}`);
            return;
          }
          try {
            if (target === 1 && done) {
              await clearDayCheckins(this.app, habit, todayStr);
              new Notice("↩️ 已取消今日打卡");
            } else {
              // 手势内先给反馈：多次打卡只在补满当日目标（含超出）时响
              if (count + 1 >= target) this.plugin.feedback.notify();
              const t = await checkinHabit(this.app, habit, todayStr);
              const n = count + 1;
              new Notice(n >= target
                ? `✅ ${habit.name} ${t} · 今日已达标（${n}/${target}）`
                : `✅ ${habit.name} ${t}（${n}/${target}）`);
            }
            refreshAll();
          } catch (e) {
            new Notice("打卡失败，请检查日记目录设置");
          }
        });

        // ⋯ 菜单：跳过 / 备注 / 清空 / 编辑 / 删除
        const more = makeActivatable(card.createDiv({
          cls: `db-habit-more${note ? " has-note" : ""}`,
          attr: { "aria-label": `${habit.name} 更多操作` },
        }), "更多操作");
        setIcon(more, "more-horizontal");
        more.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          const menu = new Menu();
          if (!resting) {
            if (skipped) {
              menu.addItem(mi => mi.setIcon("undo-2").setTitle("取消跳过").onClick(async () => {
                await removeSkip(this.app, habit, todayStr);
                refreshAll();
              }));
            } else {
              menu.addItem(mi => mi.setIcon("skip-forward").setTitle("跳过今天（不中断连续）").onClick(async () => {
                await skipDay(this.app, habit, todayStr);
                new Notice("🚫 今日已跳过（不计入连续）");
                refreshAll();
              }));
            }
          }
          menu.addItem(mi => mi.setIcon("pencil").setTitle(note ? `修改备注：${note}` : "添加今日备注").onClick(() => {
            new HabitNoteModal(this.app, habit, todayStr, note ?? "", async (noteText) => {
              await setCheckinNote(this.app, habit, todayStr, noteText);
              refreshAll();
            }).open();
          }));
          if (count > 0) {
            menu.addItem(mi => mi.setIcon("eraser").setTitle("清空今日打卡").onClick(async () => {
              await clearDayCheckins(this.app, habit, todayStr);
              refreshAll();
            }));
          }
          menu.addItem(mi => mi.setIcon("sliders-horizontal").setTitle("编辑习惯").onClick(() => {
            new HabitEditModal(this.app, habit, async (draft) => {
              try {
                await updateHabitConfig(this.app, habit, draft);
              } catch (e) {
                new Notice("保存失败");
                return;
              }
              rerender();
            }).open();
          }));
          menu.addItem(mi => mi.setIcon("trash-2").setTitle("删除习惯").onClick(() => {
            new ConfirmModal(this.app, "删除习惯",
              `确定删除「${habit.icon} ${habit.name}」吗？习惯文件将移入回收站。`,
              "删除", () => {
                void deleteHabitFile(this.app, habit).then(rerender).catch(() => new Notice("删除失败"));
              }).open();
          }));
          menu.showAtMouseEvent(e);
        });
      });
    };

    renderAll();
  }

  /** 记账：支出/收入 + 金额 + 分类（就地管理） + 备注，一行写入当日日记「记账」小节 */
  private renderExpensesTab(container: HTMLElement, section: SectionConfig) {
    container.empty();
    container.addClass("db-expenses-tab");
    this._currentSection = section;

    let kind: ExpenseKind = "expense";
    let selectedCat: string | null = null;
    let manageCats = false;

    // 头部：标题 + 支出/收入切换
    const head = container.createDiv({ cls: "db-expenses-head" });
    head.createSpan({ cls: "db-expenses-head-title", text: "记一笔" });
    const seg = head.createDiv({ cls: "db-expense-seg" });
    const segItems: [ExpenseKind, string][] = [["expense", "支出"], ["income", "收入"]];
    segItems.forEach(([k, label]) => {
      const btn = makeActivatable(seg.createDiv({
        cls: `db-expense-seg-btn ${k === kind ? `active ${k}` : ""}`,
        text: label,
        attr: { "aria-pressed": String(k === kind), "aria-label": `${label}模式` },
      }), `${label}模式`);
      btn.addEventListener("click", () => {
        kind = k;
        seg.querySelectorAll<HTMLElement>(".db-expense-seg-btn").forEach(el => el.removeClass("active", "expense", "income"));
        btn.addClass("active", k);
        amountInput.removeClass("expense", "income");
        amountInput.addClass(k);
      });
    });

    // 金额输入（大字号，居中）
    const amountRow = container.createDiv({ cls: "db-expense-amount-row" });
    amountRow.createSpan({ cls: "db-expense-currency", text: "¥" });
    const amountInput = amountRow.createEl("input", {
      cls: `db-expense-amount-input ${kind}`,
      attr: { type: "text", inputmode: "decimal", placeholder: "0.00", "aria-label": "金额" },
    });

    // 分类 chips（就地管理：＋ 新增 / 管理模式下 ✕ 删除）
    const catRow = container.createDiv({ cls: "db-expense-cats" });

    const persistCats = async (next: string[]) => {
      this.plugin.settings.expenseCategories = next;
      await this.plugin.saveSettings();
    };

    const renderCats = () => {
      catRow.empty();
      const cats = this.plugin.settings.expenseCategories;
      cats.forEach(cat => {
        const chip = makeActivatable(catRow.createDiv({
          cls: `db-expense-cat${selectedCat === cat ? " selected" : ""}${manageCats ? " managing" : ""}`,
          attr: { "aria-pressed": String(selectedCat === cat), "aria-label": `分类 ${cat}` },
        }), `选择分类 ${cat}`);
        chip.createSpan({ cls: "db-expense-cat-name", text: cat });
        if (manageCats) {
          const del = chip.createSpan({ cls: "db-expense-cat-del", text: "×", attr: { role: "button", "aria-label": `删除分类 ${cat}` } });
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            const next = cats.filter(c => c !== cat);
            if (next.length === 0) { new Notice("至少保留一个分类"); return; }
            if (selectedCat === cat) selectedCat = null;
            void persistCats(next).then(renderCats);
          });
        } else {
          chip.addEventListener("click", () => {
            selectedCat = selectedCat === cat ? null : cat;
            renderCats();
          });
        }
      });
      // ＋ 新增分类（行内输入）
      const addChip = makeActivatable(catRow.createDiv({ cls: "db-expense-cat-add", attr: { "aria-label": "新增分类" } }), "新增分类");
      addChip.createSpan({ text: "＋" });
      addChip.addEventListener("click", () => {
        addChip.empty();
        const input = addChip.createEl("input", {
          cls: "db-expense-cat-input",
          attr: { type: "text", maxlength: "6", placeholder: "名称", "aria-label": "新分类名称" },
        });
        activeWindow.setTimeout(() => input.focus(), 30);
        const commit = async () => {
          const v = input.value.trim();
          if (v && !this.plugin.settings.expenseCategories.includes(v)) {
            await persistCats([...this.plugin.settings.expenseCategories, v]);
          }
          renderCats();
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") void commit();
          else if (e.key === "Escape") renderCats();
        });
        input.addEventListener("blur", () => void commit());
      });
      // 管理模式切换
      const mgr = makeActivatable(catRow.createDiv({
        cls: `db-expense-cat-mgr${manageCats ? " active" : ""}`,
        text: manageCats ? "完成" : "管理",
        attr: { "aria-label": manageCats ? "完成分类管理" : "管理分类" },
      }), "管理分类");
      mgr.addEventListener("click", () => { manageCats = !manageCats; renderCats(); });
    };
    renderCats();

    // 备注 + 保存
    const noteRow = container.createDiv({ cls: "db-expense-note-row" });
    const noteInput = noteRow.createEl("input", {
      cls: "db-expense-note-input",
      attr: { type: "text", placeholder: "备注（可选），如：午饭", "aria-label": "备注" },
    });
    const saveBtn = makeActivatable(noteRow.createDiv({ cls: "db-save-btn db-expense-save-btn" }), "记一笔");
    saveBtn.createDiv({ cls: "db-btn-text", text: "记一笔" });

    const submit = async () => {
      const amount = parseAmountInput(amountInput.value);
      if (amount === null) {
        new Notice("请输入正确的金额");
        amountInput.focus();
        return;
      }
      saveBtn.addClass("loading");
      try {
        const content = buildExpenseContent({
          kind,
          amount,
          category: selectedCat ?? undefined,
          note: noteInput.value,
        });
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, content, section);
        new Notice(kind === "expense" ? `−¥${formatMoney(amount)} 已记账` : `+¥${formatMoney(amount)} 已记账`);
        amountInput.value = "";
        noteInput.value = "";
        this.refreshToday();
        amountInput.focus();
      } catch (e) {
        new Notice("记账失败，请检查日记目录设置");
      } finally {
        saveBtn.removeClass("loading");
      }
    };
    saveBtn.addEventListener("click", () => void submit());
    amountInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
    noteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });

    activeWindow.setTimeout(() => amountInput.focus(), 50);
  }

  /** 根据当前文本刷新"已识别标签"预览 */
  private refreshTagPreview(value: string, previewEl: HTMLElement) {
    const tags = extractInlineTags(value);
    previewEl.empty();
    previewEl.toggleClass("has-tags", tags.length > 0);
    if (tags.length === 0) return;
    previewEl.createDiv({ cls: "db-tag-preview-label", text: "\u5DF2\u8BC6\u522B\u6807\u7B7E" });
    const list = previewEl.createDiv({ cls: "db-tag-preview-list" });
    tags.forEach(tag => { list.createDiv({ cls: "db-tag-chip", text: tag }); });
  }

  /**
   * 媒体支持：图片文件选择 + 图片粘贴（粘贴由编辑器 onPasteFiles 传入）+ 录音。
   * toolbarSlot 存在时渲染精简工具栏（拍照 + 录音）；实时渲染模式下不再需要
   * B/S/双链 等格式化按钮——标记语法在输入时即被原生渲染。
   */
  private setupMediaSupport(editor: LiveEditor, wrap: HTMLElement, section?: SectionConfig, toolbarSlot?: HTMLElement) {
    // 图片文件选择
    const fileInput = wrap.createEl("input", {
      cls: "db-img-file-input",
      attr: { type: "file", accept: "image/*", multiple: "true" },
    });
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const files = fileInput.files;
      if (!files) return;
      for (let i = 0; i < files.length; i++) {
        await this.saveImageToVault(files[i], editor);
      }
      fileInput.value = "";
    });

    if (!toolbarSlot) return;

    // 精简工具栏：照片 + 录音
    toolbarSlot.empty();
    toolbarSlot.addClass("db-memo-toolbar");

    const photoBtn = makeActivatable(toolbarSlot.createDiv({
      cls: "db-memo-tb-btn db-memo-tb-icon",
      attr: { role: "button", "aria-label": "上传照片", title: "上传照片" },
    }));
    setIcon(photoBtn, "image");
    photoBtn.addEventListener("mousedown", e => e.preventDefault());
    photoBtn.addEventListener("click", () => fileInput.click());

    const micBtn = makeActivatable(toolbarSlot.createDiv({
      cls: "db-memo-tb-btn db-memo-tb-icon db-memo-tb-audio",
      attr: { role: "button", "aria-label": "录音", title: "录音" },
    }));
    setIcon(micBtn, "mic");
    micBtn.addEventListener("mousedown", e => e.preventDefault());
    micBtn.addEventListener("click", () => {
      if (this.isRecording) this.stopRecording(editor, micBtn);
      else this.startRecording(editor, micBtn);
    });
  }

  /** 开始录音 */
  private async startRecording(editor: LiveEditor, btn: HTMLElement) {
    try {
      // 移动端 WebView 常无媒体设备权限/API，先探测再调用
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        new Notice("当前设备不支持录音功能");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      // 探测支持的 MIME 类型
      let mimeType = "";
      const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      for (const t of types) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
          mimeType = t;
          break;
        }
      }

      if (typeof MediaRecorder === "undefined") {
        new Notice("当前环境不支持录音功能");
        return;
      }

      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.isRecording = true;
      btn.addClass("recording");

      this.mediaRecorder.ondataavailable = (e: any) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        btn.removeClass("recording");

        // 编辑器可能已因重渲染被销毁（脱离 DOM），此时只保存文件
        const blob = new Blob(this.audioChunks, { type: mimeType || "audio/webm" });
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        this.saveAudioBlob(blob, ext, editor.el.isConnected ? editor : null);
      };

      this.mediaRecorder.start();
      new Notice("\u{1F3A4} 开始录音，再次点击停止");
    } catch (e) {
      new Notice("无法启动录音，请检查麦克风权限");
      console.error("Daybook: 录音启动失败", e);
    }
  }

  /** 停止录音 */
  private stopRecording(_editor: LiveEditor, _btn: HTMLElement) {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
  }

  /** 保存音频 blob 到 vault，可选插入到编辑器 */
  private async saveAudioBlob(blob: Blob, ext: string, editor: LiveEditor | null) {
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
      const fileName = `db-audio-${ts}.${ext}`;

      const fullPath = resolveSectionPath(this.plugin.settings, this._currentSection);
      const diaryFolder = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
      const audioPath = `${diaryFolder}/${fileName}`;

      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      await this.app.vault.createBinary(audioPath, uint8);

      if (editor) {
        editor.insertAtCursor(`\n![[${fileName}]]\n`);
      }

      new Notice(`\u{1F3A4} 录音已保存：${fileName}`);
    } catch (e) {
      new Notice("音频保存失败，请检查日记目录设置");
      console.error("Daybook: 音频保存失败", e);
    }
  }

  private async saveImageToVault(file: File, editor: LiveEditor) {
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
      const ext = file.name.split(".").pop() || "png";
      const fileName = `db-img-${ts}.${ext}`;

      const fullPath = resolveSectionPath(this.plugin.settings, this._currentSection);
      const diaryFolder = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
      const imagePath = `${diaryFolder}/${fileName}`;

      const arrayBuffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      await this.app.vault.createBinary(imagePath, uint8);

      editor.insertAtCursor(`\n![[${fileName}]]\n`);

      new Notice(`\u{1F4F7} 图片已添加：${fileName}`);
    } catch (e) {
      new Notice("图片保存失败，请检查日记目录设置");
      console.error("Daybook: 图片保存失败", e);
    }
  }

  /** 闪念 Tab：快速记录（心情选择器可选，支持 Markdown/双链/标签的增强编辑器） */
  private renderMemosTab(container: HTMLElement, section: SectionConfig) {
    const mobile = isMobile();
    const moods = this.plugin.settings.customMoods;
    const showMood = section.showMoodPicker !== false;

    // 心情选择器（可在章节设置中隐藏）
    if (showMood) {
      const moodGrid = container.createDiv({ cls: "db-mood-grid db-mood-grid-4col" });
      moods.forEach((mood, idx) => {
        const pill = moodGrid.createDiv({
          cls: `db-mood-pill ${this.selectedMood === mood.emoji ? "selected" : ""}`,
          attr: { "aria-label": `${mood.label}（长按编辑）` },
        });
        pill.createDiv({ cls: "db-mood-emoji", text: mood.emoji });
        pill.createEl("span", { cls: "db-mood-label", text: mood.label });

        // 长按编辑（600ms）
        let longPressTimer: number | null = null;
        let isLongPress = false;

        const startPress = () => {
          isLongPress = false;
          longPressTimer = activeWindow.setTimeout(() => {
            isLongPress = true;
            const canDelete = moods.length > 1;
            new MoodEditModal(
              this.app,
              mood,
              idx,
              canDelete,
              async (i, emoji, label) => {
                this.plugin.settings.customMoods[i].emoji = emoji;
                this.plugin.settings.customMoods[i].label = label;
                await this.plugin.saveSettings();
                if (this.selectedMood === mood.emoji) {
                  this.selectedMood = emoji;
                }
                this.buildUI();
              },
              async (i) => {
                if (this.selectedMood === this.plugin.settings.customMoods[i].emoji) {
                  this.selectedMood = null;
                }
                this.plugin.settings.customMoods.splice(i, 1);
                await this.plugin.saveSettings();
                this.buildUI();
              }
            ).open();
          }, 600);
        };

        const cancelPress = () => {
          if (longPressTimer !== null) {
            activeWindow.clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        };

        pill.addEventListener("pointerdown", startPress);
        pill.addEventListener("pointerup", cancelPress);
        pill.addEventListener("pointerleave", cancelPress);
        pill.addEventListener("pointermove", cancelPress);
        pill.addEventListener("pointercancel", cancelPress);

        pill.addEventListener("click", () => {
          if (isLongPress) return; // 长按触发后不触发点击
          this.selectedMood = this.selectedMood === mood.emoji ? null : mood.emoji;
          moodGrid.querySelectorAll(".db-mood-pill").forEach(p => p.removeClass("selected"));
          if (this.selectedMood) pill.addClass("selected");
        });
      });
    }

    const wrap = container.createDiv({ cls: "db-input-wrap" });
    // 工具栏挂载点（位于输入框上方）：照片 + 录音
    const toolbarSlot = wrap.createDiv({ cls: "db-memo-toolbar-slot" });
    this._currentSection = section;

    // 内嵌 Live Preview 编辑器：输入即渲染（Obsidian 原生 Markdown 效果）
    // tagPreview 在下方声明，onChange 回调触发时它必然已存在
    const tagPreviewRef: { el: HTMLElement | null } = { el: null };
    const editor = this.makeEditor(wrap, {
      placeholder: section.placeholder,
      onChange: (value) => { if (tagPreviewRef.el) this.refreshTagPreview(value, tagPreviewRef.el); },
      onPasteFiles: (files) => {
        files.forEach(f => this.saveImageToVault(f, editor));
      },
    }, mobile ? "db-live-editor-mobile" : "");

    // 快捷标签 chips（紧跟输入框）
    this.renderQuickTags(wrap, editor);
    // 标签识别预览
    const tagPreview = wrap.createDiv({ cls: "db-tag-preview" });
    tagPreviewRef.el = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

    // 媒体：图片选择/粘贴 + 录音（精简工具栏渲染到 toolbarSlot）
    this.setupMediaSupport(editor, wrap, section, toolbarSlot);
    // textarea 降级模式：保留旧的双链/标签自动补全（实时渲染模式使用原生补全）
    if (!editor.isLive && editor.nativeInput) {
      attachMemoEditor(this.app, this.plugin, editor.nativeInput, wrap, { toolbar: false });
    }

    const saveBtn = makeActivatable(wrap.createDiv({ cls: "db-save-btn db-save-btn-sticky" }), `保存${section.label}`);
    saveBtn.createDiv({ cls: "db-btn-icon", text: section.emoji });
    saveBtn.createDiv({ cls: "db-btn-text", text: `\u4FDD\u5B58${section.label}` });
    // focusin 对 textarea 与 CM contentDOM 均可冒泡捕获
    editor.el.addEventListener("focusin", () => {
      activeWindow.setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });
    saveBtn.addEventListener("click", async () => {
      const text = editor.getValue().trim();
      if (!text && !this.selectedMood) { new Notice("\u8BF7\u5148\u8F93\u5165\u5185\u5BB9\uFF5E"); return; }
      const mood = moods.find(m => m.emoji === this.selectedMood);
      const content = mood
        ? (text ? `${mood.emoji} ${mood.label} \u2014 ${text}` : `${mood.emoji} ${mood.label}`)
        : text;
      saveBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, content, section);
        new Notice("\u2726 \u95EA\u5FF5\u5DF2\u8BB0\u5F55");
        editor.setValue("");
        this.selectedMood = null;
        container.querySelectorAll(".db-mood-pill.selected").forEach(p => p.removeClass("selected"));
        this.refreshToday();
        editor.focus();
      } catch (e) { new Notice("\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { saveBtn.removeClass("loading"); }
    });
  }

  /** 渲染快捷标签 chips，点击向编辑器插入 #标签 */
  private renderQuickTags(container: HTMLElement, editor: LiveEditor) {
    const tags = this.plugin.settings.quickTags;
    if (tags.length === 0) return;

    const chipRow = container.createDiv({ cls: "db-quick-tags" });
    chipRow.createSpan({ cls: "db-quick-tags-label", text: "\u5FEB\u6377\u6807\u7B7E\uFF1A" });
    tags.forEach(tag => {
      const chip = makeActivatable(chipRow.createDiv({
        cls: "db-quick-tag-chip",
        text: `#${tag}`,
        attr: { role: "button", "aria-label": `添加标签 ${tag}` },
      }));
      chip.addEventListener("click", () => {
        const insertText = `#${tag} `;
        const sel = editor.getSelection();
        // 光标前已有 '#'（如补全触发中）时替换它，避免出现 ##标签
        let from = sel.from;
        if (from > 0 && editor.getValue()[from - 1] === "#") from--;
        editor.replaceRange(from, sel.to, insertText);
      });
    });
  }

  private renderPlansTab(container: HTMLElement, section: SectionConfig) {
    const wrap = container.createDiv({ cls: "db-input-wrap db-plans-input-wrap" });

    // 输入行：左侧 + 按钮，右侧内嵌 Live Preview 编辑器
    const addRow = wrap.createDiv({ cls: "db-todo-add-row db-todo-add-row-textarea" });
    const addBtn = makeActivatable(addRow.createDiv({ cls: "db-todo-add-btn db-todo-add-btn-left", text: "+", attr: { "aria-label": "添加待办" } }));

    this._currentSection = section;

    // 提示区元素在编辑器后创建，onChange 触发时通过 ref 访问
    const hintRefs: { date: HTMLElement | null; tags: HTMLElement | null } = { date: null, tags: null };

    // 单行增长型实时编辑器：Enter 添加、Shift+Enter 换行（高度由 CSS 自适应，最高 120px）
    const editor = this.makeEditor(addRow, {
      placeholder: section.placeholder,
      onChange: (value) => {
        // 降级 textarea 才需要 JS 自动增高；CM 由 CSS 自适应
        if (!editor.isLive && editor.nativeInput) {
          const ta = editor.nativeInput;
          ta.style.height = "auto";
          ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
        }
        const dateHint = hintRefs.date;
        if (dateHint) {
          const result = extractDateFromText(value);
          if (result.date) {
            dateHint.setText(`\u{1F4C5} \u5DF2\u8BC6\u522B\uFF1A${formatDueDate(result.date)}（${result.date}）`);
            dateHint.addClass("visible");
          } else {
            dateHint.setText("");
            dateHint.removeClass("visible");
          }
        }
        if (hintRefs.tags) this.refreshTagPreview(value, hintRefs.tags);
      },
      onEnter: (_mod, shift) => {
        if (!shift) {
          addItem();
          return true; // 吞掉 Enter，不插入换行
        }
        return false; // Shift+Enter 换行
      },
      onPasteFiles: (files) => {
        files.forEach(f => this.saveImageToVault(f, editor));
      },
    }, "db-live-editor-plan");

    // 降级 textarea 初始为单行（CM 模式高度完全由 CSS 控制）
    if (!editor.isLive && editor.nativeInput) editor.nativeInput.rows = 1;

    // 快捷标签 chips（紧跟输入行）
    this.renderQuickTags(wrap, editor);
    // 自动识别日期的提示区
    const dateHint = wrap.createDiv({ cls: "db-date-hint" });
    hintRefs.date = dateHint;
    // 子任务添加提示区
    const subHint = wrap.createDiv({ cls: "db-date-hint db-subtask-hint" });
    // 标签识别预览
    const tagPreview = wrap.createDiv({ cls: "db-tag-preview db-tag-preview-plans" });
    hintRefs.tags = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

    const updateSubHint = () => {
      const target = this.subtaskTarget !== null ? this.todoItems[this.subtaskTarget] : null;
      if (target) {
        subHint.setText(`\u21B3 \u6B63\u5728\u4E3A\u300C${target.text}\u300D\u6DFB\u52A0\u5B50\u4EFB\u52A1`);
        subHint.addClass("visible");
      } else {
        subHint.setText("");
        subHint.removeClass("visible");
      }
    };

    // 媒体支持（图片粘贴/选择；计划页不放录音工具栏）
    this.setupMediaSupport(editor, wrap, section);
    // textarea 降级模式：保留旧的双链/标签自动补全
    if (!editor.isLive && editor.nativeInput) {
      attachMemoEditor(this.app, this.plugin, editor.nativeInput, wrap, { toolbar: false });
    }

    // 优先级按钮行
    const priorityRow = wrap.createDiv({ cls: "db-priority-row" });
    const priorityBtn = makeActivatable(priorityRow.createDiv({
      cls: `db-priority-btn ${this.currentPriority ? `priority-${this.currentPriority}` : ""}`,
      attr: { "aria-label": "设置优先级" },
    }));
    createPriorityBadge(priorityBtn, this.currentPriority);
    priorityBtn.createSpan({ cls: "db-priority-label", text: PRIORITY_META[effectivePriority(this.currentPriority)].label });

    // 优先级弹出层（4 级：1重要且紧急 / 2重要不紧急默认 / 3不重要但紧急 / 4不重要不紧急）
    const priorityPopover = wrap.createDiv({ cls: "db-priority-popover" });
    priorityPopover.style.display = "none";

    const doc = activeDocument;
    (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => {
      const opt = priorityPopover.createDiv({ cls: `db-priority-option level-${lv}` });
      createPriorityBadge(opt, lv);
      opt.createSpan({ text: `${lv} ${PRIORITY_META[lv].label}` });
      if (effectivePriority(this.currentPriority) === lv) opt.addClass("active");
      opt.addEventListener("click", () => {
        doc.removeEventListener("click", docClickHandler);
        this.currentPriority = lv;
        this.buildUI();
      });
    });

    const clearOpt = priorityPopover.createDiv({ cls: "db-priority-option clear" });
    clearOpt.createSpan({ text: "\u{274C}" });
    clearOpt.createSpan({ text: "\u6062\u590D\u9ED8\u8BA4\uFF082 \u91CD\u8981\u4E0D\u7D27\u6025\uFF09" });
    if (!this.currentPriority) clearOpt.addClass("active");

    let popoverOpen = false;
    const docClickHandler = () => {
      if (popoverOpen) {
        popoverOpen = false;
        priorityPopover.style.display = "none";
        priorityBtn.removeClass("open");
        doc.removeEventListener("click", docClickHandler);
      }
    };
    const togglePopover = () => {
      popoverOpen = !popoverOpen;
      priorityPopover.style.display = popoverOpen ? "block" : "none";
      priorityBtn.toggleClass("open", popoverOpen);
      if (popoverOpen) {
        // 延迟添加，避免当前点击立即触发关闭
        activeWindow.setTimeout(() => {
          doc.addEventListener("click", docClickHandler);
        }, 0);
      } else {
        doc.removeEventListener("click", docClickHandler);
      }
    };
    priorityBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(); });
    priorityPopover.addEventListener("click", (e) => { e.stopPropagation(); });

    clearOpt.addEventListener("click", () => {
      doc.removeEventListener("click", docClickHandler);
      this.currentPriority = null;
      this.buildUI();
    });

    // 保存按钮紧贴输入区，本次编辑的任务列表显示在其下方
    const saveBtn = makeActivatable(container.createDiv({ cls: "db-save-btn db-save-btn-sticky" }), `保存${section.label}`);
    saveBtn.createDiv({ cls: "db-btn-icon", text: section.emoji });
    saveBtn.createDiv({ cls: "db-btn-text", text: `\u4FDD\u5B58${section.label}` });
    editor.el.addEventListener("focusin", () => {
      activeWindow.setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });

    const todoList = container.createDiv({ cls: "db-todo-list" });
    this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
      this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
      updateSubHint();
      editor.focus();
    } });

    const addItem = () => {
      const rawText = editor.getValue().trim();
      if (!rawText) return;
      const { date, text } = extractDateFromText(rawText);
      const item: TodoItem = {
        text: text || rawText,
        done: false,
        lineIndex: -1,
        dueDate: date,
        createdAt: moment().format("YYYY-MM-DD HH:mm"),
        priority: this.currentPriority ?? undefined,
      };
      if (this.subtaskTarget !== null && this.todoItems[this.subtaskTarget]) {
        // 子任务：插入到目标任务的子树末尾
        item.indent = 1;
        let e = this.subtaskTarget + 1;
        while (e < this.todoItems.length && this.todoItems[e].indent) e++;
        this.todoItems.splice(e, 0, item);
      } else {
        // 最后添加的在最上面
        this.todoItems.unshift(item);
      }
      this.subtaskTarget = null;
      editor.setValue("");
      dateHint.setText("");
      dateHint.removeClass("visible");
      updateSubHint();
      this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
        this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
        updateSubHint();
        editor.focus();
      } });
      editor.focus();
    };

    addBtn.addEventListener("click", addItem);
    // Enter 添加 / Shift+Enter 换行已由编辑器 onEnter 统一处理

    const clearRow = container.createDiv({ cls: "db-todo-clear-row" });
    const clearBtn = clearRow.createDiv({ cls: "db-todo-clear-btn", text: "\u6E05\u9664\u5DF2\u5B8C\u6210" });
    const rerender = () => this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
      this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
      updateSubHint();
      editor.focus();
    } });
    clearBtn.addEventListener("click", () => { this.todoItems = this.todoItems.filter(t => !t.done); rerender(); });

    saveBtn.addEventListener("click", async () => {
      if (this.todoItems.length === 0) { new Notice("\u8BF7\u5148\u6DFB\u52A0\u5F85\u529E\u4E8B\u9879\uFF5E"); return; }
      // 保持父子层级排序：先分组（顶级+子任务），组间按优先级/日期排序
      const groups: { head: TodoItem; children: TodoItem[] }[] = [];
      this.todoItems.forEach(t => {
        if (t.indent && groups.length > 0) groups[groups.length - 1].children.push(t);
        else groups.push({ head: t, children: [] });
      });
      groups.sort((a, b) => {
        if (a.head.done !== b.head.done) return a.head.done ? 1 : -1;
        const pa = parseInt(effectivePriority(a.head.priority));
        const pb = parseInt(effectivePriority(b.head.priority));
        if (pa !== pb) return pa - pb;
        if (a.head.dueDate && b.head.dueDate) return a.head.dueDate.localeCompare(b.head.dueDate);
        if (a.head.dueDate) return -1;
        if (b.head.dueDate) return 1;
        return 0;
      });
      const sorted = groups.flatMap(g => [g.head, ...g.children]);
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const completedField = getCompletedFieldName(this.plugin.settings);
      // 与其他章节统一的 "- HH:mm" 列表格式（章节标题已表明是计划，不再重复写"计划"字样）
      const lines = [
        `- ${timeStr}`,
        ...sorted.map(t => {
          const indent = t.indent ? "        " : "    ";
          let line = `${indent}- [${t.done ? "x" : " "}] ${t.text}`;
          // 优先级标记放在文本后面（默认 2 级不写标记）
          const eff = effectivePriority(t.priority);
          if (eff !== "2") line += ` ${PRIORITY_EMOJI[eff]}`;
          if (t.dueDate) line += ` \u{1F4C5} ${t.dueDate}`;
          // 创建时间行内字段（用于计算完成耗时）
          if (t.createdAt) line += ` [createdAt::${t.createdAt}]`;
          // 完成时间行内字段（仅已完成的任务）
          if (t.done && t.completedAt) line += ` [${completedField}::${t.completedAt}]`;
          return line;
        }),
      ];
      saveBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, lines.join("\n"), section);
        new Notice("\u2726 \u8BA1\u5212\u5DF2\u8BB0\u5F55");
        this.todoItems = [];
        this.currentPriority = null;
        this.subtaskTarget = null;
        this.buildUI();
      } catch (e) { new Notice("\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { saveBtn.removeClass("loading"); }
    });
  }

  private renderTodoItems(
    container: HTMLElement,
    opts?: { onAddSubtask?: (idx: number) => void }
  ) {
    let dragFrom: number | null = null;
    container.empty();
    if (this.todoItems.length === 0) {
      container.createDiv({ cls: "db-todo-empty", text: "\u6682\u65E0\u5F85\u529E\uFF0C\u5728\u4E0A\u65B9\u8F93\u5165\u540E\u6309\u56DE\u8F66\u6DFB\u52A0\uFF5E" });
      return;
    }
    this.todoItems.forEach((todo, i) => {
      const item = container.createDiv({ cls: `db-todo-item ${todo.done ? "done" : ""} ${todo.indent ? "sub" : ""}` });
      // 拖拽调整顺序与层级：拖到目标任务上半 = 插到其前；下半 = 顶级任务变为其子任务 / 子任务插到其后
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        dragFrom = i;
        item.addClass("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(i));
        }
      });
      item.addEventListener("dragend", () => {
        dragFrom = null;
        container.querySelectorAll(".db-todo-item").forEach(el => el.removeClass("drop-before", "drop-after", "dragging"));
      });
      item.addEventListener("dragover", (e) => {
        if (dragFrom === null || dragFrom === i) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        item.toggleClass("drop-before", !lower);
        item.toggleClass("drop-after", lower);
      });
      item.addEventListener("dragleave", () => item.removeClass("drop-before", "drop-after"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = dragFrom;
        dragFrom = null;
        item.removeClass("drop-before", "drop-after");
        if (from === null || from === i) return;
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        const asChild = !this.todoItems[i].indent && lower;
        moveTodoSubtree(this.todoItems, from, i, asChild, lower && !asChild);
        this.renderTodoItems(container, opts);
      });
      const cb = item.createEl("input", { cls: "db-todo-checkbox", attr: { type: "checkbox" } });
      cb.checked = todo.done;
      cb.addEventListener("change", () => {
        // 父子级联：勾父全勾子，子全勾自动勾父（含完成时间）
        if (cb.checked) this.plugin.feedback.notify();
        this.setEditTodoCascade(i, cb.checked, moment().format("YYYY-MM-DD HH:mm"));
        this.renderTodoItems(container, opts);
      });
      const textEl = item.createDiv({ cls: `db-todo-text ${todo.done ? "strikethrough" : ""}` });
      // 优先级徽标（圆形罗马数字 SVG；2 级默认隐藏，可在设置开启）
      if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
        createPriorityBadge(textEl, todo.priority);
      }
      textEl.createSpan({ text: todo.text });
      if (todo.dueDate) {
        textEl.createSpan({ cls: `db-todo-due ${moment(todo.dueDate).isBefore(moment(), "day") ? "overdue" : ""}`, text: `\u{1F4C5} ${formatDueDate(todo.dueDate)}` });
      }
      // 已完成任务的耗时 / 完成时间徽标
      appendTodoCompletionInfo(textEl, todo, this.plugin.settings, false);
      const actionRow = item.createDiv({ cls: "db-todo-actions" });
      // 添加子任务按钮（仅顶级任务）
      if (!todo.indent && opts?.onAddSubtask) {
        makeActivatable(actionRow.createDiv({
          cls: `db-todo-add-sub ${this.subtaskTarget === i ? "active" : ""}`,
          text: "\u21B3",
          attr: { role: "button", "aria-label": "添加子任务" },
        })).addEventListener("click", () => opts.onAddSubtask!(i));
      }
      makeActivatable(actionRow.createDiv({ cls: "db-todo-del", text: "\xD7", attr: { "aria-label": "删除待办" } })).addEventListener("click", () => {
        this.todoItems.splice(i, 1);
        if (this.subtaskTarget === i) this.subtaskTarget = null;
        this.renderTodoItems(container, opts);
      });
    });
  }

  /** 编辑视图（内存中）父子任务级联勾选 */
  private setEditTodoCascade(index: number, done: boolean, stamp: string) {
    const items = this.todoItems;
    const t = items[index];
    if (!t) return;
    t.done = done;
    t.completedAt = done ? stamp : undefined;
    if (t.indent) {
      // 子任务 → 同步父任务：全部完成自动完成，任一未完成自动取消
      let p = index - 1;
      while (p >= 0 && items[p].indent) p--;
      if (p >= 0) {
        let e = p + 1;
        let allDone = true;
        while (e < items.length && items[e].indent) {
          if (!items[e].done) allDone = false;
          e++;
        }
        if (e > p + 1) {
          items[p].done = allDone;
          items[p].completedAt = allDone ? (items[p].completedAt ?? stamp) : undefined;
        }
      }
    } else {
      // 父任务 → 同步所有子任务
      let e = index + 1;
      while (e < items.length && items[e].indent) {
        items[e].done = done;
        items[e].completedAt = done ? stamp : undefined;
        e++;
      }
    }
  }
}
