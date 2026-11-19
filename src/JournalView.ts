import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, Menu, setIcon, debounce, Platform } from "obsidian";
import type DaybookPlugin from "./main";
import { appendToSection, resolveSectionPath } from "./fileManager";
import { createPriorityBadge, effectivePriority, PRIORITY_META, readAllJournalEntries, type PriorityLevel } from "./fileReader";
import { openDateSelect } from "./dateSelect";
import { openPlanSortSheet } from "./planSortSheet";
import { DEFAULT_SETTINGS, getVisibleSections, type SectionConfig, type MoodOption } from "./settings";
import { ConfirmModal, TodayPanel } from "./TodayPanel";
import { FilterPanel } from "./FilterPanel";
import { MemoSearchModal, type SearchHit } from "./memoSearch";
import { MemoSidebar } from "./memoSidebar";
import { ScrollTopButton } from "./scrollTopButton";
import {
  activeDimensions,
  collectTags,
  emptyFilter,
  isFilterActive,
  keywordMatch,
  matchHabit,
  type SectionFilter,
  type StatusFilter,
} from "./filters";
import { attachMemoEditor } from "./memoEditor";
import { DashboardPage } from "./DashboardView";
import { AiChatPage } from "./aiPage";
import { LedgerPage } from "./ledgerPage";
import { DramaPage } from "./dramaPage";
import { DRAMA_FIELDS, dramaFieldOn } from "./dramaStore";
import { createLiveEditor, type LiveEditor, type LiveEditorOptions } from "./liveEditor";
import {
  loadHabits,
  readHabitFile,
  createHabitFile,
  updateHabitConfig,
  deleteHabitFile,
  checkinHabit,
  recordRecentManualTime,
  isValidHHmm,
  deleteCheckinAt,
  clearDayCheckins,
  skipDay,
  removeSkip,
  setCheckinNote,
  computeHabitStats,
  monthCalendarCells,
  lastOpenShift,
  fmtShiftDuration,
  dayCheckins,
  daySkipped,
  isExecuteDay,
  trendBuckets,
  shiftAnchor,
  type CheckinRow,
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
  attendance: boolean;     // 上下班打卡型：点打卡弹出时间选择
  quickTimes: string[];    // 常用时间 HH:mm（attendance 时有效）
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

    /* ── 打卡类型：每日习惯 / 上下班 ──
       上下班型点打卡时弹出时间选择框（默认当前时间 + 常用时间一键打），
       用于上班/下班卡这类"记录的是时刻而非次数"的打卡 */
    let attendance = !!this.habit?.attendance;
    let quickTimes: string[] = [...(this.habit?.quickTimes ?? [])];

    const typeRow = contentEl.createDiv({ cls: "db-habit-edit-field" });
    typeRow.createDiv({ cls: "db-habit-edit-label", text: "打卡类型" });
    const typeChips = typeRow.createDiv({ cls: "db-habit-type-row" });

    // 常用时间编辑区：仅上下班型显示
    const qtField = contentEl.createDiv({ cls: "db-habit-edit-field" });
    qtField.createDiv({ cls: "db-habit-edit-label", text: "常用时间" });
    const qtChips = qtField.createDiv({ cls: "db-habit-quicktimes-row" });
    const qtAddRow = qtField.createDiv({ cls: "db-habit-quicktimes-add" });
    const qtInput = qtAddRow.createEl("input", {
      cls: "db-habit-quicktime-input",
      attr: { type: "time", "aria-label": "新常用时间" },
    });
    qtInput.value = "09:00";
    const qtAddBtn = makeActivatable(qtAddRow.createDiv({ cls: "db-habit-quicktime-addbtn", text: "添加" }), "添加常用时间");

    const renderQuickTimes = () => {
      qtField.toggleClass("is-hidden", !attendance);
      qtChips.empty();
      if (quickTimes.length === 0) {
        qtChips.createDiv({ cls: "db-habit-quicktimes-empty", text: "还没有常用时间，添加几个吧（如 09:00 / 18:00）" });
      }
      quickTimes.forEach(t => {
        const chip = qtChips.createDiv({ cls: "db-habit-quicktime-chip" });
        chip.createSpan({ cls: "db-habit-quicktime-text", text: t });
        const del = makeActivatable(chip.createSpan({ cls: "db-habit-quicktime-del", text: "×", attr: { "aria-label": `删除常用时间 ${t}` } }), `删除常用时间 ${t}`);
        del.addEventListener("click", e => {
          e.stopPropagation();
          quickTimes = quickTimes.filter(x => x !== t);
          renderQuickTimes();
        });
      });
    };
    const addQuickTime = () => {
      const v = (qtInput.value || "").trim();
      if (!isValidHHmm(v)) { new Notice("请选择有效时间（HH:mm）"); return; }
      if (quickTimes.includes(v)) { new Notice(`${v} 已在常用时间中`); return; }
      if (quickTimes.length >= 8) { new Notice("常用时间最多 8 个"); return; }
      quickTimes = [...quickTimes, v].sort();
      renderQuickTimes();
    };
    qtAddBtn.addEventListener("click", addQuickTime);

    const renderTypeChips = () => {
      typeChips.empty();
      const mk = (label: string, on: boolean, pick: () => void, tip: string) => {
        const chip = makeActivatable(typeChips.createDiv({ cls: `db-habit-type-chip${on ? " on" : ""}` }), tip);
        chip.createSpan({ text: label });
        chip.setAttribute("aria-pressed", String(on));
        chip.addEventListener("click", () => { pick(); renderTypeChips(); renderQuickTimes(); });
      };
      mk("每日习惯", !attendance, () => { attendance = false; }, "普通习惯：点打卡即记录当前时间");
      mk("上下班打卡", attendance, () => {
        attendance = true;
        // 首次开启且没配过：预置早晚两个常用时间，省去手动输入
        if (quickTimes.length === 0) quickTimes = ["09:00", "18:00"];
      }, "记录上下班时刻：点打卡弹出时间选择，常用时间可一键打卡");
    };
    renderTypeChips();
    renderQuickTimes();

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
        attendance,
        quickTimes: attendance ? quickTimes : [],
      });
      this.close();
    });
    activeWindow.setTimeout(() => nameInput.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 打卡时间选择弹窗（上下班型专用）：
 * 可选记为上班 / 下班（默认按顺序推断：有进行中班次 = 下班，否则 = 上班）；
 * 常用时间胶囊一键按该时刻打卡（最近手动设置的时间排最前）；「手动设置」展开自定义时间输入。
 * onPick 抛错时弹窗保持打开，由调用方提示。
 */
export class CheckinTimeModal extends Modal {
  constructor(
    app: any,
    private habit: HabitConfig,
    private date: string,
    private rows: CheckinRow[] | null,
    private onPick: (time: string, role: "in" | "out", manual: boolean) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-checkin-time-modal");
    contentEl.createEl("h3", { text: `${this.habit.icon} ${this.habit.name}` });
    contentEl.createDiv({ cls: "db-checkin-time-date", text: this.date });

    // 班次角色：默认按顺序推断（有进行中班次 = 下班，否则 = 上班），可手动切换
    const open = lastOpenShift(this.rows ?? [], this.habit.id);
    let role: "in" | "out" = open ? "out" : "in";

    const hint = contentEl.createDiv({ cls: "db-checkin-time-hint" });
    const renderHint = () => {
      if (role === "out" && open) {
        hint.setText(open.inDate === this.date
          ? `本次打卡将记为下班卡（上班 ${open.inTime}）`
          : `${open.inDate} ${open.inTime} 的班次还在进行中 · 本次打卡将记为它的下班卡（跨天，记录在今天）`);
      } else if (open) {
        hint.setText(`已有 ${open.inDate} ${open.inTime} 的班次进行中 · 本次打卡将开始新的班次（上班卡）`);
      } else {
        hint.setText("本次打卡将记为上班卡");
      }
    };

    // 上班 / 下班 选择（没有进行中班次时「下班」不可选——班次必须从上班卡开始）
    const roleRow = contentEl.createDiv({ cls: "db-checkin-role-row" });
    const inChip = makeActivatable(roleRow.createDiv({
      cls: "db-checkin-role-chip",
      attr: { "aria-label": "记为上班卡" },
    }), "记为上班卡");
    inChip.setText("上班");
    const outChip = open
      ? makeActivatable(roleRow.createDiv({
          cls: "db-checkin-role-chip",
          attr: { "aria-label": "记为下班卡" },
        }), "记为下班卡")
      : roleRow.createDiv({
          cls: "db-checkin-role-chip is-disabled",
          attr: { "aria-label": "没有进行中的班次，不能记下班卡" },
        });
    outChip.setText("下班");

    const setRole = (r: "in" | "out") => {
      if (r === "out" && !open) return;
      role = r;
      inChip.toggleClass("is-active", r === "in");
      outChip.toggleClass("is-active", r === "out");
      renderHint();
    };
    inChip.addEventListener("click", () => setRole("in"));
    outChip.addEventListener("click", () => setRole("out"));
    setRole(role);

    let busy = false;
    const pick = async (t: string, manual: boolean) => {
      if (busy) return;
      busy = true;
      try {
        await this.onPick(t, role, manual);
        if (manual) {
          try { await recordRecentManualTime(this.app, this.habit, t); } catch { /* 记常用失败不影响打卡 */ }
        }
        this.close();
      } catch (e) {
        busy = false;
        new Notice("打卡失败：" + (e instanceof Error ? e.message : String(e)));
      }
    };

    // 常用时间：最近手动设置的排最前，其后是设置页的快捷时刻；行尾「手动设置」展开自定义输入
    const configured = this.habit.quickTimes ?? [];
    const recents = this.habit.recentTimes ?? [];
    const quicks = [...recents, ...configured.filter(t => !recents.includes(t))];
    const row = contentEl.createDiv({ cls: "db-checkin-time-quick-row" });
    if (quicks.length > 0) row.createDiv({ cls: "db-checkin-time-quick-label", text: "常用时间" });
    quicks.forEach(t => {
      const chip = makeActivatable(row.createDiv({ cls: "db-checkin-time-quick-chip", text: t }), `按 ${t} 打卡`);
      chip.addEventListener("click", () => void pick(t, false));
    });
    const manualBtn = makeActivatable(row.createDiv({
      cls: "db-checkin-time-quick-chip db-checkin-time-manual-btn",
      attr: { "aria-label": "手动设置打卡时间" },
    }), "手动设置打卡时间");
    manualBtn.setText("＋ 手动设置");
    const manualArea = contentEl.createDiv({ cls: "db-checkin-time-manual-area" });
    const timeInput = manualArea.createEl("input", {
      cls: "db-checkin-time-input",
      attr: { type: "time", "aria-label": "打卡时间" },
    });
    timeInput.value = moment().format("HH:mm");
    manualBtn.addEventListener("click", () => {
      manualArea.toggleClass("is-open", !manualArea.hasClass("is-open"));
      if (manualArea.hasClass("is-open")) activeWindow.setTimeout(() => timeInput.focus(), 50);
    });

    const btns = contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const ok = btns.createEl("button", { cls: "mod-cta", text: "打卡" });
    ok.addEventListener("click", () => {
      const v = (timeInput.value || "").trim();
      if (manualArea.hasClass("is-open") && isValidHHmm(v)) void pick(v, true);
      else void pick(moment().format("HH:mm"), false);
    });
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
      addRow.createSpan({ text: this.habit.attendance ? "补打卡（选择时间）" : "补打卡（记录当前时间）" });
      addBtn = addRow;
      const doAdd = async () => {
        if (addRow.classList.contains("busy")) return;
        // 上下班型：补打也要选时刻，不直接落当前时间（带上班/下班提示）
        if (this.habit.attendance) {
          void (async () => {
            let rows: CheckinRow[] = [];
            try { rows = (await readHabitFile(this.app, this.habit)).rows; } catch { /* 读不到按无班次提示 */ }
            new CheckinTimeModal(this.app, this.habit, this.date, rows, async (t, role) => {
              await checkinHabit(this.app, this.habit, this.date, t, role);
              new Notice(`✅ 已补打卡 ${this.date} ${t}`);
              this.onChanged?.();
              render();
            }).open();
          })();
          return;
        }
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
 * 2) 打卡月历卡：整月日历网格，每天格子展示打卡时间点；
 *    上下班习惯显示班次（上班–下班 + 间隔时长，支持跨天班次），点格子 → 当日明细（逐条撤销）
 * 3) 历史记录趋势卡：周/月/年维度切换 + 日期范围翻页 + 蓝色柱状图
 */
export class HabitDetailModal extends Modal {
  private data: HabitData | null = null;
  private heatMonth = moment().format("YYYY-MM");    // 月历当前月份（YYYY-MM）
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
    this.renderCalendar(body);
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

  /* ── 打卡月历卡 ── */

  private renderCalendar(body: HTMLElement) {
    const rows = this.data?.rows ?? [];
    const todayStr = moment().format("YYYY-MM-DD");
    const monthLabel = moment(`${this.heatMonth}-01`, "YYYY-MM-DD").format("YYYY年M月");
    const cells = monthCalendarCells(rows, this.habit, this.heatMonth, todayStr);
    const attendance = !!this.habit.attendance;

    const card = this.makeCard(body, "打卡月历", "db-detail-mcal", (head) => {
      this.renderMonthNav(head, todayStr);
    });

    const main = card.createDiv({ cls: "db-mcal-main" });

    // 星期表头（周一 → 周日）
    const headRow = main.createDiv({ cls: "db-mcal-grid db-mcal-head" });
    WEEKDAY_CN.forEach(w => headRow.createDiv({ cls: "db-mcal-weekday", text: w }));

    const grid = main.createDiv({ cls: "db-mcal-grid" });
    cells.forEach(cell => {
      const cls = ["db-mcal-cell"];
      if (!cell.inMonth) cls.push("out");
      if (cell.future) cls.push("future");
      if (cell.today) cls.push("today");
      if (cell.skipped && cell.count === 0) cls.push("skipped");
      else if (cell.rest && cell.count === 0) cls.push("rest");
      else if (cell.met) cls.push("met");
      else if (cell.count > 0) cls.push("partial");
      const el = makeActivatable(grid.createDiv({ cls: cls.join(" ") }), `${cell.date} 打卡明细`);
      el.style.setProperty("--habit-color", this.habit.color);

      // 日期数字行（今天有跨天班次进行中时加「昨班」角标）
      const dayline = el.createDiv({ cls: "db-mcal-dayline" });
      dayline.createSpan({ cls: "db-mcal-day", text: String(cell.day) });
      if (attendance && cell.today && cell.openFromBefore) {
        dayline.createSpan({ cls: "db-mcal-flag", text: "昨班" });
      }

      // 时间点 / 班次
      const timesEl = el.createDiv({ cls: "db-mcal-times" });
      if (attendance) {
        for (const s of cell.shifts) {
          const line = timesEl.createDiv({ cls: "db-mcal-shift" });
          if (s.open) {
            line.createSpan({ cls: "db-mcal-shift-range", text: `${s.inTime} 上班中` });
          } else {
            line.createSpan({
              cls: "db-mcal-shift-range",
              text: `${s.inTime}–${s.crossDay ? "次日" : ""}${s.outTime}`,
            });
            line.createSpan({ cls: "db-mcal-shift-dur", text: fmtShiftDuration(s.minutes ?? 0) });
          }
        }
        for (const t of cell.times) {
          if (t.skipped) continue;
          const lastNightOut = cell.crossDayOuts.includes(t.time ?? "");
          timesEl.createDiv({ cls: "db-mcal-time", text: lastNightOut ? `${t.time} 下班·昨班` : t.time ?? "打卡" });
        }
      } else {
        const valid = cell.times.filter(t => !t.skipped);
        valid.slice(0, 3).forEach(t => timesEl.createDiv({ cls: "db-mcal-time", text: t.time ?? "打卡" }));
        if (valid.length > 3) timesEl.createDiv({ cls: "db-mcal-time more", text: `+${valid.length - 3}` });
      }

      el.addEventListener("click", () => {
        new HabitDayDetailModal(this.app, this.habit, cell.date, () => {
          void this.reload();
          this.onChanged?.();
        }).open();
      });
    });

    // 本月统计（右栏 / 窄屏换行到底部）
    const inMonth = cells.filter(c => c.inMonth && !c.future);
    const doneDays = inMonth.filter(c => !c.rest && c.met).length;
    const totalCount = inMonth.reduce((n, c) => n + c.count, 0);
    const items: [string, string][] = [["达标", `${doneDays} 天`], ["打卡", `${totalCount} 次`]];
    if (attendance) {
      const minutes = inMonth.reduce((n, c) => n + c.shifts.reduce((m, s) => m + (s.minutes ?? 0), 0), 0);
      items.push(["班次时长", fmtShiftDuration(minutes)]);
    } else {
      items.push(["单日最多", `${inMonth.reduce((n, c) => Math.max(n, c.count), 0)} 次`]);
    }
    const side = main.createDiv({ cls: "db-mcal-side" });
    const metrics = side.createDiv({ cls: "db-heatmap-metrics" });
    items.forEach(([label, value]) => {
      const row = metrics.createDiv({ cls: "db-heatmap-metric" });
      row.createSpan({ cls: "db-heatmap-metric-label", text: label });
      row.createSpan({ cls: "db-heatmap-metric-value", text: value });
    });
    const legend = side.createDiv({ cls: "db-heatmap-legend db-mcal-legend" });
    (["met:达标", "partial:未达标", "skipped:跳过"] as const).forEach(pair => {
      const [cls, label] = pair.split(":");
      legend.createDiv({ cls: `db-mcal-cell ${cls} mini`, attr: { "aria-label": label } });
      legend.createSpan({ text: label });
    });
  }

  /** 月历标题行右侧的翻页：‹ 2026年10月 今 ›，不能翻到未来月份 */
  private renderMonthNav(head: HTMLElement, todayStr: string) {
    const nav = head.createDiv({ cls: "db-heatmap-range" });
    nav.createDiv({
      cls: "db-heatmap-range-label",
      text: moment(`${this.heatMonth}-01`, "YYYY-MM-DD").format("YYYY年M月"),
    });

    const prev = makeActivatable(nav.createDiv({
      cls: "db-heatmap-arrow",
      attr: { "aria-label": "上个月" },
    }), "上个月");
    setIcon(prev, "chevron-left");
    prev.addEventListener("click", () => {
      this.heatMonth = moment(`${this.heatMonth}-01`, "YYYY-MM-DD").subtract(1, "month").format("YYYY-MM");
      this.render();
    });

    const isCurrent = this.heatMonth >= moment(todayStr).format("YYYY-MM");
    const next = makeActivatable(nav.createDiv({
      cls: `db-heatmap-arrow${isCurrent ? " disabled" : ""}`,
      attr: { "aria-label": "下个月" },
    }), "下个月");
    setIcon(next, "chevron-right");
    if (!isCurrent) {
      next.addEventListener("click", () => {
        this.heatMonth = moment(`${this.heatMonth}-01`, "YYYY-MM-DD").add(1, "month").format("YYYY-MM");
        this.render();
      });
      const back = makeActivatable(nav.createDiv({
        cls: "db-heatmap-arrow db-mcal-now",
        attr: { "aria-label": "回到本月" },
      }), "回到本月");
      back.setText("今");
      back.addEventListener("click", () => {
        this.heatMonth = moment().format("YYYY-MM");
        this.render();
      });
    }
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
  /** 计划输入条当前选中的截止日期（日历图设置；优先于输入文本中的日期词） */
  private currentDue: string | null = null;
  // 当前页面上的内嵌实时渲染编辑器（buildUI 重建/onClose 时统一销毁）
  private liveEditors = new Set<LiveEditor>();
  // 内容筛选：每个章节各自保留一份条件（视图会话内有效，不持久化）
  private sectionFilters: Record<string, SectionFilter> = {};
  private filterPanel: FilterPanel | null = null;
  private filterOpen = false;
  /** 筛选抽屉浮层（与闪念统计抽屉同呈现：左侧滑出 + 遮罩） */
  private filterOverlayEl: HTMLElement | null = null;
  /** 追剧「显示字段」抽屉浮层（同款呈现，逐字段开关） */
  private dramaFieldsOverlayEl: HTMLElement | null = null;
  private dramaFieldsSentinelArmed = false;
  private filterBtnEl: HTMLElement | null = null;
  private todayHeadEl: HTMLElement | null = null;
  // 顶栏（memos 式三区）：右区操作按钮 + 常驻「···」菜单，窄屏由 fitTopbar 折叠
  private topbarEl: HTMLElement | null = null;
  private topbarRightEl: HTMLElement | null = null;
  private topbarActions: { icon: string; label: string; run: () => void; el?: HTMLElement }[] = [];
  // 习惯章节：筛选只作用于习惯列表，重渲染入口由 renderHabitsTab 登记
  private habitsRerender: (() => void) | null = null;
  /** 最近一次整页渲染的日期（YYYY-MM-DD）：切回标签页时用于检测跨天 */
  private renderedDate = moment().format("YYYY-MM-DD");
  /* ── 页内新页面：Dashboard 在本视图内部渲染（不走标签页系统），硬件返回键揭开 ── */
  private dashEl: HTMLElement | null = null;
  private dashPage: DashboardPage | null = null;
  private dashHiddenEls: HTMLElement[] = [];
  private dashSentinelArmed = false;
  /* ── 页内新页面：AI 助手（与 Dashboard 同一套返回键哨兵） ── */
  private aiEl: HTMLElement | null = null;
  private aiPage: AiChatPage | null = null;
  private aiHiddenEls: HTMLElement[] = [];
  private aiSentinelArmed = false;
  /** 回到顶部悬浮钮（仅移动端）：锚容器右下角，root 滚到深处上滑时隐现 */
  private scrollTopBtn: ScrollTopButton | null = null;
  /** 软键盘是否弹出：弹出期间回顶钮收起，别浮在打字区上方碍事 */
  private aiKbVisible = false;
  /** AI 页输入框聚焦中：桌面端没有键盘事件，靠焦点感知编辑态收起回顶钮 */
  private aiEditing = false;
  /** AI 写过文件：关闭本页时整页重建，让当前章节读到新内容 */
  private aiDirty = false;
  /** 记账章节：多页浮层实例（视图重建 / 关闭时销毁） */
  private ledgerPage: LedgerPage | null = null;
  /** 追剧章节：列表页 + 页内编辑二级页实例 */
  private dramaPage: DramaPage | null = null;

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
    // 移动端长页「回到顶部」钮：滚过约两屏再上滑才隐现，二级页 / 键盘 / 编辑态收起
    // （滚动容器 = root，buildUI 只 empty 不替换，绑一次即可）
    this.scrollTopBtn = new ScrollTopButton(
      this.containerEl,
      () => this.containerEl.children[1] as HTMLElement ?? null,
      () => !!(
        this.dashEl || this.aiEl || this.aiKbVisible || this.aiEditing ||
        this.ledgerPage?.isEditing() || this.dramaPage?.isEditing()
      ),
    );
    this.scrollTopBtn.mount();
    // Android 返回键哨兵弹出（Dashboard 新页打开期间 armed）：揭开新页而不是退出应用
    this.registerDomEvent(window, "popstate", () => {
      if (this.dashSentinelArmed) {
        this.dashSentinelArmed = false;
        this.closeDashboard(false);
      }
      if (this.aiSentinelArmed) {
        this.aiSentinelArmed = false;
        this.closeAiPage(false);
      }
      // 追剧「显示字段」抽屉：哨兵被弹出（返回键）就收抽屉，浮层由 close 负责移除
      if (this.dramaFieldsSentinelArmed) this.closeDramaFieldsPanel(false);
    });
  }

  async onClose() {
    this.teardownViewportAdapter();
    this.destroyLiveEditors();
    this.todayPanel?.destroy();
    this.todayPanel = null;
    this.ledgerPage?.destroy();
    this.ledgerPage = null;
    this.dramaPage?.destroy();
    this.dramaPage = null;
    this.aiPage?.destroy();
    this.aiPage = null;
    this.scrollTopBtn?.destroy();
    this.scrollTopBtn = null;
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
    this._vpResizeHandler = () => {
      this.applyViewportSize();
    };
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
      this.aiKbVisible = true;
      this.scrollTopBtn?.sync();
      // 原生层先派发事件、后落地 --keyboard-height 与动画，连续补测对齐
      activeWindow.setTimeout(() => this.applyViewportSize(), 80);
      activeWindow.setTimeout(() => this.applyViewportSize(), 300);
    };
    this._kbHideHandler = () => {
      this.applyViewportSize();
      this.aiKbVisible = false;
      this.scrollTopBtn?.sync();
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
    // 回顶钮锚在容器（root 外）上：同值再写一份，右下角才能避开导航栏 / 手势条
    this.containerEl.style.setProperty("--db-bottom-inset", `${bottomInset}px`);
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
    // 整页重建会清空 DOM：先揭开并释放页内新页，避免残留死引用与哨兵历史
    this.closeDashboard();
    this.closeAiPage(true, false);
    const root = this.containerEl.children[1] as HTMLElement;
    this.renderedDate = moment().format("YYYY-MM-DD");
    this.destroyLiveEditors();
    this.todayPanel?.destroy();
    this.todayPanel = null;
    this.ledgerPage?.destroy();
    this.ledgerPage = null;
    this.dramaPage?.destroy();
    this.dramaPage = null;
    root.empty();
    // root.empty() 已移除筛选抽屉浮层，重建前清掉旧引用
    this.filterOverlayEl = null;
    // 显示字段抽屉同样挂在 root 里：连同未消费的哨兵一起清掉，别漏给返回键
    this.dramaFieldsOverlayEl = null;
    this.dramaFieldsSentinelArmed = false;
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

    // 筛选面板改为浮层抽屉（见 openFilterPanel），不再占文档流
    this.filterPanel = null;
    this.habitsRerender = null;

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
    // 计划视图偏好（分组 / 排序 / 已完成与详细的显隐）由 TodayPanel 直接读 settings，
    // 顶栏「···」与排序面板改的是同一份对象，这里不需要再中转
    this.syncHabitStreamVisibility();
    void this.todayPanel.refresh(active.id);

    // 视图重建后恢复已展开的筛选面板
    if (this.filterOpen) this.openFilterPanel();
    // 重建后立即让位底部导航栏（等不到下一次视口 resize）
    this.applyViewportSize();
    // 切章节会销毁旧页面实例（不走它们的渲染回调）：这里兜底重算回顶钮显隐
    this.scrollTopBtn?.sync();
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
      setIcon(drawerBtn, "flame"); // 火焰：呼应抽屉里的记录热力图
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
          },          onDateClick: (date) => {
            const f = this.getFilter(active.id);
            // 再点同一天 = 取消该日期筛选
            const same = f.datePreset === "custom" && f.dateFrom === date && f.dateTo === date;
            if (same) {
              f.datePreset = "";
              f.dateFrom = "";
              f.dateTo = "";
            } else {
              f.datePreset = "custom";
              f.dateFrom = date;
              f.dateTo = date;
            }
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
    // 记账 / 追剧章节自带页内筛选，不显示日记内容筛选入口
    if (active?.type !== "ledger" && active?.type !== "drama") {
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
    } else {
      this.filterBtnEl = null;
    }

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

    /* ── 右区：快捷操作（真实 <button>；宽度不足时由 fitTopbar 折进「···」） ──
       按钮预算：每章最多 2 个（闪念＝搜索 + ···，其余＝仅 ···）。
       统计面板、分组排序都是二级操作，常驻顶栏会在窄屏把标题胶囊挤出去。 */
    const right = bar.createDiv({ cls: "db-topbar-zone db-topbar-actions" });
    this.topbarRightEl = right;
    const isPlans = active?.type === "plans";
    const specs: { icon: string; label: string; run: () => void; el?: HTMLElement }[] =
      active?.type === "memos"
        ? [{ icon: "search", label: "搜索闪念", run: () => this.openMemoSearch(active) }]
        : active?.type === "plans"
          ? [{ icon: "search", label: "搜索计划", run: () => this.openPlansSearch(active) }]
          : active?.type === "habits"
            ? [{ icon: "search", label: "搜索习惯", run: () => this.openHabitSearch(active) }]
            : active?.type === "drama"
              ? [{ icon: "search", label: "搜索追剧", run: () => this.openDramaSearch(active) }]
              : active?.type === "ledger"
                ? [{ icon: "arrow-left-right", label: "切换页面", run: () => this.openLedgerPageMenu() }]
                : [];
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
      // 常驻：本章主操作与统计面板都在这里，折起来就没地方点了
      cls: "db-topbar-btn db-topbar-more",
      attr: {
        type: "button", "aria-label": "更多操作", "aria-haspopup": "menu", title: "更多操作",
      },
    });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", e => {
      e.stopPropagation();
      const menu = new Menu();
      let grouped = false;
      if (isPlans && active) {
        const rs = this.plugin.settings.reviewState;
        // 本章主操作置顶
        menu.addItem(item => {
          item.setTitle("分组与排序").setIcon("arrow-down-up");
          item.onClick(() => this.openPlanSortPanel());
        });
        // 文案即状态即动作：显示「显示已完成」时当前是隐藏态，点一下切换（不再打勾避免歧义）
        const toggleView = (label: string, on: boolean, set: (v: boolean) => void) => {
          menu.addItem(item => {
            item.setTitle(label);
            item.onClick(() => {
              set(!on);
              void this.plugin.saveSettings();
              void this.todayPanel?.refresh(active.id);
            });
          });
        };
        // 「隐藏已完成 / 显示已完成」＝旧筛选面板里的完成度筛选，默认只看未完成
        toggleView(rs.planShowDone ? "隐藏已完成" : "显示已完成", rs.planShowDone,
          v => { rs.planShowDone = v; });
        // 「隐藏详细 / 显示详细」＝任务行里的描述徽标与 #标签
        toggleView(rs.planShowDetail ? "隐藏详细" : "显示详细", rs.planShowDetail,
          v => { rs.planShowDetail = v; });
        grouped = true;
      }
      // 记账已有「切换页面」占着右区，搜索收进「···」（每章最多 2 个按钮）
      if (active?.type === "ledger" && !this.ledgerPage?.isEditing()) {
        menu.addItem(item => {
          item.setTitle("搜索记账").setIcon("search");
          item.onClick(() => this.openLedgerSearch(active));
        });
        grouped = true;
      }
      this.topbarActions.forEach(a => {
        if (!a.el?.hasClass("is-folded")) return;
        menu.addItem(item => item.setTitle(a.label).setIcon(a.icon).onClick(() => a.run()));
        grouped = true;
      });
      // 追剧：列表卡片显示哪些字段（编辑二级页里不开放——改的是列表，看不到也刷不了）
      if (active?.type === "drama" && !this.dramaPage?.isEditing()) {
        menu.addItem(item => {
          item.setTitle("显示字段").setIcon("eye");
          item.onClick(() => this.openDramaFieldsPanel());
        });
        grouped = true;
      }
      if (grouped) menu.addSeparator();
      menu.addItem(item => {
        item.setTitle("AI 助手").setIcon("sparkles");
        item.onClick(() => this.openAiPage());
      });
      menu.addItem(item => {
        item.setTitle("打开统计面板").setIcon("layout-dashboard");
        item.onClick(() => void this.plugin.activateDashboard());
      });
      menu.addItem(item => {
        item.setTitle("插件设置").setIcon("settings");
        item.onClick(() => {
          const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
          if (setting) { setting.open(); setting.openTabById(this.plugin.manifest.id); }
        });
      });
      const rect = moreBtn.getBoundingClientRect();
      menu.showAtPosition({ x: Math.max(8, rect.right - 180), y: rect.bottom + 4 });
    });
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
    bar.style.setProperty("--db-topbar-overlap", on ? `${inset}px` : "");
  }

  /**
   * 右区宽度不足时，将操作按钮从左到右折入常驻的「···」菜单。
   * 与 memos 的「窄屏隐藏按钮」不同：折叠保留功能入口，安卓竖屏也能全部点到。
   * 判定用真实渲染结果（内容宽 scrollWidth 是否越过分区可视宽），不按 44px 估算：
   * 估算一旦和实际按钮宽度对不上，多出的按钮就会压到中区标题上。
   */
  private fitTopbar(): void {
    const right = this.topbarRightEl;
    if (!right) return;
    const visible = () => this.topbarActions.filter(a => a.el && !a.el.hasClass("is-folded"));
    const folded = () => this.topbarActions.filter(a => a.el?.hasClass("is-folded"));
    const overflows = () => right.scrollWidth > right.clientWidth + 1;
    let guard = 8;
    while (guard-- > 0 && overflows()) {
      const next = visible()[0];
      if (!next?.el) break;
      next.el.addClass("is-folded");
    }
    // 腾出空间后逐个试放回来，能放下就少一层菜单
    guard = 8;
    while (guard-- > 0) {
      const list = folded();
      if (!list.length) break;
      const last = list[list.length - 1];
      last.el!.removeClass("is-folded");
      if (overflows()) { last.el!.addClass("is-folded"); break; }
    }
  }

  /* ── 内容筛选 ── */

  /** 顶栏「排序」：弹出分组 / 排序底部面板，点选即时生效并持久化 */
  private openPlanSortPanel(): void {
    const section = this._currentSection;
    if (!section || section.type !== "plans") return;
    const rs = this.plugin.settings.reviewState;
    const apply = () => {
      void this.plugin.saveSettings();
      void this.todayPanel?.refresh(section.id);
    };
    openPlanSortSheet(this.app, {
      getGroupBy: () => rs.planGroupBy,
      getSortBy: () => rs.planSortBy,
      onGroupBy: v => { rs.planGroupBy = v; apply(); },
      onSortBy: v => { rs.planSortBy = v; apply(); },
      onReset: () => {
        rs.planGroupBy = DEFAULT_SETTINGS.reviewState.planGroupBy;
        rs.planSortBy = DEFAULT_SETTINGS.reviewState.planSortBy;
        apply();
      },
    });
  }

  /** 记账顶栏「切换页面」：点选目标页（当前页打勾），不做逐页循环 */
  private openLedgerPageMenu(): void {
    const info = this.ledgerPage?.getPageInfo();
    if (!info) return;
    const menu = new Menu();
    info.pages.forEach(p => {
      menu.addItem(item => {
        item.setTitle(p.title);
        if (p.key === info.current) item.setIcon("check");
        item.onClick(() => {
          /* 先显式收起再切页：setPage 里可能同步 history.go(-n) 回收二级层哨兵，
             个别 WebView 上点击处理函数里的导航会打断菜单自身的收起，列表就挂在屏幕上 */
          menu.close();
          this.ledgerPage?.setPage(p.key);
        });
      });
    });
    // 锚定在按钮下方；键盘 Enter 触发（坐标为 0）或按钮折进「···」时回退到顶栏下方
    const btn = this.topbarActions.find(a => a.label === "切换页面")?.el;
    const rect = btn && btn.isConnected ? btn.getBoundingClientRect() : null;
    if (rect && (rect.left > 0 || rect.top > 0)) {
      menu.showAtPosition({ x: Math.max(8, rect.right - 150), y: rect.bottom + 4 });
    } else if (this.topbarEl) {
      const tr = this.topbarEl.getBoundingClientRect();
      menu.showAtPosition({ x: Math.max(8, tr.right - 160), y: tr.bottom + 4 });
    } else {
      menu.showAtMouseEvent(new MouseEvent("click"));
    }
  }

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
    this.filterOverlayEl?.remove();
    this.filterOverlayEl = null;
    this.updateFilterBadge();
  }

  /** 打开筛选抽屉：与闪念统计（flame）抽屉同呈现——遮罩 + 左侧滑出，面板挂在抽屉体内 */
  private async openFilterPanel(): Promise<void> {
    const section = this._currentSection;
    if (!section) return;
    this.filterOpen = true;

    let tags: { tag: string; count: number }[] = [];
    try {
      const groups = await readAllJournalEntries(this.app, this.plugin.settings, new Set([section.id]));
      tags = collectTags(groups.flatMap(g => g.entries));
    } catch { /* 读不到历史时只给静态维度（心情/优先级等仍可用） */ }
    // 取数期间面板可能已关闭 / 视图已重建
    if (!this.filterOpen) return;
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    if (!root || !root.isConnected) return;
    this.filterOverlayEl?.remove();
    this.filterPanel?.destroy();
    this.filterPanel = null;

    const overlay = root.createDiv({ cls: "db-drawer-overlay" });
    this.filterOverlayEl = overlay;
    overlay.addEventListener("click", () => this.closeFilterPanel());
    const drawer = overlay.createDiv({ cls: "db-drawer" });
    drawer.addEventListener("click", e => e.stopPropagation());
    const head = drawer.createDiv({ cls: "db-drawer-head" });
    // ✕ 放最左（与筛选按钮同侧，点开即点关），标题靠右
    const closeBtn = head.createDiv({
      cls: "db-drawer-close",
      attr: { role: "button", "aria-label": "关闭筛选" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.closeFilterPanel());
    head.createSpan({ cls: "db-drawer-title", text: "筛选" });
    const bodyEl = drawer.createDiv({ cls: "db-drawer-body" });

    this.filterPanel = new FilterPanel({
      host: bodyEl,
      plugin: this.plugin,
      section,
      filter: this.getFilter(section.id),
      tags,
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

  /** 习惯/记账/追剧章节的数据在 habits/*.md、记账/ 目录与 drama/shows.md 里，不展示日记的今日记录流 */
  private syncHabitStreamVisibility(): void {
    const t = this._currentSection?.type;
    const hide = t === "habits" || t === "ledger" || t === "drama";
    this.todayHeadEl?.toggleClass("is-hidden", hide);
    this.todayHostEl?.toggleClass("is-hidden", hide);
  }

  /* ── 页内新页面：Dashboard ──
     闪念本体只隐藏不销毁（滚动位置、草稿、选中态全保留），
     Dashboard 作为文档流里的"下一页"填充视图；安卓返回键通过
     WebView 哨兵历史揭开本页。不用绝对定位覆盖，原生头部层级不受影响。 */
  openDashboard(): void {
    if (this.dashEl) return;
    const root = this.containerEl.children[1] as HTMLElement;
    // 筛选抽屉现为浮层：进 Dashboard 前先收起，避免浮在面板上
    this.closeFilterPanel();
    const candidates = [
      root.querySelector(".db-topbar"),
      root.querySelector(".db-scroll"),
    ];
    this.dashHiddenEls = candidates.filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.style.display !== "none"
    );
    this.dashHiddenEls.forEach(el => {
      el.dataset.dbPrevDisplay = el.style.display;
      el.style.display = "none";
    });
    const host = root.createDiv({ cls: "db-page-dashboard" });
    this.dashEl = host;
    this.dashPage = new DashboardPage(this.app, this.plugin, host, this.containerEl, "db-page-dashboard", () => this.closeDashboard());
    void this.dashPage.open();
    this.scrollTopBtn?.sync();
    // 哨兵历史条目：返回键弹出它 → popstate 揭开新页；没有条目时返回键会直接退出应用
    if (Platform.isMobileApp) {
      this.dashSentinelArmed = true;
      window.history.pushState({ daybookBack: "dashboard-page" }, "");
    }
  }

  closeDashboard(reclaimSentinel = true): void {
    if (!this.dashEl) return;
    const armed = this.dashSentinelArmed;
    this.dashSentinelArmed = false;
    // 非返回键路径关闭（切章节、关视图等）：回收未消费的哨兵，避免吞掉下一次返回
    if (reclaimSentinel && armed) window.history.back();
    this.dashPage?.close();
    this.dashPage = null;
    this.dashEl.remove();
    this.dashEl = null;
    this.dashHiddenEls.forEach(el => {
      el.style.display = el.dataset.dbPrevDisplay || "";
      delete el.dataset.dbPrevDisplay;
    });
    this.dashHiddenEls = [];
    // 顶栏刚从 display:none 恢复，重测折叠布局
    this.fitTopbar();
    this.scrollTopBtn?.sync();
  }

  /* ── 页内新页面：AI 助手 ──
     与 Dashboard 同构：隐藏顶栏与滚动区（只隐藏不销毁），聊天页放进文档流；
     安卓返回键通过哨兵历史揭开本页。期间写过文件的话，关闭时整页重建，
     让当前章节立即读到新数据（习惯列表、今日记录流、记账/追剧都会重新加载）。 */
  openAiPage(): void {
    if (this.aiEl) return;
    const root = this.containerEl.children[1] as HTMLElement;
    this.closeFilterPanel();
    const candidates = [
      root.querySelector(".db-topbar"),
      root.querySelector(".db-scroll"),
    ];
    this.aiHiddenEls = candidates.filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.style.display !== "none"
    );
    this.aiHiddenEls.forEach(el => {
      el.dataset.dbPrevDisplay = el.style.display;
      el.style.display = "none";
    });
    const host = root.createDiv({ cls: "db-page-ai" });
    this.aiEl = host;
    this.aiDirty = false;
    /* 输入框聚焦 = 编辑态：回顶钮收起（点击别处 / 键盘收起失焦后还原）。
       监听挂在 AI 页宿主上，随 aiEl.remove() 一起消失，不用手动清理。 */
    host.addEventListener("focusin", (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) { this.aiEditing = true; this.scrollTopBtn?.sync(); }
    });
    host.addEventListener("focusout", (e: FocusEvent) => {
      const next = e.relatedTarget as HTMLElement | null;
      if (next && (next.tagName === "TEXTAREA" || next.tagName === "INPUT")) return;
      this.aiEditing = false;
      this.scrollTopBtn?.sync();
    });
    this.aiPage = new AiChatPage(
      this.app, this.plugin, host, this.containerEl,
      () => this.closeAiPage(),
      () => { this.aiDirty = true; },
    );
    void this.aiPage.open();
    this.scrollTopBtn?.sync();
    if (Platform.isMobileApp) {
      this.aiSentinelArmed = true;
      window.history.pushState({ daybookBack: "ai-page" }, "");
    }
  }

  closeAiPage(reclaimSentinel = true, refresh = true): void {
    if (!this.aiEl) return;
    const armed = this.aiSentinelArmed;
    this.aiSentinelArmed = false;
    this.aiEditing = false;   // 焦点监听随 aiEl 移除，编辑态标记在这里归零
    // 非返回键路径关闭（菜单返回、切章节、关视图）：回收未消费的哨兵
    if (reclaimSentinel && armed) window.history.back();
    this.aiPage?.destroy();
    this.aiPage = null;
    this.aiEl.remove();
    this.aiEl = null;
    this.aiHiddenEls.forEach(el => {
      el.style.display = el.dataset.dbPrevDisplay || "";
      delete el.dataset.dbPrevDisplay;
    });
    this.aiHiddenEls = [];
    const dirty = this.aiDirty;
    this.aiDirty = false;
    if (refresh && dirty) {
      this.buildUI();
      return;
    }
    this.fitTopbar();
    this.scrollTopBtn?.sync();
  }

  /** 追剧「显示字段」抽屉：逐字段开关，点一下即时写设置并就地重排列表 */
  private openDramaFieldsPanel(): void {
    if (this.dramaFieldsOverlayEl) return;
    const root = this.containerEl.children[1] as HTMLElement | undefined;
    if (!root || !root.isConnected) return;

    const overlay = root.createDiv({ cls: "db-drawer-overlay" });
    this.dramaFieldsOverlayEl = overlay;
    overlay.addEventListener("click", () => this.closeDramaFieldsPanel());
    const drawer = overlay.createDiv({ cls: "db-drawer" });
    drawer.addEventListener("click", e => e.stopPropagation());

    const head = drawer.createDiv({ cls: "db-drawer-head" });
    // ✕ 放最左、标题靠右：与筛选抽屉同一套版式
    const closeBtn = head.createDiv({
      cls: "db-drawer-close",
      attr: { role: "button", tabindex: "0", "aria-label": "关闭显示字段" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.closeDramaFieldsPanel());
    closeBtn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.closeDramaFieldsPanel(); }
    });
    head.createSpan({ cls: "db-drawer-title", text: "显示字段" });

    const body = drawer.createDiv({ cls: "db-drawer-body db-drama-vis-body" });
    body.createDiv({
      cls: "db-drama-vis-note",
      text: "关掉的项只是不在列表卡片上出现，数据仍在，编辑页里始终可以改。",
    });

    DRAMA_FIELDS.forEach(f => {
      const row = body.createDiv({ cls: "db-drama-vis-row", attr: { role: "switch", tabindex: "0" } });
      row.createDiv({ cls: "db-drama-vis-label", text: f.label });
      row.createDiv({ cls: "db-drama-vis-hint", text: f.hint });
      const mark = row.createDiv({ cls: "db-drama-vis-mark" });
      const paint = (on: boolean): void => {
        row.toggleClass("is-on", on);
        row.setAttribute("aria-checked", on ? "true" : "false");
        row.setAttribute("aria-label", `${f.label}，${on ? "已显示" : "已隐藏"}`);
        mark.empty();
        if (on) setIcon(mark, "check");
      };
      const flip = (): void => {
        const on = !dramaFieldOn(this.plugin.settings.dramaFields, f.key);
        const st = this.plugin.settings;
        if (!st.dramaFields) st.dramaFields = {};
        st.dramaFields[f.key] = on;
        void this.plugin.saveSettings();
        paint(on);
        this.dramaPage?.refresh();
      };
      row.addEventListener("click", flip);
      row.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
      });
      paint(dramaFieldOn(this.plugin.settings.dramaFields, f.key));
    });

    // 返回键先收抽屉，再交回 Obsidian（与仪表盘二级页同一套哨兵写法）
    if (Platform.isMobileApp) {
      this.dramaFieldsSentinelArmed = true;
      window.history.pushState({ daybookBack: "drama-fields" }, "");
    }
  }

  private closeDramaFieldsPanel(reclaim = true): void {
    const armed = this.dramaFieldsSentinelArmed;
    this.dramaFieldsSentinelArmed = false;
    if (this.dramaFieldsOverlayEl) {
      this.dramaFieldsOverlayEl.remove();
      this.dramaFieldsOverlayEl = null;
    }
    // 非返回键路径关闭（点遮罩 / ✕）：回收未消费的哨兵
    if (reclaim && armed && Platform.isMobileApp) window.history.back();
  }

  /** 保存后局部刷新今日记录流（不重建输入区，保留草稿与滚动位置） */
  /** 打开闪念搜索弹窗：确认后把关键词与快捷筛选写入章节筛选并刷新记录流 */
  private openMemoSearch(section: SectionConfig) {
    this.openEntrySearch(section);
  }

  /** 计划：与闪念同一套记录流搜索，只是占位文案按章节区分 */
  private openPlansSearch(section: SectionConfig) {
    this.openEntrySearch(section, "搜索计划或任务，空格分隔多个关键词");
  }

  /** 记录流章节（闪念 / 计划）共用：确认后把关键词与快捷筛选写回章节筛选 */
  private openEntrySearch(section: SectionConfig, placeholder?: string) {
    const f = this.getFilter(section.id);
    new MemoSearchModal(this.app, {
      plugin: this.plugin,
      section,
      initialKeyword: f.q,
      initialQuick: f.quick,
      placeholder,
      onApply: (keyword, quick) => {
        f.q = keyword.trim();
        f.quick = quick;
        this.applyFilter();
        if (this.filterOpen) void this.openFilterPanel();
      },
    }).open();
  }

  /** 习惯：搜习惯名与打卡备注，确认后把关键词写回章节筛选（列表按关键词过滤） */
  private openHabitSearch(section: SectionConfig) {
    const f = this.getFilter(section.id);
    const status: StatusFilter = f.status === "archived" ? "archived" : "active";
    new MemoSearchModal(this.app, {
      plugin: this.plugin,
      section,
      initialKeyword: f.q,
      placeholder: "搜索习惯名或打卡备注",
      unit: "个习惯",
      pills: [],
      filterable: false,
      load: async (keyword): Promise<{ hits: SearchHit[] }> => {
        const q = keyword.trim();
        const data = await loadHabits(this.app, this.plugin.settings);
        const hits: SearchHit[] = [];
        data.forEach(d => {
          const h = d.config;
          if ((h.archived ? "archived" : "active") !== status) return;
          const doneRows = d.rows.filter(r => !r.skipped);
          if (q) {
            const notes = doneRows.filter(r => r.note).map(r => `${r.date} ${r.note}`).join("\n");
            if (!keywordMatch(`${h.icon} ${h.name}\n${notes}`, q)) return;
          }
          const byDateDesc = (a: CheckinRow, b: CheckinRow) => b.date.localeCompare(a.date);
          const last = doneRows.slice().sort(byDateDesc)[0];
          const hitNote = q ? doneRows.filter(r => r.note && keywordMatch(r.note, q)).sort(byDateDesc)[0] : null;
          hits.push({
            id: h.id,
            date: last ? last.date.slice(5) : "",
            text: `${h.icon || ""} ${h.name}`.trim(),
            meta: [
              hitNote ? `${hitNote.date.slice(5)} ${hitNote.note}` : "",
              doneRows.length ? `累计 ${doneRows.length} 次` : "还没有打卡",
            ].filter(Boolean).join(" · "),
          });
        });
        return { hits };
      },
      onApply: (keyword) => {
        f.q = keyword.trim();
        f.quick = [];
        this.applyFilter();
        if (this.filterOpen) void this.openFilterPanel();
      },
    }).open();
  }

  /** 记账：搜全部记录的备注 / 分类 / 账户 / 标签 / 金额，点结果直接进记录编辑页 */
  private openLedgerSearch(section: SectionConfig) {
    if (!this.ledgerPage) return;
    if (this.ledgerPage.isEditing()) {
      new Notice("请先保存或返回列表再搜索");
      return;
    }
    const page = this.ledgerPage;
    new MemoSearchModal(this.app, {
      plugin: this.plugin,
      section,
      initialKeyword: "",
      placeholder: "搜索备注、分类、账户、标签或金额",
      unit: "笔记录",
      pills: [],
      filterable: false,
      load: async (keyword) => ({ hits: page.searchRecords(keyword) }),
      onApply: () => {},
      onPick: (hit) => page.openRecordById(hit.id),
    }).open();
  }

  /** 追剧：搜剧名 / 原名 / 类型 / 标签 / 状态，点结果直接进编辑二级页 */
  private openDramaSearch(section: SectionConfig) {
    if (!this.dramaPage) return;
    if (this.dramaPage.isEditing()) {
      new Notice("请先保存或返回列表再搜索");
      return;
    }
    const page = this.dramaPage;
    new MemoSearchModal(this.app, {
      plugin: this.plugin,
      section,
      initialKeyword: "",
      placeholder: "搜索剧名、原名、类型或标签",
      unit: "部剧",
      pills: [],
      filterable: false,
      load: async (keyword) => ({ hits: page.searchShows(keyword) }),
      onApply: () => {},
      onPick: (hit) => page.openShowById(hit.id),
    }).open();
  }

  private refreshToday() {
    void this.todayPanel?.refresh(this.activeSectionId);
  }

  private renderTabContent(container: HTMLElement, section: SectionConfig) {
    if (section.type === "plans") this.renderPlansTab(container, section);
    else if (section.type === "habits") this.renderHabitsTab(container, section);
    else if (section.type === "ledger") void this.renderLedgerTab(container);
    else if (section.type === "drama") void this.renderDramaTab(container);
    else this.renderMemosTab(container, section);
  }

  /** 记账：七页（首页/视图/资产/预算/统计/报表/设置）在页面内渲染，记一笔为贴视口底部的浮层 sheet */
  private async renderLedgerTab(container: HTMLElement) {
    container.empty();
    container.addClass("db-ledger-tab");
    this.ledgerPage?.destroy();
    this.ledgerPage = new LedgerPage(this.app, this.plugin, container);
    // 页名并入顶栏章节标题（「记账 · 首页」），切章节时 buildUI 会复原
    this.ledgerPage.onPageTitle = (t) => {
      if (this._currentSection?.type !== "ledger") return;
      const lbl = this.topbarEl?.querySelector(".db-section-trigger-label");
      if (lbl) lbl.setText(`${this._currentSection.label} · ${t}`);
      // 每次记账页渲染（含编辑二级页进出）都会走这里：顺路同步回顶钮显隐
      this.scrollTopBtn?.sync();
    };
    await this.ledgerPage.mount();
  }

  /** 追剧：卡片列表在页面内渲染，编辑是页内整页二级页（不新开标签、不弹浮层） */
  private async renderDramaTab(container: HTMLElement) {
    container.empty();
    container.addClass("db-drama-tab");
    this.dramaPage?.destroy();
    this.dramaPage = new DramaPage(this.app, this.plugin, container);
    // 追剧每次渲染（含编辑二级页进出）通知回顶钮同步显隐
    this.dramaPage.onRendered = () => this.scrollTopBtn?.sync();
    await this.dramaPage.mount();
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

    // 头部：仅新建习惯入口（章节名已由顶栏标题胶囊展示，不再重复大标题）
    const head = container.createDiv({ cls: "db-habits-head" });

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
        // 上下班型：当前班次状态（进行中 / 未打上班卡 / 已下班），跨天班次特别标注
        const openShift = habit.attendance ? lastOpenShift(rows, habit.id) : null;
        const attendanceStatus = openShift
          ? (openShift.inDate === todayStr
            ? `上班中 ${openShift.inTime} · 今日 ${count}/${target}`
            : `${openShift.inDate.slice(5)} ${openShift.inTime} 班次进行中`)
          : done
            ? `已下班 · 今日 ${count}/${target}`
            : `未打上班卡 · 今日 ${count}/${target}`;

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
            : habit.attendance
              ? attendanceStatus
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
              refreshAll();
            } else if (habit.attendance) {
              // 上下班型：先选班次角色与时刻（默认按顺序推断 / 常用时间一键），再落记录
              new CheckinTimeModal(this.app, habit, todayStr, rows, async (t, role) => {
                if (count + 1 >= target) this.plugin.feedback.notify();
                const time = await checkinHabit(this.app, habit, nowToday(), t, role);
                const n = count + 1;
                new Notice(n >= target
                  ? `✅ ${habit.name} ${time} · 今日已达标（${n}/${target}）`
                  : `✅ ${habit.name} ${time}（${n}/${target}）`);
                refreshAll();
              }).open();
            } else {
              // 手势内先给反馈：多次打卡只在补满当日目标（含超出）时响
              if (count + 1 >= target) this.plugin.feedback.notify();
              const t = await checkinHabit(this.app, habit, todayStr);
              const n = count + 1;
              new Notice(n >= target
                ? `✅ ${habit.name} ${t} · 今日已达标（${n}/${target}）`
                : `✅ ${habit.name} ${t}（${n}/${target}）`);
              refreshAll();
            }
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
  private setupMediaSupport(editor: LiveEditor, wrap: HTMLElement, section?: SectionConfig, toolbarSlot?: HTMLElement, onRecState?: (on: boolean) => void) {
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
      else void this.startRecording(editor, micBtn, onRecState);
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

  /** 开始录音（点按式：点击开始/再次点击停止，音频插入编辑器；onState 供调用方同步录音计时等 UI） */
  private async startRecording(editor: LiveEditor | null, btn: HTMLElement, onState?: (on: boolean) => void) {
    const ok = await this.startRecorder((blob, ext) => {
      btn.removeClass("recording");
      const prev = btn.dataset.dbRecLabel ?? "录音";
      btn.setAttribute("aria-label", prev);
      btn.setAttribute("title", prev);
      onState?.(false);
      void this.saveAudioBlob(blob, ext, editor && editor.el.isConnected ? editor : null);
    });
    if (ok) {
      btn.dataset.dbRecLabel = btn.getAttribute("aria-label") ?? btn.getAttribute("title") ?? "录音";
      btn.setAttribute("aria-label", "停止录音");
      btn.setAttribute("title", "录音中，再次点击停止");
      btn.addClass("recording");
      onState?.(true);
      new Notice("\u{1F3A4} 开始录音，再次点击停止");
    }
  }

  /** 停止录音 */
  private stopRecording(_editor: LiveEditor | null, _btn: HTMLElement | null) {
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

    // 心情选择条（移动端 sheet 默认随章节设置展开/收起；桌面 inline 默认收起，点工具条 🙂 展开）
    if (moods.length) {
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

      // 2) 图片 + 录音（点按式麦克风就放在编辑器功能栏里，旁边显示录音时长）
      const toolbarSlot = toolsLeft.createDiv({ cls: "db-memo-toolbar-slot" });
      const recTime = toolsLeft.createSpan({ cls: "db-editor-rec-time", text: "0:00" });
      recTime.style.display = "none";
      let recTimer = 0;
      let recSecs = 0;
      const stopRecTimer = () => {
        if (recTimer) { activeWindow.clearInterval(recTimer); recTimer = 0; }
        recTime.style.display = "none";
      };
      this.setupMediaSupport(editor, wrap, section, toolbarSlot, on => {
        if (!on) { stopRecTimer(); return; }
        recSecs = 0;
        recTime.textContent = "0:00";
        recTime.style.display = "";
        recTimer = activeWindow.setInterval(() => {
          recSecs++;
          recTime.textContent = `${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, "0")}`;
        }, 1000);
      });

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

      // 6) 心情（配置了心情才显示）：展开/收起上方心情网格，选中后表情显示在按钮上
      if (moods.length) {
        const moodTool = makeActivatable(toolsLeft.createDiv({
          cls: `db-editor-tool db-mood-toggle${moodOpen ? " is-active" : ""}`,
          text: this.selectedMood ?? "🙂",
          attr: { role: "button", "aria-label": "展开/收起心情选择", title: "心情选择" },
        }), "心情选择");
        moodTool.addEventListener("click", () => {
          const now = !(this.moodOpenMap[section.id] ?? section.showMoodPicker !== false);
          this.moodOpenMap[section.id] = now;
          panel.querySelectorAll(".db-mood-grid").forEach(g => g.toggleClass("is-collapsed", !now));
          moodTool.toggleClass("is-active", now);
        });
        moodToggleRef.el = moodTool;
      }

      // 右侧发送按钮（录音入口在功能栏左组的麦克风，这里只保留纸飞机）
      const actionBtn = toolbar.createEl("button", {
        cls: "db-editor-send",
        attr: { type: "button", "aria-label": `保存${section.label}` },
      });
      setIcon(actionBtn, "send");
      const syncAction = () => {
        actionBtn.toggleClass("is-active", !!editor.getValue().trim() || !!this.selectedMood);
      };
      updateSend = syncAction;
      syncAction();

      const submit = async () => {
        const text = editor.getValue().trim();
        if (!text && !this.selectedMood) { new Notice("请先输入内容～"); return; }
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
      actionBtn.addEventListener("click", () => { void submit(); });
      editor.el.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
      });
    } else {
      // 移动端 sheet：flomo 式紧凑布局——文本区 + 单行工具条（# 图片 录音 B 列表 心情 ⋯ ｜ 发送）
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

      // 2) 图片 + 录音（都留在功能栏左组，紧跟 # 之后；右组只留发送）
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

      // 发送（保存）按钮：绿色圆形纸飞机（录音已归入左组功能栏）
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
    // 截止日期提示：优先显示日历图选中的日期，其次识别输入文本中的日期词
    let refreshDateHint: (value?: string) => void = () => {};

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
        refreshDateHint(value);
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
    // 截止日期提示：日历图选中的日期优先，其次识别输入文本中的日期词
    refreshDateHint = (value?: string) => {
      const recognized = extractDateFromText(value ?? editor.getValue()).date;
      const due = this.currentDue ?? recognized;
      if (due) {
        dateHint.setText(`\u{1F4C5} \u622A\u6B62\uFF1A${formatDueDate(due)}（${due}）`);
        dateHint.addClass("visible");
      } else {
        dateHint.setText("");
        dateHint.removeClass("visible");
      }
    };
    refreshDateHint(editor.getValue());
    // 标签识别预览
    const tagPreview = wrap.createDiv({ cls: "db-tag-preview db-tag-preview-plans" });
    hintRefs.tags = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

    // ── 单行工具条（与闪念输入卡同款）：左 = # 标签 / 图片 / 优先级，右 = 圆形纸飞机发送 ──
    const composerBar = wrap.createDiv({ cls: "db-composer-bar" });
    const barLeft = composerBar.createDiv({ cls: "db-composer-bar-left" });
    const barRight = composerBar.createDiv({ cls: "db-composer-bar-right" });

    // # 标签
    const hashBtn = makeActivatable(barLeft.createDiv({
      cls: "db-memo-tb-btn db-memo-tb-icon",
      attr: { role: "button", "aria-label": "插入标签", title: "插入标签" },
    }), "插入标签");
    setIcon(hashBtn, "hash");
    hashBtn.addEventListener("click", () => {
      editor.insertAtCursor("#");
      editor.focus();
    });

    // 图片（计划页不放录音按钮）
    const mediaSlot = barLeft.createDiv({ cls: "db-composer-media-slot" });
    this.setupMediaSupport(editor, wrap, section, mediaSlot);
    mediaSlot.querySelector(".db-memo-tb-audio")?.remove();

    // 截止日期：日历图按钮 → 月历选择弹窗（移动端 / PC 同款）
    const dueBtn = makeActivatable(barLeft.createDiv({
      cls: `db-memo-tb-btn db-memo-tb-icon db-plans-due-btn${this.currentDue ? " has-due" : ""}`,
      attr: { role: "button", "aria-label": "设置截止日期", title: "截止日期" },
    }), "设置截止日期");
    const renderDueBtn = () => {
      dueBtn.empty();
      setIcon(dueBtn, "calendar");
      if (this.currentDue) {
        dueBtn.createSpan({ cls: "db-plans-due-flag", text: formatDueDate(this.currentDue) });
      }
      dueBtn.setAttribute(
        "aria-label",
        this.currentDue ? `截止日期：${formatDueDate(this.currentDue)}（${this.currentDue}）` : "设置截止日期"
      );
    };
    renderDueBtn();
    dueBtn.addEventListener("click", () => {
      openDateSelect(this.app, {
        value: this.currentDue ?? undefined,
        onPick: (d) => {
          this.currentDue = d;
          renderDueBtn();
          refreshDateHint();
        },
      });
    });

    // 优先级：紧凑触发按钮（色块徽标 + 罗马数字）+ 四级弹出层
    const priorityBtn = makeActivatable(barLeft.createDiv({
      cls: `db-priority-btn db-priority-btn-compact ${this.currentPriority ? `priority-${this.currentPriority}` : ""}`,
      attr: { "aria-label": "设置优先级", title: "优先级" },
    }));
    const renderPriorityBtn = () => {
      priorityBtn.empty();
      (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => priorityBtn.removeClass(`priority-${lv}`));
      if (this.currentPriority) priorityBtn.addClass(`priority-${this.currentPriority}`);
      createPriorityBadge(priorityBtn, this.currentPriority);
      priorityBtn.createSpan({ cls: "db-priority-label", text: PRIORITY_META[effectivePriority(this.currentPriority)].numeral });
      priorityBtn.setAttribute("aria-label", `优先级：${PRIORITY_META[effectivePriority(this.currentPriority)].label}`);
    };
    renderPriorityBtn();

    const priorityPopover = wrap.createDiv({ cls: "db-priority-popover" });
    priorityPopover.style.display = "none";

    const doc = activeDocument;
    let popoverOpen = false;
    const closePopover = () => {
      popoverOpen = false;
      priorityPopover.style.display = "none";
      priorityBtn.removeClass("open");
      doc.removeEventListener("click", docClickHandler);
    };
    const docClickHandler = () => {
      if (popoverOpen) closePopover();
    };

    const syncPopoverActive = () => {
      priorityPopover.querySelectorAll(".db-priority-option").forEach(o => o.removeClass("active"));
    };
    (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => {
      const opt = priorityPopover.createDiv({ cls: `db-priority-option level-${lv}` });
      createPriorityBadge(opt, lv);
      opt.createSpan({ text: `${lv} ${PRIORITY_META[lv].label}` });
      if (effectivePriority(this.currentPriority) === lv) opt.addClass("active");
      opt.addEventListener("click", () => {
        closePopover();
        this.currentPriority = lv;
        syncPopoverActive();
        opt.addClass("active");
        renderPriorityBtn();
        editor.focus();
      });
    });

    const clearOpt = priorityPopover.createDiv({ cls: "db-priority-option clear" });
    clearOpt.createSpan({ text: "\u{274C}" });
    clearOpt.createSpan({ text: "\u6062\u590D\u9ED8\u8BA4\uFF082 \u91CD\u8981\u4E0D\u7D27\u6025\uFF09" });
    if (!this.currentPriority) clearOpt.addClass("active");
    clearOpt.addEventListener("click", () => {
      closePopover();
      this.currentPriority = null;
      syncPopoverActive();
      clearOpt.addClass("active");
      renderPriorityBtn();
      editor.focus();
    });

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

    // 发送按钮：绿色圆形纸飞机（与闪念发送一致），替代旧的整幅大按钮
    const sendBtn = makeActivatable(barRight.createEl("button", {
      cls: "db-composer-send",
      attr: { type: "button", "aria-label": `添加${section.label}` },
    }), `添加${section.label}`);
    setIcon(sendBtn, "send");

    const addItem = async () => {
      const rawText = editor.getValue().trim();
      if (!rawText) { new Notice("\u8BF7\u5148\u8F93\u5165\u5185\u5BB9\uFF5E"); return; }
      const { date, text } = extractDateFromText(rawText);
      // 新格式：顶格任务行，属性全部 Dataview 行内字段（不再写 "- HH:mm" 时间标题包装）
      let taskLine = `- [ ] ${text || rawText}`;
      const eff = effectivePriority(this.currentPriority);
      if (eff !== "2") taskLine += ` [优先级: ${eff}]`;
      // 截止日期：日历图选中的优先，其次输入文本中识别到的日期词
      const due = this.currentDue ?? date;
      if (due) taskLine += ` [截止: ${due}]`;
      taskLine += ` [创建于: ${moment().format("YYYY-MM-DD HH:mm")}]`;
      sendBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, taskLine, section);
        new Notice("\u2726 \u5DF2\u6DFB\u52A0\u5F85\u529E");
        editor.setValue("");
        dateHint.setText("");
        dateHint.removeClass("visible");
        this.currentPriority = null;
        renderPriorityBtn();
        this.currentDue = null;
        renderDueBtn();
        refreshDateHint("");
        void this.refreshToday();
        editor.focus();
      } catch { new Notice("\u6DFB\u52A0\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { sendBtn.removeClass("loading"); }
    };

    sendBtn.addEventListener("click", () => { void addItem(); });
    // Enter 添加 / Shift+Enter 换行 / Ctrl+Enter 添加，均由编辑器 onEnter 统一处理

    // textarea 降级模式：保留旧的双链/标签自动补全
    if (!editor.isLive && editor.nativeInput) {
      attachMemoEditor(this.app, this.plugin, editor.nativeInput, wrap, { toolbar: false });
    }
  }
}
