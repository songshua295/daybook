import { ItemView, WorkspaceLeaf, setIcon, moment } from "obsidian";
import type DaybookPlugin from "./main";

export const VIEW_TYPE_DASHBOARD = "daybook-dashboard-view";

/* ════════════════════════════════════════════════════════
   DashboardView — Apple HIG × Obsidian Native
   零依赖 · 纯 DOM API · setIcon(Lucide)
   ════════════════════════════════════════════════════════ */

interface SegmentTab { id: string; label: string; icon: string; }
interface StatCard { icon: string; label: string; value: string; sublabel?: string; accent?: boolean; }
interface ToggleConfig { icon: string; title: string; subtitle: string; enabled: boolean; onToggle: (v: boolean) => void; }
interface SliderConfig { icon: string; title: string; subtitle: string; min: number; max: number; step: number; value: number; unit: string; onChange: (v: number) => void; }

export class DashboardView extends ItemView {
  plugin: DaybookPlugin;
  private activeTab = "overview";
  private rootEl!: HTMLElement;
  private dashState = { autoSave: true, syncMode: false, compactView: false, fontSize: 15, maxEntries: 50 };

  constructor(leaf: WorkspaceLeaf, plugin: DaybookPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return VIEW_TYPE_DASHBOARD; }
  getDisplayText(): string { return "Daybook Dashboard"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen() { this.render(); }
  async onClose() { /* cleanup */ }

  /* ── 主渲染 ── */
  render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty(); root.setAttribute("class", "db-root"); this.rootEl = root;
    this.buildHeader(root);
    this.buildSegmentedControl(root);
    const content = root.createDiv({ cls: "db-content" });
    this.renderActiveTab(content);
  }

  /* ═══ 1. Header Bar ═══ */
  private buildHeader(root: HTMLElement) {
    const header = root.createDiv({ cls: "db-header" });
    const titleGroup = header.createDiv({ cls: "db-header-title-group" });
    const title = titleGroup.createDiv({ cls: "db-header-title" });
    setIcon(title, "book-open");
    title.createSpan({ text: "Daybook", cls: "db-header-title-text" });
    titleGroup.createDiv({ cls: "db-header-date", text: moment().format("YYYY年MM月DD日 · dddd") });

    const actions = header.createDiv({ cls: "db-header-actions" });
    const refreshBtn = this.createIconButton(actions, "refresh-cw", "刷新");
    refreshBtn.addEventListener("click", () => this.render());
    this.createIconButton(actions, "settings-2", "设置");
  }

