/**
 * memoSearch.ts — 章节搜索弹窗（flomo 式：全屏搜索 + 快捷筛选 pills + 底部筛选抽屉）
 *
 * 默认承载闪念 / 计划这类「记录流」章节：读日记条目 + matchEntry 出结果，
 * 关键词与 pills 经 onApply 写回章节筛选（TodayPanel.filter + refresh）。
 * 习惯 / 记账 / 追剧的数据不在记录流里，通过 load / onPick 注入各自的搜索与跳转逻辑，
 * 外观与交互（输入防抖、结果预览、回车确认）保持一致。
 *
 * 关键词：空格分隔多词，全部命中（AND），300ms 防抖；
 * 快捷 pills：无标签 / 有链接 / 有图片 / 有语音 / 那年今日 / 今天，可多选 AND；
 * 「筛选」按钮展开该章节既有的 FilterPanel（仅记录流章节提供）。
 */
import { Modal, setIcon, debounce, moment } from "obsidian";
import type DaybookPlugin from "./main";
import { collectTags } from "./filters";
import { readAllJournalEntries, type JournalEntry } from "./fileReader";
import { emptyFilter, type SectionFilter } from "./filters";
import { FilterPanel } from "./FilterPanel";
import type { SectionConfig } from "./settings";

/** 快捷 pills 定义（value 对应 SectionFilter.quick 里的标记） */
const QUICK_PILLS: { value: string; label: string; icon: string }[] = [
  { value: "noneTag", label: "无标签", icon: "tag-off" },
  { value: "hasLink", label: "有链接", icon: "link" },
  { value: "hasImage", label: "有图片", icon: "image" },
  { value: "hasAudio", label: "有语音", icon: "mic" },
  { value: "onThisDay", label: "那年今日", icon: "calendar-heart" },
  { value: "today", label: "今天", icon: "calendar-check" },
];

/** 一条搜索结果：date 为左侧短标签，text 为主文本，meta / badge 补充分类与金额等 */
export interface SearchHit {
  id: string;
  date?: string;
  text: string;
  meta?: string;
  badge?: string;
  /** badge 配色（记账的收入 / 支出 / 转账） */
  badgeTone?: "in" | "out" | "tr";
}

export interface SearchResult {
  hits: SearchHit[];
}

export interface SearchPill {
  value: string;
  label: string;
  icon: string;
}

export interface MemoSearchOptions {
  plugin: DaybookPlugin;
  section: SectionConfig;
  /** 初始关键词（来自此前输入） */
  initialKeyword: string;
  /** 初始快捷筛选（来自此前输入） */
  initialQuick?: string[];
  /** 应用搜索状态（视图把关键词与 pills 写入章节筛选并刷新记录流） */
  onApply: (keyword: string, quick: string[]) => void;
  /** 输入框占位，默认「搜索闪念，空格分隔多个关键词」 */
  placeholder?: string;
  /** 结果计数单位，默认「条结果」 */
  unit?: string;
  /** 快捷 pills；不传 = 闪念那组，传 [] = 不显示 */
  pills?: SearchPill[];
  /** 自定义结果加载（不传 = 读日记条目 + matchEntry） */
  load?: (keyword: string, quick: string[]) => Promise<SearchResult>;
  /** 点击结果行；不传 = 应用关键词并关闭 */
  onPick?: (hit: SearchHit) => void;
  /** 是否提供筛选抽屉（默认 true；数据不在记录流里的章节传 false） */
  filterable?: boolean;
}

export class MemoSearchModal extends Modal {
  private keyword: string;
  private quick: string[];
  private opts: MemoSearchOptions;
  private resultEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private filterPanel: FilterPanel | null = null;
  private filterHost: HTMLElement | null = null;
  private resultTimer = 0;
  /** 结果请求序号：异步加载回来时只认最后一次输入 */
  private seq = 0;
  private hits: SearchHit[] = [];

