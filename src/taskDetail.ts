/**
 * taskDetail.ts — 任务详情页（TickTick 风格全屏页）
 *
 * 由计划列表 / 卡片点击任务文字、或操作菜单「编辑」打开。
 * 顶栏：左上收缩（关闭）、右上「更多」→ 弹层（置顶 / 放弃 / 删除 + 添加子任务 / 复制链接）。
 * 正文：① 勾选框 + 截止日期（三态：正常 / 未设日期显示日历 / 逾期红色） ② 标题 ③ 子任务（拖拽排序）
 *      ④ 描述（实时编辑器，位于子任务下方）。底栏左下：标签 / 图片 / 录音。
 *
 * 直接提交：勾选、增删子任务、拖拽、改日期、标题/描述失焦、置顶/放弃均即时落盘；
 * 每次提交后由宿主（TodayPanel）重写整块并重取最新条目（父任务行号稳定，用作身份锚点）。
 */
import { Modal, Notice, TFile, moment, setIcon, type App } from "obsidian";
import { makeActivatable } from "./JournalView";
import type DaybookPlugin from "./main";
import { createLiveEditor, type LiveEditor } from "./liveEditor";
import { openDateSelect } from "./dateSelect";
import {
  genBlockId,
  isTodoOverdue,
  createPriorityBadge,
  effectivePriority,
  PRIORITY_META,
  type PriorityLevel,
  type JournalEntry,
  type TodoItem,
} from "./fileReader";

