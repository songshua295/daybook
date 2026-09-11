import {
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  moment,
  TFile,
  normalizePath,
  type App,
} from "obsidian";
import type LifeJournalPlugin from "./main";
import { isTypeEnabled } from "./settings";
import {
  readAllJournalEntries,
  setTodoStatesInFile,
  buildTodoCascade,
  moveTodoSubtree,
  appendTodoCompletionInfo,
  createPriorityBadge,
  getCompletedFieldName,
  formatDateLabel,
  effectivePriority,
  shouldShowPriorityBadge,
  PRIORITY_META,
  PRIORITY_EMOJI,
  type PriorityLevel,
  type DayGroup,
  type JournalEntry,
  type EntryType,
  type TodoItem,
} from "./fileReader";
import {
  readLineRange,
  insertLineAfter,
  replaceLineRange,
  removeLineRange,
} from "./fileManager";

/** 筛选标签类型（"all" 表示全部，否则为章节 id） */
type FilterTag = "all" | EntryType;

/** 宽松解析日期：兼容 2026-9-10 等无前导零格式，返回 YYYY-MM-DD 或 null */
function parseFlexibleDate(s: string): string | null {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const norm = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = moment(norm, "YYYY-MM-DD", true);
  return d.isValid() ? d.format("YYYY-MM-DD") : null;
}

/** 删除等危险操作确认弹窗 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmText: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const btns = this.contentEl.createDiv({ cls: "lj-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { text: this.confirmText, cls: "mod-warning" });
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 计划块编辑弹窗：逐条编辑任务文字/完成/优先级/截止日期，支持增删任务 */
class PlanEditModal extends Modal {
  private plugin: LifeJournalPlugin;
  private entry: JournalEntry;
  private onSave: (title: string, rows: PlanTodoRow[]) => void;
  private rows: PlanTodoRow[] = [];

