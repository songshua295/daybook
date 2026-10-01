/**
 * TodayPanel.ts — 今日记录流（合一视图的阅读区）
 *
 * 编辑与阅读已合一：输入区使用 Live Preview 实时渲染，
 * 本页下方的"今日记录"即原阅读流的精简版——只展示当前章节今天的
 * 记录块，支持勾选级联、拖拽排序、置顶 / 编辑 / 原文 / 归档 / 删除。
 */

import {
  MarkdownView,
  Menu,
  Modal,
  Notice,
  moment,
  TFile,
  type App,
  setIcon,
} from "obsidian";
import { makeActivatable } from "./JournalView";
import type DaybookPlugin from "./main";
import { renderMarkdown } from "./renderMarkdown";
import { createLiveEditor, type LiveEditor } from "./liveEditor";
import {
  readLineRange,
  insertLineAfter,
  replaceLineRange,
  removeLineRange,
} from "./fileManager";
import {
  readAllJournalEntries,
  setTodoStatesInFile,
  buildTodoCascade,
  moveTodoSubtree,
  appendTodoCompletionInfo,
  createPriorityBadge,
  getCompletedFieldName,
  effectivePriority,
  shouldShowPriorityBadge,
  planTodoProgress,
  PRIORITY_META,
  PRIORITY_EMOJI,
  type PriorityLevel,
  type JournalEntry,
  type TodoItem,
  formatDateLabel,
} from "./fileReader";
import { getAllSections, type SectionConfig } from "./settings";
import { isFilterActive, matchEntry, type SectionFilter } from "./filters";
import { collectPlanTasks, groupPlanTasks, type PlanGroupMode } from "./planOverview";

/** 删除等危险操作确认弹窗 */
export class ConfirmModal extends Modal {
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
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const btns = this.contentEl.createDiv({ cls: "db-mood-modal-btns" });
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

/** 计划编辑弹窗中的一行任务 */
interface PlanTodoRow {
  text: string;
  done: boolean;
  priority?: PriorityLevel;
  dueDate?: string;
  createdAt?: string;
  completedAt?: string;
  indent?: number;
  note?: string;
}

/** 计划块编辑弹窗：逐条编辑任务文字/完成/优先级/截止日期，支持增删任务 */
class PlanEditModal extends Modal {
  private entry: JournalEntry;
  private onSave: (title: string, rows: PlanTodoRow[]) => void;
  private rows: PlanTodoRow[] = [];