/** 宿主注入的落盘 / 删除回调 */
export interface TaskDetailHost {
  /** 把 todos 写回 entry 对应块，刷新背景列表，返回重取后的最新条目（失败返回 null） */
  applyChange: (entry: JournalEntry, todos: TodoItem[]) => Promise<JournalEntry | null>;
  /** 请求删除整条（宿主负责确认 + 删除 + 关闭本弹窗 + 刷新） */
  requestDelete: (entry: JournalEntry) => void;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 复制文本到剪贴板（优先 Clipboard API，失败降级 execCommand） */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降级 */ }
  try {
    const ta = activeDocument.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    activeDocument.body.appendChild(ta);
    ta.select();
    const ok = activeDocument.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 按顺序尝试图标名，取第一个真正渲染出 svg 的。
 * Obsidian 内置图标集随版本增删（lucide 重命名等），未知名字只会静默留空，
 * 因此对不常用的名字给出等价备选，保证按钮永远有图形。
 */
function setAnyIcon(el: HTMLElement, names: string[]): void {
  for (const name of names) {
    setIcon(el, name);
    if (el.querySelector("svg")) return;
  }
}

export class TaskDetailModal extends Modal {
  private entry: JournalEntry;
  private todos: TodoItem[];
  private busy = false;

  // 常驻元素（onOpen 建一次，render 只更新内容，避免重建描述编辑器）
  private headerRow!: HTMLElement;
  private taskTitleEl!: HTMLInputElement;
  private subsWrap!: HTMLElement;
  private addInput!: HTMLInputElement;
  private descWrap!: HTMLElement;
  private descEditor!: LiveEditor;
  private sheet!: HTMLElement;
  private scrim!: HTMLElement;
  // 优先级弹出层（挂在标题行里，renderHeaderRow 每次重建，先摘掉文档级关闭监听）
  private priPop: HTMLElement | null = null;
  private priDocClose: (() => void) | null = null;

  // 录音
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private isRecording = false;

  constructor(app: App, private plugin: DaybookPlugin, entry: JournalEntry, private host: TaskDetailHost) {
    super(app);
    this.entry = entry;
    this.todos = entry.todos ?? [];
  }

  /** 父任务的子任务数组（todos 中紧跟父任务、indent 为真的连续若干条） */
  private childTodos(): TodoItem[] {
    const out: TodoItem[] = [];
    for (let i = 1; i < this.todos.length && this.todos[i].indent; i++) out.push(this.todos[i]);
    return out;
  }

  private hasTag(tag: string): boolean {
    return new RegExp(`(^|\\s)#${tag}(?=\\s|$)`).test(this.todos[0]?.text ?? "");
  }

  onOpen(): void {
    this.modalEl.addClass("db-task-detail-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-task-detail");

    // ── 顶栏 ──
    const head = contentEl.createDiv({ cls: "db-td-head" });
    const closeBtn = head.createDiv({
      cls: "db-td-head-btn db-td-close",
      attr: { role: "button", tabindex: "0", "aria-label": "关闭", title: "关闭" },
    });
    setIcon(closeBtn, "chevron-down");
    closeBtn.addEventListener("click", () => this.close());

    head.createDiv({ cls: "db-td-head-title", text: this.entry.sectionLabel || "任务" });

    const moreBtn = head.createDiv({
      cls: "db-td-head-btn db-td-more",
      attr: { role: "button", tabindex: "0", "aria-label": "更多", title: "更多" },
    });
    setIcon(moreBtn, "more-vertical");
    moreBtn.addEventListener("click", (e) => { e.stopPropagation(); this.toggleSheet(); });

    // ── 更多弹层（第二层）──
    this.scrim = contentEl.createDiv({ cls: "db-td-scrim" });
    this.scrim.addEventListener("click", () => this.closeSheet());
    this.sheet = contentEl.createDiv({ cls: "db-td-sheet" });
    const iconRow = this.sheet.createDiv({ cls: "db-td-sheet-icons" });
    this.sheetIcon(iconRow, "pin", "置顶", "td-pin", () => { this.toggleStateTag("pinned"); this.closeSheet(); });
    this.sheetIcon(iconRow, ["circle-slash", "circle-off", "x"], "放弃", "td-abandon", () => { this.toggleStateTag("abandoned"); this.closeSheet(); });
    this.sheetIcon(iconRow, "trash-2", "删除", "td-delete", () => { this.closeSheet(); this.host.requestDelete(this.entry); this.close(); });
    const listRow = this.sheet.createDiv({ cls: "db-td-sheet-list" });
    this.sheetRow(listRow, ["list-plus", "list", "plus"], "添加子任务", () => { this.closeSheet(); this.addInput.focus(); });
    this.sheetRow(listRow, "link", "复制链接", () => { this.closeSheet(); void this.copyLink(); });

    // ── 正文 ──
    const body = contentEl.createDiv({ cls: "db-td-body" });
    this.headerRow = body.createDiv({ cls: "db-td-hrow" });

    this.taskTitleEl = body.createEl("input", {
      cls: "db-td-title",
      attr: { type: "text", placeholder: "任务内容", "aria-label": "任务内容" },
    });
    this.taskTitleEl.addEventListener("blur", () => this.commitTitle());
    this.taskTitleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.taskTitleEl.blur(); }
    });

    body.createDiv({ cls: "db-td-label", text: "子任务" });
    this.subsWrap = body.createDiv({ cls: "db-td-subs" });
    const addRow = body.createDiv({ cls: "db-td-sub-add" });
    this.addInput = addRow.createEl("input", {
      cls: "db-td-sub-add-input",
      attr: { type: "text", placeholder: "添加子任务，回车确认", "aria-label": "添加子任务" },
    });
    const addSub = () => {
      const t = this.addInput.value.trim();
      if (!t) return;
      this.addSubtask(t);
      this.addInput.value = "";
    };
    this.addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.repeat) { e.preventDefault(); addSub(); }
    });
    addRow.createEl("button", { text: "添加", cls: "db-td-sub-add-btn" }).addEventListener("click", addSub);

    body.createDiv({ cls: "db-td-label", text: "描述" });
    this.descWrap = body.createDiv({ cls: "db-td-desc" });
    const sourceFile = this.app.vault.getAbstractFileByPath(this.entry.filePath);
    this.descEditor = createLiveEditor(
      this.app,
      this.descWrap,
      {
        placeholder: "补充背景、要点，或插入图片 / 录音…",
        onPasteFiles: (files) => { void this.saveImages(files); },
        onBlur: () => this.commitDesc(),
      },
      "db-td-desc-editor",
      sourceFile instanceof TFile ? sourceFile : null
    );
    this.descEditor.setValue(this.todos[0]?.desc ?? this.todos[0]?.note ?? "");

    // ── 底栏：标签 / 图片 / 录音 ──
    const foot = contentEl.createDiv({ cls: "db-td-foot" });
    const footBtn = (icon: string, label: string, cls: string, fn: () => void) => {
      const b = foot.createDiv({ cls: `db-td-foot-btn ${cls}`, attr: { role: "button", tabindex: "0", "aria-label": label, title: label } });
      setIcon(b, icon);
      b.addEventListener("click", fn);
      return b;
    };
    footBtn("tag", "添加标签", "td-tag", () => {
      // 标签写在父任务文本里：把光标移到标题末尾并补一个 #，直接键入标签名
      this.taskTitleEl.focus();
      const cur = this.taskTitleEl.value;
      this.taskTitleEl.value = /\s$/.test(cur) || cur.length === 0 ? `${cur}#` : `${cur} #`;
      this.taskTitleEl.setSelectionRange(this.taskTitleEl.value.length, this.taskTitleEl.value.length);
    });
    const imgInput = foot.createEl("input", { cls: "db-td-img-input", attr: { type: "file", accept: "image/*", multiple: "true" } });
    imgInput.style.display = "none";
    imgInput.addEventListener("change", () => {
      const files = Array.from(imgInput.files ?? []);
      if (files.length) void this.saveImages(files);
      imgInput.value = "";
    });
    footBtn("image", "插入图片", "td-image", () => imgInput.click());
    const micBtn = footBtn("mic", "录音", "td-mic", () => { void this.toggleRecord(micBtn); });

    this.render();
  }

  onClose(): void {
    this.closePriorityPopover();
    try { this.descEditor?.destroy(); } catch { /* ignore */ }
    if (this.isRecording) { try { this.mediaRecorder?.stop(); } catch { /* ignore */ } }
    this.contentEl.empty();
  }

  /* ── 更多弹层 ── */
  private toggleSheet(): void {
    const open = this.sheet.hasClass("is-open");
    if (open) this.closeSheet();
    else {
      this.updateSheetState();
      this.sheet.addClass("is-open");
      this.scrim.addClass("is-open");
    }
  }
  private closeSheet(): void {
    this.sheet.removeClass("is-open");
    this.scrim.removeClass("is-open");
  }
  private sheetIcon(parent: HTMLElement, icon: string | string[], label: string, cls: string, fn: () => void): HTMLElement {
    const wrap = parent.createDiv({ cls: `db-td-sheet-icon ${cls}`, attr: { role: "button", tabindex: "0", "aria-label": label, title: label } });
    const ic = wrap.createDiv({ cls: "db-td-sheet-icon-glyph" });
    setAnyIcon(ic, Array.isArray(icon) ? icon : [icon]);
    wrap.createDiv({ cls: "db-td-sheet-icon-label", text: label });
    wrap.addEventListener("click", fn);
    return wrap;
  }
  private sheetRow(parent: HTMLElement, icon: string | string[], label: string, fn: () => void): void {
    const row = parent.createDiv({ cls: "db-td-sheet-row", attr: { role: "button", tabindex: "0", "aria-label": label } });
    const ic = row.createDiv({ cls: "db-td-sheet-row-icon" });
    setAnyIcon(ic, Array.isArray(icon) ? icon : [icon]);
    row.createDiv({ cls: "db-td-sheet-row-label", text: label });
    row.addEventListener("click", fn);
  }
  private updateSheetState(): void {
    this.sheet.querySelector(".td-pin")?.toggleClass("is-active", !!this.entry.pinned);
    this.sheet.querySelector(".td-pin .db-td-sheet-icon-label")?.setText(this.entry.pinned ? "取消置顶" : "置顶");
    this.sheet.querySelector(".td-abandon")?.toggleClass("is-active", !!this.entry.abandoned);
    this.sheet.querySelector(".td-abandon .db-td-sheet-icon-label")?.setText(this.entry.abandoned ? "恢复" : "放弃");
  }

  /* ── 渲染 ── */
  private render(): void {
    this.renderHeaderRow();
    if (activeDocument.activeElement !== this.taskTitleEl) this.taskTitleEl.value = this.todos[0]?.text ?? "";
    this.renderSubs();
    const descVal = this.todos[0]?.desc ?? "";
    if (this.descEditor.getValue() !== descVal && activeDocument.activeElement !== this.descEditor.el) {
      this.descEditor.setValue(descVal);
    }
  }

  private renderHeaderRow(): void {
    this.headerRow.empty();
    this.closePriorityPopover();
    const parent = this.todos[0];
    const kids = this.childTodos();

    const chk = this.headerRow.createDiv({
      cls: `db-td-check${parent.done ? " checked" : ""}${kids.length ? " has-kids" : ""}`,
      attr: { role: "checkbox", tabindex: "0", "aria-checked": String(parent.done), "aria-label": parent.done ? "取消完成" : "标记完成" },
    });
    if (kids.length && !parent.done) setIcon(chk, "list");
    const toggleParent = () => void this.toggleTodo(parent);
    chk.addEventListener("click", toggleParent);
    makeActivatable(chk);

    const due = this.headerRow.createDiv({ cls: "db-td-due", attr: { role: "button", tabindex: "0" } });
    if (parent.dueDate && moment(parent.dueDate, "YYYY-MM-DD", true).isValid()) {
      const overdue = isTodoOverdue(parent.dueDate);
      const m = moment(parent.dueDate);
      due.addClass(overdue ? "is-overdue" : "is-set");
      due.setAttribute("aria-label", `截止日期 ${parent.dueDate}${overdue ? "（已逾期）" : ""}，点击修改`);
      due.createSpan({ cls: "db-td-due-wd", text: WEEKDAYS[m.day()] });
      due.createSpan({ cls: "db-td-due-date", text: `${m.year()}年${m.month() + 1}月${m.date()}日` });
      if (overdue) due.createSpan({ cls: "db-td-due-flag", text: "已逾期" });
    } else {
      due.addClass("is-empty");
      due.setAttribute("aria-label", "设置截止日期");
      const ic = due.createDiv({ cls: "db-td-due-cal" });
      setIcon(ic, "calendar");
      due.createSpan({ cls: "db-td-due-date", text: "设置截止日期" });
    }
    const pickDue = () => {
      openDateSelect(this.app, {
        value: parent.dueDate,
        onPick: (d) => { parent.dueDate = d ?? undefined; void this.commit(); },
      });
    };
    due.addEventListener("click", pickDue);
    makeActivatable(due);

    this.renderPriorityControl(parent);
  }

  /**
   * 优先级：色块徽标 + 罗马数字的小胶囊，点开四级弹出层（与输入条同一套类名）。
   * 选中即落盘（详情页的直接提交风格），弹出层随本次提交的重渲染一起关闭。
   */
  private renderPriorityControl(parent: TodoItem): void {
    const meta = PRIORITY_META[effectivePriority(parent.priority)];
    const btn = this.headerRow.createDiv({
      cls: `db-td-pri${parent.priority ? ` priority-${parent.priority}` : ""}`,
      attr: {
        role: "button", tabindex: "0", "aria-haspopup": "true", title: "优先级",
        "aria-label": `优先级：${meta.label}，点击修改`,
      },
    });
    createPriorityBadge(btn, parent.priority);
    btn.createSpan({ cls: "db-td-pri-label", text: meta.label });

    const pop = this.headerRow.createDiv({ cls: "db-priority-popover db-td-pri-popover" });
    pop.style.display = "none";
    this.priPop = pop;
    (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => {
      const opt = pop.createDiv({ cls: `db-priority-option level-${lv}` });
      createPriorityBadge(opt, lv);
      opt.createSpan({ text: `${lv} ${PRIORITY_META[lv].label}` });
      if (effectivePriority(parent.priority) === lv) opt.addClass("active");
      opt.addEventListener("click", () => {
        this.closePriorityPopover();
        parent.priority = lv;
        void this.commit();
      });
    });
    const clearOpt = pop.createDiv({ cls: "db-priority-option clear" });
    clearOpt.createSpan({ text: "\u{274C}" });
    clearOpt.createSpan({ text: "恢复默认（2 重要不紧急）" });
    if (!parent.priority) clearOpt.addClass("active");
    clearOpt.addEventListener("click", () => {
      this.closePriorityPopover();
      parent.priority = undefined;
      void this.commit();
    });

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pop.style.display === "none") {
        pop.style.display = "block";
        btn.addClass("open");
        // 点别处收起：延后挂监听，避免这次点击立刻把自己关掉
        const handler = () => this.closePriorityPopover();
        this.priDocClose = handler;
        activeWindow.setTimeout(() => activeDocument.addEventListener("click", handler), 0);
      } else this.closePriorityPopover();
    });
    pop.addEventListener("click", (e) => e.stopPropagation());
    makeActivatable(btn);
  }

  private closePriorityPopover(): void {
    if (this.priDocClose) {
      activeDocument.removeEventListener("click", this.priDocClose);
      this.priDocClose = null;
    }
    if (this.priPop) {
      this.priPop.style.display = "none";
      this.priPop = null;
    }
    this.headerRow?.querySelector(".db-td-pri")?.removeClass("open");
  }

  private renderSubs(): void {
    this.subsWrap.empty();
    const kids = this.childTodos();
    kids.forEach((kid) => {
      const row = this.subsWrap.createDiv({ cls: `db-td-sub${kid.done ? " done" : ""}` });

      const check = row.createDiv({
        cls: `db-td-sub-check${kid.done ? " checked" : ""}`,
        attr: { role: "checkbox", tabindex: "0", "aria-checked": String(kid.done), "aria-label": kid.done ? "取消完成" : "标记完成" },
      });
      check.addEventListener("click", () => void this.toggleTodo(kid));
      makeActivatable(check);

      const text = row.createEl("input", {
        cls: "db-td-sub-text",
        attr: { type: "text", "aria-label": "子任务内容" },
      });
      text.value = kid.text;
      text.addEventListener("blur", () => {
        const v = text.value.trim();
        if (!v) { if (kid.text) this.removeSubtask(kid); return; }  // 清空 = 删除该子任务
        if (v !== kid.text) { kid.text = v; void this.commit(); }
      });
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.repeat) { e.preventDefault(); text.blur(); }
      });

      const handle = row.createDiv({ cls: "db-td-sub-handle", attr: { role: "button", tabindex: "-1", "aria-label": "拖动排序" } });
      setIcon(handle, "grip-vertical");
      this.bindSubDrag(handle, row);
    });
  }

  /* ── 交互：勾选级联（内存计算后整体落盘） ── */
  private toggleTodo(todo: TodoItem): Promise<void> | void {
    if (this.busy) return;
    const newDone = !todo.done;
    const stamp = moment().format("YYYY-MM-DD HH:mm");
    const setDone = (t: TodoItem, done: boolean) => {
      t.done = done;
      t.completedAt = done ? (t.completedAt ?? stamp) : undefined;
    };
    const idx = this.todos.indexOf(todo);
    if (!todo.indent) {
      setDone(todo, newDone);
      for (let i = idx + 1; i < this.todos.length && this.todos[i].indent; i++) setDone(this.todos[i], newDone);
    } else {
      setDone(todo, newDone);
      let p = idx - 1;
      while (p >= 0 && this.todos[p].indent) p--;
      if (p >= 0) {
        const kids: TodoItem[] = [];
        for (let i = p + 1; i < this.todos.length && this.todos[i].indent; i++) kids.push(this.todos[i]);
        const all = kids.every(k => k.done);
        const par = this.todos[p];
        if (all && !par.done) setDone(par, true);
        else if (!all && par.done) { par.done = false; par.completedAt = undefined; }
      }
    }
    if (newDone) this.plugin.feedback.notify();
    return this.commit();
  }

  private addSubtask(text: string): void {
    let end = 1;
    while (end < this.todos.length && this.todos[end].indent) end++;
    const parentWs = this.todos[0].ws ?? (this.todos[0].indent ? 4 : 0);
    this.todos.splice(end, 0, {
      text, done: false, lineIndex: -1, indent: 1, ws: parentWs + 4,
      createdAt: moment().format("YYYY-MM-DD HH:mm"),
    });
    void this.commit();
  }

  private removeSubtask(kid: TodoItem): void {
    const i = this.todos.indexOf(kid);
    if (i <= 0) return;   // 只删子任务，父任务由「更多 → 删除」负责
    this.todos.splice(i, 1);
    void this.commit();
  }

  private reorderKids(from: number, to: number): void {
    const kids = this.childTodos();
    if (from === to || from < 0 || to < 0 || from >= kids.length || to >= kids.length) return;
    const [moved] = kids.splice(from, 1);
    kids.splice(to, 0, moved);
    this.todos = [this.todos[0], ...kids];
    void this.commit();
  }

  private commitTitle(): void {
    const v = this.taskTitleEl.value.trim();
    if (!v) { this.taskTitleEl.value = this.todos[0].text; return; }
    if (v === this.todos[0].text) return;
    this.todos[0].text = v;
    void this.commit();
  }

  private commitDesc(): void {
    const v = this.descEditor.getValue().replace(/\s+$/, "");
    if (v === (this.todos[0].desc ?? "")) return;
    this.todos[0].desc = v || undefined;
    this.todos[0].note = undefined;   // 迁移：描述统一走内容行，清除旧行内备注
    void this.commit();
  }

  private toggleStateTag(tag: "pinned" | "abandoned"): void {
    const parent = this.todos[0];
    const re = new RegExp(`(^|\\s)#${tag}(?=\\s|$)`, "g");
    parent.text = this.hasTag(tag)
      ? parent.text.replace(re, "$1").replace(/\s{2,}/g, " ").trim()
      : `${parent.text} #${tag}`.trim();
    void this.commit();
  }

  private async copyLink(): Promise<void> {
    const parent = this.todos[0];
    if (!parent.blockId) {
      parent.blockId = genBlockId();
      await this.commit();
    }
    const id = parent.blockId;
    const path = this.entry.filePath.replace(/\.md$/, "");
    const link = `[[${path}#^${id}]]`;
    const ok = await copyToClipboard(link);
    new Notice(ok ? `⧉ 已复制链接：${link}` : "复制失败");
  }

  /** 写回文件 + 刷新背景 + 重取最新条目并刷新自身 */
  private async commit(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const fresh = await this.host.applyChange(this.entry, this.todos);
      if (fresh) {
        this.entry = fresh;
        this.todos = fresh.todos ?? this.todos;
      }
      this.render();
    } catch (e) {
      new Notice("保存失败，请检查日记文件");
    } finally {
      this.busy = false;
    }
  }

  /* ── 子任务拖拽排序（pointer 事件，桌面 + 触屏通用） ── */
  private bindSubDrag(handle: HTMLElement, row: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if ((pe.button ?? 0) !== 0) return;
      pe.preventDefault();
      const startY = pe.clientY;
      const rows = () => Array.from(this.subsWrap.querySelectorAll<HTMLElement>(".db-td-sub"));
      const from = rows().indexOf(row);
      row.addClass("dragging");
      let lastX = pe.clientX;
      let lastY = pe.clientY;
      try { handle.setPointerCapture(pe.pointerId); } catch { /* ignore */ }

      const onMove = (ev: PointerEvent) => {
        lastX = ev.clientX; lastY = ev.clientY;
        row.style.transform = `translateY(${ev.clientY - startY}px)`;
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        row.style.transform = "";
        row.removeClass("dragging");
        // 让被拖行在命中测试时不可见，取指针下的真实目标行
        row.style.visibility = "hidden";
        const under = activeDocument.elementFromPoint(lastX, lastY) as HTMLElement | null;
        row.style.visibility = "";
        const target = under?.closest?.(".db-td-sub") as HTMLElement | null;
        const to = target ? rows().indexOf(target) : -1;
        if (to >= 0 && to !== from) this.reorderKids(from, to);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  /* ── 媒体：图片 / 录音插入描述 ── */
  private mediaDir(): string {
    const p = this.entry.filePath;
    return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }
  private async saveImages(files: File[]): Promise<void> {
    for (const f of files) {
      try {
        const ext = (f.name.split(".").pop() || "png").toLowerCase();
        const name = `db-img-${this.stamp()}.${ext}`;
        const buf = new Uint8Array(await f.arrayBuffer());
        await this.app.vault.createBinary(`${this.mediaDir()}/${name}`, buf);
        this.insertIntoDesc(`![[${name}]]`);
      } catch {
        new Notice("图片保存失败，请检查日记目录");
      }
    }
  }
  private insertIntoDesc(embed: string): void {
    this.descEditor.focus();
    this.descEditor.insertAtCursor(`\n${embed}\n`);
    this.commitDesc();
  }
  private stamp(): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  }

  private async toggleRecord(btn: HTMLElement): Promise<void> {
    if (this.isRecording) { this.stopRecord(btn); return; }
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        new Notice("当前设备不支持录音");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let mimeType = "";
      for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
        if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
      }
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.mediaRecorder.ondataavailable = (ev) => { if (ev.data.size > 0) this.audioChunks.push(ev.data); };
      this.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        btn.removeClass("recording");
        const rec = this.mediaRecorder;
        const type = rec?.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        void this.saveAudio(new Blob(this.audioChunks, { type }), ext);
        this.mediaRecorder = null;
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      btn.addClass("recording");
      new Notice("🎤 录音中，再次点击停止");
    } catch {
      new Notice("无法启动录音，请检查麦克风权限");
    }
  }
  private stopRecord(btn: HTMLElement): void {
    if (this.mediaRecorder && this.isRecording) { try { this.mediaRecorder.stop(); } catch { /* ignore */ } }
    else { btn.removeClass("recording"); this.isRecording = false; }
  }
  private async saveAudio(blob: Blob, ext: string): Promise<void> {
    try {
      const name = `db-audio-${this.stamp()}.${ext}`;
      const buf = new Uint8Array(await blob.arrayBuffer());
      await this.app.vault.createBinary(`${this.mediaDir()}/${name}`, buf);
      this.insertIntoDesc(`![[${name}]]`);
      new Notice(`🎤 录音已保存：${name}`);
    } catch {
      new Notice("音频保存失败，请检查日记目录");
    }
  }
}

/** 打开任务详情页 */
export function openTaskDetail(
  app: App,
  plugin: DaybookPlugin,
  entry: JournalEntry,
  host: TaskDetailHost
): void {
  new TaskDetailModal(app, plugin, entry, host).open();
}