  constructor(
    app: App,
    plugin: LifeJournalPlugin,
    entry: JournalEntry,
    onSave: (title: string, rows: PlanTodoRow[]) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.entry = entry;
    this.onSave = onSave;
    this.rows = (entry.todos ?? []).map(t => ({
      text: t.text,
      done: t.done,
      priority: t.priority,
      dueDate: t.dueDate,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      indent: t.indent,
    }));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lj-plan-edit-modal");
    contentEl.createEl("h3", { text: "编辑计划" });

    // 标题行：时间 + 标题输入
    const headerRow = contentEl.createDiv({ cls: "lj-plan-edit-header" });
    headerRow.createSpan({ cls: "lj-plan-edit-time", text: this.entry.time ?? "🕐" });
    const titleInput = headerRow.createEl("input", {
      cls: "lj-plan-edit-title",
      attr: { type: "text", placeholder: "计划标题", "aria-label": "计划标题" },
    });
    // entry.text 含时间前缀（"HH:mm 标题"），剥离后才是纯标题
    titleInput.value = this.entry.time ? this.entry.text.replace(/^\d{2}:\d{2}(?::\d{2})?\s*/, "") : "";

    // 任务行列表容器
    const listEl = contentEl.createDiv({ cls: "lj-plan-edit-list" });

    const renderRow = (row: PlanTodoRow) => {
      const itemEl = listEl.createDiv({ cls: "lj-plan-edit-row" });

      const cb = itemEl.createEl("input", {
        cls: "lj-plan-edit-done",
        attr: { type: "checkbox", "aria-label": "已完成" },
      });
      cb.checked = row.done;
      cb.addEventListener("change", () => {
        row.done = cb.checked;
        // 新勾选完成 → 记录完成时间；取消 → 清除
        row.completedAt = row.done ? moment().format("YYYY-MM-DD HH:mm") : undefined;
      });

      const textInput = itemEl.createEl("input", {
        cls: "lj-plan-edit-text",
        attr: { type: "text", placeholder: "任务内容", "aria-label": "任务内容" },
      });
      textInput.value = row.text;
      textInput.addEventListener("input", () => { row.text = textInput.value; });

      const prioritySelect = itemEl.createEl("select", {
        cls: "lj-plan-edit-priority",
        attr: { "aria-label": "优先级" },
      });
      // undefined = 2 级默认；写文件时 2 级不写标记
      (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => {
        const meta = PRIORITY_META[lv];
        const opt = prioritySelect.createEl("option", { value: lv, text: `${meta.numeral} ${meta.label}` });
        if (effectivePriority(row.priority) === lv) opt.setAttribute("selected", "selected");
      });
      prioritySelect.addEventListener("change", () => {
        const v = prioritySelect.value as PriorityLevel;
        row.priority = v === "2" ? undefined : v;
      });

      // 子任务缩进切换
      const indentBtn = itemEl.createDiv({
        cls: `lj-plan-edit-indent ${row.indent ? "active" : ""}`,
        text: "↳",
        attr: { role: "button", "aria-label": "切换为子任务/顶级任务" },
      });
      indentBtn.addEventListener("click", () => {
        row.indent = row.indent ? undefined : 1;
        indentBtn.toggleClass("active", !!row.indent);
        itemEl.toggleClass("sub", !!row.indent);
      });
      if (row.indent) itemEl.addClass("sub");

      const dueInput = itemEl.createEl("input", {
        cls: "lj-plan-edit-due",
        attr: { type: "text", placeholder: "YYYY-MM-DD", "aria-label": "截止日期" },
      });
      dueInput.value = row.dueDate ?? "";
      dueInput.addEventListener("input", () => {
        const v = dueInput.value.trim();
        row.dueDate = v && moment(v, "YYYY-MM-DD", true).isValid() ? v : undefined;
      });

      const del = itemEl.createDiv({
        cls: "lj-plan-edit-del",
        text: "×",
        attr: { role: "button", "aria-label": "删除任务" },
      });
      del.addEventListener("click", () => {
        this.rows = this.rows.filter(r => r !== row);
        itemEl.remove();
      });
    };

    this.rows.forEach(renderRow);

    const addBtn = contentEl.createEl("button", {
      cls: "lj-plan-edit-add",
      text: "+ 添加任务",
      attr: { "aria-label": "添加任务" },
    });
    addBtn.addEventListener("click", () => {
      const row: PlanTodoRow = { text: "", done: false, priority: undefined, dueDate: undefined };
      this.rows.push(row);
      renderRow(row);
      listEl.lastElementChild?.querySelector("input")?.focus();
    });

    const btnRow = contentEl.createDiv({ cls: "lj-mood-modal-btns" });
    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      this.onSave(this.entry.time ? titleInput.value.trim() : "", this.rows);
      this.close();
    });

    setTimeout(() => titleInput.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 计划编辑弹窗中的一行任务 */
interface PlanTodoRow {
  text: string;
  done: boolean;
  priority?: PriorityLevel;
  dueDate?: string;
  createdAt?: string;
  completedAt?: string;
  indent?: number;
}

/** 计划块标题行（entry.text 含时间前缀时剥离，避免重复） */
function planHeaderLine(entry: JournalEntry): string {
  if (entry.time) {
    const title = entry.text.replace(/^\d{2}:\d{2}(?::\d{2})?\s*/, "");
    return `- ${entry.time}${title ? ` ${title}` : ""}`;
  }
  return `- ${entry.text || entry.sectionLabel}`;
}

/** 计划任务行（与记录页保存格式一致：顶级缩进4空格，子任务缩进8空格） */
function planTaskLine(t: TodoItem, completedField: string): string {
  const indent = t.indent ? "        " : "    ";
  let line = `${indent}- [${t.done ? "x" : " "}] ${t.text}`;
  const eff = effectivePriority(t.priority);
  if (eff !== "2") line += ` ${PRIORITY_EMOJI[eff]}`;
  if (t.dueDate) line += ` \u{1F4C5} ${t.dueDate}`;
  if (t.createdAt) line += ` [createdAt::${t.createdAt}]`;
  if (t.done && t.completedAt) line += ` [${completedField}::${t.completedAt}]`;
  return line;
}

export class ReviewView {
  private plugin: LifeJournalPlugin;
  private container: HTMLElement;
  private activeFilter: FilterTag = "all";
  private activeInlineTag: string | null = null;
  private isLoading = false;

  // plansMode=true：计划模式（整页只展示待办计划）；false：阅读模式
  private plansMode: boolean;

  // 分组 / 排序 / 筛选 / 搜索状态（持久化保存在 settings.reviewState）
  private searchVisible: boolean;
  private searchQuery: string;
  private focusSearchOnRender = false;
  private scrollArea: HTMLElement | null = null;

  private availableTags: string[] = [];
  private tagChipsEl: HTMLElement | null = null;
  private filterDateFrom: string;
  private filterDateTo: string;
  private filterPriorities: Set<string>;

  // 计划视图：分组与排序
  private groupVisible: boolean;
  private sortVisible: boolean;
  private planGroupBy: "none" | "priority" | "date";
  private planDateGranularity: "day" | "week" | "month";
  private planSortBy: "time" | "title" | "tag" | "priority";
  private planSortAsc: boolean;
  private collapsedGroups = new Set<string>(); // 收缩状态仅会话内保留
  private groupOrder: string[];
  private lastGroupKeys: string[] = [];

  constructor(container: HTMLElement, plugin: LifeJournalPlugin, plansMode = false) {
    this.container = container;
    this.plugin = plugin;
    this.plansMode = plansMode;
    const rs = plugin.settings.reviewState;
    this.groupVisible = rs.groupVisible;
    this.sortVisible = rs.sortVisible;
    this.planGroupBy = rs.planGroupBy;
    this.planDateGranularity = rs.planDateGranularity;
    this.planSortBy = rs.planSortBy;
    this.planSortAsc = rs.planSortAsc;
    this.activeInlineTag = rs.activeInlineTag;
    this.filterDateFrom = rs.filterDateFrom;
    this.filterDateTo = rs.filterDateTo;
    this.filterPriorities = new Set(rs.filterPriorities);
    this.groupOrder = rs.groupOrder ?? [];
    this.searchVisible = rs.searchVisible;
    this.searchQuery = rs.searchQuery;
  }

  private persistTimer: number | null = null;

  /** 将当前分组/排序/筛选/搜索状态写入设置持久化（防抖 500ms，避免搜索逐字写盘） */
  private persistState() {
    const rs = this.plugin.settings.reviewState;
    rs.groupVisible = this.groupVisible;
    rs.sortVisible = this.sortVisible;
    rs.planGroupBy = this.planGroupBy;
    rs.planDateGranularity = this.planDateGranularity;
    rs.planSortBy = this.planSortBy;
    rs.planSortAsc = this.planSortAsc;
    rs.activeInlineTag = this.activeInlineTag;
    rs.filterDateFrom = this.filterDateFrom;
    rs.filterDateTo = this.filterDateTo;
    rs.filterPriorities = [...this.filterPriorities];
    rs.groupOrder = [...this.groupOrder];
    rs.searchVisible = this.searchVisible;
    rs.searchQuery = this.searchQuery;
    if (this.persistTimer !== null) activeWindow.clearTimeout(this.persistTimer);
    this.persistTimer = activeWindow.setTimeout(() => {
      this.persistTimer = null;
      void this.plugin.saveSettings();
    }, 500);
  }

  /** 渲染整个回顾视图 */
  async render() {
    this.container.empty();
    this.container.addClass("lj-review-root");

    // 打开今日原文按钮（计划模式不显示）+ 分组/排序/搜索按钮
    this.renderTopActionBar();

    // 分组面板（展开时，仅计划）
    this.renderGroupPanel();

    // 排序面板（展开时）
    this.renderSortPanel();

    // 搜索面板（展开时：搜索框 + 标签筛选 + 日期/优先级筛选）
    this.renderSearchPanel();

    // 类型筛选栏
    this.renderFilterBar();

    // 行内标签筛选状态
    this.renderActiveInlineTagBar();

    // 内容区（滚动）
    this.scrollArea = this.container.createDiv({ cls: "lj-review-scroll" });
    await this.refreshResults();
  }

  /** 加载并渲染结果列表（筛选 + 搜索过滤后） */
  private async refreshResults() {
    const scrollArea = this.scrollArea;
    if (!scrollArea) return;

    scrollArea.empty();
    this.renderLoadingState(scrollArea);

    try {
      const groups = await readAllJournalEntries(
        this.plugin.app,
        this.plugin.settings,
        // 计划模式固定展示全部计划章节，不套用章节筛选
        this.plansMode || this.activeFilter === "all" ? undefined : this.activeFilter
      );

      // 收集该类别下所有标签（供标签面板展示）
      const tagCount = new Map<string, number>();
      groups.forEach(g => g.entries.forEach(e => e.tags?.forEach(t => {
        tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      })));
      this.availableTags = [...tagCount.keys()].sort((a, b) => (tagCount.get(b) ?? 0) - (tagCount.get(a) ?? 0));
      this.updateTagPanel();

      let visibleGroups = this.activeInlineTag
        ? this.filterGroupsByInlineTag(groups, this.activeInlineTag)
        : groups;

      // 日期范围筛选（按日记日期）
      if (this.filterDateFrom || this.filterDateTo) {
        visibleGroups = visibleGroups.filter(g =>
          (!this.filterDateFrom || g.date >= this.filterDateFrom) &&
          (!this.filterDateTo || g.date <= this.filterDateTo)
        );
      }

      // 计划模式：优先级筛选（块内任一任务命中即保留；无标记视为 2 级）
      if (this.plansMode && this.filterPriorities.size > 0) {
        visibleGroups = visibleGroups
          .map(g => ({
            ...g,
            entries: g.entries.filter(e => e.todos?.some(t => this.filterPriorities.has(effectivePriority(t.priority)))),
          }))
          .filter(g => g.entries.length > 0);
      }

      // 多关键字模糊搜索（空格分隔，全部命中才算匹配）
      const query = this.searchQuery.trim();
      if (query) {
        const keywords = query.split(/[\s\u3000]+/).filter(Boolean).map(k => k.toLowerCase());
        visibleGroups = visibleGroups
          .map(group => ({
            ...group,
            entries: group.entries.filter(entry => this.matchEntry(entry, keywords)),
          }))
          .filter(group => group.entries.length > 0);
      }

      // 计划模式：排序与分组；阅读模式：日期组内按排序设置排列
      if (this.plansMode) {
        visibleGroups = this.applyPlanSort(visibleGroups);
      } else {
        visibleGroups = visibleGroups.map(g => ({ ...g, entries: this.sortEntries(g.entries) }));
      }

      scrollArea.empty();
      if (visibleGroups.length === 0) {
        this.renderEmpty(scrollArea);
      } else {
        this.renderGroups(scrollArea, visibleGroups);
      }
    } catch (e) {
      // 透出真实错误信息便于定位问题
      console.error("Life Journal: 读取日记失败", e);
      scrollArea.empty();
      const tip = scrollArea.createDiv({ cls: "lj-review-empty", text: "读取日记失败，请检查日记目录设置" });
      tip.createDiv({ cls: "lj-review-panel-empty", text: String((e as Error)?.message ?? e) });
    }
  }

  /** 计划条目的最优（最高）优先级名次：1=0 … 4=3；无任务的空计划块也归入 3，避免越界 */
  private entryPriorityRank(entry: JournalEntry): number {
    let best = 3;
    entry.todos?.forEach(t => {
      const r = parseInt(effectivePriority(t.priority)) - 1;
      if (r < best) best = r;
    });
    return Math.min(Math.max(best, 0), 3);
  }

  /** 计划条目的最早截止日期（无截止的条目返回 null） */
  private entryEarliestDue(entry: JournalEntry): string | null {
    let best: string | null = null;
    entry.todos?.forEach(t => {
      if (t.dueDate && (best === null || t.dueDate < best)) best = t.dueDate;
    });
    return best;
  }

  /** 实际生效的排序方式：阅读模式无优先级概念，"priority" 回退为 "time" */
  private get activeSortBy(): "time" | "title" | "tag" | "priority" {
    return !this.plansMode && this.planSortBy === "priority" ? "time" : this.planSortBy;
  }

  /** 计划条目排序比较器（基础升序方向） */
  private planEntryComparator(a: JournalEntry, b: JournalEntry): number {
    const sortBy = this.activeSortBy;
    if (sortBy === "time") {
      return a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "");
    }
    if (sortBy === "title") {
      return a.text.localeCompare(b.text, "zh") || a.date.localeCompare(b.date);
    }
    if (sortBy === "tag") {
      const ta = a.tags?.[0];
      const tb = b.tags?.[0];
      if (ta && tb) return ta.localeCompare(tb, "zh") || a.date.localeCompare(b.date);
      if (ta) return -1; // 无标签的条目排在最后
      if (tb) return 1;
      return a.date.localeCompare(b.date);
    }
    // 按优先级：1→4；同优先级时优先有截止日期的，再按日期
    const pr = this.entryPriorityRank(a) - this.entryPriorityRank(b);
    if (pr !== 0) return pr;
    const da = this.entryEarliestDue(a);
    const db = this.entryEarliestDue(b);
    if (!!da !== !!db) return da ? -1 : 1;
    if (da && db) return da.localeCompare(db);
    return a.date.localeCompare(b.date);
  }

  /** 按当前排序设置排列条目
   * 方向通过比较器乘系数实现并附带原始位置稳定 tiebreak：
   * 排序键相同的条目保持原有的时间倒序（最新在前），不会因整体 reverse 而翻转 */
  private sortEntries(entries: JournalEntry[]): JournalEntry[] {
    const dir = this.planSortAsc ? 1 : -1;
    const arr = entries.map((e, i) => ({ e, i }));
    arr.sort((a, b) => this.planEntryComparator(a.e, b.e) * dir || a.i - b.i);
    return arr.map(x => x.e);
  }

  /** 计划视图排序 + 分组（分组方式/粒度由面板控制） */
  private applyPlanSort(groups: DayGroup[]): DayGroup[] {

    // 不分组：保持日期分组，仅组内排序
    if (this.planGroupBy === "none") {
      return groups.map(g => ({ ...g, entries: this.sortEntries(g.entries) }));
    }

    // 展平 → 排序 → 重新分组
    const sorted = this.sortEntries(groups.flatMap(g => g.entries));

    if (this.planGroupBy === "priority") {
      const levels = ["1", "2", "3", "4"] as const;
      const buckets: Record<string, JournalEntry[]> = { "1": [], "2": [], "3": [], "4": [] };
      sorted.forEach(e => buckets[levels[this.entryPriorityRank(e)]].push(e));
      // 分组固定 1→2→3→4（重要的在前），方向开关只影响组内条目排序
      const keys = levels;
      return keys
        .filter(k => buckets[k].length > 0)
        .map(k => ({
          date: k,
          dateLabel: `${PRIORITY_META[k].numeral} ${PRIORITY_META[k].label}`,
          entries: buckets[k],
        }));
    }

    // 按日期分组（日/周/月）
    const fmtKey = (date: string): string => {
      const m = moment(date);
      if (this.planDateGranularity === "month") return m.format("YYYY-MM");
      if (this.planDateGranularity === "week") return `${m.weekYear()}-W${String(m.week()).padStart(2, "0")}`;
      return date;
    };
    const fmtLabel = (date: string): string => {
      const m = moment(date);
      if (this.planDateGranularity === "month") return `${m.year()}年${m.month() + 1}月`;
      if (this.planDateGranularity === "week") {
        const start = m.clone().startOf("week");
        const end = m.clone().endOf("week");
        return `${m.weekYear()}年第${m.week()}周（${start.format("MM-DD")} ~ ${end.format("MM-DD")}）`;
      }
      return formatDateLabel(date);
    };

    const map = new Map<string, JournalEntry[]>();
    sorted.forEach(e => {
      const key = fmtKey(e.date);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    });
    const keys = [...map.keys()];
    // 日期分组始终按时间排列，升序/降序跟随方向开关
    keys.sort((a, b) => this.planSortAsc ? a.localeCompare(b) : b.localeCompare(a));
    return keys.map(k => ({ date: k, dateLabel: fmtLabel(k), entries: map.get(k)! }));
  }

  /** 单条记录是否命中全部关键字（正文/标签/章节/待办，忽略大小写的子串匹配） */
  private matchEntry(entry: JournalEntry, keywords: string[]): boolean {
    if (keywords.length === 0) return true;
    const parts = [
      entry.text,
      entry.sectionLabel,
      entry.date,
      entry.time ?? "",
      ...(entry.tags ?? []),
      ...(entry.todos?.flatMap(t => [t.text, t.dueDate ?? "", t.completedAt ?? ""]) ?? []),
    ];
    const haystack = parts.join("\n").toLowerCase();
    return keywords.every(k => haystack.includes(k));
  }

  /** 渲染顶部操作栏：「打开今日原文」（阅读模式）+ 搜索开关 */
  private renderTopActionBar() {
    const row = this.container.createDiv({ cls: "lj-review-open-today-row" });

    if (!this.plansMode) {
      const btn = row.createDiv({ cls: "lj-review-open-today-btn" });
      btn.createSpan({ text: "\u{1F4C4}" });
      btn.createSpan({ text: "\u6253\u5F00\u4ECA\u65E5\u539F\u6587" });
      btn.addEventListener("click", () => {
        const today = moment().format(this.plugin.settings.dateFormat || "YYYY-MM-DD");
        const folder = this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
        const filePath = normalizePath(`${folder}/${today}.md`);
        const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          const leaf = this.plugin.app.workspace.getLeaf(false);
          leaf.openFile(file);
        } else {
          new Notice("\u4ECA\u65E5\u65E5\u8BB0\u6587\u4EF6\u4E0D\u5B58\u5728");
        }
      });
    }

    // 已配置标记（按钮加深高亮）
    const groupSet = this.planGroupBy !== "none";
    const sortSet = this.planSortBy !== "priority" || this.planSortAsc;
    const searchSet = !!this.searchQuery || !!this.activeInlineTag ||
      !!this.filterDateFrom || !!this.filterDateTo || this.filterPriorities.size > 0;

    // 分组按钮（仅计划模式）
    if (this.plansMode) {
      const groupToggle = row.createDiv({
        cls: `lj-review-search-toggle ${this.groupVisible ? "active" : ""} ${groupSet ? "set" : ""}`,
        text: "\u{1F4C2}",
        attr: { "aria-label": "分组" },
      });
      groupToggle.addEventListener("click", () => {
        this.groupVisible = !this.groupVisible;
        this.persistState();
        this.render();
      });
    }

    // 排序按钮（阅读 + 计划都可用）
    const sortToggle = row.createDiv({
      cls: `lj-review-search-toggle ${this.sortVisible ? "active" : ""} ${sortSet ? "set" : ""}`,
      text: "\u{1F503}",
      attr: { "aria-label": "排序" },
    });
    sortToggle.addEventListener("click", () => {
      this.sortVisible = !this.sortVisible;
      this.persistState();
      this.render();
    });

    // 搜索按钮（子面板：搜索框 + 标签筛选 + 日期/优先级筛选）
    const searchToggle = row.createDiv({
      cls: `lj-review-search-toggle ${this.searchVisible ? "active" : ""} ${searchSet ? "set" : ""}`,
      text: "\u{1F50D}",
      attr: { "aria-label": "搜索与筛选" },
    });
    searchToggle.addEventListener("click", () => {
      this.searchVisible = !this.searchVisible;
      this.focusSearchOnRender = this.searchVisible;
      this.persistState();
      this.render();
    });
  }

  /** 面板选项小胶囊 */
  private mkChip(parent: HTMLElement, label: string, active: boolean, onClick: () => void): HTMLElement {
    const chip = parent.createDiv({ cls: `lj-review-inline-tag ${active ? "active" : ""}` });
    chip.createSpan({ text: label });
    chip.addEventListener("click", onClick);
    return chip;
  }

  /** 计划视图：分组与排序面板（芯片按钮式） */
  private renderGroupPanel() {
    if (!this.plansMode || !this.groupVisible) return;

    const panel = this.container.createDiv({ cls: "lj-review-filter-panel" });
    panel.createSpan({ cls: "lj-review-panel-label", text: "\u{1F4C2} 分组" });
    const row1 = panel.createDiv({ cls: "lj-review-filter-row" });
    this.mkChip(row1, "不分组", this.planGroupBy === "none", () => {
      this.planGroupBy = "none";
      this.collapsedGroups.clear();
      this.persistState();
      this.render();
    });
    this.mkChip(row1, "优先级", this.planGroupBy === "priority", () => {
      this.planGroupBy = "priority";
      this.collapsedGroups.clear();
      this.persistState();
      this.render();
    });
    this.mkChip(row1, "日期", this.planGroupBy === "date", () => {
      this.planGroupBy = "date";
      this.collapsedGroups.clear();
      this.persistState();
      this.render();
    });
    if (this.planGroupBy === "date") {
      (["day", "week", "month"] as const).forEach(g => {
        const labels = { day: "按日", week: "按周", month: "按月" } as const;
        this.mkChip(row1, labels[g], this.planDateGranularity === g, () => {
          this.planDateGranularity = g;
          this.collapsedGroups.clear();
          this.persistState();
          this.render();
        });
      });
    }
  }

  /** 计划视图：排序面板（时间/标题/标签/优先级 + 升降序） */
  private renderSortPanel() {
    if (!this.sortVisible) return;

    const panel = this.container.createDiv({ cls: "lj-review-filter-panel" });
    const row = panel.createDiv({ cls: "lj-review-filter-row" });
    row.createSpan({ cls: "lj-review-filter-label", text: "\u{1F503} 排序" });
    // 阅读模式的普通记录没有优先级，不提供"优先级"排序
    const allOpts = { time: "时间", title: "标题", tag: "标签", priority: "优先级" } as const;
    const sortOpts: (keyof typeof allOpts)[] = this.plansMode
      ? ["time", "title", "tag", "priority"]
      : ["time", "title", "tag"];
    sortOpts.forEach(s => {
      this.mkChip(row, allOpts[s], this.activeSortBy === s, () => {
        this.planSortBy = s;
        this.persistState();
        this.render();
      });
    });
    this.mkChip(row, this.planSortAsc ? "\u2191 升序" : "\u2193 降序", true, () => {
      this.planSortAsc = !this.planSortAsc;
      this.persistState();
      this.render();
    });
  }

  /** 搜索面板：搜索框 + 标签筛选 + 日期/优先级筛选（搜索按钮的子层） */
  private renderSearchPanel() {
    if (!this.searchVisible) return;
    const panel = this.container.createDiv({ cls: "lj-review-search-panel" });

    // 搜索框
    const bar = panel.createDiv({ cls: "lj-review-search-bar" });
    const input = bar.createEl("input", {
      cls: "lj-review-search-input",
      type: "text",
      attr: { placeholder: "搜索记录，多个关键字用空格分隔", "aria-label": "搜索记录" },
    });
    input.value = this.searchQuery;

    const clearBtn = bar.createDiv({
      cls: `lj-review-search-clear ${this.searchQuery ? "visible" : ""}`,
      text: "\u2715",
      attr: { "aria-label": "清除搜索" },
    });

    let searchTimer: number | null = null;
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      clearBtn.toggleClass("visible", input.value.trim().length > 0);
      this.persistState();
      // 输入防抖 250ms，避免每个字符都重新读取解析全部日记
      if (searchTimer !== null) activeWindow.clearTimeout(searchTimer);
      searchTimer = activeWindow.setTimeout(() => {
        searchTimer = null;
        void this.refreshResults();
      }, 250);
    });

    clearBtn.addEventListener("click", () => {
      this.searchQuery = "";
      input.value = "";
      clearBtn.removeClass("visible");
      input.focus();
      this.persistState();
      void this.refreshResults();
    });

    // 标签筛选
    const tagRow = panel.createDiv({ cls: "lj-review-tag-panel" });
    tagRow.createSpan({ cls: "lj-review-panel-label", text: "\u{1F3F7} 标签" });
    this.tagChipsEl = tagRow.createDiv({ cls: "lj-review-tag-chips" });
    this.updateTagPanel();

    // 日期范围 + 快捷筛选 + 优先级（沿用原筛选面板内容）
    this.renderFilterRows(panel);

    if (this.focusSearchOnRender) {
      this.focusSearchOnRender = false;
      input.focus();
    }
  }

  /** 刷新标签面板的标签列表（refreshResults 加载数据后调用） */
  private updateTagPanel() {
    const chips = this.tagChipsEl;
    if (!chips || !chips.isConnected) return;
    chips.empty();
    if (this.availableTags.length === 0) {
      chips.createSpan({ cls: "lj-review-panel-empty", text: "暂无标签" });
      return;
    }
    const allChip = chips.createDiv({
      cls: `lj-review-inline-tag ${this.activeInlineTag === null ? "active" : ""}`,
    });
    allChip.createSpan({ text: "全部" });
    allChip.addEventListener("click", () => {
      this.activeInlineTag = null;
      this.persistState();
      this.render();
    });
    this.availableTags.forEach(tag => {
      const chip = chips.createDiv({
        cls: `lj-review-inline-tag ${this.activeInlineTag === tag ? "active" : ""}`,
      });
      chip.createSpan({ text: tag });
      chip.addEventListener("click", () => {
        this.activeInlineTag = this.activeInlineTag === tag ? null : tag;
        this.persistState();
        this.render();
      });
    });
  }

  /** 筛选行：日期范围（含快捷筛选与小日历）+ 优先级（仅计划），挂在搜索面板内 */
  private renderFilterRows(panel: HTMLElement) {
    const row1 = panel.createDiv({ cls: "lj-review-filter-row" });
    row1.createSpan({ cls: "lj-review-filter-label", text: "\u{1F4C5} 日期" });

    const applyDate = () => {
      this.persistState();
      void this.refreshResults();
    };
    const fromField = this.createDateField(row1, "开始 YYYY-MM-DD", "开始日期", this.filterDateFrom, v => {
      this.filterDateFrom = v;
      applyDate();
    });
    row1.createSpan({ cls: "lj-review-filter-sep", text: "\u2192" });
    const toField = this.createDateField(row1, "结束 YYYY-MM-DD", "结束日期", this.filterDateTo, v => {
      this.filterDateTo = v;
      applyDate();
    });

    // 快捷筛选：本月 / 下月 / 今年
    const fmt = (m: ReturnType<typeof moment>) => m.format("YYYY-MM-DD");
    const presets: [string, () => { from: string; to: string }][] = [
      ["本月", () => ({ from: fmt(moment().startOf("month")), to: fmt(moment().endOf("month")) })],
      ["下月", () => ({ from: fmt(moment().add(1, "month").startOf("month")), to: fmt(moment().add(1, "month").endOf("month")) })],
      ["今年", () => ({ from: fmt(moment().startOf("year")), to: fmt(moment().endOf("year")) })],
    ];
    presets.forEach(([label, fn]) => {
      const r = fn();
      const matched = this.filterDateFrom === r.from && this.filterDateTo === r.to;
      this.mkChip(row1, label, matched, () => {
        this.filterDateFrom = r.from;
        this.filterDateTo = r.to;
        fromField.set(r.from);
        toField.set(r.to);
        applyDate();
      });
    });

    // 计划模式：优先级筛选（4 级）
    if (this.plansMode) {
      const row2 = panel.createDiv({ cls: "lj-review-filter-row" });
      row2.createSpan({ cls: "lj-review-filter-label", text: "\u{1F7E0} 优先级" });
      (["1", "2", "3", "4"] as PriorityLevel[]).forEach(p => {
        const meta = PRIORITY_META[p];
        this.mkChip(row2, `${meta.numeral} ${meta.label}`, this.filterPriorities.has(p), () => {
          if (this.filterPriorities.has(p)) this.filterPriorities.delete(p);
          else this.filterPriorities.add(p);
          this.persistState();
          void this.refreshResults();
        });
      });
    }

    const clearBtn = panel.createDiv({
      cls: "lj-review-filter-clear",
      text: "\u2715 清除筛选",
      attr: { role: "button", "aria-label": "清除筛选" },
    });
    clearBtn.addEventListener("click", () => {
      this.filterDateFrom = "";
      this.filterDateTo = "";
      this.filterPriorities.clear();
      fromField.set("");
      toField.set("");
      this.persistState();
      void this.refreshResults();
    });
  }

  /** 日期字段：输入框 + 点击弹出的迷你日历（支持手输无前导零日期） */
  private createDateField(
    row: HTMLElement,
    placeholder: string,
    aria: string,
    value: string,
    onSet: (v: string) => void
  ): { set: (v: string) => void } {
    const wrap = row.createDiv({ cls: "lj-review-date-field" });
    const input = wrap.createEl("input", {
      cls: "lj-review-filter-date",
      attr: { type: "text", placeholder, "aria-label": aria },
    });
    input.value = value;
    const pop = wrap.createDiv({ cls: "lj-review-datepicker" });
    pop.style.display = "none";

    const closePop = () => { pop.style.display = "none"; };
    // 日历内部点击（翻月/翻年/选日期重绘会移除原节点）不冒泡到 document，
    // 否则 document 上的"点击外部关闭"会因 contains(已移除节点)=false 而误关
    pop.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("click", () => {
      const willOpen = pop.style.display === "none";
      pop.style.display = willOpen ? "block" : "none";
      if (willOpen) {
        this.renderDatePicker(pop, input, onSet, closePop);
        // 点击面板外部自动关闭（节点已从 DOM 移除时视为内部操作，忽略）
        const onDoc = (e: MouseEvent) => {
          const t = e.target as Node;
          if (!wrap.contains(t) && document.contains(t)) {
            closePop();
            document.removeEventListener("click", onDoc);
          }
        };
        activeWindow.setTimeout(() => document.addEventListener("click", onDoc), 0);
      }
    });
    // 手输：兼容 2026-9-10 等无前导零格式
    input.addEventListener("change", () => {
      const v = parseFlexibleDate(input.value);
      input.value = v ?? "";
      onSet(v ?? "");
    });

    return {
      set: (v: string) => { input.value = v; onSet(v); },
    };
  }

  /** 渲染迷你日历：顶部手输框 + 月份导航 + 点选日期网格 */
  private renderDatePicker(
    pop: HTMLElement,
    input: HTMLInputElement,
    onPick: (d: string) => void,
    close: () => void
  ) {
    let view = moment(input.value, "YYYY-MM-DD", true).isValid()
      ? moment(input.value, "YYYY-MM-DD")
      : moment();

    const draw = () => {
      pop.empty();

      // 顶部：手动输入框 + 关闭
      const top = pop.createDiv({ cls: "ljd-top" });
      const manual = top.createEl("input", {
        cls: "ljd-manual",
        attr: { type: "text", placeholder: "YYYY-MM-DD", "aria-label": "输入日期" },
      });
      manual.value = input.value;
      const closeBtn = top.createDiv({ cls: "ljd-close", text: "\xD7", attr: { role: "button", "aria-label": "关闭日历" } });
      closeBtn.addEventListener("click", () => close());
      manual.addEventListener("change", () => {
        const v = parseFlexibleDate(manual.value);
        if (v) { onPick(v); close(); }
        else { manual.value = input.value; }
      });

      // 年/月导航：« 上一年 ‹ 上个月 · 标题 · 下个月 › 下一年 »
      const head = pop.createDiv({ cls: "ljd-head" });
      const prevYear = head.createDiv({ cls: "ljd-nav", text: "\u00AB", attr: { role: "button", "aria-label": "上一年" } });
      const prev = head.createDiv({ cls: "ljd-nav", text: "\u2039", attr: { role: "button", "aria-label": "上个月" } });
      head.createSpan({ cls: "ljd-title", text: `${view.year()}年${view.month() + 1}月` });
      const next = head.createDiv({ cls: "ljd-nav", text: "\u203A", attr: { role: "button", "aria-label": "下个月" } });
      const nextYear = head.createDiv({ cls: "ljd-nav", text: "\u00BB", attr: { role: "button", "aria-label": "下一年" } });
      prevYear.addEventListener("click", () => { view = view.clone().subtract(1, "year"); draw(); });
      prev.addEventListener("click", () => { view = view.clone().subtract(1, "month"); draw(); });
      next.addEventListener("click", () => { view = view.clone().add(1, "month"); draw(); });
      nextYear.addEventListener("click", () => { view = view.clone().add(1, "year"); draw(); });

      // 日期网格（周一起始）
      const grid = pop.createDiv({ cls: "ljd-grid" });
      ["一", "二", "三", "四", "五", "六", "日"].forEach(w => grid.createSpan({ cls: "ljd-wd", text: w }));
      const first = view.clone().startOf("month");
      const offset = (first.day() + 6) % 7;
      const daysInMonth = view.daysInMonth();
      const todayStr = moment().format("YYYY-MM-DD");
      const selStr = input.value;
      for (let i = 0; i < offset; i++) grid.createSpan({ cls: "ljd-day empty" });
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${view.year()}-${String(view.month() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const cell = grid.createSpan({
          cls: `ljd-day ${dateStr === todayStr ? "today" : ""} ${dateStr === selStr ? "selected" : ""}`,
          text: String(d),
        });
        cell.addEventListener("click", () => { onPick(dateStr); close(); });
      }
    };
    draw();
  }

  /** 渲染搜索框（展开态） */

  /** 渲染筛选标签栏（复用编辑视图的 lj-tab-bar 样式） */
  private renderFilterBar() {
    // 计划模式：计划已独立成板块，不再显示章节筛选栏
    if (this.plansMode) return;

    // 阅读模式：计划单独成板块或计划类型已关闭时，筛选栏不显示计划类章节
    const includePlansInReading = this.plugin.settings.plansDisplay !== "separate" && isTypeEnabled(this.plugin.settings, "plans");
    const visibleSections = this.plugin.settings.sections.filter(s =>
      s.enabled && isTypeEnabled(this.plugin.settings, s.type) && (includePlansInReading || s.type !== "plans")
    );
    // 只有一个可见章节时不显示章节选择栏（含"全部"），直接展示内容
    if (visibleSections.length <= 1) return;
    if (this.activeFilter !== "all") {
      const activeSec = this.plugin.settings.sections.find(s => s.id === this.activeFilter);
      if (!activeSec || !visibleSections.includes(activeSec)) {
        this.activeFilter = "all"; // 当前筛选的章节已移出阅读，回退到全部
      }
    }

    const bar = this.container.createDiv({ cls: "lj-tab-bar" });

    // "全部" 标签
    const allBtn = bar.createDiv({
      cls: `lj-tab ${this.activeFilter === "all" ? "active" : ""}`,
    });
    allBtn.createDiv({ cls: "lj-tab-emoji", text: "\u{1F4CB}" });
    allBtn.createDiv({ text: "\u5168\u90E8" });
    allBtn.addEventListener("click", () => {
      if (this.activeFilter === "all") return;
      this.activeFilter = "all";
      this.render();
    });

    // 从 settings.sections 动态渲染筛选标签（仅显示启用的章节）
    this.plugin.settings.sections.filter(s => s.enabled && isTypeEnabled(this.plugin.settings, s.type)).forEach(sec => {
      if (!includePlansInReading && sec.type === "plans") return;
      const btn = bar.createDiv({
        cls: `lj-tab filter-${sec.id} ${this.activeFilter === sec.id ? "active" : ""}`,
      });
      btn.createDiv({ cls: "lj-tab-emoji", text: sec.emoji });
      btn.createDiv({ text: sec.label });
      btn.addEventListener("click", () => {
        if (this.activeFilter === sec.id) return;
        this.activeFilter = sec.id;
        this.render();
      });
    });
  }

  /** 渲染当前激活的行内标签筛选 */
  private renderActiveInlineTagBar() {
    if (!this.activeInlineTag) return;

    const bar = this.container.createDiv({ cls: "lj-review-active-tag-bar" });
    bar.createSpan({ cls: "lj-review-active-tag-label", text: "标签筛选" });

    const activeTag = bar.createDiv({ cls: "lj-review-inline-tag active" });
    activeTag.createSpan({ text: this.activeInlineTag });

    const clearBtn = bar.createDiv({ cls: "lj-review-clear-tag", text: "清除" });
    clearBtn.addEventListener("click", () => {
      this.activeInlineTag = null;
      this.render();
    });
  }

  /** 渲染加载中状态 */
  private renderLoadingState(container: HTMLElement) {
    const loading = container.createDiv({ cls: "lj-review-loading" });
    loading.createDiv({ cls: "lj-review-loading-dot" });
    loading.createDiv({ cls: "lj-review-loading-dot" });
    loading.createDiv({ cls: "lj-review-loading-dot" });
  }

  /** 渲染空状态 */
  private renderEmpty(container: HTMLElement) {
    const empty = container.createDiv({ cls: "lj-review-empty" });
    empty.createDiv({ cls: "lj-review-empty-icon", text: "\u{1F4D6}" });
    if (this.searchQuery.trim()) {
      empty.createDiv({ cls: "lj-review-empty-title", text: "没有找到相关记录" });
      empty.createDiv({ cls: "lj-review-empty-sub", text: "换个关键字试试，或清除搜索条件" });
      return;
    }
    if (this.plansMode) {
      empty.createDiv({ cls: "lj-review-empty-title", text: "还没有计划" });
      empty.createDiv({ cls: "lj-review-empty-sub", text: "到「✏️ 编辑」的 📅 计划章节添加待办，就会出现在这里" });
      return;
    }
    if (this.activeInlineTag) {
      empty.createDiv({ cls: "lj-review-empty-title", text: "这个标签下还没有记录" });
      empty.createDiv({ cls: "lj-review-empty-sub", text: `试试清除标签筛选，或先记录一条包含 ${this.activeInlineTag} 的内容` });
      return;
    }

    empty.createDiv({ cls: "lj-review-empty-title", text: "还没有记录" });
    empty.createDiv({ cls: "lj-review-empty-sub", text: "切换到「记录」开始写第一篇日记吧" });
  }

  /** 渲染日期分组列表（按模式过滤：计划模式只看计划；阅读模式按设置决定是否混入计划） */
  private renderGroups(container: HTMLElement, groups: DayGroup[]) {
    const includePlansInReading = this.plugin.settings.plansDisplay !== "separate" && isTypeEnabled(this.plugin.settings, "plans");
    const memosEnabled = isTypeEnabled(this.plugin.settings, "memos");
    const collapsible = this.plansMode && this.planGroupBy !== "none";
    let dragKey: string | null = null;

    // 预计算每个分组的可见条目（类型开关：计划模式只看计划，阅读模式按 plansDisplay 与类型开关，旧 mood/text 归入闪念）
    const rendered = groups
      .map(group => ({
        group,
        entries: group.entries.filter(entry => {
          if (entry.renderType === "plans") return this.plansMode ? true : includePlansInReading;
          return !this.plansMode && memosEnabled;
        }),
      }))
      .filter(r => r.entries.length > 0);

    // 拖拽产生的自定义次序：未记录的新分组按默认次序插到末尾
    if (collapsible) {
      const idx = (key: string) => {
        const i = this.groupOrder.indexOf(key);
        return i === -1 ? 1000 : i;
      };
      rendered.sort((a, b) => idx(a.group.date) - idx(b.group.date));
      this.lastGroupKeys = rendered.map(r => r.group.date);
    }

    rendered.forEach(({ group, entries }) => {
      const groupEl = container.createDiv({ cls: "lj-review-date-group" });

      if (collapsible) {
        const collapsed = this.collapsedGroups.has(group.date);
        const head = groupEl.createDiv({ cls: `lj-review-group-head ${collapsed ? "collapsed" : ""}` });
        head.createSpan({ cls: "lj-review-group-arrow", text: collapsed ? "\u25b8" : "\u25be" });
        head.createSpan({ cls: "lj-review-group-title", text: group.dateLabel });
        head.createSpan({ cls: "lj-review-group-count", text: `${entries.length} \u9879` });

        // 拖拽调整分组次序
        head.draggable = true;
        head.addEventListener("dragstart", (e) => {
          dragKey = group.date;
          head.addClass("dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", group.date);
          }
        });
        head.addEventListener("dragend", () => {
          dragKey = null;
          container.querySelectorAll(".lj-review-group-head").forEach(el => el.removeClass("drop-before", "drop-after", "dragging"));
        });
        head.addEventListener("dragover", (e) => {
          if (dragKey === null || dragKey === group.date) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          const rect = head.getBoundingClientRect();
          const lower = e.clientY > rect.top + rect.height / 2;
          head.toggleClass("drop-before", !lower);
          head.toggleClass("drop-after", lower);
        });
        head.addEventListener("dragleave", () => head.removeClass("drop-before", "drop-after"));
        head.addEventListener("drop", (e) => {
          e.preventDefault();
          const from = dragKey;
          head.removeClass("drop-before", "drop-after");
          if (!from || from === group.date) return;
          const rect = head.getBoundingClientRect();
          const lower = e.clientY > rect.top + rect.height / 2;
          this.reorderGroups(from, group.date, lower);
          dragKey = null;
          this.render();
        });

        head.addEventListener("click", () => {
          if (this.collapsedGroups.has(group.date)) this.collapsedGroups.delete(group.date);
          else this.collapsedGroups.add(group.date);
          this.render();
        });
        if (collapsed) return;
      } else {
        // 日期标签
        const dateLabel = groupEl.createDiv({ cls: "lj-review-date-label" });
        dateLabel.createSpan({ text: group.dateLabel });
        dateLabel.createSpan({ cls: "lj-review-date-full", text: group.date });
      }

      // 该日期下的所有卡片
      entries.forEach(entry => {
        this.renderCard(groupEl, entry);
      });
    });
  }

  /** 拖拽后更新分组自定义次序（以最近一次渲染的分组集合为基准） */
  private reorderGroups(fromKey: string, toKey: string, after: boolean) {
    const base = this.lastGroupKeys.length > 0 ? this.lastGroupKeys : [];
    const order = [...this.groupOrder.filter(k => base.includes(k)), ...base.filter(k => !this.groupOrder.includes(k))];
    const fromIdx = order.indexOf(fromKey);
    let toIdx = order.indexOf(toKey);
    if (fromIdx === -1 || toIdx === -1) return;
    order.splice(fromIdx, 1);
    toIdx = order.indexOf(toKey);
    if (after) toIdx += 1;
    order.splice(toIdx, 0, fromKey);
    this.groupOrder = order;
    this.persistState();
  }

  /** 渲染单张内容卡片 */
  private renderCard(container: HTMLElement, entry: JournalEntry) {
    const card = container.createDiv({ cls: "lj-review-card" });

    // 卡片头部
    const header = card.createDiv({ cls: "lj-review-card-header" });

    const tagEl = header.createDiv({ cls: "lj-review-card-tag" });
    tagEl.createSpan({ text: `${entry.sectionEmoji} ${entry.sectionLabel}` });

    // 置顶 / 归档徽标
    if (entry.pinned) {
      tagEl.createSpan({ cls: "lj-review-card-flag", text: "📌", attr: { "aria-label": "已置顶" } });
    }
    if (entry.archived) {
      tagEl.createSpan({
        cls: "lj-review-card-flag archived",
        text: "📦 已归档",
        attr: { "aria-label": `归档于 ${entry.archived}` },
      });
    }

    if (entry.time) {
      header.createDiv({ cls: "lj-review-card-time", text: entry.time });
    }

    // 卡片内容（v3.1.4：多行内容换行渲染）
    if (entry.renderType === "plans" && entry.todos) {
      this.renderTodoCard(card, entry);
    } else {
      const textWrap = card.createDiv({ cls: "lj-review-card-text markdown-rendered" });
      // v3.1.4：多行内容用 pre-wrap 保留换行
      if (entry.text.includes("\n")) {
        textWrap.style.whiteSpace = "pre-wrap";
      }
      void MarkdownRenderer.render(this.plugin.app, entry.text, textWrap, entry.filePath, this.plugin);
    }

    this.renderEntryTags(card, entry.tags);

    // 悬浮「⋯」操作按钮（右上角）
    const moreBtn = card.createDiv({
      cls: "lj-review-card-more",
      text: "⋯",
      attr: { "aria-label": "更多操作" },
    });
    moreBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.showEntryMenu(evt as MouseEvent, card, entry);
    });
  }

  /** 单条记录操作菜单：置顶 / 编辑 / 原文 / 归档 / 删除 */
  private showEntryMenu(evt: MouseEvent, card: HTMLElement, entry: JournalEntry) {
    const menu = new Menu();

    menu.addItem(item =>
      item
        .setTitle(entry.pinned ? "取消置顶" : "置顶")
        .setIcon("pin")
        .onClick(() => this.togglePinEntry(entry))
    );

    // 计划块用专用编辑弹窗（逐任务编辑）；普通记录用内联文本编辑
    if (entry.renderType === "plans") {
      menu.addItem(item =>
        item.setTitle("编辑").setIcon("pencil").onClick(() => this.openPlanEditModal(entry))
      );
    } else {
      menu.addItem(item =>
        item.setTitle("编辑").setIcon("pencil").onClick(() => this.enterEditMode(card, entry))
      );
    }

    menu.addItem(item =>
      item.setTitle("原文").setIcon("file-text").onClick(() => this.revealEntryInFile(entry))
    );

    if (!entry.archived) {
      menu.addItem(item =>
        item.setTitle("归档").setIcon("archive").onClick(() => this.archiveEntry(entry))
      );
    }

    menu.addSeparator();
    menu.addItem(item =>
      item
        .setTitle("删除")
        .setIcon("trash-2")
        .onClick(() => {
          new ConfirmModal(
            this.plugin.app,
            "删除这条记录？",
            "将从日记文件中移除该记录的原文，此操作不可撤销。",
            "删除",
            async () => {
              try {
                await removeLineRange(
                  this.plugin.app,
                  entry.filePath,
                  entry.rawLineIndex ?? 0,
                  entry.endLineIndex ?? entry.rawLineIndex ?? 0
                );
                new Notice("🗑 已删除");
                this.render();
              } catch (e) {
                new Notice("删除失败，请检查日记文件");
              }
            }
          ).open();
        })
    );

    menu.showAtMouseEvent(evt);
  }

  /** 置顶 / 取消置顶：在记录块尾增删 [pinned::true] 字段行 */
  private async togglePinEntry(entry: JournalEntry) {
    try {
      const start = entry.rawLineIndex ?? 0;
      const end = entry.endLineIndex ?? start;
      const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
      const fieldIdx = block.findIndex(l => /^\s*\[pinned::/.test(l));
      if (fieldIdx >= 0) {
        await removeLineRange(this.plugin.app, entry.filePath, start + fieldIdx, start + fieldIdx);
        new Notice("已取消置顶");
      } else {
        await insertLineAfter(this.plugin.app, entry.filePath, end, "[pinned::true]");
        new Notice("📌 已置顶");
      }
      this.render();
    } catch (e) {
      new Notice("操作失败，请检查日记文件");
    }
  }

  /** 归档：在记录块尾追加 [archived::YYYY-MM-DD HH:mm:ss] */
  private async archiveEntry(entry: JournalEntry) {
    try {
      const stamp = moment().format("YYYY-MM-DD HH:mm:ss");
      await insertLineAfter(
        this.plugin.app,
        entry.filePath,
        entry.endLineIndex ?? entry.rawLineIndex ?? 0,
        `[archived::${stamp}]`
      );
      new Notice("📦 已归档");
      this.render();
    } catch (e) {
      new Notice("归档失败，请检查日记文件");
    }
  }

  /** 原文：打开来源日记文件并定位滚动到该记录所在行 */
  private async revealEntryInFile(entry: JournalEntry) {
    const file = this.plugin.app.vault.getAbstractFileByPath(entry.filePath);
    if (!(file instanceof TFile)) {
      new Notice("日记文件不存在");
      return;
    }
    const leaf = this.plugin.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    if (leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      const lineCount = editor.lineCount();
      const line = Math.min(entry.rawLineIndex ?? 0, lineCount - 1);
      editor.setCursor({ line, ch: 0 });
      editor.scrollIntoView(
        {
          from: { line, ch: 0 },
          to: { line: Math.min(entry.endLineIndex ?? line, lineCount - 1), ch: 0 },
        },
        true
      );
    }
  }

  /** 打开计划块编辑弹窗，保存后整块回写日记文件 */
  private openPlanEditModal(entry: JournalEntry) {
    new PlanEditModal(this.plugin.app, this.plugin, entry, async (title, rows) => {
      try {
        const start = entry.rawLineIndex ?? 0;
        const end = entry.endLineIndex ?? start;
        // 保留块尾的置顶/归档字段行
        const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
        const fieldLines = block.filter(l => /^\s*\[(pinned|archived)::.*\]\s*$/.test(l));

        const completedField = getCompletedFieldName(this.plugin.settings);
        const lines: string[] = [];
        // 块标题行（保留原时间）
        lines.push(entry.time ? `- ${entry.time}${title ? ` ${title}` : ""}` : `- ${title || entry.sectionLabel}`);
        // 任务行（与记录页保存格式一致：顶级缩进4空格，子任务缩进8空格）
        rows.forEach(r => {
          const text = r.text.trim();
          if (!text && !r.dueDate) return;
          lines.push(planTaskLine(r as unknown as TodoItem, completedField));
        });

        await replaceLineRange(this.plugin.app, entry.filePath, start, end, [
          ...lines,
          ...fieldLines,
        ]);
        new Notice("✎ 计划已保存");
        this.render();
      } catch (e) {
        new Notice("保存失败，请检查日记文件");
      }
    }).open();
  }

  /** 编辑：卡片切换为内联编辑态 */
  private enterEditMode(card: HTMLElement, entry: JournalEntry) {
    if (card.querySelector(".lj-review-card-edit")) return;

    // 隐藏现有内容（保留头部与操作按钮）
    Array.from(card.children).forEach(el => {
      const child = el as HTMLElement;
      if (child.hasClass("lj-review-card-header") || child.hasClass("lj-review-card-more")) return;
      child.addClass("lj-hidden-for-edit");
    });

    const editWrap = card.createDiv({ cls: "lj-review-card-edit" });
    const textarea = editWrap.createEl("textarea");
    textarea.value = entry.text;

    const actions = editWrap.createDiv({ cls: "lj-review-card-edit-actions" });
    const cancelBtn = actions.createEl("button", { text: "取消", cls: "lj-review-edit-cancel" });
    const saveBtn = actions.createEl("button", { text: "保存", cls: "lj-review-edit-save" });

    cancelBtn.onclick = () => {
      editWrap.remove();
      Array.from(card.children).forEach(el => (el as HTMLElement).removeClass("lj-hidden-for-edit"));
    };

    saveBtn.onclick = async () => {
      const newText = textarea.value.trim();
      if (!newText) {
        new Notice("内容不能为空～");
        return;
      }
      saveBtn.disabled = true;
      try {
        const start = entry.rawLineIndex ?? 0;
        const end = entry.endLineIndex ?? start;
        // 保留块尾的置顶/归档字段行
        const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
        const fieldLines = block.filter(l => /^\s*\[(pinned|archived)::.*\]\s*$/.test(l));
        const contentLines = newText.split("\n").map((line, i) =>
          i === 0 && entry.time ? `- ${entry.time} ${line}` : line
        );
        await replaceLineRange(this.plugin.app, entry.filePath, start, end, [
          ...contentLines,
          ...fieldLines,
        ]);
        new Notice("✎ 已保存");
        this.render();
      } catch (e) {
        new Notice("保存失败，请检查日记文件");
        saveBtn.disabled = false;
      }
    };

    textarea.focus();
  }

  /** 按当前任务顺序重写计划块（拖拽排序后调用，保留置顶/归档字段行） */
  private async rewritePlanBlock(entry: JournalEntry, todos: TodoItem[]) {
    const start = entry.rawLineIndex ?? 0;
    const end = entry.endLineIndex ?? start;
    const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
    const fieldLines = block.filter(l => /^\s*\[(pinned|archived)::.*\]\s*$/.test(l));
    const completedField = getCompletedFieldName(this.plugin.settings);
    const lines = [planHeaderLine(entry), ...todos.map(t => planTaskLine(t, completedField))];
    await replaceLineRange(this.plugin.app, entry.filePath, start, end, [...lines, ...fieldLines]);
  }

  /** 渲染计划任务卡片（含可勾选 checkbox、父子子任务层级，进度实时更新） */
  private renderTodoCard(card: HTMLElement, entry: JournalEntry) {
    if (!entry.todos || entry.todos.length === 0) return;

    const todos = entry.todos;
    const total = todos.length;
    let dragFrom: number | null = null;
    let doneCount = todos.filter(t => t.done).length;

    // 行引用（级联更新后刷新对应行）
    const refs = new Map<number, { todo: TodoItem; checkbox: HTMLElement; textEl: HTMLElement; itemEl: HTMLElement }>();

    // 进度引用（勾选时实时更新）
    let progressText: HTMLElement | null = null;
    let progressFill: HTMLElement | null = null;

    const refreshProgress = () => {
      doneCount = todos.filter(t => t.done).length;
      if (progressText) progressText.setText(`${doneCount}/${total} 已完成`);
      if (progressFill) progressFill.style.width = `${Math.round((doneCount / total) * 100)}%`;
    };

    const refreshRow = (todo: TodoItem) => {
      const ref = refs.get(todo.lineIndex);
      if (!ref) return;
      ref.checkbox.toggleClass("checked", todo.done);
      ref.textEl.toggleClass("done", todo.done);
      ref.itemEl.toggleClass("done", todo.done);
      appendTodoCompletionInfo(ref.textEl, todo, this.plugin.settings, true);
    };

    const todoList = card.createDiv({ cls: "lj-review-todo-list" });

    const renderItem = (todo: TodoItem, isSub: boolean) => {
      const item = todoList.createDiv({ cls: `lj-review-todo-item ${todo.done ? "done" : ""} ${isSub ? "sub" : ""}` });

      // 自定义 checkbox
      const checkbox = item.createDiv({
        cls: `lj-review-checkbox ${todo.done ? "checked" : ""}`,
      });

      const textEl = item.createDiv({
        cls: `lj-review-todo-text ${todo.done ? "done" : ""}`,
      });
      // 优先级徽标（圆形罗马数字 SVG；2 级默认隐藏，可在设置开启）
      if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
        textEl.appendChild(createPriorityBadge(todo.priority));
      }
      textEl.createSpan({ text: todo.text });
      // v3.1.4：截止日期标签
      if (todo.dueDate) {
        const overdue = this.isTodoOverdue(todo.dueDate);
        const dueTag = textEl.createSpan({
          cls: `lj-review-due ${overdue ? "overdue" : ""}`,
          text: overdue ? "⚠️过期" : `📅 ${this.formatTodoDue(todo.dueDate)}`,
        });
      }
      // 已完成任务的耗时 / 完成时间徽标
      appendTodoCompletionInfo(textEl, todo, this.plugin.settings, true);

      refs.set(todo.lineIndex, { todo, checkbox, textEl, itemEl: item });

      // 拖拽调整任务顺序/层级：上半=插到其前，下半=顶级任务变为其子任务 / 子任务插到其后
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        dragFrom = todo.lineIndex;
        item.addClass("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(todo.lineIndex));
        }
      });
      item.addEventListener("dragend", () => {
        dragFrom = null;
        todoList.querySelectorAll(".lj-review-todo-item").forEach(el => el.removeClass("drop-before", "drop-after", "dragging"));
      });
      item.addEventListener("dragover", (e) => {
        if (dragFrom === null || dragFrom === todo.lineIndex) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        item.toggleClass("drop-before", !lower);
        item.toggleClass("drop-after", lower);
      });
      item.addEventListener("dragleave", () => item.removeClass("drop-before", "drop-after"));
      item.addEventListener("drop", async (e) => {
        e.preventDefault();
        const from = dragFrom;
        item.removeClass("drop-before", "drop-after");
        if (from === null || from === todo.lineIndex || this.isLoading) return;
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        const fromIdx = todos.findIndex(t => t.lineIndex === from);
        const targetIdx = todos.indexOf(todo);
        if (fromIdx === -1 || targetIdx === -1) return;
        const asChild = !todo.indent && lower;
        moveTodoSubtree(todos, fromIdx, targetIdx, asChild, lower && !asChild);
        this.isLoading = true;
        try {
          await this.rewritePlanBlock(entry, todos);
          new Notice("\u2195 \u5df2\u66f4\u65b0\u8ba1\u5212");
          this.render();
        } catch (err) {
          new Notice("\u6392\u5e8f\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u65e5\u8bb0\u6587\u4ef6");
        } finally {
          this.isLoading = false;
        }
      });

      // 点击事件（父子级联）
      const toggle = async () => {
        if (this.isLoading) return;
        this.isLoading = true;
        const newDone = !todo.done;
        const stamp = moment().format("YYYY-MM-DD HH:mm");
        try {
          const updates = buildTodoCascade(todos, todo, newDone, stamp);
          await setTodoStatesInFile(this.plugin.app, entry.filePath, updates, this.plugin.settings);
          // 同步内存状态并刷新受影响的行
          updates.forEach(u => {
            const t = todos.find(x => x.lineIndex === u.lineIndex);
            if (!t) return;
            t.done = u.done;
            t.completedAt = u.done ? (u.completedAt ?? stamp) : undefined;
            refreshRow(t);
          });
          refreshProgress();
          new Notice(newDone ? "✅ 任务完成" : "↩️ 已取消完成");
        } catch (e) {
          new Notice("同步失败，请检查日记文件");
        } finally {
          this.isLoading = false;
        }
      };

      checkbox.addEventListener("click", toggle);
      textEl.addEventListener("click", toggle);
    };

    // 按层级渲染：子任务缩进显示在父任务之后
    todos.forEach(t => renderItem(t, !!t.indent));

    // 显示进度
    if (total > 0) {
      const progress = card.createDiv({ cls: "lj-review-todo-progress" });
      progressText = progress.createSpan({ text: `${doneCount}/${total} 已完成` });
      const bar = progress.createDiv({ cls: "lj-review-progress-bar" });
      progressFill = bar.createDiv({ cls: "lj-review-progress-fill" });
      progressFill.style.width = `${Math.round((doneCount / total) * 100)}%`;
    }
  }

  /** 渲染识别到的行内标签 */
  private renderEntryTags(container: HTMLElement, tags: string[] | undefined) {
    if (!tags || !tags.length) return;

    const row = container.createDiv({ cls: "lj-review-entry-tags" });
    tags.forEach(tag => {
      const chip = row.createDiv({
        cls: `lj-review-inline-tag ${this.activeInlineTag === tag ? "active" : ""}`,
      });
      chip.createSpan({ text: tag });
      chip.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.activeInlineTag = this.activeInlineTag === tag ? null : tag;
        this.render();
      });
    });
  }

  /** 根据行内标签二次过滤回顾结果 */
  private filterGroupsByInlineTag(groups: DayGroup[], tag: string): DayGroup[] {
    return groups
      .map(group => ({
        ...group,
        entries: group.entries.filter(entry => entry.tags?.includes(tag)),
      }))
      .filter(group => group.entries.length > 0);
  }

  // ════════════════════════════════════════════════
  // v3.1.4 工具方法
  // ════════════════════════════════════════════════

  /** 格式化截止日期为友好显示 */
  private formatTodoDue(dateStr: string): string {
    const due = moment(dateStr).startOf("day");
    const today = moment().startOf("day");
    const diff = due.diff(today, "day");
    if (diff === 0) return "今天";
    if (diff === 1) return "明天";
    if (diff < 0) return `${Math.abs(diff)}天前`;
    if (diff <= 7) return `${diff}天后`;
    return `${due.month() + 1}月${due.date()}日`;
  }

  /** 判断待办是否过期 */
  private isTodoOverdue(dateStr: string): boolean {
    return moment(dateStr).isBefore(moment(), "day");
  }
}