  constructor(
    app: App,
    private plugin: DaybookPlugin,
    entry: JournalEntry,
    onSave: (title: string, rows: PlanTodoRow[]) => void
  ) {
    super(app);
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
      note: t.note,
    }));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-plan-edit-modal");
    contentEl.createEl("h3", { text: "编辑计划" });

    // 标题行：时间 + 标题输入
    const headerRow = contentEl.createDiv({ cls: "db-plan-edit-header" });
    headerRow.createSpan({ cls: "db-plan-edit-time", text: this.entry.time ?? "🕐" });
    const titleInput = headerRow.createEl("input", {
      cls: "db-plan-edit-title",
      attr: { type: "text", placeholder: "计划标题", "aria-label": "计划标题" },
    });
    // entry.text 含时间前缀（"HH:mm 标题"），剥离后才是纯标题
    titleInput.value = this.entry.time ? this.entry.text.replace(/^\d{2}:\d{2}(?::\d{2})?\s*/, "") : "";

    const listEl = contentEl.createDiv({ cls: "db-plan-edit-list" });

    const renderList = () => {
      listEl.empty();
      this.rows.forEach(r => renderRow(r));
    };

    const renderRow = (row: PlanTodoRow) => {
      const itemEl = listEl.createDiv({ cls: "db-plan-edit-row" });

      const cb = itemEl.createEl("input", {
        cls: "db-plan-edit-done",
        attr: { type: "checkbox", "aria-label": "已完成" },
      });
      cb.checked = row.done;
      cb.addEventListener("change", () => {
        row.done = cb.checked;
        row.completedAt = row.done ? moment().format("YYYY-MM-DD HH:mm") : undefined;
      });

      const textInput = itemEl.createEl("input", {
        cls: "db-plan-edit-text",
        attr: { type: "text", placeholder: "任务内容", "aria-label": "任务内容" },
      });
      textInput.value = row.text;
      textInput.addEventListener("input", () => { row.text = textInput.value; });

      const prioritySelect = itemEl.createEl("select", {
        cls: "db-plan-edit-priority",
        attr: { "aria-label": "优先级" },
      });
      (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => {
        const meta = PRIORITY_META[lv];
        const opt = prioritySelect.createEl("option", { value: lv, text: `${meta.numeral} ${meta.label}` });
        if (effectivePriority(row.priority) === lv) opt.setAttribute("selected", "selected");
      });
      prioritySelect.addEventListener("change", () => {
        const v = prioritySelect.value as PriorityLevel;
        row.priority = v === "2" ? undefined : v;
      });

      const indentBtn = itemEl.createDiv({
        cls: `db-plan-edit-indent ${row.indent ? "active" : ""}`,
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
        cls: "db-plan-edit-due",
        attr: { type: "text", placeholder: "YYYY-MM-DD", "aria-label": "截止日期" },
      });
      dueInput.value = row.dueDate ?? "";
      dueInput.addEventListener("input", () => {
        const v = dueInput.value.trim();
        row.dueDate = v && moment(v, "YYYY-MM-DD", true).isValid() ? v : undefined;
      });

      // 上移 / 下移（触屏设备无法使用拖拽，用按钮排序）
      const moveUp = itemEl.createDiv({
        cls: "db-plan-edit-move",
        text: "↑",
        attr: { role: "button", "aria-label": "上移任务", tabindex: "0" },
      });
      moveUp.addEventListener("click", () => {
        const i = this.rows.indexOf(row);
        if (i <= 0) return;
        [this.rows[i - 1], this.rows[i]] = [this.rows[i], this.rows[i - 1]];
        renderList();
      });
      const moveDown = itemEl.createDiv({
        cls: "db-plan-edit-move",
        text: "↓",
        attr: { role: "button", "aria-label": "下移任务", tabindex: "0" },
      });
      moveDown.addEventListener("click", () => {
        const i = this.rows.indexOf(row);
        if (i < 0 || i >= this.rows.length - 1) return;
        [this.rows[i + 1], this.rows[i]] = [this.rows[i], this.rows[i + 1]];
        renderList();
      });

      const del = itemEl.createDiv({
        cls: "db-plan-edit-del",
        text: "×",
        attr: { role: "button", "aria-label": "删除任务" },
      });
      del.addEventListener("click", () => {
        this.rows = this.rows.filter(r => r !== row);
        itemEl.remove();
      });
    };

    renderList();

    const addBtn = contentEl.createEl("button", {
      cls: "db-plan-edit-add",
      text: "+ 添加任务",
      attr: { "aria-label": "添加任务" },
    });
    addBtn.addEventListener("click", () => {
      const row: PlanTodoRow = { text: "", done: false, priority: undefined, dueDate: undefined };
      this.rows.push(row);
      renderRow(row);
      listEl.lastElementChild?.querySelector("input")?.focus();
    });

    const btnRow = contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      this.onSave(this.entry.time ? titleInput.value.trim() : "", this.rows);
      this.close();
    });

    activeWindow.setTimeout(() => titleInput.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 计划详情弹窗：点击顶级任务进入 — 写备注、添加/勾选/删除子计划；保存才整块回写 */
class PlanDetailModal extends Modal {
  private todos: TodoItem[];
  private parentIdx: number;

  constructor(
    app: App,
    private plugin: DaybookPlugin,
    private entry: JournalEntry,
    parent: TodoItem,
    private persist: (todos: TodoItem[]) => Promise<void>
  ) {
    super(app);
    // 浅拷贝：取消即丢弃全部改动，只有「保存」才落盘
    this.todos = (entry.todos ?? []).map(t => ({ ...t }));
    this.parentIdx = Math.max(0, this.todos.findIndex(t => t.lineIndex === parent.lineIndex));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-plan-detail-modal");
    contentEl.createEl("h3", { text: "计划详情" });

    const parent = this.todos[this.parentIdx];

    // 任务本体（只读；修改文字仍走「编辑计划」弹窗）
    const head = contentEl.createDiv({ cls: "db-plan-detail-task" });
    if (shouldShowPriorityBadge(parent.priority, this.plugin.settings)) {
      createPriorityBadge(head, parent.priority);
    }
    head.createSpan({ cls: "db-plan-detail-task-text", text: parent.text });
    if (parent.dueDate) {
      const overdue = isTodoOverdue(parent.dueDate);
      head.createSpan({
        cls: `db-plan-detail-due ${overdue ? "overdue" : ""}`,
        text: overdue ? "⚠️过期" : `📅 ${formatTodoDue(parent.dueDate)}`,
      });
    }

    // 备注
    contentEl.createDiv({ cls: "db-plan-detail-label", text: "备注" });
    const noteInput = contentEl.createEl("textarea", {
      cls: "db-plan-detail-note",
      attr: { placeholder: "写点背景、思路、要点…（保存后随任务存储）", "aria-label": "任务备注", rows: "4" },
    });
    noteInput.value = parent.note ?? "";

    // 子计划
    contentEl.createDiv({ cls: "db-plan-detail-label", text: "子计划" });
    const subList = contentEl.createDiv({ cls: "db-plan-detail-subs" });

    /** 顶级任务的连续子任务区间 [start, end) */
    const childRange = () => {
      const start = this.parentIdx + 1;
      let end = start;
      while (end < this.todos.length && this.todos[end].indent) end++;
      return { start, end };
    };

    const renderSubs = () => {
      subList.empty();
      const { start, end } = childRange();
      if (start === end) {
        subList.createDiv({ cls: "db-plan-detail-subs-empty", text: "还没有子计划，在下方输入添加～" });
        return;
      }
      for (let i = start; i < end; i++) {
        const sub = this.todos[i];
        const row = subList.createDiv({ cls: `db-plan-detail-sub ${sub.done ? "done" : ""}` });
        const cb = row.createDiv({
          cls: `db-plan-detail-sub-check ${sub.done ? "checked" : ""}`,
          attr: { role: "checkbox", tabindex: "0", "aria-checked": String(sub.done), "aria-label": sub.done ? "取消完成" : "标记完成" },
        });
        const toggleSub = () => {
          const done = !sub.done;
          if (done) this.plugin.feedback.notify();
          const stamp = moment().format("YYYY-MM-DD HH:mm");
          sub.done = done;
          sub.completedAt = done ? stamp : undefined;
          // 子计划全部完成 → 顶级任务自动完成；有未完成 → 顶级恢复未完成
          const rng = childRange();
          const kids = this.todos.slice(rng.start, rng.end);
          if (kids.length > 0) {
            const all = kids.every(k => k.done);
            parent.done = all;
            parent.completedAt = all ? (parent.completedAt ?? stamp) : undefined;
          }
          renderSubs();
        };
        cb.addEventListener("click", toggleSub);
        cb.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); toggleSub(); }
        });
        row.createSpan({ cls: "db-plan-detail-sub-text", text: sub.text });
        const del = row.createDiv({ cls: "db-plan-detail-sub-del", text: "×", attr: { role: "button", tabindex: "0", "aria-label": "删除子计划" } });
        del.addEventListener("click", () => { this.todos.splice(i, 1); renderSubs(); });
      }
    };
    renderSubs();

    // 添加子计划
    const addRow = contentEl.createDiv({ cls: "db-plan-detail-add-row" });
    const addInput = addRow.createEl("input", {
      cls: "db-plan-detail-add-input",
      attr: { type: "text", placeholder: "输入子计划，回车添加", "aria-label": "添加子计划" },
    });
    const addBtn = addRow.createEl("button", { text: "添加", cls: "db-plan-detail-add-btn" });
    const addSub = () => {
      const t = addInput.value.trim();
      if (!t) return;
      this.todos.splice(childRange().end, 0, {
        text: t,
        done: false,
        lineIndex: -1,
        indent: 1,
        createdAt: moment().format("YYYY-MM-DD HH:mm"),
      });
      addInput.value = "";
      renderSubs();
      addInput.focus();
    };
    addBtn.addEventListener("click", addSub);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.repeat) { e.preventDefault(); addSub(); }
    });

    // 底部按钮
    const btns = contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = btns.createEl("button", { text: "保存", cls: "mod-cta" });
    save.addEventListener("click", () => {
      const note = noteInput.value.replace(/[\r\n\]]+/g, " ").trim();
      parent.note = note || undefined;
      save.disabled = true;
      this.persist(this.todos).then(() => this.close()).catch(() => { save.disabled = false; });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
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
  if (t.note) line += ` [note::${t.note.replace(/[\r\n\]]+/g, " ")}]`;
  return line;
}

