import { App, Component, ItemView, WorkspaceLeaf, setIcon, moment } from "obsidian";
import type DaybookPlugin from "./main";
import { readAllJournalEntries, formatDateLabel, planTodoProgress, type DayGroup, type JournalEntry } from "./fileReader";
import { checkinState, isExecuteDay, loadHabits, type CheckinRow, type HabitConfig } from "./habitManager";
import { isTypeEnabled, type SectionType } from "./settings";

export const VIEW_TYPE_DASHBOARD = "daybook-dashboard-view";

/* ════════════════════════════════════════════════════════
   DashboardView — Apple HIG × Obsidian Native
   零依赖 · 纯 DOM API · setIcon(Lucide)
   所有统计均来自真实日记数据，控制项直接读写插件设置

   DashboardPage：可嵌入的面板组件，由闪念视图作为"页内新页面"渲染；
   DashboardView：独立标签页兼容壳（旧 workspace 布局恢复时用），内部复用 DashboardPage。
   ════════════════════════════════════════════════════════ */

interface SegmentTab { id: string; label: string; icon: string; }
interface StatCard { icon: string; label: string; value: string; sublabel?: string; accent?: boolean; }
interface ToggleConfig { icon: string; title: string; subtitle: string; enabled: boolean; onToggle: (v: boolean) => void; }

export class DashboardPage extends Component {
  app: App;
  plugin: DaybookPlugin;
  /** 渲染宿主：由调用方创建并负责移除；本组件只负责填充 */
  private hostEl: HTMLElement;
  /** 原生 .view-header 所在的查询范围（叶子容器） */
  private scopeEl: HTMLElement;
  /** 宿主追加类名（页内新页面样式），与 db-root 并存 */
  private extraClass: string;
  /** 页内嵌入时的"返回"回调：标题栏显示返回箭头；独立标签页模式不传 */
  private onBack: (() => void) | null;
  private activeTab = "overview";
  private rootEl!: HTMLElement;
  private compactView = false;
  private groups: DayGroup[] = [];
  private checkinRows: CheckinRow[] = [];
  private habitConfigs: HabitConfig[] = [];
  private loaded = false;
  private loading = false;

  constructor(app: App, plugin: DaybookPlugin, hostEl: HTMLElement, scopeEl: HTMLElement, extraClass = "", onBack?: () => void) {
    super();
    this.app = app;
    this.plugin = plugin;
    this.hostEl = hostEl;
    this.scopeEl = scopeEl;
    this.extraClass = extraClass;
    this.onBack = onBack ?? null;
  }

  /** 挂载 + 加载 + 渲染（宿主页面或 ItemView 壳调用） */
  async open(): Promise<void> {
    this.load();
    await this.loadData();
    this.render();
    // 原生标题栏显隐/尺寸变化会改变与内容的重叠量（与闪念主页同方案）
    this.registerEvent(this.app.workspace.on("resize", () => this.applyHeaderInset()));
  }
  close(): void { this.unload(); }

  /* ── 数据加载 ── */
  private async loadData() {
    if (this.loading) return;
    this.loading = true;
    try {
      this.groups = await readAllJournalEntries(this.app, this.plugin.settings);
      const habits = await loadHabits(this.app, this.plugin.settings);
      this.habitConfigs = habits.map(h => h.config);
      this.checkinRows = habits.flatMap(h => h.rows);
      this.loaded = true;
    } catch (error) {
      console.error("[Daybook] Dashboard 数据加载失败：", error);
    } finally {
      this.loading = false;
    }
  }

  /* ── 主渲染 ── */
  render() {
    const root = this.hostEl;
    root.empty();
    root.setAttribute("class", ["db-root", this.extraClass, this.compactView ? "db-compact" : ""].filter(Boolean).join(" "));
    this.rootEl = root;
    this.buildHeader(root);
    this.buildSegmentedControl(root);
    const content = root.createDiv({ cls: "db-content" });
    this.renderActiveTab(content);
    this.applyHeaderInset();
    activeWindow.requestAnimationFrame(() => this.applyHeaderInset());
  }

