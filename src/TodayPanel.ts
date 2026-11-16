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
  Platform,
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
  shouldShowPriorityBadge,
  planTodoProgress,
  planTaskLine,
  planTaskBlockLines,
  formatTodoDue,
  isTodoOverdue,
  type PriorityLevel,
  type JournalEntry,
  type TodoItem,
  formatDateLabel,
  extractInlineTags,
  stripInlineTags,
} from "./fileReader";
import { getAllSections, type SectionConfig, type PlanGroupBy } from "./settings";
import { isFilterActive, matchEntry, planDone, type SectionFilter } from "./filters";
import { openDateSelect } from "./dateSelect";
import { openTaskDetail } from "./taskDetail";
import { collectPlanTasks, collectAllPlanTasks, groupPlanTasks, childTodosOfParent, planTaskDone, sortPlanTasks, type PlanGroupMode, type PlanTaskGroup } from "./planOverview";

/** 视图层的「分组」取值 → planOverview 的聚合分组模式 */
const PLAN_GROUP_MODE: Record<Exclude<PlanGroupBy, "created">, PlanGroupMode> = {
  due: "date",
  priority: "priority",
  tag: "tag",
};

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


/** 今日某章节的记录流：只读渲染 + 行内操作（勾选/置顶/编辑/归档/删除） */
export class TodayPanel {
  private plugin: DaybookPlugin;
  private container: HTMLElement;
  private listEl: HTMLElement;
  private headEl: HTMLElement | null;
  private liveEditors = new Set<LiveEditor>();
  private busy = false;
  /** 已展开子任务的父任务（本次会话内的视图状态，键 = 文件路径:父任务行号，不落盘） */
  private expandedTasks = new Set<string>();
  /** 当前筛选条件（由视图注入；生效时结果跨日期） */
  filter: SectionFilter | null = null;
  /** 结果条数回调（供筛选面板显示） */
  onResult: ((count: number, days: number, filtering: boolean) => void) | null = null;
  /** 点击记录上的标签 → 切换该标签到章节筛选（由视图注入；再点一次取消，可叠加多个） */
  onToggleTag: ((tag: string) => void) | null = null;
  /**
   * 计划视图偏好（分组 / 排序 / 已完成与详细的显隐）直接读 settings：
   * 顶栏「···」和排序面板改的就是同一份对象，不需要再经视图层中转。
   */
  private get planView(): DaybookPlugin["settings"]["reviewState"] {
    return this.plugin.settings.reviewState;
  }
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