/** 格式化截止日期为友好显示 */
function formatTodoDue(dateStr: string): string {
  const due = moment(dateStr).startOf("day");
  const diff = due.diff(moment().startOf("day"), "day");
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff < 0) return `${Math.abs(diff)}天前`;
  if (diff <= 7) return `${diff}天后`;
  return `${due.month() + 1}月${due.date()}日`;
}

/** 判断待办是否过期 */
function isTodoOverdue(dateStr: string): boolean {
  return moment(dateStr).isBefore(moment(), "day");
}

/** 今日某章节的记录流：只读渲染 + 行内操作（勾选/置顶/编辑/归档/删除） */
export class TodayPanel {
  private plugin: DaybookPlugin;
  private container: HTMLElement;
  private listEl: HTMLElement;
  private headEl: HTMLElement | null;
  private liveEditors = new Set<LiveEditor>();
  private busy = false;
  /** 当前筛选条件（由视图注入；生效时结果跨日期） */
  filter: SectionFilter | null = null;
  /** 结果条数回调（供筛选面板显示） */
  onResult: ((count: number, days: number, filtering: boolean) => void) | null = null;
  /** 点击记录上的标签 → 切换该标签到章节筛选（由视图注入；再点一次取消，可叠加多个） */
  onToggleTag: ((tag: string) => void) | null = null;
  /** 计划分组方式（由视图注入，读 reviewState.planGroupBy；"none" = 按计划块原样展示） */
  planGroupBy: (() => PlanGroupMode | "none") | null = null;
  /** 用户切换分组方式 → 视图持久化 */
  onPlanGroupByChange: ((mode: PlanGroupMode | "none") => void) | null = null;
  /** 刷新序号：连续触发刷新（如勾选后多处联动）时，只有最后一次允许落笔，避免重复渲染 */
  private refreshSeq = 0;
  /** 筛选结果分页状态（跨日期筛选模式专用） */
  private pager: {
    dates: string[];        // 全部命中日期（新→旧）
    rendered: number;       // 已渲染日期数
    byDate: Map<string, JournalEntry[]>;
    labels: Map<string, string>;
    observer: IntersectionObserver | null;
  } | null = null;

  constructor(container: HTMLElement, plugin: DaybookPlugin, headEl: HTMLElement | null = null) {
    this.plugin = plugin;
    this.container = container;
    this.headEl = headEl;
    this.listEl = container.createDiv({ cls: "db-today-list" });
  }