  private createIconButton(parent: HTMLElement, icon: string, ariaLabel: string): HTMLElement {
    const btn = parent.createDiv({ cls: "db-icon-btn", attr: { "aria-label": ariaLabel, role: "button", tabindex: "0" } });
    setIcon(btn, icon);
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

    tabs.forEach((tab, index) => {
      const seg = control.createDiv({ cls: `db-segment ${this.activeTab === tab.id ? "active" : ""}`, attr: { role: "button", tabindex: "0", "aria-label": tab.label } });
      const iconEl = seg.createDiv({ cls: "db-segment-icon" });
      setIcon(iconEl, tab.icon);
      seg.createSpan({ text: tab.label, cls: "db-segment-label" });

      seg.addEventListener("click", () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        indicator.style.transform = `translateX(${index * 100}%)`;
        control.querySelectorAll(".db-segment").forEach((el, i) => el.toggleClass("active", i === index));
        const content = this.rootEl.querySelector(".db-content") as HTMLElement;
        if (content) { content.empty(); this.renderActiveTab(content); }
      });
    });
    const activeIndex = tabs.findIndex(t => t.id === this.activeTab);
    indicator.style.transform = `translateX(${activeIndex * 100}%)`;
  }

  /* ═══ Tab Router ═══ */
  private renderActiveTab(container: HTMLElement) {
    if (this.activeTab === "overview") this.renderOverviewTab(container);
    else if (this.activeTab === "controls") this.renderControlsTab(container);
    else this.renderStatsTab(container);
  }

  /* ═══ Tab: Overview ═══ */
  private renderOverviewTab(container: HTMLElement) {
    this.buildStatGrid(container, this.computeStats());
    const st = container.createDiv({ cls: "db-section-title" });
    setIcon(st, "zap"); st.createSpan({ text: "快速开关" });
    this.buildToggleCard(container, { icon: "cloud-upload", title: "自动保存", subtitle: "编辑后自动写入日记文件", enabled: this.dashState.autoSave, onToggle: v => { this.dashState.autoSave = v; } });
    this.buildToggleCard(container, { icon: "smartphone", title: "紧凑视图", subtitle: "移动端减少间距，显示更多内容", enabled: this.dashState.compactView, onToggle: v => { this.dashState.compactView = v; this.rootEl.toggleClass("db-compact", v); } });
  }

  /* ═══ Tab: Controls ═══ */
  private renderControlsTab(container: HTMLElement) {
    const tt = container.createDiv({ cls: "db-section-title" });
    setIcon(tt, "toggle-left"); tt.createSpan({ text: "开关控制" });
    this.buildToggleCard(container, { icon: "cloud-upload", title: "自动保存", subtitle: "编辑后自动写入日记文件", enabled: this.dashState.autoSave, onToggle: v => { this.dashState.autoSave = v; } });
    this.buildToggleCard(container, { icon: "refresh-cw", title: "实时同步", subtitle: "多设备间自动同步日记数据", enabled: this.dashState.syncMode, onToggle: v => { this.dashState.syncMode = v; } });
    this.buildToggleCard(container, { icon: "smartphone", title: "紧凑视图", subtitle: "移动端减少间距，显示更多内容", enabled: this.dashState.compactView, onToggle: v => { this.dashState.compactView = v; this.rootEl.toggleClass("db-compact", v); } });
    const st = container.createDiv({ cls: "db-section-title" });
    setIcon(st, "sliders-horizontal"); st.createSpan({ text: "参数调节" });
    this.buildSliderCard(container, { icon: "type", title: "字体大小", subtitle: "调整日记正文字体大小", min: 12, max: 22, step: 1, value: this.dashState.fontSize, unit: "px", onChange: v => { this.dashState.fontSize = v; } });
    this.buildSliderCard(container, { icon: "list-ordered", title: "最大条目数", subtitle: "阅读视图每页显示的最大条目数", min: 10, max: 200, step: 5, value: this.dashState.maxEntries, unit: "条", onChange: v => { this.dashState.maxEntries = v; } });
  }

  /* ═══ Tab: Stats ═══ */
  private renderStatsTab(container: HTMLElement) {
    const extended: StatCard[] = [
      ...this.computeStats(),
      { icon: "flame", label: "连续记录", value: "7", sublabel: "天", accent: true },
      { icon: "calendar-check", label: "本月完成率", value: "82%", sublabel: "高于上月 5%" },
      { icon: "trending-up", label: "本周趋势", value: "↑ 12%", sublabel: "记录频率上升" },
      { icon: "clock", label: "平均时长", value: "3.2", sublabel: "分钟/条" },
      { icon: "hash", label: "标签使用", value: "24", sublabel: "个不同标签" },
      { icon: "link", label: "双链引用", value: "18", sublabel: "条内部链接" },
    ];
    this.buildStatGrid(container, extended);
    const st = container.createDiv({ cls: "db-section-title" });
    setIcon(st, "activity"); st.createSpan({ text: "近期活动" });
    const card = container.createDiv({ cls: "db-activity-card" });
    const acts = [
      { icon: "pen-line", text: "添加了 3 条闪念", time: "2 分钟前" },
      { icon: "check-check", text: "完成了 2 项待办", time: "1 小时前" },
      { icon: "file-text", text: "创建了今日日记", time: "今天 09:30" },
      { icon: "star", text: "标记了 1 条重要记录", time: "昨天" },
    ];
    acts.forEach(a => {
      const row = card.createDiv({ cls: "db-activity-row" });
      const iw = row.createDiv({ cls: "db-activity-icon" }); setIcon(iw, a.icon);
      row.createDiv({ cls: "db-activity-text", text: a.text });
      row.createDiv({ cls: "db-activity-time", text: a.time });
    });
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

  /* ═══ Component: Toggle Switch Card (Apple HIG) ═══ */
  private buildToggleCard(parent: HTMLElement, config: ToggleConfig) {
    const card = parent.createDiv({ cls: "db-toggle-card" });
    const left = card.createDiv({ cls: "db-toggle-left" });
    const iw = left.createDiv({ cls: "db-toggle-icon" }); setIcon(iw, config.icon);
    const tw = left.createDiv({ cls: "db-toggle-text" });
    tw.createDiv({ cls: "db-toggle-title", text: config.title });
    tw.createDiv({ cls: "db-toggle-subtitle", text: config.subtitle });
    const sw = card.createDiv({ cls: "db-toggle-switch-wrap" });
    const track = sw.createDiv({ cls: `db-toggle-track ${config.enabled ? "on" : "off"}`, attr: { role: "switch", "aria-checked": String(config.enabled), tabindex: "0" } });
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

  /* ═══ Component: Sleek Slider Card (Apple HIG) ═══ */
  private buildSliderCard(parent: HTMLElement, config: SliderConfig) {
    const card = parent.createDiv({ cls: "db-slider-card" });
    // Header row
    const header = card.createDiv({ cls: "db-slider-header" });
    const left = header.createDiv({ cls: "db-slider-left" });
    const iw = left.createDiv({ cls: "db-slider-icon" }); setIcon(iw, config.icon);
    const tw = left.createDiv({ cls: "db-slider-text" });
    tw.createDiv({ cls: "db-slider-title", text: config.title });
    tw.createDiv({ cls: "db-slider-subtitle", text: config.subtitle });
    // Value badge
    const badge = header.createDiv({ cls: "db-slider-badge" });
    badge.createSpan({ cls: "db-slider-badge-value", text: String(config.value) });
    badge.createSpan({ cls: "db-slider-badge-unit", text: config.unit });

    // Slider track
    const trackWrap = card.createDiv({ cls: "db-slider-track-wrap" });
    const track = trackWrap.createDiv({ cls: "db-slider-rail" });
    const fill = track.createDiv({ cls: "db-slider-fill" });
    const thumb = track.createDiv({ cls: "db-slider-thumb" });

    // Range input (invisible, for accessibility + native touch)
    const range = trackWrap.createEl("input", {
      cls: "db-slider-range",
      attr: { type: "range", min: String(config.min), max: String(config.max), step: String(config.step), value: String(config.value), "aria-label": config.title },
    });

    const updateUI = (val: number) => {
      const pct = ((val - config.min) / (config.max - config.min)) * 100;
      fill.style.width = `${pct}%`;
      thumb.style.left = `${pct}%`;
      badge.querySelector(".db-slider-badge-value")!.textContent = String(val);
    };

    updateUI(config.value);

    range.addEventListener("input", () => {
      const val = parseFloat(range.value);
      updateUI(val);
      config.onChange(val);
    });

    // Prevent card click from interfering
    card.addEventListener("click", (e) => e.stopPropagation());
  }

  /* ═══ Stats Computation ═══ */
  private computeStats(): StatCard[] {
    return [
      { icon: "pen-line", label: "今日闪念", value: "12", sublabel: "条", accent: true },
      { icon: "check-square", label: "待办计划", value: "5", sublabel: "2 已完成" },
      { icon: "notebook-pen", label: "总日记", value: "128", sublabel: "篇" },
      { icon: "sparkles", label: "心情指数", value: "8.2", sublabel: "本周均值" },
    ];
  }
}