  constructor(app: any, opts: MemoSearchOptions) {
    super(app);
    this.opts = opts;
    this.keyword = opts.initialKeyword;
    this.quick = [...(opts.initialQuick ?? [])];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("db-memo-search");

    // 顶部搜索栏：输入框 + 筛选漏斗 + 取消
    const bar = contentEl.createDiv({ cls: "db-memo-search-bar" });
    const inputWrap = bar.createDiv({ cls: "db-memo-search-input" });
    setIcon(inputWrap.createDiv({ cls: "db-memo-search-icon" }), "search");
    const input = inputWrap.createEl("input", {
      cls: "db-memo-search-input-el",
      attr: {
        type: "text",
        placeholder: this.opts.placeholder ?? "搜索闪念，空格分隔多个关键词",
      },
    });
    input.value = this.keyword;
    if (this.opts.filterable !== false) {
      const funnel = makeBtn(bar, "sliders-horizontal", "展开/收起筛选", () => this.toggleFilterPanel());
      funnel.addClass("db-memo-search-funnel");
    }
    makeBtn(bar, "x", "关闭搜索", () => this.close()).addClass("db-memo-search-close");

    // 快捷筛选 pills（多选 AND）
    const pillDefs = this.opts.pills ?? QUICK_PILLS;
    const pills = contentEl.createDiv({ cls: "db-memo-search-pills" });
    if (pillDefs.length === 0) pills.remove();
    pillDefs.forEach(p => {
      const active = this.quick.includes(p.value);
      const pill = pills.createDiv({
        cls: `db-memo-pill${active ? " is-active" : ""}`,
        attr: { role: "button", "aria-pressed": String(active), "aria-label": p.label },
      });
      setIcon(pill.createDiv({ cls: "db-memo-pill-icon" }), p.icon);
      pill.createSpan({ cls: "db-memo-pill-label", text: p.label });
      pill.addEventListener("click", () => {
        const on = this.quick.includes(p.value);
        this.quick = on ? this.quick.filter(v => v !== p.value) : [...this.quick, p.value];
        pill.toggleClass("is-active", !on);
        pill.setAttribute("aria-pressed", String(!on));
        this.scheduleSearch();
      });
    });

    // 结果计数 + 筛选面板宿主 + 结果预览列表
    this.countEl = contentEl.createDiv({ cls: "db-memo-search-count" });
    this.filterHost = contentEl.createDiv({ cls: "db-memo-search-filter-host" });
    this.resultEl = contentEl.createDiv({ cls: "db-memo-search-results" });

    // 输入防抖 300ms 搜索
    input.addEventListener("input", debounce(() => {
      this.keyword = input.value;
      this.scheduleSearch();
    }, 300, true));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") this.commit();
    });

    this.scheduleSearch();
    activeWindow.setTimeout(() => input.focus(), 50);
  }

  /** 关键词/pills → 筛选条件，即时刷新计数与预览；确认时回写视图 */
  private scheduleSearch() {
    if (this.resultTimer) activeWindow.clearTimeout(this.resultTimer);
    this.resultTimer = activeWindow.setTimeout(() => void this.runSearch(), 60);
  }

  private buildFilter(): SectionFilter {
    const f = emptyFilter();
    const words = this.keyword.trim().split(/\s+/).filter(Boolean);
    // 复用关键词 AND 语义：q 传空格分隔原文
    f.q = words.join(" ");
    f.tags = [];
    f.quick = [...this.quick];
    f.status = "active";
    return f;
  }

  private async runSearch() {
    const seq = ++this.seq;
    this.countEl?.setText("搜索中…");
    let hits: SearchHit[] = [];
    try {
      if (this.opts.load) {
        const res = await this.opts.load(this.keyword.trim(), [...this.quick]);
        hits = res.hits;
      } else {
        hits = await this.searchEntries();
      }
    } catch { /* 读取失败显示空 */ }
    // 输入已经变过 / 弹窗已关：丢弃过期结果
    if (seq !== this.seq || !this.contentEl.isConnected) return;

    this.hits = hits;
    this.countEl?.setText(`${hits.length} ${this.opts.unit ?? "条结果"}`);
    if (this.resultEl) {
      this.resultEl.empty();
      hits.slice(0, 20).forEach(hit => {
        const rich = !!(hit.meta || hit.badge);
        const row = this.resultEl!.createDiv({
          cls: `db-memo-search-hit${rich ? " is-rich" : ""}`,
        });
        if (hit.date) row.createSpan({ cls: "db-memo-search-hit-date", text: hit.date });
        const main = row.createDiv({ cls: "db-memo-search-hit-main" });
        main.createSpan({ cls: "db-memo-search-hit-text", text: hit.text });
        if (hit.meta) main.createSpan({ cls: "db-memo-search-hit-meta", text: hit.meta });
        if (hit.badge) {
          row.createSpan({
            cls: `db-memo-search-hit-badge${hit.badgeTone ? ` is-${hit.badgeTone}` : ""}`,
            text: hit.badge,
          });
        }
        row.addEventListener("click", () => this.pick(hit));
      });
      if (!hits.length) {
        this.resultEl.createDiv({
          cls: "db-memo-search-empty",
          text: this.keyword.trim() ? "没有找到匹配的内容" : "这里还没有内容",
        });
      } else if (hits.length > 20) {
        this.resultEl.createDiv({
          cls: "db-memo-search-more",
          text: this.opts.onPick
            ? `… 共 ${hits.length} ${this.opts.unit ?? "条"}，回车打开第一条`
            : `… 共 ${hits.length} 条，回车查看全部`,
        });
      }
    }
  }

  /** 记录流章节（闪念 / 计划）：读日记条目并按章节筛选匹配 */
  private async searchEntries(): Promise<SearchHit[]> {
    const { plugin, section } = this.opts;
    const f = this.buildFilter();
    const today = moment().format("YYYY-MM-DD");
    const groups = await readAllJournalEntries(this.app, plugin.settings, new Set([section.id]));
    const { matchEntry } = await import("./filters");
    const entries: JournalEntry[] = groups
      .flatMap(g => g.entries)
      .filter(e => matchEntry(e, f, today));
    return entries.map(e => ({
      id: e.id,
      date: e.date === today ? (e.time ?? "今天") : e.date.slice(5),
      text: e.text.replace(/#/g, "＃").slice(0, 80),
    }));
  }

  /** 点结果：跳转型（记账 / 追剧）交给 onPick，记录流章节则应用关键词并关闭 */
  private pick(hit: SearchHit) {
    if (this.opts.onPick) {
      this.opts.onPick(hit);
      this.close();
      return;
    }
    this.applyAndClose();
  }

  /** 展开/收起底部筛选抽屉（复用章节 FilterPanel，条件直接写入章节筛选） */
  private toggleFilterPanel() {
    if (this.filterPanel) {
      this.filterPanel.destroy();
      this.filterPanel = null;
      this.filterHost?.empty();
      return;
    }
    const host = this.filterHost;
    if (!host) return;
    host.empty();
    const { plugin, section, onApply } = this.opts;
    void (async () => {
      let tags: { tag: string; count: number }[] = [];
      try {
        const groups = await readAllJournalEntries(this.app, plugin.settings, new Set([section.id]));
        tags = collectTags(groups.flatMap(g => g.entries));
      } catch { /* 标签候选读不到时仅静态维度可用 */ }
      if (!this.contentEl.isConnected) return;
      this.filterPanel = new FilterPanel({
        host,
        plugin,
        section,
        filter: plugin.getJournalView()?.getFilter(section.id) ?? emptyFilter(),
        tags,
        onChange: () => this.scheduleSearch(),
        onRequestClose: () => this.toggleFilterPanel(),
      });
      void onApply;
    })();
  }

  /** 回车：跳转型打开第一条结果；记录流章节应用关键词 */
  private commit() {
    if (this.opts.onPick) {
      if (this.hits.length) this.pick(this.hits[0]);
      return;
    }
    this.applyAndClose();
  }

  /** 确认：把关键词 + pills 写回视图（FilterPanel 的条件已实时写入章节筛选） */
  private applyAndClose() {
    this.opts.onApply(this.keyword, this.quick);
    this.close();
  }

  onClose() {
    this.filterPanel?.destroy();
    this.filterPanel = null;
    this.contentEl.empty();
  }
}

function makeBtn(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
  const b = parent.createDiv({
    cls: "db-memo-search-btn",
    attr: { role: "button", tabindex: "0", "aria-label": label },
  });
  setIcon(b, icon);
  b.addEventListener("click", onClick);
  return b;
}
