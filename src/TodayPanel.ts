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
} from "obsidian";
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
  PRIORITY_META,
  PRIORITY_EMOJI,
  type PriorityLevel,
  type JournalEntry,
  type TodoItem,
} from "./fileReader";
import { getAllSections } from "./settings";
import { parseExpenseText, formatMoney } from "./expenseManager";
import { isFilterActive, matchEntry, type SectionFilter } from "./filters";

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

  /** 重新加载并渲染指定章节的记录（无筛选=今天；有筛选=按条件跨日期查询） */
  async refresh(sectionId: string): Promise<void> {
    this.destroyEditors();
    const app = this.plugin.app;
    const today = moment().format("YYYY-MM-DD");
    const filter = this.filter;
    const filtering = !!filter && isFilterActive(filter);
    let entries: JournalEntry[] = [];
    const labels = new Map<string, string>();
    try {
      const groups = await readAllJournalEntries(app, this.plugin.settings, new Set([sectionId]));
      groups.forEach(g => labels.set(g.date, g.dateLabel));
      entries = filtering && filter
        ? groups.flatMap(g => g.entries).filter(e => matchEntry(e, filter, today))
        : groups.find(g => g.date === today)?.entries ?? [];
    } catch {
      /* 读取失败时保持空列表 */
    }
    if (!this.listEl.isConnected) return;

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
    const section = getAllSections(this.plugin.settings).find(s => s.id === sectionId);
    if (section?.type === "expenses") this.renderExpenseSummary(entries, filtering);
    let lastDate = "";
    entries.forEach(entry => {
      if (filtering && entry.date !== lastDate) {
        lastDate = entry.date;
        this.listEl.createDiv({ cls: "db-entry-day", text: labels.get(entry.date) ?? entry.date });
      }
      this.renderEntry(entry);
    });
  }

  /** 记账章节顶部：支出/收入合计（筛选态为结果区间合计） */
  private renderExpenseSummary(entries: JournalEntry[], filtering: boolean) {
    let expense = 0;
    let income = 0;
    entries.forEach(e => {
      const p = parseExpenseText(e.text);
      if (!p) return;
      if (p.amount < 0) expense += -p.amount;
      else income += p.amount;
    });
    const bar = this.listEl.createDiv({ cls: "db-expense-summary" });
    const item = (label: string, value: number, cls: string) => {
      const cell = bar.createDiv({ cls: `db-expense-summary-item ${cls}` });
      cell.createSpan({ cls: "db-expense-summary-label", text: label });
      cell.createSpan({ cls: "db-expense-summary-value", text: value > 0 ? `¥${formatMoney(value)}` : "—" });
    };
    item(filtering ? "筛选支出" : "今日支出", expense, "expense");
    item(filtering ? "筛选收入" : "今日收入", income, "income");
  }

  /** 单条记录块 */
  private renderEntry(entry: JournalEntry) {
    const card = this.listEl.createDiv({ cls: `db-entry ${entry.pinned ? "pinned" : ""} ${entry.archived ? "archived" : ""}` });

    // 元信息行：时间 + 置顶/归档标记
    const meta = card.createDiv({ cls: "db-entry-meta" });
    if (entry.time) meta.createSpan({ cls: "db-entry-time", text: entry.time });
    if (entry.pinned) meta.createSpan({ cls: "db-entry-flag", text: "📌", attr: { "aria-label": "已置顶" } });
    if (entry.archived) meta.createSpan({ cls: "db-entry-flag archived", text: "📦 已归档", attr: { "aria-label": `归档于 ${entry.archived}` } });

    if (entry.renderType === "plans" && entry.todos && entry.todos.length > 0) {
      const title = entry.text.replace(/^\d{2}:\d{2}(?::\d{2})?\s*/, "");
      if (title && title !== entry.sectionLabel) {
        card.createDiv({ cls: "db-entry-title", text: title });
      }
      this.renderTodoCard(card, entry);
    } else if (entry.renderType === "expenses" && parseExpenseText(entry.text)) {
      this.renderExpenseEntry(card, parseExpenseText(entry.text)!);
    } else {
      const body = card.createDiv({ cls: "db-entry-body" });
      if (entry.text.includes("\n")) body.style.whiteSpace = "pre-wrap";
      void renderMarkdown(this.plugin.app, entry.text, body, {
        sourcePath: entry.filePath,
        component: this.plugin,
        lazyThreshold: 10,
      });
    }

    if (entry.tags && entry.tags.length > 0) {
      const row = card.createDiv({ cls: "db-entry-tags" });
      entry.tags.forEach(tag => row.createSpan({ cls: "db-entry-tag", text: `#${tag}` }));
    }

    // 悬浮「⋯」操作按钮
    const moreBtn = card.createDiv({
      cls: "db-entry-more",
      text: "⋯",
      attr: { role: "button", tabindex: "0", "aria-label": "更多操作" },
    });
    moreBtn.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); moreBtn.click(); }
    });
    moreBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.showEntryMenu(evt as MouseEvent, card, entry);
    });
  }

  /** 记账记录行：金额（支出红/收入绿） + 分类徽标 + 备注 */
  private renderExpenseEntry(card: HTMLElement, p: { amount: number; category?: string; note: string }) {
    const body = card.createDiv({ cls: "db-entry-body db-expense-entry" });
    const isExpense = p.amount < 0;
    body.createSpan({
      cls: `db-expense-amount ${isExpense ? "expense" : "income"}`,
      text: `${isExpense ? "−" : "+"}¥${formatMoney(p.amount)}`,
    });
    if (p.category) body.createSpan({ cls: "db-expense-cat-chip", text: p.category });
    if (p.note) body.createSpan({ cls: "db-expense-entry-note", text: p.note });
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
    } else if (entry.renderType !== "expenses") {
      // 记账条目含行内字段（[amt::]/[cat::]），不提供内联编辑，改金额可删除后重记
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

  /** 编辑：记录块切换为内联编辑态 */
  private enterEditMode(card: HTMLElement, entry: JournalEntry) {
    if (card.querySelector(".db-entry-edit")) return;

    Array.from(card.children).forEach(el => {
      const child = el as HTMLElement;
      if (child.hasClass("db-entry-meta") || child.hasClass("db-entry-more")) return;
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

  /** 计划任务列表：勾选父子级联 + 拖拽排序 + 进度条 */
  private renderTodoCard(card: HTMLElement, entry: JournalEntry) {
    const todos = entry.todos!;
    const total = todos.length;
    let dragFrom: number | null = null;
    let doneCount = todos.filter(t => t.done).length;

    const refs = new Map<number, { todo: TodoItem; checkbox: HTMLElement; textEl: HTMLElement; itemEl: HTMLElement }>();

    let progressText: HTMLElement | null = null;
    let progressFill: HTMLElement | null = null;

    const refreshProgress = () => {
      doneCount = todos.filter(t => t.done).length;
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
      textEl.addEventListener("click", toggle);
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