  /** 安卓端原生 .view-header 悬浮在内容之上：量出重叠高度，让 sticky 头部下移避让（不遮盖原生按钮） */
  private applyHeaderInset(): void {
    const header = this.rootEl?.querySelector(".db-header") as HTMLElement | null;
    if (!header) return;
    const native = this.scopeEl.querySelector(".view-header") as HTMLElement | null;
    let inset = 0;
    if (native && native.offsetHeight > 0) {
      const nBottom = native.getBoundingClientRect().bottom;
      const rTop = this.rootEl.getBoundingClientRect().top;
      inset = Math.max(0, Math.ceil(nBottom - rTop));
    }
    const on = inset > 0;
    header.toggleClass("is-inset", on);
    header.style.top = on ? `${inset}px` : "";
    header.style.marginTop = on ? `${inset}px` : "";
  }

  /* ═══ 1. Header Bar ═══ */
  private buildHeader(root: HTMLElement) {
    const header = root.createDiv({ cls: "db-header" });
    // 页内新页面：标题左侧加返回箭头，点按揭开本页回到闪念
    let titleGroup: HTMLElement;
    if (this.onBack) {
      const left = header.createDiv({ cls: "db-header-left" });
      const backBtn = left.createDiv({ cls: "db-icon-btn db-header-back", attr: { "aria-label": "返回", role: "button", tabindex: "0" } });
      setIcon(backBtn, "chevron-left");
      backBtn.addEventListener("click", () => this.onBack?.());
      backBtn.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); this.onBack?.(); }
      });
      titleGroup = left.createDiv({ cls: "db-header-title-group" });
    } else {
      titleGroup = header.createDiv({ cls: "db-header-title-group" });
    }
    const title = titleGroup.createDiv({ cls: "db-header-title" });
    setIcon(title, "book-open");
    title.createSpan({ text: "Daybook", cls: "db-header-title-text" });
    titleGroup.createDiv({ cls: "db-header-date", text: moment().format("YYYY年MM月DD日 · dddd") });

    const actions = header.createDiv({ cls: "db-header-actions" });
    const refreshBtn = this.createIconButton(actions, "refresh-cw", "刷新数据");
    refreshBtn.addEventListener("click", async () => {
      // 点击反馈：图标旋转一圈；重渲染会替换按钮节点，故等动画播完再刷新界面
      refreshBtn.classList.remove("db-rotating");
      void refreshBtn.offsetWidth; // 强制重排，连点时可重新起播
      refreshBtn.classList.add("db-rotating");
      this.loaded = false;
      const startAt = Date.now();
      await this.loadData();
      const remain = 600 - (Date.now() - startAt);
      if (remain > 0) await new Promise<void>((r) => setTimeout(r, remain));
      this.render();
    });
    const settingsBtn = this.createIconButton(actions, "settings-2", "打开设置");
    settingsBtn.addEventListener("click", () => {
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      if (setting) { setting.open(); setting.openTabById(this.plugin.manifest.id); }
    });
  }

  private createIconButton(parent: HTMLElement, icon: string, ariaLabel: string): HTMLElement {
    const btn = parent.createDiv({ cls: "db-icon-btn", attr: { "aria-label": ariaLabel, role: "button", tabindex: "0" } });
    setIcon(btn, icon);
    btn.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); btn.click(); }
    });
    return btn;
  }

  /* ═══ 2. Segmented Control (macOS style) ═══ */
  private buildSegmentedControl(root: HTMLElement) {
    const tabs: SegmentTab[] = [
      { id: "overview", label: "概览", icon: "layout-dashboard" },
      { id: "controls", label: "控制", icon: "sliders-horizontal" },
      { id: "stats", label: "统计", icon: "bar-chart-3" },
    ];
    const container = root.createDiv({ cls: "db-segment-container" });
    const control = container.createDiv({ cls: "db-segment-control" });
    const indicator = control.createDiv({ cls: "db-segment-indicator" });

    const activate = (tab: SegmentTab, index: number) => {
      if (this.activeTab === tab.id) return;
      this.activeTab = tab.id;
      indicator.style.transform = `translateX(${index * 100}%)`;
      control.querySelectorAll(".db-segment").forEach((el, i) => el.toggleClass("active", i === index));
      const content = this.rootEl.querySelector(".db-content") as HTMLElement;
      if (content) { content.empty(); this.renderActiveTab(content); }
    };

    tabs.forEach((tab, index) => {
      const seg = control.createDiv({ cls: `db-segment ${this.activeTab === tab.id ? "active" : ""}`, attr: { role: "button", tabindex: "0", "aria-label": tab.label } });
      const iconEl = seg.createDiv({ cls: "db-segment-icon" });
      setIcon(iconEl, tab.icon);
      seg.createSpan({ text: tab.label, cls: "db-segment-label" });
      seg.addEventListener("click", () => activate(tab, index));
      seg.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); activate(tab, index); }
      });
    });
    const activeIndex = Math.max(0, tabs.findIndex(t => t.id === this.activeTab));
    indicator.style.transform = `translateX(${activeIndex * 100}%)`;
  }

  /* ═══ Tab Router ═══ */
  private renderActiveTab(container: HTMLElement) {
    if (!this.loaded) {
      container.createDiv({ cls: "db-section-title", text: "正在加载数据…" });
      return;
    }
    if (this.activeTab === "overview") this.renderOverviewTab(container);
    else if (this.activeTab === "controls") this.renderControlsTab(container);
    else this.renderStatsTab(container);
  }

  /* ═══ Tab: Overview ═══ */
  private renderOverviewTab(container: HTMLElement) {
    this.buildStatGrid(container, this.computeStats());
    this.buildActivityFeed(container);
  }

  /* ═══ Tab: Controls（全部为真实设置） ═══ */
  private renderControlsTab(container: HTMLElement) {
    const tt = container.createDiv({ cls: "db-section-title" });
    setIcon(tt, "toggle-left"); tt.createSpan({ text: "记录类型开关" });

    const typeToggles: { key: SectionType; icon: string; title: string; subtitle: string }[] = [
      { key: "memos", icon: "zap", title: "闪念", subtitle: "关闭后闪念章节不再显示" },
      { key: "plans", icon: "calendar-check", title: "待办计划", subtitle: "关闭后计划章节不再显示" },
      { key: "habits", icon: "droplet", title: "习惯打卡", subtitle: "关闭后习惯章节与习惯卡片不再显示" },
    ];
    typeToggles.forEach(({ key, icon, title, subtitle }) => {
      this.buildToggleCard(container, {
        icon, title, subtitle,
        enabled: isTypeEnabled(this.plugin.settings, key),
        onToggle: async v => {
          this.plugin.settings.typeEnabled[key] = v;
          await this.plugin.saveSettings();
          this.plugin.getJournalView()?.buildUI();
          this.render();
        },
      });
    });

    const dt = container.createDiv({ cls: "db-section-title" });
    setIcon(dt, "smartphone"); dt.createSpan({ text: "界面" });
    this.buildToggleCard(container, {
      icon: "smartphone", title: "紧凑视图", subtitle: "本 Dashboard 减少间距，显示更多内容",
      enabled: this.compactView,
      onToggle: v => { this.compactView = v; this.render(); },
    });
  }

  /* ═══ Tab: Stats ═══ */
  private renderStatsTab(container: HTMLElement) {
    this.buildStatGrid(container, this.computeExtendedStats());
    this.buildActivityFeed(container, 10);
  }

  /* ═══ Component: Stat Cards Grid ═══ */
  private buildStatGrid(parent: HTMLElement, cards: StatCard[]) {
    const grid = parent.createDiv({ cls: "db-stat-grid" });
    cards.forEach(c => {
      const item = grid.createDiv({ cls: `db-stat-card ${c.accent ? "db-stat-accent" : ""}` });
      const iw = item.createDiv({ cls: "db-stat-icon" }); setIcon(iw, c.icon);
      const vw = item.createDiv({ cls: "db-stat-value-wrap" });
      vw.createDiv({ cls: "db-stat-value", text: c.value });
      if (c.sublabel) vw.createDiv({ cls: "db-stat-sublabel", text: c.sublabel });
      item.createDiv({ cls: "db-stat-label", text: c.label });
    });
  }

  /* ═══ Component: 近期活动（真实条目） ═══ */
  private buildActivityFeed(container: HTMLElement, limit = 6) {
    const recent: { entry: JournalEntry }[] = [];
    for (const g of this.groups) {
      for (const e of g.entries) {
        recent.push({ entry: e });
        if (recent.length >= limit) break;
      }
      if (recent.length >= limit) break;
    }

    const st = container.createDiv({ cls: "db-section-title" });
    setIcon(st, "activity"); st.createSpan({ text: "近期记录" });

    if (recent.length === 0) {
      const card = container.createDiv({ cls: "db-activity-card" });
      card.createDiv({ cls: "db-activity-text", text: "还没有记录，去 Daybook 写第一条吧" });
      return;
    }

    const card = container.createDiv({ cls: "db-activity-card" });
    recent.forEach(({ entry }) => {
      const row = card.createDiv({ cls: "db-activity-row" });
      const iw = row.createDiv({ cls: "db-activity-icon", text: entry.sectionEmoji || "📝" });
      let preview = entry.text.replace(/\n+/g, " ");
      if (entry.renderType === "plans") {
        const p = planTodoProgress(entry.todos ?? []);
        preview = `${entry.text}（${p.done}/${p.total} 已完成）`;
      }
      row.createDiv({ cls: "db-activity-text", text: preview });
      row.createDiv({ cls: "db-activity-time", text: `${formatDateLabel(entry.date)}${entry.time ? " " + entry.time : ""}` });
    });
  }

  /* ═══ Component: Toggle Switch Card (Apple HIG) ═══ */
  private buildToggleCard(parent: HTMLElement, config: ToggleConfig) {
    const card = parent.createDiv({ cls: "db-toggle-card" });
    const left = card.createDiv({ cls: "db-toggle-left" });
    const iw = left.createDiv({ cls: "db-toggle-icon" }); setIcon(iw, config.icon);
    const tw = left.createDiv({ cls: "db-toggle-text" });
    tw.createDiv({ cls: "db-toggle-title", text: config.title });
    tw.createDiv({ cls: "db-toggle-subtitle", text: config.subtitle });
    const sw = card.createDiv({ cls: "db-toggle-switch-wrap" });
    const track = sw.createDiv({ cls: `db-toggle-track ${config.enabled ? "on" : "off"}`, attr: { role: "switch", "aria-checked": String(config.enabled), tabindex: "0", "aria-label": config.title } });
    track.createDiv({ cls: "db-toggle-thumb" });

    const toggle = () => {
      const nv = !track.hasClass("on");
      track.toggleClass("on", nv); track.toggleClass("off", !nv);
      track.setAttribute("aria-checked", String(nv));
      config.onToggle(nv);
    };
    track.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    track.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(); } });
    card.addEventListener("click", () => toggle());
  }

  /* ═══ Stats Computation（真实数据） ═══ */
  private todayStr(): string {
    return moment().format("YYYY-MM-DD");
  }

  private todayGroups(): DayGroup[] {
    const t = this.todayStr();
    return this.groups.filter(g => g.date === t);
  }

  /** 连续记录天数：从今天（或昨天）向前连续有条目的天数 */
  private computeStreak(): number {
    const dates = new Set(this.groups.map(g => g.date));
    const cursor = moment();
    if (!dates.has(cursor.format("YYYY-MM-DD"))) cursor.subtract(1, "days");
    let streak = 0;
    while (dates.has(cursor.format("YYYY-MM-DD"))) {
      streak++;
      cursor.subtract(1, "days");
    }
    return streak;
  }

  private computeStats(): StatCard[] {
    const today = this.todayGroups();
    const todayEntries = today.flatMap(g => g.entries);

    const memosToday = todayEntries.filter(e => e.renderType === "memos").length;

    // 计划进度：有子计划的组按子计划数量计数（与今日面板进度条口径一致）
    let planDone = 0;
    let planTotal = 0;
    todayEntries.filter(e => e.renderType === "plans").forEach(e => {
      const p = planTodoProgress(e.todos ?? []);
      planDone += p.done;
      planTotal += p.total;
    });

    const t = this.todayStr();
    // 今日应打卡的习惯 = 未归档且今天是执行日（休息日不计入分母）
    const activeHabits = this.habitConfigs.filter(h => !h.archived && isExecuteDay(h, t));
    const habitsDone = activeHabits.filter(h => checkinState(this.checkinRows, h.id, t, h.executeDays) === "checked").length;

    const totalEntries = this.groups.reduce((n, g) => n + g.entries.length, 0);

    return [
      { icon: "pen-line", label: "今日闪念", value: String(memosToday), sublabel: "条", accent: true },
      { icon: "check-square", label: "今日计划", value: `${planDone}/${planTotal}`, sublabel: "已完成" },
      { icon: "droplet", label: "今日习惯", value: `${habitsDone}/${activeHabits.length}`, sublabel: "已打卡" },
      { icon: "flame", label: "连续记录", value: String(this.computeStreak()), sublabel: "天" },
      { icon: "notebook-pen", label: "总条目", value: String(totalEntries), sublabel: `${this.groups.length} 天有记录` },
    ];
  }

  private computeExtendedStats(): StatCard[] {
    const weekStart = moment().subtract(6, "days").format("YYYY-MM-DD");
    const t = this.todayStr();
    const allEntries = this.groups.flatMap(g => g.entries);
    const weekEntries = allEntries.filter(e => e.date >= weekStart && e.date <= t);

    let doneTodos = 0;
    let allTodoCount = 0;
    allEntries.filter(e => e.renderType === "plans").forEach(e => {
      const p = planTodoProgress(e.todos ?? []);
      doneTodos += p.done;
      allTodoCount += p.total;
    });
    const rate = allTodoCount > 0 ? Math.round((doneTodos / allTodoCount) * 100) : 0;

    const tags = new Set<string>();
    allEntries.forEach(e => e.tags?.forEach(tag => tags.add(tag)));

    const weekCheckins = this.checkinRows.filter(r => !r.skipped && r.date >= weekStart && r.date <= t).length;

    return [
      ...this.computeStats(),
      { icon: "calendar-days", label: "本周记录", value: String(weekEntries.length), sublabel: "条", accent: true },
      { icon: "check-check", label: "计划完成率", value: `${rate}%`, sublabel: `${doneTodos}/${allTodoCount} 项` },
      { icon: "hash", label: "标签使用", value: String(tags.size), sublabel: "个不同标签" },
      { icon: "droplets", label: "本周打卡", value: String(weekCheckins), sublabel: "次" },
    ];
  }
}

/** 兼容壳：旧 workspace 布局里恢复的独立标签页视图类型，内容复用 DashboardPage */
export class DashboardView extends ItemView {
  plugin: DaybookPlugin;
  private page: DashboardPage | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DaybookPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return VIEW_TYPE_DASHBOARD; }
  getDisplayText(): string { return "Daybook Dashboard"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen() {
    this.page = new DashboardPage(this.app, this.plugin, this.containerEl.children[1] as HTMLElement, this.containerEl);
    await this.page.open();
  }
  async onClose() {
    this.page?.close();
    this.page = null;
  }
}
