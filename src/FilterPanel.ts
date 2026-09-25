/**
 * FilterPanel.ts — 章节内容筛选面板（顶栏「筛选」按钮下方挂出的托盘）
 *
 * 只渲染当前章节类型相关的维度：闪念=心情/标签/链接/附件，计划=完成度/优先级/逾期，
 * 记账=收支/分类/金额，习惯=今日打卡态/应打卡/期间有打卡。条件改动即时回调视图重跑筛选。
 *
 * 交互约定（全面板统一，别破例）：
 * - 一行＝一个维度，左侧导栏是维度名，右侧是可选值；导栏在生效时加 is-set（字色变实）。
 * - 选项里不出现「全部 / 不限」这种空操作按钮：再点一次已选中的值＝回到默认。
 * - 顶部吸附行是唯一的强调元素：大号结果条数 + 清空。
 */

import type DaybookPlugin from "./main";
import type { SectionConfig } from "./settings";
import { setIcon } from "obsidian";
import { PRIORITY_META, PRIORITY_EMOJI, type PriorityLevel } from "./fileReader";
import {
  emptyFilter,
  activeDimensions,
  type SectionFilter,
  type Presence,
} from "./filters";

/** 让 div 具备按钮的键盘可达性（与 JournalView.makeActivatable 同规则，独立以免循环依赖） */
function activatable<T extends HTMLElement>(el: T, ariaLabel: string): T {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", ariaLabel);
  el.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); el.click(); }
  });
  return el;
}

export interface FilterPanelOptions {
  host: HTMLElement;
  plugin: DaybookPlugin;
  section: SectionConfig;
  /** 面板直接读写该对象（由视图持有，切换章节时各自保留） */
  filter: SectionFilter;
  /** 该章节已出现过的标签（含使用次数） */
  tags: { tag: string; count: number }[];
  /** 记账分类候选（设置项 + 历史出现过的） */
  categories: string[];
  /** 条件变化 → 视图重跑筛选 */
  onChange: () => void;
  /** 收起面板 */
  onRequestClose: () => void;
}

interface Opt { value: string; label: string; count?: number; tip?: string }

export class FilterPanel {
  private opts: FilterPanelOptions;
  private root: HTMLElement;
  private body: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private lastCount: number | null = null;
  private lastDays = 0;
  private qTimer = 0;

