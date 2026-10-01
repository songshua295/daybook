/**
 * memoSearch.ts — 闪念搜索弹窗（flomo 式：全屏搜索 + 快捷筛选 pills + 底部筛选抽屉）
 *
 * 关键词：空格分隔多词，全部命中（AND），300ms 防抖；
 * 快捷 pills：无标签 / 有链接 / 有图片 / 有语音 / 那年今日 / 今天，可多选 AND；
 * 「筛选」按钮展开该章节既有的 FilterPanel（日期范围/标签/内容维度齐全），本弹窗只承载宿主。
 * 结果经 onApply 回调交由视图走既有筛选管线（TodayPanel.filter + refresh）。
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

export interface MemoSearchOptions {
  plugin: DaybookPlugin;
  section: SectionConfig;
  /** 初始关键词（来自此前输入） */
  initialKeyword: string;
  /** 应用搜索状态（视图把关键词与 pills 写入章节筛选并刷新记录流） */
  onApply: (keyword: string, quick: string[]) => void;
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

  constructor(app: any, opts: MemoSearchOptions) {
    super(app);
    this.opts = opts;
    this.keyword = opts.initialKeyword;
    this.quick = [];
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
      attr: { type: "text", placeholder: "搜索闪念，空格分隔多个关键词" },
    });
    input.value = this.keyword;
    const funnel = makeBtn(bar, "sliders-horizontal", "展开/收起筛选", () => this.toggleFilterPanel());
    funnel.addClass("db-memo-search-funnel");
    makeBtn(bar, "x", "关闭搜索", () => this.close()).addClass("db-memo-search-close");

    // 快捷筛选 pills（多选 AND）
    const pills = contentEl.createDiv({ cls: "db-memo-search-pills" });
    QUICK_PILLS.forEach(p => {
      const pill = pills.createDiv({
        cls: "db-memo-pill",
        attr: { role: "button", "aria-pressed": "false", "aria-label": p.label },
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
      if (e.key === "Enter") this.applyAndClose();
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
    const { plugin, section } = this.opts;
    const f = this.buildFilter();
    const today = moment().format("YYYY-MM-DD");
    let hits: JournalEntry[] = [];
    try {
      const groups = await readAllJournalEntries(this.app, plugin.settings, new Set([section.id]));
      const { matchEntry } = await import("./filters");
      hits = groups.flatMap(g => g.entries).filter(e => matchEntry(e, f, today));
    } catch { /* 读取失败显示空 */ }
    if (!this.contentEl.isConnected) return;

    this.countEl?.setText(`${hits.length} 条结果`);
    if (this.resultEl) {
      this.resultEl.empty();
      hits.slice(0, 20).forEach(e => {
        const row = this.resultEl!.createDiv({ cls: "db-memo-search-hit" });
        row.createSpan({
          cls: "db-memo-search-hit-date",
          text: e.date === today ? (e.time ?? "今天") : e.date.slice(5),
        });
        const text = e.text.replace(/#/g, "＃").slice(0, 80);
        row.createSpan({ cls: "db-memo-search-hit-text", text });
        row.addEventListener("click", () => this.applyAndClose());
      });
      if (hits.length > 20) {
        this.resultEl.createDiv({ cls: "db-memo-search-more", text: `… 共 ${hits.length} 条，回车查看全部` });
      }
    }
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