  /** 更新「今日记录 / 筛选结果」标题与条数徽标 */
  private setHead(label: string, count: number) {
    if (!this.headEl) return;
    this.headEl.querySelector<HTMLElement>(".db-today-label")?.setText(label);
    this.headEl.querySelector<HTMLElement>(".db-today-count")?.setText(String(count));
  }

  destroy(): void {
    this.destroyEditors();
  }

  private destroyEditors() {
    this.liveEditors.forEach(ed => {
      try { ed.destroy(); } catch { /* ignore */ }
    });
    this.liveEditors.clear();
  }

  /** 重新加载并渲染指定章节的记录（无筛选=今天；有筛选=按条件跨日期查询；计划章节可按优先级/日期分组） */
  async refresh(sectionId: string): Promise<void> {
    this.destroyEditors();
    const seq = ++this.refreshSeq;
    const app = this.plugin.app;
    const today = moment().format("YYYY-MM-DD");
    const filter = this.filter;
    const filtering = !!filter && isFilterActive(filter);
    const section = getAllSections(this.plugin.settings).find(s => s.id === sectionId);
    const groupMode = !filtering && section?.type === "plans" ? (this.planGroupBy?.() ?? "none") : "none";
    let entries: JournalEntry[] = [];
    const labels = new Map<string, string>();
    let allPlanEntries: JournalEntry[] = [];
    try {
      const groups = await readAllJournalEntries(app, this.plugin.settings, new Set([sectionId]));
      if (seq !== this.refreshSeq) return;   // 已有更新的刷新接管渲染，避免重复落笔
      groups.forEach(g => labels.set(g.date, g.dateLabel));
      entries = filtering && filter
        ? groups.flatMap(g => g.entries).filter(e => matchEntry(e, filter, today))
        : (() => {
            const todayEntries = groups.find(g => g.date === today)?.entries ?? [];
            // 默认内容为未归档的；已归档的追加到底部弱化展示，不与正常记录混排
            return [...todayEntries.filter(e => !e.archived), ...todayEntries.filter(e => e.archived)];
          })();
      // 计划分组：跨日期聚合全部计划条目（分组视图只列未完成任务）
      if (groupMode !== "none") {
        allPlanEntries = groups.flatMap(g => g.entries)
          .filter(e => e.renderType === "plans" && !e.archived && (e.todos?.length ?? 0) > 0);
      }
    } catch {
      /* 读取失败时保持空列表 */
    }
    if (seq !== this.refreshSeq || !this.listEl.isConnected) return;

    // 异步读取前先铺骨架屏（仅列表为空的首屏，避免刷新已有内容时闪烁）
    if (this.listEl.children.length === 0) {
      this.listEl.empty();
      const sk = this.listEl.createDiv({ cls: "db-stream-skeleton" });
      for (let i = 0; i < 3; i++) {
        const c = sk.createDiv({ cls: "db-skeleton-card" });
        c.createDiv({ cls: "db-skeleton-bar w40" });
        c.createDiv({ cls: "db-skeleton-bar w85" });
        c.createDiv({ cls: "db-skeleton-bar w60" });
      }
    }

    // ── 计划分组视图：滴答清单式，同组任务合并进一张原样卡片 ──
    if (groupMode !== "none" && section) {
      this.renderGroupedPlans(section, allPlanEntries, groupMode as PlanGroupMode, today);
      return;
    }

    this.listEl.empty();
    this.container.toggleClass("is-empty", entries.length === 0);
    this.setHead(filtering ? "筛选结果" : "今日记录", entries.length);
    // 无筛选且当天没记录时不显示标题行；筛选态即使 0 条也保留，便于看清结果。
    // 宿主被视图整体隐藏时（习惯章节）不接管标题显隐，避免互相打架。
    if (!this.container.hasClass("is-hidden")) {
      this.headEl?.toggleClass("is-hidden", entries.length === 0 && !filtering);
    }
    this.onResult?.(entries.length, new Set(entries.map(e => e.date)).size, filtering);

    if (entries.length === 0) {
      this.listEl.createDiv({
        cls: "db-today-empty",
        text: filtering
          ? "没有符合筛选条件的记录，放宽日期或去掉某个条件试试～"
          : "今天还没有记录，在上方写下第一条～",
      });
      return;
    }
    if (!filtering) {
      // 默认视图：一次渲染全部（今日范围小）。
      // 置顶恒在最上、已归档恒垫底，与「新→旧 / 旧→新」设置无关；
      // 各组内部保持 parse 给出的时间序（旧→新时整组反转）
      const ascending = this.plugin.settings.memoSortOrder === "oldest";
      const pinned = entries.filter(e => e.pinned && !e.archived);
      const normal = entries.filter(e => !e.pinned && !e.archived);
      const archived = entries.filter(e => e.archived);
      if (ascending) { pinned.reverse(); normal.reverse(); }
      const ordered = [...pinned, ...normal, ...archived];

      let archivedDividerShown = false;
      ordered.forEach(entry => {
        if (entry.archived && !archivedDividerShown) {
          archivedDividerShown = true;
          this.listEl.createDiv({ cls: "db-entry-day db-entry-day-archived", text: "📦 已归档" });
        }
        this.renderEntry(entry);
      });
      return;
    }

    // 筛选视图：按日期分桶分页加载（每页 5 组，滚动到底自动加载下一页）
    const dates: string[] = [];
    const byDate = new Map<string, JournalEntry[]>();
    entries.forEach(entry => {
      if (!byDate.has(entry.date)) { byDate.set(entry.date, []); dates.push(entry.date); }
      byDate.get(entry.date)!.push(entry);
    });
    this.disconnectPagerObserver();
    this.pager = { dates, rendered: 0, byDate, labels, observer: null };
    this.appendNextPage();
  }