  constructor(opts: FilterPanelOptions) {
    this.opts = opts;
    this.root = opts.host.createDiv({ cls: "db-filter-panel" });
    this.render();
    // Esc 收起面板（与顶栏筛选按钮的开合等价）
    this.root.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); opts.onRequestClose(); }
    });
  }

  destroy(): void {
    this.opts.host.empty();
  }

  /** 结果条数回填（null 表示读取中） */
  setCount(n: number | null, days: number): void {
    this.lastCount = n;
    this.lastDays = days;
    this.paintCount();
  }

  private get f(): SectionFilter { return this.opts.filter; }
  private get type(): SectionConfig["type"] { return this.opts.section.type; }
  /** 有任一维度生效＝跨历史筛选；否则只看今日记录流 */
  private get filtering(): boolean { return activeDimensions(this.f).length > 0; }

  private changed(): void {
    this.render();
    this.opts.onChange();
  }

  private paintCount(): void {
    const el = this.countEl;
    if (!el) return;
    el.empty();
    if (this.lastCount === null) {
      el.createSpan({ cls: "db-filter-count-unit", text: "正在查历史记录…" });
      return;
    }
    el.createSpan({ cls: "db-filter-count-num", text: String(this.lastCount) });
    const unit = this.type === "habits"
      ? "个习惯"
      : this.filtering ? "条" : "条今日记录";
    el.createSpan({ cls: "db-filter-count-unit", text: unit });
    if (this.filtering && this.lastDays > 1) {
      el.createSpan({ cls: "db-filter-count-unit db-filter-count-span", text: `跨 ${this.lastDays} 天` });
    }
  }

  /* ── 行 / 控件构建 ── */

  /**
   * 一行＝一个维度：`导栏 | 值区`。
   * @param label  维度名；留空＝整行（搜索框用）
   * @param active 该维度已生效 → 行加 is-set，导栏字色变实
   */
  private row(label?: string, active = false): { main: HTMLElement; values: HTMLElement } {
    const r = this.body!.createDiv({
      cls: "db-filter-row" + (label ? "" : " is-full") + (active ? " is-set" : ""),
    });
    if (label) r.createDiv({ cls: "db-filter-row-label", text: label });
    const main = r.createDiv({ cls: "db-filter-row-main" });
    const values = main.createDiv({ cls: "db-filter-values" });
    return { main, values };
  }

  private chip(parent: HTMLElement, o: Opt, active: boolean, onClick: () => void): HTMLElement {
    const c = activatable(parent.createDiv({ cls: "db-filter-chip" + (active ? " active" : "") }),
      `${o.tip ?? o.label}${active ? "（已选中，再点取消）" : ""}`);
    c.createSpan({ cls: "db-filter-chip-text", text: o.label });
    if (o.count !== undefined && o.count > 0) {
      c.createSpan({ cls: "db-filter-chip-n", text: String(o.count) });
    }
    if (active) c.setAttribute("aria-pressed", "true");
    c.addEventListener("click", onClick);
    return c;
  }

  /**
   * 单选维度。只给「会让结果变少」的取值，不写「全部/不限」：
   * 点当前选中项即回到 none（＝该维度失效）。
   */
  private single(
    label: string,
    options: Opt[],
    current: string,
    none: string,
    set: (v: string) => void,
    hint?: string,
  ): HTMLElement {
    const value = current === none ? "" : current;
    const { main, values } = this.row(label, value !== "");
    options.forEach(o => this.chip(values, o, value === o.value, () => set(value === o.value ? none : o.value)));
    if (hint) main.createDiv({ cls: "db-filter-hint", text: hint });
    return main;
  }

  /** 多选维度；候选为空时只留一行提示（不渲染空行） */
  private multi(label: string, options: Opt[], values: string[], toggle: (v: string) => void, emptyTip?: string): void {
    if (options.length === 0 && !emptyTip) return;
    const { main, values: box } = this.row(label, values.length > 0);
    options.forEach(o => this.chip(box, o, values.includes(o.value), () => toggle(o.value)));
    if (options.length === 0) main.createDiv({ cls: "db-filter-hint", text: emptyTip });
  }

  /** 三态「有无」：只露 有 / 无 两个值 */
  private presence(label: string, value: Presence, set: (v: Presence) => void, withTip: string): void {
    this.single(label, [
      { value: "with", label: "有", tip: `只看有${withTip}的记录` },
      { value: "without", label: "无", tip: `只看没有${withTip}的记录` },
    ], value, "any", v => set(v as Presence));
  }

  /** 布尔维度一行（如 📌 只看置顶） */
  private toggle(label: string, o: Opt, on: boolean, set: (v: boolean) => void): void {
    const { values } = this.row(label, on);
    this.chip(values, o, on, () => set(!on));
  }

  /* ── 渲染 ── */

  private render(): void {
    const host = this.root;
    host.empty();

    /* 顶部吸附行：本面板唯一的强调元素（大号条数 + 右侧清空） */
    const head = host.createDiv({ cls: "db-filter-head" });
    this.countEl = head.createDiv({ cls: "db-filter-count", attr: { "aria-live": "polite" } });
    if (this.filtering) {
      const clear = activatable(head.createDiv({ cls: "db-filter-reset", text: "清空筛选" }), "清空全部筛选条件");
      clear.addEventListener("click", () => {
        Object.assign(this.opts.filter, emptyFilter());
        this.changed();
      });
    }

    this.body = host.createDiv({ cls: "db-filter-body" });
    this.paintCount();

    /* 关键词 */
    const { values: qBox } = this.row();
    qBox.addClass("db-filter-values-q");
    const wrap = qBox.createDiv({ cls: "db-filter-qwrap" });
    setIcon(wrap.createDiv({ cls: "db-filter-q-icon" }), "search");
    const input = wrap.createEl("input", {
      cls: "db-filter-q",
      type: "search",
      placeholder: this.qPlaceholder(),
      attr: { "aria-label": "关键词搜索（空格分隔多关键词）" },
    });
    input.value = this.f.q;
    input.addEventListener("input", () => {
      const v = input.value;
      activeWindow.clearTimeout(this.qTimer);
      this.qTimer = activeWindow.setTimeout(() => {
        this.f.q = v;
        this.opts.onChange();
      }, 220);
    });
    if (this.f.q) {
      const x = activatable(wrap.createDiv({ cls: "db-filter-clear-q", text: "×" }), "清空关键词");
      x.addEventListener("click", () => { this.f.q = ""; this.changed(); });
    }

    /* 日期范围：不选即不限（在全部历史里筛） */
    const presets: Opt[] = [
      { value: "today", label: "今天", tip: "只看今天" },
      { value: "7d", label: "近 7 天", tip: "只看近 7 天" },
      { value: "30d", label: "近 30 天", tip: "只看近 30 天" },
      { value: "month", label: "本月", tip: "只看本月" },
      { value: "lastmonth", label: "上月", tip: "只看上月" },
      { value: "custom", label: "自定义", tip: "自己填起止日期" },
    ];
    const dateMain = this.single(this.type === "habits" ? "期间打卡" : "日期", presets,
      this.f.datePreset, "", v => {
        this.f.datePreset = v as SectionFilter["datePreset"];
        this.changed();
      }, this.f.datePreset ? undefined
        : this.type === "habits" ? "不选＝看整个记录期间" : "不选日期＝在全部历史里筛");
    if (this.f.datePreset === "custom") {
      const range = dateMain.createDiv({ cls: "db-filter-range" });
      const from = range.createEl("input", { cls: "db-filter-date", type: "date", attr: { "aria-label": "起始日期" } });
      from.value = this.f.dateFrom;
      from.addEventListener("change", () => { this.f.dateFrom = from.value; this.opts.onChange(); });
      range.createSpan({ cls: "db-filter-dash", text: "–" });
      const to = range.createEl("input", { cls: "db-filter-date", type: "date", attr: { "aria-label": "结束日期" } });
      to.value = this.f.dateTo;
      to.addEventListener("change", () => { this.f.dateTo = to.value; this.opts.onChange(); });
    }

    /* 类型专属维度 */
    if (this.type === "memos") this.renderMemos();
    else if (this.type === "plans") this.renderPlans();
    else if (this.type === "expenses") this.renderExpenses();
    else if (this.type === "habits") this.renderHabits();

    /* 标签（记录类章节；习惯章节的对象不是日记条目） */
    if (this.type !== "habits") {
      this.multi("标签", this.opts.tags.map(t => ({
        value: t.tag, label: `#${t.tag}`, count: t.count, tip: `标签 ${t.tag}`,
      })), this.f.tags, v => {
        this.f.tags = this.f.tags.includes(v) ? this.f.tags.filter(x => x !== v) : [...this.f.tags, v];
        this.changed();
      }, this.opts.tags.length === 0 ? "这个章节还没出现过 #标签" : undefined);

      this.presence("链接", this.f.links, v => { this.f.links = v; this.changed(); }, "链接（双链 / 外链）");
      this.presence("附件", this.f.attachments, v => { this.f.attachments = v; this.changed(); }, "图片 / 音视频附件");
    }

    /* 归档态 + 置顶（四类章节的记录都可归档/置顶） */
    this.single("状态", [
      { value: "active", label: "进行中", tip: "只看未归档" },
      { value: "archived", label: "已归档", tip: "只看已归档" },
    ], this.f.status, "all", v => { this.f.status = v as SectionFilter["status"]; this.changed(); });
    if (this.type !== "habits") {   // 习惯本身没有置顶概念
      this.toggle("置顶", { value: "pin", label: "只看", tip: "只看置顶记录" },
        this.f.pinnedOnly, v => { this.f.pinnedOnly = v; this.changed(); });
    }
  }

  private qPlaceholder(): string {
    switch (this.type) {
      case "plans": return "搜索任务，空格分隔多关键词（如：报告 周五）";
      case "expenses": return "搜索备注内容";
      case "habits": return "搜索习惯名或打卡备注";
      default: return `搜索${this.opts.section.label}，空格分隔多关键词`;
    }
  }

  /* ── 各类型专属行 ── */

  private renderMemos(): void {
    const moods = this.opts.plugin.settings.customMoods ?? [];
    this.multi("心情", moods.map(m => ({
      value: m.emoji, label: `${m.emoji} ${m.label}`, tip: `心情 ${m.label}`,
    })), this.f.moods, v => {
      this.f.moods = this.f.moods.includes(v) ? this.f.moods.filter(x => x !== v) : [...this.f.moods, v];
      this.changed();
    });
  }

  private renderPlans(): void {
    this.single("完成度", [
      { value: "undone", label: "未完成", tip: "只看还有未勾选任务的" },
      { value: "done", label: "已完成", tip: "只看全部勾选的" },
    ], this.f.completion, "all", v => { this.f.completion = v as SectionFilter["completion"]; this.changed(); });

    this.multi("重要程度", (["1", "2", "3", "4"] as PriorityLevel[]).map(p => ({
      value: p,
      label: `${PRIORITY_EMOJI[p]} ${PRIORITY_META[p].numeral}`,
      tip: `优先级 ${PRIORITY_META[p].numeral} · ${PRIORITY_META[p].label}`,
    })), this.f.priorities, v => {
      this.f.priorities = this.f.priorities.includes(v) ? this.f.priorities.filter(x => x !== v) : [...this.f.priorities, v];
      this.changed();
    });

    const { values } = this.row("截止", this.f.overdueOnly || this.f.dueOnly);
    this.chip(values, { value: "overdue", label: "已逾期", tip: "只看超过截止日且未完成" },
      this.f.overdueOnly, () => { this.f.overdueOnly = !this.f.overdueOnly; this.changed(); });
    this.chip(values, { value: "due", label: "设了截止日", tip: "只看设置了截止日期的任务" },
      this.f.dueOnly, () => { this.f.dueOnly = !this.f.dueOnly; this.changed(); });
  }

  private renderExpenses(): void {
    this.single("收支", [
      { value: "expense", label: "支出", tip: "只看支出" },
      { value: "income", label: "收入", tip: "只看收入" },
    ], this.f.kinds, "all", v => { this.f.kinds = v as SectionFilter["kinds"]; this.changed(); });

    const cats = [...new Set([...this.opts.plugin.settings.expenseCategories, ...this.opts.categories])];
    this.multi("分类", cats.map(c => ({ value: c, label: c, tip: `分类 ${c}` })), this.f.categories, v => {
      this.f.categories = this.f.categories.includes(v) ? this.f.categories.filter(x => x !== v) : [...this.f.categories, v];
      this.changed();
    });

    const { main, values } = this.row("金额", !!(this.f.minAmount || this.f.maxAmount));
    const min = values.createEl("input", {
      cls: "db-filter-num", type: "text", placeholder: "最低",
      attr: { "aria-label": "金额下限", inputmode: "decimal" },
    });
    min.value = this.f.minAmount;
    min.addEventListener("input", () => { this.f.minAmount = min.value; this.opts.onChange(); });
    values.createSpan({ cls: "db-filter-dash", text: "–" });
    const max = values.createEl("input", {
      cls: "db-filter-num", type: "text", placeholder: "最高",
      attr: { "aria-label": "金额上限", inputmode: "decimal" },
    });
    max.value = this.f.maxAmount;
    max.addEventListener("input", () => { this.f.maxAmount = max.value; this.opts.onChange(); });
    if (this.f.minAmount || this.f.maxAmount) {
      main.createDiv({ cls: "db-filter-hint", text: "收支两边按绝对值比较" });
    }
  }

  private renderHabits(): void {
    this.single("今日打卡", [
      { value: "checked", label: "已打卡", tip: "今天已打过卡" },
      { value: "none", label: "未打卡", tip: "今天还没打卡" },
      { value: "skipped", label: "已跳过", tip: "今天标记了跳过" },
      { value: "rest", label: "休息日", tip: "今天不是执行日" },
    ], this.f.checkins, "all", v => { this.f.checkins = v as SectionFilter["checkins"]; this.changed(); });

    this.toggle("应打卡", { value: "today", label: "今天该做", tip: "排除今天不用执行的习惯" },
      this.f.shouldToday, v => { this.f.shouldToday = v; this.changed(); });
  }
}
