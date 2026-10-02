import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, Menu, setIcon, debounce } from "obsidian";
import type DaybookPlugin from "./main";
import { appendToSection, resolveSectionPath } from "./fileManager";
import { createPriorityBadge, effectivePriority, PRIORITY_EMOJI, PRIORITY_META, readAllJournalEntries, type PriorityLevel } from "./fileReader";
import { getVisibleSections, type SectionConfig, type MoodOption } from "./settings";
import { ConfirmModal, TodayPanel } from "./TodayPanel";
import { FilterPanel } from "./FilterPanel";
import { MemoSearchModal } from "./memoSearch";
import { MemoSidebar } from "./memoSidebar";
import {
  activeDimensions,
  collectTags,
  emptyFilter,
  isFilterActive,
  matchHabit,
  type SectionFilter,
  type StatusFilter,
} from "./filters";
import { attachMemoEditor } from "./memoEditor";
import { createLiveEditor, type LiveEditor, type LiveEditorOptions } from "./liveEditor";
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
  type TrendBucket,
  type TrendDimension,
  type TrendResult,
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

/** 单日打卡明细弹窗：补打卡 / 逐条撤销 / 取消跳过（入口 = 热力图格子点击） */
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
    // 补打卡入口（过去忘记打卡时用；未来日期不提供）
    const todayStr = moment().format("YYYY-MM-DD");
    let addBtn: HTMLElement | null = null;
    if (this.date <= todayStr) {
      const addRow = makeActivatable(contentEl.createDiv({
        cls: "db-habit-day-add",
        attr: { "aria-label": `补打卡 ${this.date}` },
      }), `补打卡 ${this.date}`);
      setIcon(addRow.createDiv({ cls: "db-habit-day-add-icon" }), "plus");
      addRow.createSpan({ text: "补打卡（记录当前时间）" });
      addBtn = addRow;
      const doAdd = async () => {
        if (addRow.classList.contains("busy")) return;
        addRow.classList.add("busy");
        try {
          await checkinHabit(this.app, this.habit, this.date);
          new Notice(`✅ 已补打卡 ${this.date}`);
          this.onChanged?.();
          render();
        } catch (e) {
          new Notice("补打卡失败：" + (e instanceof Error ? e.message : String(e)));
        } finally {
          addRow.classList.remove("busy");
        }
      };
      addRow.addEventListener("click", doAdd);
    }
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
  /** 趋势图视图：柱状图 / 折线图（记忆上次选择） */
  private trendChart: "bar" | "line" = HabitDetailModal.loadChartPref();

  private static loadChartPref(): "bar" | "line" {
    try {
      return window.localStorage.getItem("daybook-trend-chart") === "line" ? "line" : "bar";
    } catch {
      return "bar";
    }
  }

  private saveChartPref() {
    try {
      window.localStorage.setItem("daybook-trend-chart", this.trendChart);
    } catch {
      // localStorage 不可用（隐私模式等）时只在本次会话内生效
    }
  }

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
        // 悬浮提示：打卡时间明细（Obsidian 原生 aria-label tooltip）
        let tip: string;
        const dayTimes = dayCheckins(rows, this.habit.id, cell.date);
        if (dayTimes.length > 0) {
          tip = `${cell.date} · ` + dayTimes
            .map(r => [r.time, r.note].filter(Boolean).join(" ") || "打卡")
            .join(" · ");
        } else if (cell.skipped) tip = `${cell.date} · 已跳过`;
        else if (cell.rest) tip = `${cell.date} · 休息日`;
        else tip = `${cell.date} · 未打卡`;
        el.setAttribute("aria-label", tip);
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
        attr: { "aria-label": `完成度 ${l * 25}% 以上` },
      });
    }
    legend.createSpan({ text: "多" });
    legend.createDiv({ cls: "db-heatmap-cell skipped mini", attr: { "aria-label": "跳过" } });
    legend.createDiv({ cls: "db-heatmap-cell rest mini", attr: { "aria-label": "休息日" } });
  }

  /** 依弹窗内容宽决定可见周数：每列实际 14px（11px 格 + 3px 缝），预留星期轴与内外边距约 96px；
   *  弹窗较宽（≥620px）时右侧统计栏占约 120px，窄弹窗时统计栏经 CSS 换行到网格下方不计宽 */
  private visibleWeeks(): number {
    const width = this.contentEl?.clientWidth ?? 0;
    if (width <= 0) return 10;   // 布局未完成时的回退
    const side = width >= 620 ? 120 : 0;
    const cols = Math.floor((width - 96 - side) / 14);
    return Math.max(5, Math.min(26, cols));
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
      const right = head.createDiv({ cls: "db-trend-head-right" });
      // 柱状图 / 折线图切换（小按钮，记忆选择）
      const syncToggle = () => {
        setIcon(chartBtn, this.trendChart === "bar" ? "line-chart" : "bar-chart");
        chartBtn.setAttribute("aria-label", this.trendChart === "bar" ? "切换为折线图" : "切换为柱状图");
      };
      const chartBtn = makeActivatable(right.createDiv({ cls: "db-heatmap-arrow db-trend-chart-toggle" }), "切换图表类型");
      syncToggle();
      chartBtn.addEventListener("click", () => {
        this.trendChart = this.trendChart === "bar" ? "line" : "bar";
        this.saveChartPref();
        syncToggle();
        this.renderTrendOnly(card);
      });
      // 维度切换标签（标题行右侧）
      const tabs = right.createDiv({ cls: "db-trend-tabs" });
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

    // 范围 + 翻页 + 图表
    this.renderTrendRange(card);
  }

  private renderTrendOnly(card: HTMLElement) {
    card.querySelectorAll(".db-trend-range, .db-trend-chart, .db-trend-axis").forEach(el => el.remove());
    this.renderTrendRange(card);
  }

  /** 悬浮提示文案（柱状图与折线图共用） */
  private trendTip(b: TrendBucket): string {
    return this.trendDim === "year"
      ? `${b.fullLabel} · 打卡 ${b.count} 次 · 达标率 ${Math.round(b.rate * 100)}%`
      : b.rest
        ? `${b.fullLabel} · 休息日`
        : `${b.fullLabel} · ${b.count}/${b.target} 次 · 完成 ${Math.round(b.rate * 100)}%`;
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

    if (this.trendChart === "line") this.renderTrendLine(card, result);
    else this.renderTrendBars(card, result);

    // 横轴标签（两种图表共用）
    const axis = card.createDiv({ cls: "db-trend-axis" });
    const thin = result.buckets.length > 14;
    result.buckets.forEach(b => {
      const lab = axis.createDiv({ cls: `db-trend-label${thin ? " thin" : ""}` });
      if (!thin || b.label === "1" || Number(b.label) % 5 === 0) lab.setText(b.label);
    });
  }

  private renderTrendBars(card: HTMLElement, result: TrendResult) {
    const chart = card.createDiv({ cls: "db-trend-chart" });
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
      barEl.setAttribute("aria-label", this.trendTip(b));
    });
  }

  /** 折线图：SVG 折线 + 面积（休息日断开），HTML 圆点覆盖层保证点不变形且可悬浮 */
  private renderTrendLine(card: HTMLElement, result: TrendResult) {
    const buckets = result.buckets;
    const n = buckets.length;
    const dailyTarget = this.trendDim === "year" ? 0 : Math.max(1, this.habit.timesPerDay || 1);
    const maxVal = Math.max(dailyTarget, 1, ...buckets.map(b => b.count));
    // 纵向留 3% 顶部余量：value → 距底部百分比
    const pctOf = (v: number) => 3 + (v / maxVal) * 94;
    const chart = card.createDiv({ cls: "db-trend-chart db-trend-line" });

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n * 10} 100`);
    svg.setAttribute("preserveAspectRatio", "none");
    const yOf = (v: number) => 100 - pctOf(v);

    // 目标参考线（年维度的 target 是天数，量纲不同，不画）
    if (dailyTarget > 0) {
      const tline = document.createElementNS(svgNS, "line");
      tline.setAttribute("x1", "0");
      tline.setAttribute("x2", String(n * 10));
      tline.setAttribute("y1", String(yOf(dailyTarget)));
      tline.setAttribute("y2", String(yOf(dailyTarget)));
      tline.setAttribute("class", "db-trend-line-target");
      svg.appendChild(tline);
    }

    // 折线按休息日切成若干段；每段配一块面积
    const segments: { pts: string; firstX: number; lastX: number }[] = [];
    let cur: string[] = [];
    let firstX = 0;
    let lastX = 0;
    buckets.forEach((b, i) => {
      if (b.rest) {
        if (cur.length) segments.push({ pts: cur.join(" "), firstX, lastX });
        cur = [];
        return;
      }
      const x = i * 10 + 5;
      if (cur.length === 0) firstX = x;
      lastX = x;
      cur.push(`${x},${yOf(b.count).toFixed(2)}`);
    });
    if (cur.length) segments.push({ pts: cur.join(" "), firstX, lastX });
    for (const seg of segments) {
      if (seg.pts.includes(" ")) {
        const area = document.createElementNS(svgNS, "polygon");
        area.setAttribute("points", `${seg.pts} ${seg.lastX},97 ${seg.firstX},97`);
        area.setAttribute("class", "db-trend-line-area");
        svg.appendChild(area);
      }
      const line = document.createElementNS(svgNS, "polyline");
      line.setAttribute("points", seg.pts);
      line.setAttribute("class", "db-trend-line-path");
      svg.appendChild(line);
    }
    chart.appendChild(svg);

    // 圆点覆盖层：每列一个绝对定位的点（与 SVG 同一纵向映射）
    const cols = chart.createDiv({ cls: "db-trend-line-cols" });
    buckets.forEach(b => {
      const col = cols.createDiv({ cls: "db-trend-line-col" });
      const dot = col.createDiv({ cls: `db-trend-line-dot${b.rest ? " rest" : ""}` });
      dot.style.bottom = `${pctOf(b.count)}%`;
      dot.setAttribute("aria-label", this.trendTip(b));
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
  // 心情选择条展开状态（按章节记忆，视图会话内有效；初始值取章节设置“是否展开”）
  private moodOpenMap: Record<string, boolean> = {};
  private activeSectionId: string = "memos";
  // 合一视图：顶栏（左上角章节下拉）+ 单列页面（输入区 → 今日记录流）
  private todayPanel: TodayPanel | null = null;
  private todayHostEl: HTMLElement | null = null;
  private _vpResizeHandler: (() => void) | null = null;
  /** pan 模式下 visualViewport 滚动（系统平移）监听 */
  private _vpScrollHandler: (() => void) | null = null;
  /** Obsidian 原生键盘事件监听（window 上的 keyboardWillShow/Hide） */
  private _kbShowHandler: ((e: Event) => void) | null = null;
  private _kbHideHandler: (() => void) | null = null;
  /** 键盘收起状态下的布局视口高度基线（webview 是否随键盘收缩的判定基准） */
  private _idleInnerH = 0;
  /** 最近一次已知的键盘高度（收起后仍保留，用于面板展开前预抬、避免系统平移漂移） */
  private _lastKnownKeyboardHeight = 0;
  /** 最近一次记录的 visualViewport.offsetTop（pan 漂移校正用） */
  private _lastVpOffsetTop = 0;
  /** 安卓底部导航栏显隐观察（body class/style 变化时重算底部让位） */
  private _navClassObserver: MutationObserver | null = null;
  /** 最近一次视口几何指纹（导航栏重叠|容器底|视口高|视觉视口|键盘变量），变化时才重算 */
  private _lastVpFingerprint = "";
  /** 系统底部安全区高度缓存（按视口尺寸失效） */
  private _safeBottom = -1;
  private _safeBottomKey = "";
  // 录音相关
  private mediaRecorder: any = null;
  private audioChunks: Blob[] = [];
  private _currentSection?: SectionConfig;
  private isRecording = false;
  // 计划优先级
  private currentPriority: PriorityLevel | null = null;
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
  /** 最近一次整页渲染的日期（YYYY-MM-DD）：切回标签页时用于检测跨天 */
  private renderedDate = moment().format("YYYY-MM-DD");

  constructor(leaf: WorkspaceLeaf, plugin: DaybookPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_JOURNAL; }
  getDisplayText(): string { return "Daybook"; }
  getIcon(): string { return "book-open"; }

  async onOpen() {
    // 恢复最近使用的章节（章节已删/停用时 buildUI 会回退到首个）
    this.activeSectionId = this.plugin.settings.lastSectionId || this.activeSectionId;
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
    this._vpResizeHandler = () => this.applyViewportSize();
    vp?.addEventListener("resize", this._vpResizeHandler);
    // 工作区尺寸变化（分栏拖拽、旋转屏幕、原生头部显隐）时重算避让与折叠
    this.registerEvent(this.app.workspace.on("resize", () => {
      this.applyViewportSize();
    }));
    // 安卓端 Obsidian 滚动/键盘时会显隐底部导航栏、设置键盘高度（body class/style 变化），
    // 几何有变化时重算根容器高度与底部让位，保证固定输入栏/面板不被遮挡
    this._navClassObserver = new MutationObserver(() => {
      if (this.viewportFingerprint() !== this._lastVpFingerprint) this.applyViewportSize();
    });
    this._navClassObserver.observe(activeDocument.body, { attributes: true, attributeFilter: ["class", "style"] });
    // --keyboard-height 可能挂在 :root 上，一并观察
    const htmlEl = activeDocument.documentElement;
    if (htmlEl && htmlEl !== activeDocument.body) {
      this._navClassObserver.observe(htmlEl, { attributes: true, attributeFilter: ["class", "style"] });
    }
    // Obsidian 原生层在 window 上派发键盘事件（Capacitor Keyboard 插件，安卓/iOS 通用），
    // 与自带移动工具栏用的是同一事件源——是键盘弹出/收起最确定、最及时的信号
    this._kbShowHandler = () => {
      this.applyViewportSize();
      // 原生层先派发事件、后落地 --keyboard-height 与动画，连续补测对齐
      activeWindow.setTimeout(() => this.applyViewportSize(), 80);
      activeWindow.setTimeout(() => this.applyViewportSize(), 300);
    };
    this._kbHideHandler = () => {
      this.applyViewportSize();
      activeWindow.setTimeout(() => this.applyViewportSize(), 150);
    };
    activeWindow.addEventListener("keyboardWillShow", this._kbShowHandler as EventListener);
    activeWindow.addEventListener("keyboardWillHide", this._kbHideHandler as EventListener);
    // pan 模式下系统平移会改变 visualViewport.offsetTop，滚动事件里随时校正漂移
    this._vpScrollHandler = () => {
      const vp2 = activeWindow.visualViewport;
      if (vp2 && Math.round(vp2.offsetTop) !== this._lastVpOffsetTop) this.applyViewportSize();
    };
    vp?.addEventListener("scroll", this._vpScrollHandler);
    // 跨天检测：切回 Daybook 标签页时若日期已变，整页重建（今日记录流/输入区/习惯页翻到新的一天）
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!leaf || leaf.view !== this) return;
      const today = moment().format("YYYY-MM-DD");
      if (today !== this.renderedDate) {
        this.buildUI();
        new Notice("ℹ️ 已跨入新的一天，Daybook 已按今天刷新");
      }
    }));
    this.applyViewportSize();
    // 首帧布局未就绪时 visualViewport.height 可能为 0（被上面的守卫跳过），布局后再补测两次
    activeWindow.requestAnimationFrame(() =>
      activeWindow.requestAnimationFrame(() => this.applyViewportSize())
    );
  }

  private teardownViewportAdapter() {
    const vp = activeWindow.visualViewport;
    if (vp && this._vpResizeHandler) {
      vp.removeEventListener("resize", this._vpResizeHandler);
      this._vpResizeHandler = null;
    }
    if (vp && this._vpScrollHandler) {
      vp.removeEventListener("scroll", this._vpScrollHandler);
      this._vpScrollHandler = null;
    }
    if (this._kbShowHandler) {
      activeWindow.removeEventListener("keyboardWillShow", this._kbShowHandler as EventListener);
      this._kbShowHandler = null;
    }
    if (this._kbHideHandler) {
      activeWindow.removeEventListener("keyboardWillHide", this._kbHideHandler as EventListener);
      this._kbHideHandler = null;
    }
    this._navClassObserver?.disconnect();
    this._navClassObserver = null;
  }

  /**
   * 根容器高度 = min(可视视口高度 - 底部导航栏重叠, 容器实际可用高度)。
   * 安卓端 floating navbar（.mobile-navbar）悬浮在内容之上，不清让会导致
   * 底部输入栏/编辑面板/保存按钮被盖住；Obsidian 键盘弹起时会自行收缩
   * app-container（--keyboard-height），visualViewport 也可能收缩——两者取小值，
   * 无论哪种键盘模式都能让底部输入贴在键盘上方。桌面端无导航栏，重叠量为 0。
   */
  private applyViewportSize() {
    const root = this.containerEl.children[1] as HTMLElement;
    if (!root) return;
    const vp = activeWindow.visualViewport;
    const navbarInset = this.measureBottomInset();
    const vpH = vp ? Math.round(vp.height) : 0;
    const containerRect = this.containerEl.getBoundingClientRect();
    const rootTop = root.getBoundingClientRect().top;
    const availH = Math.round(containerRect.bottom - rootTop);
    const base = vpH > 0 ? vpH - navbarInset : availH;
    const h = Math.min(base, availH > 0 ? availH : base);
    if (h <= 0) return; // 首帧未布局（如弹窗窗口）时不写 0 高度
    const innerH = Math.round(activeWindow.innerHeight);
    this._lastVpFingerprint = `${navbarInset}|${Math.round(containerRect.bottom)}|${innerH}|${vpH}|${this.readCssKeyboardHeight()}`;
    root.style.height = h + "px";
    root.style.maxHeight = h + "px";
    // 供吸底面板限高：面板底=视口底-bottom-inset，向上不超过视口顶
    root.style.setProperty("--db-vp-h", `${innerH}px`);
    // 固定悬浮栏（flomo 式）底部让位：
    // 键盘弹出时 = 键盘高度 + 键盘上方 Obsidian 输入工具栏的高度
    // （底边贴在用户看到的"键盘"顶缘 = 工具栏顶；无工具栏时=键盘物理顶部）；
    // 键盘未弹出时 = 10px 呼吸 + 导航栏重叠 + 系统安全区（避开手势条）
    const keyboard = this.measureKeyboardHeight(vp, innerH, Math.round(containerRect.bottom));
    if (keyboard === 0) this._idleInnerH = innerH; // 维护"键盘未弹出"的视口高度基线
    const bottomInset = keyboard > 0
      ? keyboard + this.readToolbarHeight(innerH, keyboard)
      : 10 + navbarInset + this.readSafeBottom(innerH);
    root.style.setProperty("--db-bottom-inset", `${bottomInset}px`);
    this.applyTopbarInset();
    this.fitTopbar();
  }

  /** Obsidian 键盘上方输入工具栏的高度：可见且紧贴键盘顶缘停靠时才计入 */
  private readToolbarHeight(innerH: number, keyboardH: number): number {
    const toolbar = activeDocument.querySelector(".mobile-toolbar") as HTMLElement | null;
    if (!toolbar) return 0;
    const rect = toolbar.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    // 工具栏停靠位置：bottom ≈ 视口底 - 键盘高（即键盘顶缘）；未停靠/已隐藏时不占位
    if (rect.bottom < innerH - keyboardH - 2) return 0;
    return Math.round(rect.height);
  }

  /**
   * 键盘让位高度 = 键盘实际遮住布局视口底部的量，只用真实几何测量：
   * - 容器收缩量：Obsidian 键盘弹出时以 max-height: calc(100vh - 键盘高) 收缩工作区
   * - 视觉视口收缩量：webview 自身随键盘收缩（adjustResize / resizes-visual）的机型
   * 原生注入的 --keyboard-height 只反映键盘物理高度、不代表视口被遮多少——
   * 在 webview 已收缩的机型上把它加进 bottom 会造成"二次抬升"（面板飞出屏幕顶），
   * 因此绝不直接作为位移使用，只通过上面两条几何信号体现。
   */
  private measureKeyboardHeight(
    vp: VisualViewport | null,
    innerH: number,
    containerBottom: number
  ): number {
    // webview 已随键盘收缩的机型（adjustResize）：布局视口底=键盘顶，
    // fixed bottom:0 本就贴着键盘——任何额外让位都是二次抬升（面板飞出屏幕顶）
    const resized = this._idleInnerH > 0 && innerH < this._idleInnerH - 5;
    if (resized) return 0;
    let kb = Math.max(0, innerH - containerBottom);
    // pan 模式下系统平移由 offsetTop 反映：可见底缘=height+offsetTop 已到布局底时
    // 差值为 0（此时系统自行把输入区顶到键盘上方，插件不再叠加位移，避免漂移）；
    // 捏合缩放（scale≠1）排除误判
    if (vp && vp.scale === 1) {
      this._lastVpOffsetTop = Math.round(vp.offsetTop || 0);
      kb = Math.max(kb, Math.max(0, innerH - Math.round(vp.height + vp.offsetTop)));
    } else {
      this._lastVpOffsetTop = 0;
    }
    // 防御性钳制：任何信号异常（如瞬时报 0）都不允许键盘高度超过屏高 70%，
    // 否则底边 inset 会把面板整个推出屏幕外（"输入框消失"）
    const clamped = Math.min(kb, Math.round(innerH * 0.7));
    if (clamped > 0) this._lastKnownKeyboardHeight = clamped;
    return clamped;
  }

  /** 读取 Obsidian 注入的 --keyboard-height（可能挂在 :root 或 body 上） */
  private readCssKeyboardHeight(): number {
    const doc = activeDocument;
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      const v = parseFloat(getComputedStyle(el).getPropertyValue("--keyboard-height"));
      if (!Number.isNaN(v) && v > 0) return Math.round(v);
    }
    return 0;
  }

  /** 系统底部安全区高度（键盘未弹出时避开手势条）；按视口尺寸缓存 */
  private readSafeBottom(viewportKey: number): number {
    const key = `${viewportKey}x${Math.round(activeWindow.innerWidth)}`;
    if (this._safeBottomKey === key && this._safeBottom >= 0) return this._safeBottom;
    let value = 0;
    const doc = activeDocument;
    const rootEl = doc.documentElement;
    const v = rootEl ? parseFloat(getComputedStyle(rootEl).getPropertyValue("--safe-area-inset-bottom")) : NaN;
    if (!Number.isNaN(v) && v > 0) {
      value = Math.round(v);
    } else if (doc.body) {
      // env() 探针：部分安卓机型 var 未注入，用真实布局测
      const probe = doc.createElement("div");
      probe.style.cssText = "position:fixed;bottom:0;left:0;height:0;padding-bottom:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none;";
      doc.body.appendChild(probe);
      value = Math.round(probe.getBoundingClientRect().height);
      probe.remove();
    }
    this._safeBottomKey = key;
    this._safeBottom = value;
    return value;
  }

  /** 视口几何指纹：导航栏重叠|容器底缘|视口高|视觉视口高|键盘变量（键盘弹起会改变后三者） */
  private viewportFingerprint(): string {
    const containerRect = this.containerEl.getBoundingClientRect();
    const vp = activeWindow.visualViewport;
    const vpH = vp ? Math.round(vp.height) : 0;
    return `${this.measureBottomInset()}|${Math.round(containerRect.bottom)}|${Math.round(activeWindow.innerHeight)}|${vpH}|${this.readCssKeyboardHeight()}`;
  }

  /** 测量底部导航栏与视图底部的重叠量（导航栏隐藏/非悬浮/桌面端时为 0） */
  private measureBottomInset(): number {
    const navbar = activeDocument.querySelector(".mobile-navbar") as HTMLElement | null;
    if (!navbar) return 0;
    const navRect = navbar.getBoundingClientRect();
    if (navRect.height <= 0) return 0;
    const viewRect = this.containerEl.getBoundingClientRect();
    return Math.max(0, Math.round(viewRect.bottom - navRect.top));
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
    this.renderedDate = moment().format("YYYY-MM-DD");
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
    try {
      this.renderTabContent(composer, active);
    } catch (e) {
      // 真机渲染异常兜底：直接显示错误，避免整页空白无从排查
      console.error("Daybook: 编辑区渲染失败", e);
      composer.createDiv({
        cls: "db-page-empty",
        text: `编辑区渲染失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // 今日记录区标题（含条数徽标）
    const todayHead = page.createDiv({ cls: "db-today-head" });
    todayHead.createSpan({ cls: "db-today-label", text: "今日记录" });
    todayHead.createSpan({ cls: "db-today-count" });
    this.todayHeadEl = todayHead;
    this.todayHostEl = page.createDiv({ cls: "db-today-host" });
    this.todayPanel = new TodayPanel(this.todayHostEl, this.plugin, todayHead);
    this.todayPanel.filter = this.getFilter(active.id);
    this.todayPanel.onResult = (count, days) => this.filterPanel?.setCount(count, days);
    // 点击记录上的标签：叠加/移除该标签到章节筛选（多标签 = 全部包含）
    this.todayPanel.onToggleTag = (tag) => {
      const section = this._currentSection;
      if (!section) return;
      const f = this.getFilter(section.id);
      f.tags = f.tags.includes(tag) ? f.tags.filter(t => t !== tag) : [...f.tags, tag];
      this.applyFilter();
      // 筛选面板开着时重建，让标签选中态同步
      if (this.filterOpen) void this.openFilterPanel();
    };
    // 计划分组方式（任务总览）注入 TodayPanel，切换时持久化
    this.todayPanel.planGroupBy = () => {
      const v = this.plugin.settings.reviewState.planGroupBy;
      return v === "priority" || v === "date" ? v : "none";
    };
    this.todayPanel.onPlanGroupByChange = (mode) => {
      this.plugin.settings.reviewState.planGroupBy = mode;
      void this.plugin.saveSettings();
    };
    this.syncHabitStreamVisibility();
    void this.todayPanel.refresh(active.id);

    // 视图重建后恢复已展开的筛选面板
    if (this.filterOpen) this.openFilterPanel();
    // 重建后立即让位底部导航栏（等不到下一次视口 resize）
    this.applyViewportSize();
  }

  /** 顶栏（memos 式三区）：左=筛选、中=章节切换标题、右=操作；窄屏溢出折进「＋」菜单 */
  private renderTopBar(root: HTMLElement, sections: SectionConfig[], active: SectionConfig | null) {
    const bar = root.createDiv({ cls: "db-topbar" });
    this.topbarEl = bar;

    /* ── 左区：侧边抽屉（闪念）+ 本章节内容筛选入口 ── */
    const left = bar.createDiv({ cls: "db-topbar-zone db-topbar-left" });
    if (active?.type === "memos") {
      const drawerBtn = left.createEl("button", {
        cls: "db-topbar-btn",
        attr: { type: "button", "aria-label": "闪念统计与标签", title: "统计与标签" },
      });
      setIcon(drawerBtn, "menu");
      drawerBtn.addEventListener("click", () => {
        new MemoSidebar({
          plugin: this.plugin,
          section: active,
          onClose: () => {},
          onResetFilters: () => {
            const f = this.getFilter(active.id);
            Object.assign(f, emptyFilter());
            this.applyFilter();
            if (this.filterOpen) void this.openFilterPanel();
          },
          onTagClick: (tag) => {
            const f = this.getFilter(active.id);
            f.tags = f.tags.includes(tag) ? f.tags.filter(t => t !== tag) : [...f.tags, tag];
            this.applyFilter();
            if (this.filterOpen) void this.openFilterPanel();
          },
        }).open();
      });
    }
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
            // 离开计划章节时重置未提交的优先级选择
            if (this._currentSection?.type === "plans") {
              this.currentPriority = null;
            }
            this.activeSectionId = sec.id;
            // 记住最近使用的章节，下次打开视图直接进入
            this.plugin.settings.lastSectionId = sec.id;
            void this.plugin.saveSettings();
            this.buildUI();
          });
        });
      });
      // 闪念章节：排序方式（新→旧 / 旧→新），持久化
      if (active?.type === "memos") {
        menu.addSeparator();
        const cur = this.plugin.settings.memoSortOrder ?? "newest";
        menu.addItem(item => {
          item.setTitle(`排序：${cur === "newest" ? "创建时间从新到旧" : "创建时间从旧到新"}`).setIcon("arrow-down-up");
          item.onClick(() => {
            this.plugin.settings.memoSortOrder = cur === "newest" ? "oldest" : "newest";
            void this.plugin.saveSettings();
            void this.todayPanel?.refresh(active.id);
          });
        });
      }
      // 固定锚定在标题下方（键盘 Enter 触发时 click 坐标为 0，不能直接用鼠标位置）
      const rect = trigger.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left + 10, y: rect.bottom + 4 });
    });

    /* ── 右区：快捷操作（真实 <button>；宽度不足时由 fitTopbar 折叠） ── */
    const right = bar.createDiv({ cls: "db-topbar-zone db-topbar-actions" });
    this.topbarRightEl = right;
    const specs: { icon: string; label: string; run: () => void; el?: HTMLElement }[] = [
      ...(active?.type === "memos" ? [{
        icon: "search", label: "搜索闪念", run: () => this.openMemoSearch(active),
      }] : []),
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
    this.syncFilterStickyTop();
  }

  /** 筛选托盘悬浮位置：吸附在顶栏下缘（顶栏高度/避让量变化后需重设） */
  private syncFilterStickyTop(): void {
    const host = this.filterHostEl;
    const bar = this.topbarEl;
    if (!host || !bar) return;
    const inset = bar.hasClass("is-inset") ? (parseFloat(bar.style.top) || 0) : 0;
    host.style.top = `${Math.round(inset + bar.offsetHeight)}px`;
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
  getFilter(sectionId: string): SectionFilter {
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
    try {
      const groups = await readAllJournalEntries(this.app, this.plugin.settings, new Set([section.id]));
      tags = collectTags(groups.flatMap(g => g.entries));
    } catch { /* 读不到历史时只给静态维度（心情/优先级等仍可用） */ }
    if (!this.filterOpen || !host.isConnected) return;

    host.empty();
    this.filterPanel = new FilterPanel({
      host,
      plugin: this.plugin,
      section,
      filter: this.getFilter(section.id),
      tags,
      onChange: () => this.applyFilter(),
      onRequestClose: () => this.closeFilterPanel(),
    });
    this.updateFilterBadge();
    this.syncFilterStickyTop();
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
  /** 打开闪念搜索弹窗：确认后把关键词与快捷筛选写入章节筛选并刷新记录流 */
  private openMemoSearch(section: SectionConfig) {
    const f = this.getFilter(section.id);
    new MemoSearchModal(this.app, {
      plugin: this.plugin,
      section,
      initialKeyword: f.q,
      onApply: (keyword, quick) => {
        f.q = keyword.trim();
        f.quick = quick;
        this.applyFilter();
        if (this.filterOpen) void this.openFilterPanel();
      },
    }).open();
  }

  private refreshToday() {
    void this.todayPanel?.refresh(this.activeSectionId);
  }

  private renderTabContent(container: HTMLElement, section: SectionConfig) {
    if (section.type === "plans") this.renderPlansTab(container, section);
    else if (section.type === "habits") this.renderHabitsTab(container, section);
    else this.renderMemosTab(container, section);
  }

  /** 习惯打卡：主界面增删改 + 单次/多次打卡 + 休息日态（时间在详情页悬浮显示） */
  private async renderHabitsTab(container: HTMLElement, section: SectionConfig) {
    container.empty();
    container.addClass("db-habits-tab");

    const todayStr = moment().format("YYYY-MM-DD");
    /** 跨天保护：动作发生的那一刻现取"今天"，视图开过夜时避免把打卡写到昨天 */
    const nowToday = () => moment().format("YYYY-MM-DD");
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

    // 默认只列未归档的习惯；筛选面板里可切到「已归档」
    const status: StatusFilter = f.status === "archived" ? "archived" : "active";
    const rowsOf = (id: string) => data.find(d => d.config.id === id)?.rows ?? [];
    const computeHabits = () => data
      .map(d => d.config)
      .filter(h => matchHabit(h, rowsOf(h.id), { ...f, status }, todayStr));
    let habits = computeHabits();
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
          // 归档/取消归档会改变可见集合，过滤列表必须重算
          habits = computeHabits();
          this.filterPanel?.setCount(habits.length, 0);
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
          // 过天检测：界面还停在昨天时，整页按新的一天重渲染（旧计数不可信，不执行动作）
          if (nowToday() !== todayStr) {
            rerender();
            new Notice("ℹ️ 已跨入新的一天，界面已按今天刷新");
            return;
          }
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
          // 过天检测：菜单里的"今天"操作（跳过/备注/清空）都按渲染日期执行，过天先重渲染
          if (nowToday() !== todayStr) {
            rerender();
            new Notice("ℹ️ 已跨入新的一天，界面已按今天刷新");
            return;
          }
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
          menu.addItem(mi => mi
            .setIcon(habit.archived ? "archive-restore" : "archive")
            .setTitle(habit.archived ? "取消归档（恢复每日展示）" : "归档习惯（不再每日展示）")
            .onClick(async () => {
              const toArchived = !habit.archived;
              try {
                await updateHabitConfig(this.app, habit, { archived: toArchived });
              } catch (e) {
                new Notice("操作失败，请检查日记目录设置");
                return;
              }
              new Notice(toArchived
                ? `📦 ${habit.name} 已归档，可在筛选「已归档」中查看`
                : `↩️ ${habit.name} 已取消归档`);
              refreshAll();
            }));
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

  /** 通用录音启动：成功返回 true，停止时回调 blob（录音 UI 由调用方负责） */
  private async startRecorder(onStop: (blob: Blob, ext: string) => void): Promise<boolean> {
    try {
      // 移动端 WebView 常无媒体设备权限/API，先探测再调用
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        new Notice("当前设备不支持录音功能");
        return false;
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
        return false;
      }

      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.isRecording = true;

      this.mediaRecorder.ondataavailable = (e: any) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        const blob = new Blob(this.audioChunks, { type: mimeType || "audio/webm" });
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        onStop(blob, ext);
      };

      this.mediaRecorder.start();
      return true;
    } catch (e) {
      new Notice("无法启动录音，请检查麦克风权限");
      console.error("Daybook: 录音启动失败", e);
      return false;
    }
  }

  /** 开始录音（编辑面板内点按式：点击开始/再次点击停止，音频插入编辑器） */
  private async startRecording(editor: LiveEditor, btn: HTMLElement) {
    const ok = await this.startRecorder((blob, ext) => {
      btn.removeClass("recording");
      void this.saveAudioBlob(blob, ext, editor.el.isConnected ? editor : null);
    });
    if (ok) {
      btn.addClass("recording");
      new Notice("\u{1F3A4} 开始录音，再次点击停止");
    }
  }

  /** 停止录音 */
  private stopRecording(_editor: LiveEditor, _btn: HTMLElement) {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
  }

  /** 停止录音并在停止后执行回调（覆盖注册期回调，用于胶囊栏的发送/取消分支） */
  private stopRecorderWith(onStop: (blob: Blob, ext: string) => void) {
    if (this.mediaRecorder && this.isRecording) {
      const rec = this.mediaRecorder;
      rec.onstop = () => {
        rec.stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        const blob = new Blob(this.audioChunks, { type: rec.mimeType || "audio/webm" });
        const mimeType = rec.mimeType || "";
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        this.mediaRecorder = null;
        onStop(blob, ext);
      };
      rec.stop();
    }
  }

  /** 保存音频 blob 到 vault，可选插入到编辑器；返回嵌入文本（失败返回 null） */
  private async saveAudioBlob(blob: Blob, ext: string, editor: LiveEditor | null): Promise<string | null> {
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

      const embed = `![[${fileName}]]`;
      if (editor) {
        editor.insertAtCursor(`\n${embed}\n`);
      }

      new Notice(`\u{1F3A4} 录音已保存：${fileName}`);
      return embed;
    } catch (e) {
      new Notice("音频保存失败，请检查日记目录设置");
      console.error("Daybook: 音频保存失败", e);
      return null;
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

  /** 闪念 Tab：移动端=底部悬浮输入栏(长按语音)；桌面端=顶部编辑器卡片(flomo 桌面式) */
  private renderMemosTab(container: HTMLElement, section: SectionConfig) {
    this._currentSection = section;

    if (!isMobile()) {
      // 桌面端：常驻编辑器卡片（composer 即卡片）
      container.addClass("db-editor-card");
      this.buildEditorPanel(container, container, section, null, "inline");
      return;
    }

    // 移动端：flomo 式编辑卡片直接嵌在记录流顶部（第一条闪念的位置）。
    // 在文档流内随页面滚动，键盘弹出由系统自然避让光标——
    // 不用 fixed 悬浮定位，从根上消除键盘导致的漂移/丢失
    container.addClass("db-editor-card");
    container.addClass("db-composer-instream");
    this.buildEditorPanel(container, container, section, null, "sheet");
  }

  /**
   * 编辑面板内容（移动端 sheet / 桌面端 inline 卡片共用）：
   * 心情条 + 编辑器 + 快捷标签/字数 + 标签预览 + 媒体工具 + 保存( sheet 底部大按钮 / inline 纸飞机发送)
   */
  private buildEditorPanel(
    panel: HTMLElement,
    container: HTMLElement,
    section: SectionConfig,
    bar: HTMLElement | null,
    mode: "sheet" | "inline"
  ): LiveEditor {
    const mobile = isMobile();
    const moods = this.plugin.settings.customMoods;
    // inline(桌面) 默认收起心情条，保持卡片整洁；sheet(移动) 沿用章节设置
    const moodOpen = this.moodOpenMap[section.id]
      ?? (mode === "inline" ? false : section.showMoodPicker !== false);
    const moodToggleRef: { el: HTMLElement | null } = { el: null };

    // 心情选择条（仅移动端 sheet；桌面卡片按设计精简不放置）
    if (moods.length && mode === "sheet") {
      const moodGrid = panel.createDiv({ cls: `db-mood-grid db-mood-grid-4col${moodOpen ? "" : " is-collapsed"}` });
      moods.forEach((mood, idx) => {
        const pill = moodGrid.createDiv({
          cls: `db-mood-pill ${this.selectedMood === mood.emoji ? "selected" : ""}`,
          attr: { "aria-label": `${mood.label}（长按编辑）` },
        });
        pill.createDiv({ cls: "db-mood-emoji", text: mood.emoji });
        pill.createEl("span", { cls: "db-mood-label", text: mood.label });

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
                this.reopenEditorPanel(container, section, bar, mode);
              },
              async (i) => {
                if (this.selectedMood === this.plugin.settings.customMoods[i].emoji) {
                  this.selectedMood = null;
                }
                this.plugin.settings.customMoods.splice(i, 1);
                await this.plugin.saveSettings();
                this.reopenEditorPanel(container, section, bar, mode);
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
          if (isLongPress) return;
          this.selectedMood = this.selectedMood === mood.emoji ? null : mood.emoji;
          moodGrid.querySelectorAll(".db-mood-pill").forEach(p => p.removeClass("selected"));
          if (this.selectedMood) {
            pill.addClass("selected");
            this.moodOpenMap[section.id] = false;
            moodGrid.toggleClass("is-collapsed", true);
            moodToggleRef.el?.toggleClass("is-active", false);
          }
          moodToggleRef.el?.setText(this.selectedMood ?? "🙂");
          updateSend?.();
        });
      });
    }

    const wrap = panel.createDiv({ cls: "db-input-wrap" });
    const tagPreviewRef: { el: HTMLElement | null } = { el: null };
    const charCountRef: { update: ((v: string) => void) | null } = { update: null };
    let updateSend: (() => void) | null = null;

    const editor = this.makeEditor(wrap, {
      placeholder: section.placeholder,
      onChange: (value) => {
        if (tagPreviewRef.el) this.refreshTagPreview(value, tagPreviewRef.el);
        charCountRef.update?.(value);
        updateSend?.();
      },
      onPasteFiles: (files) => {
        files.forEach(f => this.saveImageToVault(f, editor));
      },
    }, mobile ? "db-live-editor-mobile" : "");

    this.renderQuickTags(wrap, editor);
    this.mountCharCount(wrap, editor, charCountRef);
    const tagPreview = wrap.createDiv({ cls: "db-tag-preview" });
    tagPreviewRef.el = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

    if (mode === "inline") {
      // 桌面：编辑器下方工具行（左工具组 + 右纸飞机发送）
      const toolbar = wrap.createDiv({ cls: "db-editor-toolbar" });
      const toolsLeft = toolbar.createDiv({ cls: "db-editor-tools" });

      // 1) 标签 #
      const hashTool = makeActivatable(toolsLeft.createDiv({
        cls: "db-editor-tool",
        text: "#",
        attr: { role: "button", "aria-label": "插入标签" },
      }), "插入标签");
      hashTool.addEventListener("click", () => {
        editor.insertAtCursor("#");
        editor.focus();
      });

      // 2) 图片（setupMediaSupport 的照片按钮；点按式麦克风按钮按设计移除）
      const toolbarSlot = toolsLeft.createDiv({ cls: "db-memo-toolbar-slot" });
      this.setupMediaSupport(editor, wrap, section, toolbarSlot);
      toolsLeft.querySelector(".db-memo-tb-audio")?.remove();

      toolsLeft.createDiv({ cls: "db-editor-divider" });

      // 3) 文字样式 Aa（二级：加粗 / 下划线 / 高亮）
      const styleTool = makeActivatable(toolsLeft.createDiv({
        cls: "db-editor-tool",
        text: "Aa",
        attr: { role: "button", "aria-label": "文字样式" },
      }), "文字样式");
      styleTool.addEventListener("click", (e) => {
        const menu = new Menu();
        menu.addItem(mi => mi.setTitle("加粗").setIcon("bold").onClick(() => this.wrapSelection(editor, "**", "**")));
        menu.addItem(mi => mi.setTitle("下划线").setIcon("underline").onClick(() => this.wrapSelection(editor, "<u>", "</u>")));
        menu.addItem(mi => mi.setTitle("高亮").setIcon("highlighter").onClick(() => this.wrapSelection(editor, "==", "==")));
        menu.showAtMouseEvent(e);
      });

      // 4) 无序列表
      const ulTool = makeActivatable(toolsLeft.createDiv({
        cls: "db-editor-tool",
        attr: { role: "button", "aria-label": "无序列表" },
      }), "无序列表");
      setIcon(ulTool, "list");
      ulTool.addEventListener("click", () => {
        editor.insertAtCursor("\n- ");
        editor.focus();
      });

      // 5) 有序列表
      const olTool = makeActivatable(toolsLeft.createDiv({
        cls: "db-editor-tool",
        attr: { role: "button", "aria-label": "有序列表" },
      }), "有序列表");
      setIcon(olTool, "list-ordered");
      olTool.addEventListener("click", () => {
        editor.insertAtCursor("\n1. ");
        editor.focus();
      });

      // 右侧动作按钮（双态）：默认麦克风=点击开始/再次点击停止录音；输入文字后变纸飞机发送
      const actionBtn = toolbar.createEl("button", {
        cls: "db-editor-send",
        attr: { type: "button", "aria-label": "录音（点击开始，再次点击停止）" },
      });
      setIcon(actionBtn, "mic");
      let actionMode: "mic" | "send" = "mic";
      const syncAction = () => {
        if (this.isRecording) return; // 录音中保持麦克风态（红色脉冲由 recording 类控制）
        const has = !!editor.getValue().trim() || !!this.selectedMood;
        const next: "mic" | "send" = has ? "send" : "mic";
        if (next !== actionMode) {
          actionMode = next;
          setIcon(actionBtn, next === "send" ? "send" : "mic");
          actionBtn.toggleClass("is-active", next === "send");
          actionBtn.setAttribute("aria-label", next === "send" ? `保存${section.label}` : "录音（点击开始，再次点击停止）");
        }
      };
      updateSend = syncAction;
      syncAction();

      const submit = async () => {
        const text = editor.getValue().trim();
        if (!text && !this.selectedMood) return;
        const mood = moods.find(m => m.emoji === this.selectedMood);
        const content = mood
          ? (text ? `${mood.emoji} ${mood.label} — ${text}` : `${mood.emoji} ${mood.label}`)
          : text;
        actionBtn.disabled = true;
        try {
          await appendToSection(this.app, this.plugin.settings, section.label, section.type, content, section);
          new Notice("✦ 闪念已记录");
          editor.setValue("");
          this.selectedMood = null;
          moodToggleRef.el?.setText("🙂");
          panel.querySelectorAll(".db-mood-pill.selected").forEach(p => p.removeClass("selected"));
          this.refreshToday();
          editor.focus();
        } catch (e) { new Notice("记录失败，请检查日记目录设置"); }
        finally { actionBtn.disabled = false; updateSend?.(); }
      };
      // 录音时长显示（桌面按钮录音态）
      const recTime = toolbar.createSpan({ cls: "db-editor-rec-time", text: "0:00" });
      recTime.style.display = "none";
      let recTimer = 0;
      let recSecs = 0;
      const stopRecTimer = () => {
        if (recTimer) { activeWindow.clearInterval(recTimer); recTimer = 0; }
        recTime.style.display = "none";
      };

      actionBtn.addEventListener("click", () => {
        if (this.isRecording) {
          stopRecTimer();
          this.stopRecording(editor, actionBtn);
          return;
        }
        if (actionMode === "send") { void submit(); return; }
        void (async () => {
          await this.startRecording(editor, actionBtn);
          if (!this.isRecording) return;   // 启动失败（无权限等）不计时
          recSecs = 0;
          recTime.textContent = "0:00";
          recTime.style.display = "";
          recTimer = activeWindow.setInterval(() => {
            recSecs++;
            recTime.textContent = `${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, "0")}`;
          }, 1000);
        })();
      });
      editor.el.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && actionMode === "send") { e.preventDefault(); void submit(); }
      });
    } else {
      // 移动端 sheet：flomo 式紧凑布局——文本区 + 单行工具条（# 图片 B 列表 心情 ⋯ ｜ 录音 发送）
      const composerBar = wrap.createDiv({ cls: "db-composer-bar" });
      const barLeft = composerBar.createDiv({ cls: "db-composer-bar-left" });
      const barRight = composerBar.createDiv({ cls: "db-composer-bar-right" });

      const barBtn = (label: string, title: string) => makeActivatable(barLeft.createDiv({
        cls: "db-memo-tb-btn db-memo-tb-icon",
        attr: { role: "button", "aria-label": title, title },
      }), title);

      // 1) # 标签
      const hashBtn = barBtn("hash", "插入标签");
      setIcon(hashBtn, "hash");
      hashBtn.addEventListener("click", () => {
        editor.insertAtCursor("#");
        editor.focus();
      });

      // 2) 图片 + 录音（setupMediaSupport 生成两个按钮，录音移到右组）
      const mediaSlot = barLeft.createDiv({ cls: "db-composer-media-slot" });
      this.setupMediaSupport(editor, wrap, section, mediaSlot);

      // 3) B 加粗
      const boldBtn = barBtn("bold", "加粗");
      setIcon(boldBtn, "bold");
      boldBtn.addEventListener("click", () => {
        this.wrapSelection(editor, "**", "**");
      });

      // 4) 列表
      const listBtn = barBtn("list", "无序列表");
      setIcon(listBtn, "list");
      listBtn.addEventListener("click", () => {
        editor.insertAtCursor("\n- ");
        editor.focus();
      });

      // 5) 心情（配置了心情才显示）
      if (moods.length) {
        const toggle = makeActivatable(barLeft.createDiv({
          cls: `db-memo-tb-btn db-memo-tb-icon db-mood-toggle${moodOpen ? " is-active" : ""}`,
          text: this.selectedMood ?? "🙂",
          attr: { role: "button", "aria-label": "展开/收起心情选择", title: "心情选择" },
        }));
        toggle.addEventListener("click", () => {
          const now = !(this.moodOpenMap[section.id] ?? section.showMoodPicker !== false);
          this.moodOpenMap[section.id] = now;
          panel.querySelectorAll(".db-mood-grid").forEach(g => g.toggleClass("is-collapsed", !now));
          toggle.toggleClass("is-active", now);
        });
        moodToggleRef.el = toggle;
      }

      // 6) ⋯ 更多文字样式
      const moreBtn = makeActivatable(barLeft.createDiv({
        cls: "db-memo-tb-btn db-memo-tb-icon",
        attr: { role: "button", "aria-label": "更多样式", title: "更多样式" },
      }), "更多样式");
      setIcon(moreBtn, "more-horizontal");
      moreBtn.addEventListener("click", (e) => {
        const menu = new Menu();
        menu.addItem(mi => mi.setTitle("下划线").setIcon("underline").onClick(() => this.wrapSelection(editor, "<u>", "</u>")));
        menu.addItem(mi => mi.setTitle("高亮").setIcon("highlighter").onClick(() => this.wrapSelection(editor, "==", "==")));
        menu.addItem(mi => mi.setTitle("删除线").setIcon("strikethrough").onClick(() => this.wrapSelection(editor, "~~", "~~")));
        menu.showAtMouseEvent(e as MouseEvent);
      });

      // 录音按钮移到右组
      const micBtn = mediaSlot.querySelector(".db-memo-tb-audio") as HTMLElement | null;
      if (micBtn) barRight.appendChild(micBtn);

      // 发送（保存）按钮：绿色圆形纸飞机
      const sendBtn = makeActivatable(barRight.createEl("button", {
        cls: "db-composer-send",
        attr: { type: "button", "aria-label": `保存${section.label}` },
      }), `保存${section.label}`);
      setIcon(sendBtn, "send");
      let saving = false;
      const submitSave = async () => {
        const text = editor.getValue().trim();
        if (!text && !this.selectedMood) { new Notice("请先输入内容～"); return; }
        if (saving) return;
        const mood = moods.find(m => m.emoji === this.selectedMood);
        const content = mood
          ? (text ? `${mood.emoji} ${mood.label} — ${text}` : `${mood.emoji} ${mood.label}`)
          : text;
        saving = true;
        sendBtn.addClass("loading");
        try {
          await appendToSection(this.app, this.plugin.settings, section.label, section.type, content, section);
          new Notice("✦ 闪念已记录");
          // 内联卡片：清空内容继续下一条，不关闭面板
          editor.setValue("");
          this.selectedMood = null;
          moodToggleRef.el?.setText("🙂");
          panel.querySelectorAll(".db-mood-pill.selected").forEach(p => p.removeClass("selected"));
          this.refreshToday();
        } catch (e) { new Notice("记录失败，请检查日记目录设置"); }
        finally { saving = false; sendBtn.removeClass("loading"); }
      };
      sendBtn.addEventListener("click", () => { void submitSave(); });
      // Ctrl/Cmd+Enter 发送
      editor.el.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submitSave(); }
      });
    }

    // textarea 降级模式：保留旧的双链/标签自动补全
    if (!editor.isLive && editor.nativeInput) {
      attachMemoEditor(this.app, this.plugin, editor.nativeInput, wrap, { toolbar: false });
    }
    return editor;
  }

  /** 重建编辑面板（心情编辑等设置变更后刷新内容；保留容器原位重建） */
  private reopenEditorPanel(container: HTMLElement, section: SectionConfig, _bar: HTMLElement | null, mode: "sheet" | "inline") {
    container.empty();
    container.addClass("db-editor-card");
    if (isMobile()) container.addClass("db-composer-instream");
    this.buildEditorPanel(container, container, section, _bar, mode);
  }

  /** 用标记包裹当前选区（无选区时插入样例文字，光标落在标记内） */
  private wrapSelection(editor: LiveEditor, before: string, after: string) {
    const sel = editor.getSelection();
    const selected = editor.getValue().slice(sel.from, sel.to);
    editor.replaceRange(sel.from, sel.to, before + selected + after);
    editor.focus();
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

  /** 字数统计：显示在快捷标签同一行最右（无快捷标签时独占一行）；超过 350 字颜色变深 */
  private mountCharCount(
    wrap: HTMLElement,
    editor: LiveEditor,
    ref: { update: ((v: string) => void) | null }
  ): void {
    let row = wrap.querySelector(":scope > .db-quick-tags") as HTMLElement | null;
    if (!row) row = wrap.createDiv({ cls: "db-quick-tags" });
    const count = row.createSpan({ cls: "db-char-count", text: "0" });
    const update = (value: string) => {
      const n = [...value.trim()].length;   // 按码点计数，emoji/生僻字不翻倍
      count.setText(String(n));
      count.toggleClass("is-over", n > 350);
    };
    ref.update = update;
    update(editor.getValue());
  }

  private renderPlansTab(container: HTMLElement, section: SectionConfig) {
    const wrap = container.createDiv({ cls: "db-input-wrap db-plans-input-wrap" });

    // 输入行：整幅内嵌实时编辑器（加号按钮已移除，「添加todo」按钮直接入库）
    const addRow = wrap.createDiv({ cls: "db-todo-add-row db-todo-add-row-textarea" });

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
          void addItem();
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
    // 标签识别预览
    const tagPreview = wrap.createDiv({ cls: "db-tag-preview db-tag-preview-plans" });
    hintRefs.tags = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

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
    // 「添加todo」按钮紧贴输入区：一次点击直接入库一条（替代旧的暂存＋保存两步）
    const saveBtn = makeActivatable(container.createDiv({ cls: "db-save-btn db-save-btn-sticky" }), "添加todo");
    saveBtn.createDiv({ cls: "db-btn-icon", text: section.emoji });
    saveBtn.createDiv({ cls: "db-btn-text", text: "添加todo" });
    editor.el.addEventListener("focusin", () => {
      activeWindow.setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });

    const addItem = async () => {
      const rawText = editor.getValue().trim();
      if (!rawText) { new Notice("\u8BF7\u5148\u8F93\u5165\u5185\u5BB9\uFF5E"); return; }
      const { date, text } = extractDateFromText(rawText);
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      // 单条计划块，格式与旧批量保存一致：顶级任务缩进 4 空格 + 行内字段
      let taskLine = `    - [ ] ${text || rawText}`;
      const eff = effectivePriority(this.currentPriority);
      if (eff !== "2") taskLine += ` ${PRIORITY_EMOJI[eff]}`;
      if (date) taskLine += ` \u{1F4C5} ${date}`;
      taskLine += ` [createdAt::${moment().format("YYYY-MM-DD HH:mm")}]`;
      saveBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type,
          [`- ${timeStr}`, taskLine].join("\n"), section);
        new Notice("\u2726 \u5DF2\u6DFB\u52A0\u5F85\u529E");
        editor.setValue("");
        dateHint.setText("");
        dateHint.removeClass("visible");
        this.currentPriority = null;
        void this.refreshToday();
        editor.focus();
      } catch { new Notice("\u6DFB\u52A0\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { saveBtn.removeClass("loading"); }
    };

    saveBtn.addEventListener("click", () => { void addItem(); });
    // Enter 添加 / Shift+Enter 换行已由编辑器 onEnter 统一处理
  }
}