  /** 追加下一页（每页 5 个日期组）；由哨兵观察器或测试直接调用 */
  private appendNextPage() {
    const pager = this.pager;
    if (!pager || pager.rendered >= pager.dates.length) return;
    const byDate = pager.byDate;
    const labels = pager.labels;
    const PAGE = 5;
    const slice = pager.dates.slice(pager.rendered, pager.rendered + PAGE);
    pager.rendered += slice.length;

    slice.forEach(date => {
      this.listEl.createDiv({ cls: "db-entry-day", text: labels.get(date) ?? date });
      byDate.get(date)?.forEach(entry => this.renderEntry(entry));
    });

    // 移除旧尾标（哨兵/完结提示），重建
    this.listEl.querySelector(".db-stream-tail")?.remove();
    if (pager.rendered < pager.dates.length) {
      const tail = this.listEl.createDiv({ cls: "db-stream-tail" });
      const sentinel = tail.createDiv({ cls: "db-stream-sentinel", text: "加载中…" });
      this.observeSentinel(sentinel, () => {
        tail.remove();
        this.appendNextPage();
      });
    } else {
      this.listEl.createDiv({ cls: "db-stream-tail" })
        .createDiv({ cls: "db-stream-end", text: `共 ${pager.dates.length} 天` });
    }
  }