  /** 重新加载并渲染指定章节的记录（无筛选=今天；有筛选=按条件跨日期查询；计划章节可按日期/截止日/优先级/标签分组） */
  async refresh(sectionId: string): Promise<void> {
    this.destroyEditors();
    const seq = ++this.refreshSeq;
    const app = this.plugin.app;
    const today = moment().format("YYYY-MM-DD");
    const filter = this.filter;
    const filtering = !!filter && isFilterActive(filter);
    const section = getAllSections(this.plugin.settings).find(s => s.id === sectionId);
    // 计划章节的分组方式；非计划章节为 null，走通用记录流
    const planGroupBy: PlanGroupBy | null = section?.type === "plans" ? this.planView.planGroupBy : null;
    let entries: JournalEntry[] = [];
    const labels = new Map<string, string>();
    let allPlanEntries: JournalEntry[] = [];
    // 闪念章节默认 = 全部未归档闪念（跨日期流，flomo 式）；其余章节无筛选仍只看今天
    const memoStream = !filtering && section?.type === "memos";
    let groups: Awaited<ReturnType<typeof readAllJournalEntries>> = [];
    try {
      groups = await readAllJournalEntries(app, this.plugin.settings, new Set([sectionId]));
      if (seq !== this.refreshSeq) return;   // 已有更新的刷新接管渲染，避免重复落笔
      groups.forEach(g => labels.set(g.date, g.dateLabel));
      entries = filtering && filter
        ? groups.flatMap(g => g.entries).filter(e => matchEntry(e, filter, today))
        : memoStream
          ? (() => {
              // 默认聚焦未归档；全部归档时兜底展示已归档条目，列表不全空
              const all = groups.flatMap(g => g.entries);
              const active = all.filter(e => !e.archived);
              return active.length > 0 ? active : all.filter(e => e.archived);
            })()
          : (() => {
              const todayEntries = groups.find(g => g.date === today)?.entries ?? [];
              // 默认内容为未归档的；已归档的追加到底部弱化展示，不与正常记录混排
              return [...todayEntries.filter(e => !e.archived), ...todayEntries.filter(e => e.archived)];
            })();
      // 按截止日 / 优先级 / 标签分组：跨条目聚合任务（已放弃的块不参与）；
      // 筛选态下直接取筛选命中的条目，分组方式对筛选结果同样生效
      if (planGroupBy && planGroupBy !== "created") {
        const source = filtering ? entries : groups.flatMap(g => g.entries);
        allPlanEntries = source
          .filter(e => e.renderType === "plans" && !e.archived && !e.abandoned && (e.todos?.length ?? 0) > 0);
      }
    } catch (e) {
      // 读取失败时保持空列表；错误入控制台便于真机排查
      console.error("Daybook: 记录流读取失败", e);
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

    // ── 计划 · 按截止日 / 优先级 / 标签分组：滴答清单式，同组任务合并进一张卡片 ──
    // 筛选态下同样生效：按筛选命中的任务分组
    if (planGroupBy && planGroupBy !== "created" && section) {
      this.renderGroupedPlans(section, allPlanEntries, PLAN_GROUP_MODE[planGroupBy], today, filtering);
      return;
    }

    // ── 计划 · 按日期（创建日期）分组：同一天的任务合并在一张卡片里（📌 置顶分组最前）──
    if (section?.type === "plans" && !filtering) {
      const showDone = this.planView.planShowDone;
      const tasksOf = (list: JournalEntry[]) => {
        const t = collectAllPlanTasks(list);
        return showDone ? t : t.filter(x => !planTaskDone(x.entry, x.todo));
      };
      const all = groups.flatMap(g => g.entries)
        .filter(e => e.renderType === "plans" && !e.archived);
      const flatGroups: PlanTaskGroup[] = [];

      const pinnedEntries = all.filter(e => e.pinned);
      if (pinnedEntries.length > 0) {
        flatGroups.push({ key: "__pinned__", label: "📌 置顶", tasks: tasksOf(pinnedEntries) });
      }
      const rest = all.filter(e => !e.pinned);
      const byDate = new Map<string, JournalEntry[]>();
      const dates: string[] = [];
      rest.forEach(e => {
        if (!byDate.has(e.date)) { byDate.set(e.date, []); dates.push(e.date); }
        byDate.get(e.date)!.push(e);
      });
      dates.sort((a, b) => b.localeCompare(a));   // 创建日期逆序（新→旧）
      dates.forEach(d => {
        flatGroups.push({ key: d, label: labels.get(d) ?? d, tasks: tasksOf(byDate.get(d)!) });
      });
      // 组内次序统一按排序键（组间次序固定：置顶最前，日期新→旧）
      flatGroups.forEach(g => { g.tasks = sortPlanTasks(g.tasks, this.planView.planSortBy); });
      const shown = flatGroups.reduce((n, g) => n + g.tasks.length, 0);

      this.listEl.empty();
      this.container.toggleClass("is-empty", all.length === 0);
      this.setHead("全部任务", shown);
      if (this.headEl) this.headEl.toggleClass("is-hidden", all.length === 0);
      this.onResult?.(shown, flatGroups.length, false);

      if (all.length === 0) {
        this.listEl.createDiv({ cls: "db-today-empty", text: "还没有任务，在上方添加一条吧～" });
        return;
      }
      if (shown === 0) {
        this.listEl.createDiv({ cls: "db-today-empty", text: "任务都完成了，点右上角「···」里的「显示已完成」可以回看。" });
        return;
      }
      this.renderPlanGroupCards(flatGroups, section.id);
      return;
    }

    // 通用记录流（计划章节的筛选态会走到这里）：「隐藏已完成」＝整块勾完的计划卡不出现
    if (section?.type === "plans" && !this.planView.planShowDone) {
      entries = entries.filter(e => e.renderType !== "plans" || !planDone(e.todos));
    }

    this.listEl.empty();
    this.container.toggleClass("is-empty", entries.length === 0);
    this.setHead(filtering ? "筛选结果" : memoStream ? "全部闪念" : "今日记录", entries.length);
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
          : memoStream
            ? "还没有闪念，在上方写下第一条～"
            : "今天还没有记录，在上方写下第一条～",
      });
      return;
    }
    if (!filtering && !memoStream) {
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

    // 筛选视图 / 闪念默认流：按日期分桶分页加载（每页 5 组，滚动到底自动加载下一页）
    const dates: string[] = [];
    const byDate = new Map<string, JournalEntry[]>();
    entries.forEach(entry => {
      if (!byDate.has(entry.date)) { byDate.set(entry.date, []); dates.push(entry.date); }
      byDate.get(entry.date)!.push(entry);
    });
    // 闪念流：每天内部沿用排序设置（旧→新时组内反转，置顶仍居先），与今日视图一致
    if (memoStream && this.plugin.settings.memoSortOrder === "oldest") {
      byDate.forEach(list => {
        const pinned = list.filter(e => e.pinned).reverse();
        const normal = list.filter(e => !e.pinned).reverse();
        list.splice(0, list.length, ...pinned, ...normal);
      });
    }
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
   * 计划分组视图（截止日 / 优先级 / 标签）：任务跨条目聚合成组，每组一张卡片。
   * 组内次序取自视图偏好的排序键；「隐藏已完成」时整块勾完的任务不进组。
   * 勾选走级联写回原文件，完成后按当前显隐设置决定要不要立刻消失。
   */
  private renderGroupedPlans(
    section: SectionConfig,
    allEntries: JournalEntry[],
    mode: PlanGroupMode,
    today: string,
    filtering = false
  ) {
    const view = this.planView;
    const tasks = view.planShowDone ? collectAllPlanTasks(allEntries) : collectPlanTasks(allEntries);
    const groups = groupPlanTasks(tasks, mode, today, view.planSortBy);

    this.listEl.empty();
    this.container.toggleClass("is-empty", allEntries.length === 0);
    this.setHead(view.planShowDone ? "全部任务" : "未完成任务", tasks.length);
    this.headEl?.toggleClass("is-hidden", tasks.length === 0);
    this.onResult?.(tasks.length, 0, filtering);

    if (tasks.length === 0) {
      this.listEl.createDiv({
        cls: "db-today-empty",
        text: allEntries.length > 0
          ? "任务都完成了，点右上角「···」里的「显示已完成」可以回看。"
          : filtering
            ? "没有符合筛选条件的任务，放宽筛选试试～"
            : "还没有任务，在上方添加一条吧～",
      });
      return;
    }

    this.renderPlanGroupCards(groups, section.id);
  }

  /** 分组卡片列表：每组一张卡（组标题 + 计数 + 任务行）；平铺与优先级/截止日/标签分组共用 */
  private renderPlanGroupCards(groups: PlanTaskGroup[], sectionId: string) {
    for (const g of groups) {
      if (g.tasks.length === 0) continue;
      const card = this.listEl.createDiv({ cls: "db-entry db-plan-group-card" });
      const head = card.createDiv({ cls: "db-plan-group-head" });
      head.createSpan({ cls: "db-plan-group-label", text: g.label });
      head.createSpan({ cls: "db-plan-group-count", text: String(g.tasks.length) });
      const list = card.createDiv({ cls: "db-entry-todo-list" });
      g.tasks.forEach(({ entry, todo }) => this.renderGroupTodoRow(list, entry, todo, sectionId));
    }
  }

  /** 父任务展开状态（键 = 文件路径:任务行号） */
  private taskKey(entry: JournalEntry, todo: TodoItem): string {
    return `${entry.filePath}:${todo.lineIndex}`;
  }

  private isTaskExpanded(entry: JournalEntry, todo: TodoItem): boolean {
    return this.expandedTasks.has(this.taskKey(entry, todo));
  }

  private toggleTaskExpanded(entry: JournalEntry, todo: TodoItem): void {
    const k = this.taskKey(entry, todo);
    if (this.expandedTasks.has(k)) this.expandedTasks.delete(k);
    else this.expandedTasks.add(k);
  }

  /**
   * 任务勾选控件（平铺 / 分组 / 筛选卡片三处共用）：
   * - 无子任务：圆形勾选框，点击 = 完成 / 取消完成
   * - 有子任务且未完成：方形「子任务」图标，点击 = 展开 / 收起子任务
   *   （父任务的完成状态由子任务级联得出，不在这里直接勾选）
   * - 有子任务且已完成：与普通完成态一致（✓），点击仍可展开查看
   */
  private makeTaskCheckbox(
    host: HTMLElement,
    entry: JournalEntry,
    todo: TodoItem,
    kids: TodoItem[],
    onClick: () => void
  ): HTMLElement {
    const hasKids = kids.length > 0;
    const expanded = hasKids && this.isTaskExpanded(entry, todo);
    const box = host.createDiv({
      cls: `db-entry-checkbox${todo.done ? " checked" : ""}${hasKids ? " has-kids" : ""}${expanded ? " is-expanded" : ""}`,
      attr: { tabindex: "0" },
    });
    if (hasKids) {
      const tip = `${expanded ? "收起" : "展开"}子任务（${kids.length}）`;
      box.setAttribute("role", "button");
      box.setAttribute("aria-expanded", String(expanded));
      box.setAttribute("aria-label", `${tip}：${todo.text}`);
      box.setAttribute("title", tip);
      if (!todo.done) setIcon(box, "list");
    } else {
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", String(todo.done));
      box.setAttribute("aria-label", todo.done ? `取消完成：${todo.text}` : `完成：${todo.text}`);
    }
    box.addEventListener("click", (e) => { e.stopPropagation(); void onClick(); });
    makeActivatable(box);   // Enter/Space → click（沿用已设好的 role / aria）
    return box;
  }

  /** 分组卡片内的任务行：样式与计划卡片中的任务一致（勾选级联写回原文件） */
  private renderGroupTodoRow(
    list: HTMLElement,
    entry: JournalEntry,
    todo: TodoItem,
    sectionId: string,
    depth = 0
  ) {
    const kids = depth === 0 ? childTodosOfParent(entry, todo) : [];
    const expanded = kids.length > 0 && this.isTaskExpanded(entry, todo);
    const item = list.createDiv({ cls: `db-plan-group-row${depth ? " sub" : ""}` });
    const toggleDone = async () => {
      try {
        const stamp = moment().format("YYYY-MM-DD HH:mm");
        const newDone = !todo.done;
        const updates = buildTodoCascade(entry.todos ?? [todo], todo, newDone, stamp);
        await setTodoStatesInFile(this.plugin.app, entry.filePath, updates, this.plugin.settings);
        if (newDone) this.plugin.feedback.notify();
        void this.refresh(sectionId);
      } catch (e) {
        new Notice("更新失败，请检查日记文件");
      }
    };
    this.makeTaskCheckbox(item, entry, todo, kids, () => {
      if (kids.length > 0) {
        this.toggleTaskExpanded(entry, todo);
        void this.refresh(sectionId);   // 展开态是视图状态，重绘列表即可
      } else void toggleDone();
    });
    const textEl = item.createDiv({ cls: `db-entry-todo-text ${todo.done ? "done" : ""}` });
    if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
      createPriorityBadge(textEl, todo.priority);
    }
    const detail = this.planView.planShowDetail;
    // 标题只显示纯文字：行内 #标签 由下面的标签胶囊承担（「隐藏详细」时两者一起收起）
    textEl.createSpan({ text: stripInlineTags(todo.text) });
    if (todo.dueDate) {
      const overdue = isTodoOverdue(todo.dueDate);
      textEl.createSpan({
        cls: `db-entry-due ${overdue ? "overdue" : ""}`,
        text: overdue ? "⚠️过期" : `📅 ${formatTodoDue(todo.dueDate)}`,
      });
    }
    if (detail && (todo.note || todo.desc)) {
      textEl.createSpan({
        cls: "db-entry-note-flag",
        text: "📝",
        attr: { "aria-label": `备注：${todo.desc || todo.note}` },
      });
    }
    // 标签随行展示（「隐藏详细」时连同上面的备注徽标一起收起）
    if (detail) {
      const tags = extractInlineTags(todo.text).filter(t => t !== "pinned" && t !== "abandoned");
      if (tags.length > 0) this.renderTagChips(item.createDiv({ cls: "db-plan-group-tags" }), tags);
    }

    // 有子任务且已完成一部分 → 行最右侧显示 x/y（父任务全部完成时已是 ✓ 完成态，不再重复显示）
    if (kids.length > 0 && !todo.done) {
      const kidDone = kids.filter(k => k.done).length;
      if (kidDone > 0) {
        item.createDiv({
          cls: "db-plan-group-progress",
          text: `${kidDone}/${kids.length}`,
          attr: { "aria-label": `子任务已完成 ${kidDone}/${kids.length}` },
        });
      }
    }

    textEl.addEventListener("click", () => {
      if (depth > 0) void toggleDone();
      else this.openTaskDetailPage(entry);
    });

    // 手机端：长按任务行 = 与卡片视图同一套操作菜单（延后 / 放弃 / 截止日期 / 归档 / 删除…）
    // 分组视图此前没有任何操作入口，手机上够不到这些功能
    if (depth === 0) this.bindLongPressMenu(item, entry);

    // 展开态：子任务紧跟父任务行渲染（只是视图状态，不改文件）
    if (expanded) kids.forEach(k => this.renderGroupTodoRow(list, entry, k, sectionId, 1));
  }

  /**
   * 标签胶囊行（记录卡片与分组任务行共用）。
   * 点击 = 叠加/移除该标签到章节筛选，再点一次取消；选中的高亮。
   */
  private renderTagChips(parent: HTMLElement, tags: string[]): void {
    tags.forEach(tag => {
      const active = this.filter?.tags?.includes(tag) ?? false;
      const chip = parent.createSpan({
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

  /** 单条记录块 */
  private renderEntry(entry: JournalEntry) {
    const card = this.listEl.createDiv({
      cls: `db-entry ${entry.pinned ? "pinned" : ""} ${entry.archived ? "archived" : ""} ${entry.abandoned ? "abandoned" : ""}`,
    });

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
    const moreBtn = makeActivatable(head.createDiv({
      cls: "db-entry-more",
      attr: { role: "button", tabindex: "0", "aria-label": "更多操作" },
    }), "更多操作");
    moreBtn.setText("⋯");

    if (entry.renderType === "plans" && entry.todos && entry.todos.length > 0) {
      // 任务中心：一张卡片就是一条任务（含子任务），标题即任务文本，无需块标题层
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

    // 计划章节的标签属于「详细」内容，随顶栏「隐藏详细」一起收起；闪念不受该开关影响
    const showTags = entry.renderType !== "plans" || this.planView.planShowDetail;
    if (showTags && entry.tags && entry.tags.length > 0) {
      this.renderTagChips(card.createDiv({ cls: "db-entry-tags" }), entry.tags);
    }

    // ⋯ 操作按钮：弹出菜单（键盘 Enter/Space 由 makeActivatable 处理）
    moreBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.showEntryMenu(card, entry, { x: evt.clientX, y: evt.clientY });
    });

    // 触屏长按卡片 → 同一操作菜单（手机没有 hover，⋯ 按钮不易发现）
    this.bindLongPressMenu(card, entry);
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

  /**
   * 触屏长按卡片 → 弹出操作菜单（flomo/微信式）。
   * 桌面鼠标不响应；长按交互元素（链接/图片/标签/勾选框/⋯）时让位给其自身行为；
   * 菜单弹出后吞掉本次抬指产生的 click，防止误触卡片内部行（如勾选/详情）。
   */
  private bindLongPressMenu(card: HTMLElement, entry: JournalEntry) {
    const LONG_PRESS_MS = 550;
    const MOVE_TOLERANCE = 12;
    const state = { timer: 0, startX: 0, startY: 0, pressing: false, fired: false };

    const cancel = () => {
      if (state.timer) { activeWindow.clearTimeout(state.timer); state.timer = 0; }
      state.pressing = false;
      card.removeClass("db-long-pressing");
    };

    card.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse") return;          // 桌面沿用 hover ⋯
      if ((pe.button ?? 0) !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("a, img, button, input, textarea, .db-entry-tag, .db-entry-more, .db-entry-checkbox, .db-entry-edit")) return;
      state.startX = pe.clientX;
      state.startY = pe.clientY;
      state.pressing = true;
      state.fired = false;
      card.addClass("db-long-pressing");               // 按住期间禁划选，避免系统选字与菜单打架
      state.timer = activeWindow.setTimeout(() => {
        state.timer = 0;
        state.fired = true;
        cancel();
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try { navigator.vibrate(10); } catch { /* 不支持则忽略 */ }
        }
        this.showEntryMenu(card, entry, { x: pe.clientX, y: pe.clientY });
      }, LONG_PRESS_MS) as unknown as number;
    });
    card.addEventListener("pointermove", (e) => {
      if (!state.pressing) return;
      const pe = e as PointerEvent;
      if (Math.hypot(pe.clientX - state.startX, pe.clientY - state.startY) > MOVE_TOLERANCE) cancel();
    });
    card.addEventListener("pointerup", cancel);
    card.addEventListener("pointercancel", cancel);
    card.addEventListener("pointerleave", cancel);

    // 抬指后的合成 click 不再落到卡片内部（勾选/计划详情等）
    card.addEventListener("click", (e) => {
      if (!state.fired) return;
      state.fired = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // 抑制系统长按菜单/选字（安卓），桌面右键不受影响
    card.addEventListener("contextmenu", (e) => {
      if (state.pressing || state.fired) e.preventDefault();
    });
  }

  /** 复制文本到剪贴板：优先 Clipboard API，失败降级 execCommand */
  private async copyEntryText(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice("⧉ 已复制原文");
        return;
      }
    } catch { /* 降级 execCommand */ }
    try {
      const ta = activeDocument.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      activeDocument.body.appendChild(ta);
      ta.select();
      const ok = activeDocument.execCommand("copy");
      ta.remove();
      new Notice(ok ? "⧉ 已复制原文" : "复制失败");
    } catch {
      new Notice("复制失败");
    }
  }

  /** 单条记录操作菜单：置顶 / 编辑 / 原文 / 复制 / 归档 / 删除 */
  private showEntryMenu(card: HTMLElement, entry: JournalEntry, pos: { x: number; y: number }) {
    const menu = new Menu();

    menu.addItem(item =>
      item
        .setTitle(entry.pinned ? "取消置顶" : "置顶")
        .setIcon("pin")
        .onClick(() => this.togglePinEntry(entry))
    );

    if (entry.renderType === "plans") {
      menu.addItem(item =>
        item.setTitle("编辑").setIcon("pencil").onClick(() => this.openTaskDetailPage(entry))
      );
      if (entry.todos?.length) {
        menu.addItem(item =>
          item
            .setTitle("截止日期")
            .setIcon("calendar")
            .onClick(() => {
              const todo = entry.todos![0];
              openDateSelect(this.plugin.app, {
                value: todo.dueDate,
                onPick: async (d) => {
                  if (!entry.todos?.length) return;
                  todo.dueDate = d ?? undefined;
                  this.busy = true;
                  try {
                    await this.rewriteTaskLine(entry, todo);
                    new Notice(d ? `📅 已设为 ${formatTodoDue(d)}` : "已清除截止日期");
                    void this.refresh(entry.type);
                  } catch (e) {
                    new Notice("操作失败，请检查日记文件");
                  } finally {
                    this.busy = false;
                  }
                },
              });
            })
        );
        menu.addItem(item =>
          item
            .setTitle("延后")
            .setIcon("calendar-plus")
            .onClick(() => this.postponeTask(entry))
        );
        menu.addItem(item =>
          item
            .setTitle(entry.abandoned ? "恢复" : "放弃")
            .setIcon(entry.abandoned ? "rotate-ccw" : "circle-off")
            .onClick(() => this.toggleAbandonEntry(entry))
        );
      }
    } else {
      menu.addItem(item =>
        item.setTitle("编辑").setIcon("pencil").onClick(() => this.enterEditMode(card, entry))
      );
    }

    menu.addItem(item =>
      item.setTitle("原文").setIcon("file-text").onClick(() => this.revealEntryInFile(entry))
    );

    menu.addItem(item =>
      item.setTitle("复制原文").setIcon("copy").onClick(() => { void this.copyEntryText(entry.text); })
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
        .onClick(() => this.deleteEntryConfirmed(entry))
    );

    menu.showAtPosition(pos);
  }

  /** 置顶 / 取消置顶：计划任务走 #pinned 标签；块尾 [置顶: true] 字段行（旧 [pinned::true] 兼容）优先移除；其他记录保持字段行方式 */
  private async togglePinEntry(entry: JournalEntry) {
    try {
      const start = entry.rawLineIndex ?? 0;
      const end = entry.endLineIndex ?? start;
      const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
      const fieldIdx = block.findIndex(l => /^\s*\[(?:置顶|pinned):+/.test(l));
      if (fieldIdx >= 0) {
        await removeLineRange(this.plugin.app, entry.filePath, start + fieldIdx, start + fieldIdx);
        new Notice("已取消置顶");
      } else if (entry.renderType === "plans" && entry.todos && entry.todos.length > 0) {
        const todo = entry.todos[0];
        todo.text = entry.pinned
          ? todo.text.replace(/(^|\s)#pinned(?=\s|$)/g, "$1").replace(/\s{2,}/g, " ").trim()
          : `${todo.text} #pinned`;
        await this.rewriteTaskLine(entry, todo);
        new Notice(entry.pinned ? "已取消置顶" : "📌 已置顶");
      } else {
        await insertLineAfter(this.plugin.app, entry.filePath, end, "[置顶: true]");
        new Notice("📌 已置顶");
      }
      void this.refresh(entry.type);
    } catch (e) {
      new Notice("操作失败，请检查日记文件");
    }
  }

  /** 用当前任务数据重建单条任务行（子任务行不动；顺带完成旧格式 → 新格式的就地迁移） */
  private async rewriteTaskLine(entry: JournalEntry, todo: TodoItem) {
    const completedField = getCompletedFieldName(this.plugin.settings);
    await replaceLineRange(
      this.plugin.app,
      entry.filePath,
      todo.lineIndex,
      todo.lineIndex,
      [planTaskLine(todo, completedField)]
    );
  }

  /** 延后：已逾期的任务延到今天，其余顺延一天；没有截止日不操作 */
  private async postponeTask(entry: JournalEntry) {
    if (!entry.todos?.length) return;
    const todo = entry.todos[0];
    if (!todo.dueDate) {
      new Notice("该任务没有截止日期");
      return;
    }
    const today = moment().format("YYYY-MM-DD");
    const newDue = todo.dueDate < today
      ? today
      : moment(todo.dueDate).add(1, "day").format("YYYY-MM-DD");
    todo.dueDate = newDue;
    this.busy = true;
    try {
      await this.rewriteTaskLine(entry, todo);
      new Notice(`⏩ 已延后至 ${formatTodoDue(newDue)}`);
      void this.refresh(entry.type);
    } catch (e) {
      new Notice("操作失败，请检查日记文件");
    } finally {
      this.busy = false;
    }
  }

  /** 放弃 / 恢复：在任务行增删 #abandoned 标签（放弃 ≠ 完成：灰色淡化 + 斜体） */
  private async toggleAbandonEntry(entry: JournalEntry) {
    if (!entry.todos?.length) return;
    const todo = entry.todos[0];
    todo.text = entry.abandoned
      ? todo.text.replace(/(^|\s)#abandoned(?=\s|$)/g, "$1").replace(/\s{2,}/g, " ").trim()
      : `${todo.text} #abandoned`;
    this.busy = true;
    try {
      await this.rewriteTaskLine(entry, todo);
      new Notice(entry.abandoned ? "↩️ 已恢复" : "🚫 已放弃");
      void this.refresh(entry.type);
    } catch (e) {
      new Notice("操作失败，请检查日记文件");
    } finally {
      this.busy = false;
    }
  }

  /** 归档：在记录块尾追加 [归档: YYYY-MM-DD HH:mm:ss] */
  private async archiveEntry(entry: JournalEntry) {
    try {
      const stamp = moment().format("YYYY-MM-DD HH:mm:ss");
      await insertLineAfter(
        this.plugin.app,
        entry.filePath,
        entry.endLineIndex ?? entry.rawLineIndex ?? 0,
        `[归档: ${stamp}]`
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

  /** 打开任务详情页（TickTick 风格全屏页：勾选 / 截止日 / 标题 / 子任务 / 描述 / 标签图片录音） */
  private openTaskDetailPage(entry: JournalEntry) {
    openTaskDetail(this.plugin.app, this.plugin, entry, {
      applyChange: async (e, todos) => {
        this.busy = true;
        try {
          await this.rewriteTaskEntry(e, todos);
          await this.refresh(e.type);
          // 父任务行号在本条编辑中稳定，用作身份锚点重取最新条目（endLineIndex 已随结构变化更新）
          return await this.findEntryAt(e.filePath, e.rawLineIndex ?? 0, e.type);
        } finally {
          this.busy = false;
        }
      },
      requestDelete: (e) => this.deleteEntryConfirmed(e),
    });
  }

  /** 重取指定文件中某父任务行对应的最新条目（详情页提交后刷新自身用） */
  private async findEntryAt(filePath: string, rawLineIndex: number, sectionId: string): Promise<JournalEntry | null> {
    try {
      const groups = await readAllJournalEntries(this.plugin.app, this.plugin.settings, new Set([sectionId]));
      for (const g of groups) {
        for (const e of g.entries) {
          if (e.filePath === filePath && e.rawLineIndex === rawLineIndex) return e;
        }
      }
    } catch { /* 读取失败时返回 null，调用方保留当前数据 */ }
    return null;
  }

  /** 删除记录（确认后移除原文行并刷新）：详情页「更多 → 删除」与卡片菜单共用 */
  private deleteEntryConfirmed(entry: JournalEntry): void {
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
    // 移动端：软键盘弹起会压缩视口，把编辑中的卡片滚回可见区（等键盘动画结束后校正）
    if (Platform.isMobile) {
      activeWindow.setTimeout(() => {
        if (editWrap.isConnected) editWrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 350);
    }
  }

  /** 按当前任务数据重写任务条目（任务编辑保存/拖拽排序后调用，保留置顶/归档字段行） */
  private async rewriteTaskEntry(entry: JournalEntry, todos: TodoItem[]) {
    const start = entry.rawLineIndex ?? 0;
    const end = entry.endLineIndex ?? start;
    const block = await readLineRange(this.plugin.app, entry.filePath, start, end);
    const fieldLines = block.filter(l => /^\s*\[(pinned|archived)::.*\]\s*$/.test(l));
    const completedField = getCompletedFieldName(this.plugin.settings);
    const lines = planTaskBlockLines(todos, completedField);
    await replaceLineRange(this.plugin.app, entry.filePath, start, end, [...lines, ...fieldLines]);
  }

  /** 计划任务列表：勾选父子级联 + 拖拽排序 + 进度条（有子计划按子计划计数） */
  private renderTodoCard(card: HTMLElement, entry: JournalEntry) {
    const todos = entry.todos!;
    let dragFrom: number | null = null;
    let { done: doneCount, total } = planTodoProgress(todos);

    const refs = new Map<number, { todo: TodoItem; kids: TodoItem[]; checkbox: HTMLElement; textEl: HTMLElement; itemEl: HTMLElement }>();

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
      if (ref.kids.length > 0) {
        // 父任务：未完成显示「子任务」图标，完成后与普通完成态一致（✓）
        ref.checkbox.empty();
        if (!todo.done) setIcon(ref.checkbox, "list");
      }
      appendTodoCompletionInfo(ref.textEl, todo, this.plugin.settings, true);
    };

    const todoList = card.createDiv({ cls: "db-entry-todo-list" });

    const renderItem = (todo: TodoItem, isSub: boolean) => {
      const kids = isSub ? [] : childTodosOfParent(entry, todo);
      const expanded = kids.length > 0 && this.isTaskExpanded(entry, todo);
      const item = todoList.createDiv({ cls: `db-entry-todo-item ${todo.done ? "done" : ""} ${isSub ? "sub" : ""}` });

      // 勾选框：无子任务 = 完成/取消；有子任务 = 展开/收起子任务（完成状态由级联得出）
      const checkbox = this.makeTaskCheckbox(item, entry, todo, kids, () => {
        if (kids.length > 0) {
          this.toggleTaskExpanded(entry, todo);
          renderList();
          return;
        }
        void toggle();
      });

      const detail = this.planView.planShowDetail;
      const textEl = item.createDiv({ cls: `db-entry-todo-text ${todo.done ? "done" : ""}` });
      if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
        createPriorityBadge(textEl, todo.priority);
      }
      textEl.createSpan({ text: stripInlineTags(todo.text) });
      if (todo.dueDate) {
        const overdue = isTodoOverdue(todo.dueDate);
        textEl.createSpan({
          cls: `db-entry-due ${overdue ? "overdue" : ""}`,
          text: overdue ? "⚠️过期" : `📅 ${formatTodoDue(todo.dueDate)}`,
        });
      }
      appendTodoCompletionInfo(textEl, todo, this.plugin.settings, true);
      // 备注徽标：有备注 / 描述时给个小标记，悬停可见内容（属「详细」，可整体收起）
      if (detail && (todo.note || todo.desc)) {
        textEl.createSpan({
          cls: "db-entry-note-flag",
          text: "\u{1F4DD}",
          attr: { "aria-label": `备注：${todo.desc || todo.note}`, "data-tooltip-text": todo.desc || todo.note || "", "data-tooltip-position": "top" },
        });
      }

      refs.set(todo.lineIndex, { todo, kids, checkbox, textEl, itemEl: item });

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
          await this.rewriteTaskEntry(entry, todos);
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

      // 点击文字：顶级任务 → 任务详情页（勾选/截止日/标题/子任务/描述）；子任务 → 直接勾选
      if (isSub) {
        textEl.addEventListener("click", () => { void toggle(); });
      } else {
        textEl.addClass("clickable");
        textEl.setAttribute("role", "button");
        textEl.setAttribute("tabindex", "0");
        textEl.setAttribute("aria-label", "打开任务编辑");
        textEl.addEventListener("click", () => this.openTaskDetailPage(entry));
        textEl.addEventListener("keydown", (e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); this.openTaskDetailPage(entry); }
        });
      }

      // 展开态：子任务紧跟父任务行渲染
      if (expanded) kids.forEach(k => renderItem(k, true));
    };

    /** 重绘任务列表（展开/收起子任务时调用；进度条在 card 上，不受影响） */
    const renderList = () => {
      todoList.empty();
      refs.clear();
      todos.forEach(t => { if (!t.indent) renderItem(t, false); });
    };

    renderList();

    // 单条无子任务的任务卡片不需要 1/1 进度条
    if (total > 1) {
      const progress = card.createDiv({ cls: "db-entry-progress" });
      progressText = progress.createSpan({ cls: "db-entry-progress-text", text: `${doneCount}/${total}` });
      const bar = progress.createDiv({ cls: "db-entry-progress-bar" });
      progressFill = bar.createDiv({ cls: "db-entry-progress-fill" });
      progressFill.style.width = `${Math.round((doneCount / total) * 100)}%`;
    }
  }
}