  /** 哨兵进入视口 → 加载下一页；优先 IntersectionObserver，环境不支持时回退滚动监听 */
  private observeSentinel(sentinel: HTMLElement, onLoad: () => void) {
    const root = this.listEl.closest(".db-journal-root") as HTMLElement | null;
    if (!root) return;
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((obs) => {
        if (obs.some(o => o.isIntersecting)) {
          io.disconnect();
          onLoad();
        }
      }, { root, rootMargin: "120px" });
      io.observe(sentinel);
      if (this.pager) this.pager.observer = io;
    } else {
      const onScroll = () => {
        const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 200;
        if (nearBottom) {
          root.removeEventListener("scroll", onScroll);
          onLoad();
        }
      };
      root.addEventListener("scroll", onScroll, { passive: true });
      if (this.pager) {
        // 借用 observer 字段做清理句柄
        (this.pager as unknown as { observer: unknown }).observer = { disconnect: () => root.removeEventListener("scroll", onScroll) } as unknown as IntersectionObserver;
      }
    }
  }

  private disconnectPagerObserver() {
    try { this.pager?.observer?.disconnect(); } catch { /* ignore */ }
    this.pager = null;
  }

  /**
   * 计划分组视图：按优先级或截止日期把全部未完成任务合并进"原样"的计划卡片。
   * 每组一张卡（组标题 + 计数 + 任务行，行样式与计划卡片内的任务一致）；
   * 勾选走级联写回原文件，完成后从分组中消失。
   */
  private renderGroupedPlans(
    section: SectionConfig,
    allEntries: JournalEntry[],
    mode: PlanGroupMode,
    today: string
  ) {
    const tasks = collectPlanTasks(allEntries);
    const groups = groupPlanTasks(tasks, mode, today);

    this.listEl.empty();
    this.container.toggleClass("is-empty", tasks.length === 0);
    this.setHead("未完成任务", tasks.length);
    if (this.headEl) {
      this.headEl.toggleClass("is-hidden", false);
      // 分组切换（先移除旧 seg，避免重复渲染）
      this.headEl.querySelector(".db-plan-seg")?.remove();
      const seg = this.headEl.createDiv({ cls: "db-plan-seg" });
      ([["priority", "优先级"], ["date", "日期"], ["none", "计划块"]] as [PlanGroupMode | "none", string][])
        .forEach(([m, label]) => {
          const tab = seg.createDiv({
            cls: `db-plan-seg-btn${mode === m ? " active" : ""}`,
            text: label,
            attr: { role: "button", "aria-pressed": String(mode === m) },
          });
          tab.addEventListener("click", () => {
            if (mode === m) return;
            this.onPlanGroupByChange?.(m);
            void this.refresh(section.id);
          });
        });
    }
    this.onResult?.(tasks.length, 0, false);

    if (tasks.length === 0) {
      this.listEl.createDiv({ cls: "db-today-empty", text: "没有未完成的任务，在上方添加一条吧～" });
      return;
    }

    for (const g of groups) {
      if (g.tasks.length === 0) continue;
      const card = this.listEl.createDiv({ cls: "db-entry db-plan-group-card" });
      const head = card.createDiv({ cls: "db-plan-group-head" });
      head.createSpan({ cls: "db-plan-group-label", text: g.label });
      head.createSpan({ cls: "db-plan-group-count", text: String(g.tasks.length) });
      const list = card.createDiv({ cls: "db-entry-todo-list" });
      g.tasks.forEach(({ entry, todo }) => this.renderGroupTodoRow(list, entry, todo, section.id));
    }
  }

  /** 分组卡片内的任务行：样式与计划卡片中的任务一致（勾选级联写回原文件） */
  private renderGroupTodoRow(
    list: HTMLElement,
    entry: JournalEntry,
    todo: TodoItem,
    sectionId: string
  ) {
    const item = list.createDiv({ cls: "db-plan-group-row" });
    const checkbox = item.createDiv({
      cls: "db-entry-checkbox",
      attr: { role: "checkbox", "aria-checked": "false", "aria-label": `完成：${todo.text}` },
    });
    const textEl = item.createDiv({ cls: "db-entry-todo-text" });
    if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
      createPriorityBadge(textEl, todo.priority);
    }
    textEl.createSpan({ text: todo.text });
    if (todo.dueDate) {
      const overdue = isTodoOverdue(todo.dueDate);
      textEl.createSpan({
        cls: `db-entry-due ${overdue ? "overdue" : ""}`,
        text: overdue ? "⚠️过期" : `📅 ${formatTodoDue(todo.dueDate)}`,
      });
    }
    if (todo.note) {
      textEl.createSpan({
        cls: "db-entry-note-flag",
        text: "📝",
        attr: { "aria-label": `备注：${todo.note}` },
      });
    }

    const toggle = async () => {
      try {
        const stamp = moment().format("YYYY-MM-DD HH:mm");
        const updates = buildTodoCascade(entry.todos ?? [todo], todo, true, stamp);
        await setTodoStatesInFile(this.plugin.app, entry.filePath, updates, this.plugin.settings);
        this.plugin.feedback.notify();
        void this.refresh(sectionId);
      } catch (e) {
        new Notice("更新失败，请检查日记文件");
      }
    };
    checkbox.addEventListener("click", () => void toggle());
    textEl.addEventListener("click", () => {
      if (todo.indent) void toggle();
      else this.openPlanDetail(entry, todo);
    });
  }

  /** 单条记录块 */
  private renderEntry(entry: JournalEntry) {
    const card = this.listEl.createDiv({ cls: `db-entry ${entry.pinned ? "pinned" : ""} ${entry.archived ? "archived" : ""}` });

    // 卡片头部：左=置顶标识+日期时间灰字（跨日期筛选时含日期），右=归档标记 + ⋯ 操作
    const head = card.createDiv({ cls: "db-entry-head" });

    // 置顶标识（左上角）：点击直接取消置顶
    if (entry.pinned) {
      const pin = makeActivatable(head.createDiv({
        cls: "db-entry-pin",
        attr: { role: "button", tabindex: "0", "aria-label": "取消置顶", title: "取消置顶" },
      }), "取消置顶");
      setIcon(pin, "pin");
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.togglePinEntry(entry);
      });
      pin.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); void this.togglePinEntry(entry); }
      });
    }

    const timeText = entry.date === moment().format("YYYY-MM-DD")
      ? (entry.time ?? "")
      : `${formatDateLabel(entry.date)}${entry.time ? " " + entry.time : ""}`;
    if (timeText) head.createSpan({ cls: "db-entry-head-time", text: timeText });

    // 归档标记（弱化展示，⋯ 旁）
    if (entry.archived) {
      head.createSpan({ cls: "db-entry-flag archived", text: "📦 已归档", attr: { "aria-label": `归档于 ${entry.archived}` } });
    }

    // 悬浮「⋯」操作按钮（头部右侧）
    const moreBtn = head.createDiv({
      cls: "db-entry-more",
      attr: { role: "button", tabindex: "0", "aria-label": "更多操作" },
    });
    moreBtn.setText("⋯");

    if (entry.renderType === "plans" && entry.todos && entry.todos.length > 0) {
      const title = entry.text.replace(/^\d{2}:\d{2}(?::\d{2})?\s*/, "");
      if (title && title !== entry.sectionLabel) {
        card.createDiv({ cls: "db-entry-title", text: title });
      }
      this.renderTodoCard(card, entry);
    } else {
      const body = card.createDiv({ cls: "db-entry-body" });
      if (entry.text.includes("\n")) body.style.whiteSpace = "pre-wrap";
      void renderMarkdown(this.plugin.app, entry.text, body, {
        sourcePath: entry.filePath,
        component: this.plugin,
        lazyThreshold: 10,
      }).then(() => this.bindImageViewer(body));
    }

    if (entry.tags && entry.tags.length > 0) {
      const row = card.createDiv({ cls: "db-entry-tags" });
      entry.tags.forEach(tag => {
        // 点击标签 = 叠加到当前筛选（再点一次取消）；选中的标签高亮
        const active = this.filter?.tags?.includes(tag) ?? false;
        const chip = row.createSpan({
          cls: `db-entry-tag${active ? " is-active" : ""}`,
          text: `#${tag}`,
          attr: {
            role: "button", tabindex: "0",
            "aria-label": active ? `取消筛选标签 ${tag}` : `筛选标签 ${tag}`,
            "aria-pressed": String(active),
          },
        });
        const toggle = () => this.onToggleTag?.(tag);
        chip.addEventListener("click", toggle);
        chip.addEventListener("keydown", (e: KeyboardEvent) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); toggle(); }
        });
      });
    }

    // ⋯ 操作按钮：键盘可访问 + 弹出菜单
    moreBtn.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); moreBtn.click(); }
    });
    moreBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.showEntryMenu(evt as MouseEvent, card, entry);
    });
  }

  /** 卡片内图片点击放大：渲染完成后绑定（编辑区不绑定） */
  private bindImageViewer(body: HTMLElement) {
    if (!body.isConnected) return;
    body.querySelectorAll("img").forEach(img => {
      img.addClass("db-entry-img");
      img.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openImageViewer((img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src);
      });
    });
  }

  /** 全屏图片查看器：遮罩 + 居中大图，点击任意处关闭 */
  private openImageViewer(src: string) {
    if (!src) return;
    const root = this.container.closest(".db-journal-root") as HTMLElement | null;
    if (!root) return;
    const overlay = root.createDiv({ cls: "db-img-viewer" });
    const img = overlay.createEl("img", { attr: { src } });
    overlay.addEventListener("click", () => overlay.remove());
    // 阻止图片自身拖拽
    img.addEventListener("dragstart", (e) => e.preventDefault());
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
                void this.refresh(entry.type);
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
      void this.refresh(entry.type);
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
      void this.refresh(entry.type);
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
        const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
        const fieldLines = block.filter(l => /^\s*\[(pinned|archived)::.*\]\s*$/.test(l));

        const completedField = getCompletedFieldName(this.plugin.settings);
        const lines: string[] = [];
        lines.push(entry.time ? `- ${entry.time}${title ? ` ${title}` : ""}` : `- ${title || entry.sectionLabel}`);
        rows.forEach(r => {
          const text = r.text.trim();
          if (!text && !r.dueDate) return;
          lines.push(planTaskLine(r as unknown as TodoItem, completedField));
        });

        await replaceLineRange(this.plugin.app, entry.filePath, start, end, [...lines, ...fieldLines]);
        new Notice("✎ 计划已保存");
        void this.refresh(entry.type);
      } catch (e) {
        new Notice("保存失败，请检查日记文件");
      }
    }).open();
  }

  /** 打开计划详情（备注 + 子计划）；保存时按当前任务数组整块回写 */
  private openPlanDetail(entry: JournalEntry, todo: TodoItem) {
    new PlanDetailModal(this.plugin.app, this.plugin, entry, todo, async (todos) => {
      this.busy = true;
      try {
        await this.rewritePlanBlock(entry, todos);
        new Notice("✎ 详情已保存");
        void this.refresh(entry.type);
      } catch (e) {
        new Notice("保存失败，请检查日记文件");
        throw e;
      } finally {
        this.busy = false;
      }
    }).open();
  }

  /** 编辑：记录块切换为内联编辑态 */
  private enterEditMode(card: HTMLElement, entry: JournalEntry) {
    if (card.querySelector(".db-entry-edit")) return;

    Array.from(card.children).forEach(el => {
      const child = el as HTMLElement;
      if (child.hasClass("db-entry-head") || child.hasClass("db-entry-more")) return;
      child.addClass("db-hidden-for-edit");
    });

    const editWrap = card.createDiv({ cls: "db-entry-edit" });
    const sourceAf = this.plugin.app.vault.getAbstractFileByPath(entry.filePath);
    const editor = createLiveEditor(
      this.plugin.app,
      editWrap,
      {
        value: entry.text,
        onEnter: (mod) => {
          if (mod) { saveBtn.click(); return true; }
          return false;
        },
      },
      "",
      sourceAf instanceof TFile ? sourceAf : null
    );
    this.liveEditors.add(editor);

    const actions = editWrap.createDiv({ cls: "db-entry-edit-actions" });
    const cancelBtn = actions.createEl("button", { text: "取消", cls: "db-entry-edit-cancel" });
    const saveBtn = actions.createEl("button", { text: "保存", cls: "db-entry-edit-save mod-cta" });

    cancelBtn.onclick = () => {
      editor.destroy();
      this.liveEditors.delete(editor);
      editWrap.remove();
      Array.from(card.children).forEach(el => (el as HTMLElement).removeClass("db-hidden-for-edit"));
    };

    saveBtn.onclick = async () => {
      const newText = editor.getValue().trim();
      if (!newText) {
        new Notice("内容不能为空～");
        return;
      }
      saveBtn.disabled = true;
      try {
        const start = entry.rawLineIndex ?? 0;
        const end = entry.endLineIndex ?? start;
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
        this.destroyEditors();
        void this.refresh(entry.type);
      } catch (e) {
        new Notice("保存失败，请检查日记文件");
        saveBtn.disabled = false;
      }
    };

    editor.focus();
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

  /** 计划任务列表：勾选父子级联 + 拖拽排序 + 进度条（有子计划按子计划计数） */
  private renderTodoCard(card: HTMLElement, entry: JournalEntry) {
    const todos = entry.todos!;
    let dragFrom: number | null = null;
    let { done: doneCount, total } = planTodoProgress(todos);

    const refs = new Map<number, { todo: TodoItem; checkbox: HTMLElement; textEl: HTMLElement; itemEl: HTMLElement }>();

    let progressText: HTMLElement | null = null;
    let progressFill: HTMLElement | null = null;

    const refreshProgress = () => {
      const p = planTodoProgress(todos);
      doneCount = p.done;
      total = p.total;
      if (progressText) progressText.setText(`${doneCount}/${total}`);
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

    const todoList = card.createDiv({ cls: "db-entry-todo-list" });

    const renderItem = (todo: TodoItem, isSub: boolean) => {
      const item = todoList.createDiv({ cls: `db-entry-todo-item ${todo.done ? "done" : ""} ${isSub ? "sub" : ""}` });

      const checkbox = item.createDiv({
        cls: `db-entry-checkbox ${todo.done ? "checked" : ""}`,
        attr: { role: "checkbox", tabindex: "0", "aria-checked": String(todo.done), "aria-label": todo.done ? "取消完成" : "标记完成" },
      });

      const textEl = item.createDiv({ cls: `db-entry-todo-text ${todo.done ? "done" : ""}` });
      if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
        createPriorityBadge(textEl, todo.priority);
      }
      textEl.createSpan({ text: todo.text });
      if (todo.dueDate) {
        const overdue = isTodoOverdue(todo.dueDate);
        textEl.createSpan({
          cls: `db-entry-due ${overdue ? "overdue" : ""}`,
          text: overdue ? "⚠️过期" : `📅 ${formatTodoDue(todo.dueDate)}`,
        });
      }
      appendTodoCompletionInfo(textEl, todo, this.plugin.settings, true);
      // 备注徽标：有备注时给个小标记，悬停可见内容
      if (todo.note) {
        textEl.createSpan({
          cls: "db-entry-note-flag",
          text: "\u{1F4DD}",
          attr: { "aria-label": `备注：${todo.note}`, "data-tooltip-text": todo.note, "data-tooltip-position": "top" },
        });
      }

      refs.set(todo.lineIndex, { todo, checkbox, textEl, itemEl: item });

      // 拖拽调整任务顺序/层级
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
        todoList.querySelectorAll(".db-entry-todo-item").forEach(el => el.removeClass("drop-before", "drop-after", "dragging"));
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
        if (from === null || from === todo.lineIndex || this.busy) return;
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        const fromIdx = todos.findIndex(t => t.lineIndex === from);
        const targetIdx = todos.indexOf(todo);
        if (fromIdx === -1 || targetIdx === -1) return;
        const asChild = !todo.indent && lower;
        moveTodoSubtree(todos, fromIdx, targetIdx, asChild, lower && !asChild);
        this.busy = true;
        try {
          await this.rewritePlanBlock(entry, todos);
          void this.refresh(entry.type);
        } catch (err) {
          new Notice("排序保存失败，请检查日记文件");
        } finally {
          this.busy = false;
        }
      });

      // 勾选（父子级联）
      const toggle = async () => {
        if (this.busy) return;
        this.busy = true;
        const newDone = !todo.done;
        const stamp = moment().format("YYYY-MM-DD HH:mm");
        if (newDone) this.plugin.feedback.notify();
        try {
          const updates = buildTodoCascade(todos, todo, newDone, stamp);
          await setTodoStatesInFile(this.plugin.app, entry.filePath, updates, this.plugin.settings);
          updates.forEach(u => {
            const t = todos.find(x => x.lineIndex === u.lineIndex);
            if (!t) return;
            t.done = u.done;
            t.completedAt = u.done ? (u.completedAt ?? stamp) : undefined;
            refreshRow(t);
          });
          refreshProgress();
        } catch (e) {
          new Notice("同步失败，请检查日记文件");
        } finally {
          this.busy = false;
        }
      };

      checkbox.addEventListener("click", toggle);
      checkbox.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); void toggle(); }
      });
      // 点击文字：顶级任务 → 计划详情（备注/子计划）；子任务 → 直接勾选
      if (isSub) {
        textEl.addEventListener("click", () => { void toggle(); });
      } else {
        textEl.addClass("clickable");
        textEl.setAttribute("role", "button");
        textEl.setAttribute("tabindex", "0");
        textEl.setAttribute("aria-label", "打开计划详情：备注与子计划");
        textEl.addEventListener("click", () => this.openPlanDetail(entry, todo));
        textEl.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); this.openPlanDetail(entry, todo); }
        });
      }
    };

    todos.forEach(t => renderItem(t, !!t.indent));

    if (total > 0) {
      const progress = card.createDiv({ cls: "db-entry-progress" });
      progressText = progress.createSpan({ cls: "db-entry-progress-text", text: `${doneCount}/${total}` });
      const bar = progress.createDiv({ cls: "db-entry-progress-bar" });
      progressFill = bar.createDiv({ cls: "db-entry-progress-fill" });
      progressFill.style.width = `${Math.round((doneCount / total) * 100)}%`;
    }
  }
}
