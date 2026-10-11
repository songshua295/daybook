/**
 * memoSidebar.ts — 闪念侧边抽屉（flomo 式：统计 3 格 + 记录热力图 + 标签树）
 *
 * 数据全部来自当前章节的闪念条目（不依赖 file.ctime，按条目真实日期统计）；
 * 从视图左侧滑出，点击标签 = 应用该标签筛选并关闭抽屉。
 */
import { Menu, Modal, setIcon, moment, TFile } from "obsidian";
import { renderMarkdown } from "./renderMarkdown";
import type DaybookPlugin from "./main";
import { readAllJournalEntries, type JournalEntry } from "./fileReader";
import { collectTags } from "./filters";
import type { SectionConfig } from "./settings";

export interface MemoSidebarOptions {
  plugin: DaybookPlugin;
  section: SectionConfig;
  onClose: () => void;
  /** 点击标签 → 应用筛选（复用记录流的标签点击管线） */
  onTagClick: (tag: string) => void;
  /** 「全部闪念」→ 清空章节筛选并刷新 */
  onResetFilters: () => void;
  /** 点击热力图格子 → 按该日期筛选记录流 */
  onDateClick?: (date: string) => void;
}

export class MemoSidebar {
  private opts: MemoSidebarOptions;
  /** 挂载到视图根容器的浮层（含遮罩） */
  private overlay: HTMLElement | null = null;

  constructor(opts: MemoSidebarOptions) {
    this.opts = opts;
  }

  open() {
    const root = this.opts.plugin.getJournalView()?.containerEl.children[1] as HTMLElement | undefined;
    if (!root) return;
    const overlay = root.createDiv({ cls: "db-memo-sidebar-overlay" });
    this.overlay = overlay;
    overlay.addEventListener("click", () => this.close());

    const drawer = overlay.createDiv({ cls: "db-memo-sidebar" });
    drawer.addEventListener("click", e => e.stopPropagation());

    // 头部：关闭 + 标题（✕ 在左好点，标题靠右；与筛选抽屉同布局）
    const head = drawer.createDiv({ cls: "db-memo-sidebar-head" });
    const closeBtn = head.createDiv({
      cls: "db-memo-sidebar-close",
      attr: { role: "button", "aria-label": "关闭" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());
    head.createSpan({ cls: "db-memo-sidebar-title", text: this.opts.section.label });

    const body = drawer.createDiv({ cls: "db-memo-sidebar-body" });
    const loading = body.createDiv({ cls: "db-memo-sidebar-loading", text: "统计中…" });
    void (async () => {
      let entries: JournalEntry[] = [];
      try {
        const groups = await readAllJournalEntries(this.app(), this.opts.plugin.settings, new Set([this.opts.section.id]));
        entries = groups.flatMap(g => g.entries).filter(e => !e.archived);
      } catch { /* 统计失败显示空 */ }
      if (!overlay.isConnected) return;
      loading.remove();
      this.renderStats(body, entries);
      this.renderNav(body, entries);
      this.renderHeatmap(body, entries);
      this.renderTagTree(body, entries);
    })();
  }

  private app(): any {
    return this.opts.plugin.app;
  }

  close() {
    this.overlay?.remove();
    this.overlay = null;
    this.opts.onClose();
  }

  /** 统计 3 格：闪念总数 / 标签数 / 连续记录天数 */
  private renderStats(body: HTMLElement, entries: JournalEntry[]) {
    const tags = collectTags(entries);
    const dates = new Set(entries.map(e => e.date));
    let streak = 0;
    const cursor = moment();
    while (dates.has(cursor.format("YYYY-MM-DD"))) {
      streak++;
      cursor.subtract(1, "day");
    }
    const grid = body.createDiv({ cls: "db-memo-stats" });
    ([[String(entries.length), "闪念"], [String(tags.length), "标签"], [String(streak), "连续天数"]] as [string, string][])
      .forEach(([num, label]) => {
        const item = grid.createDiv({ cls: "db-memo-stat" });
        item.createDiv({ cls: "db-memo-stat-num", text: num });
        item.createDiv({ cls: "db-memo-stat-label", text: label });
      });
  }

  /** 近半年热力图（周一开列，格子按抽屉宽度均分铺满；底部标注月份） */
  private renderHeatmap(body: HTMLElement, entries: JournalEntry[]) {
    const counts = new Map<string, number>();
    entries.forEach(e => counts.set(e.date, (counts.get(e.date) ?? 0) + 1));

    const WEEKS = 22; // 约半年
    const wrap = body.createDiv({ cls: "db-memo-heatmap" });
    wrap.createDiv({ cls: "db-memo-heatmap-title", text: "记录热力" });
    const today = moment();
    const lastColStart = today.clone().subtract((today.isoWeekday() + 6) % 7, "days"); // 本周周一
    const start = lastColStart.clone().subtract(WEEKS - 1, "weeks");
    const end = lastColStart.clone().add(6, "days");
    const cols: string[][] = [];
    for (let d = start.clone(); d.valueOf() <= end.valueOf(); d.add(1, "day")) {
      const col = cols[cols.length - 1];
      if (!col || col.length === 7) cols.push([d.format("YYYY-MM-DD")]);
      else col.push(d.format("YYYY-MM-DD"));
    }
    const todayStr = today.format("YYYY-MM-DD");
    const grid = wrap.createDiv({ cls: "db-memo-heatmap-grid" });
    const monthRow = wrap.createDiv({ cls: "db-memo-heatmap-months" });
    let first = true;
    cols.forEach(col => {
      const colEl = grid.createDiv({ cls: "db-memo-heatmap-col" });
      col.forEach(ds => {
        const n = counts.get(ds) ?? 0;
        const level = n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : 3;
        const cell = colEl.createDiv({ cls: `db-memo-heatmap-cell lv${level}` });
        cell.setAttribute("aria-label", `${ds} · ${n} 条`);
        if (ds === todayStr) cell.addClass("today");
        // 点击格子 → 筛选并显示该日期的闪念（再次点击同日 = 取消，由视图侧处理）
        const onDateClick = this.opts.onDateClick;
        if (onDateClick) {
          cell.addClass("clickable");
          cell.addEventListener("click", () => {
            this.close();
            onDateClick(ds);
          });
        }
      });
      // 月份标注：该列包含某月 1 号（或为首列）时标出——
      // 标注值取该列实际包含的 1 号所属月份（1 号多在列中间，列首日常仍是上月）
      const labelEl = monthRow.createDiv({ cls: "db-memo-heatmap-month" });
      const firstOfMonth = col.find(ds => moment(ds).date() === 1);
      if (first || firstOfMonth) {
        labelEl.setText(`${moment(firstOfMonth ?? col[0]).month() + 1}月`);
      }
      first = false;
    });
  }
  /** 标签树：按 "/" 建层级（子级缩进），行尾计数，点击 = 筛选该标签 */
  private renderTagTree(body: HTMLElement, entries: JournalEntry[]) {
    const tags = collectTags(entries);
    const sec = body.createDiv({ cls: "db-memo-tags" });
    sec.createDiv({ cls: "db-memo-tags-title", text: "全部标签" });
    if (tags.length === 0) {
      sec.createDiv({ cls: "db-memo-tags-empty", text: "还没有标签，记录时输入 #标签 吧～" });
      return;
    }
    const list = sec.createDiv({ cls: "db-memo-tag-list" });
    tags.forEach(({ tag, count }) => {
      const depth = tag.split("/").length - 1;
      const row = list.createDiv({
        cls: `db-memo-tag-row depth-${depth}`,
        attr: { role: "button", "aria-label": `筛选标签 ${tag}` },
      });
      row.createSpan({ cls: "db-memo-tag-name", text: `# ${tag}` });
      row.createSpan({ cls: "db-memo-tag-count", text: String(count) });
      row.addEventListener("click", () => {
        this.close();
        this.opts.onTagClick(tag);
      });
    });
  }

  /** 导航菜单：全部闪念（清筛选）/ 随机漫步 */
  private renderNav(body: HTMLElement, entries: JournalEntry[]) {
    const nav = body.createDiv({ cls: "db-memo-nav" });
    const all = nav.createDiv({ cls: "db-memo-nav-item is-active" });
    all.createSpan({ cls: "db-memo-nav-label", text: "全部闪念" });
    all.addEventListener("click", () => {
      this.close();
      this.opts.onResetFilters();
    });
    const random = nav.createDiv({ cls: "db-memo-nav-item" });
    random.createSpan({ cls: "db-memo-nav-label", text: "随机漫步" });
    random.addEventListener("click", () => {
      if (entries.length === 0) { this.close(); return; }
      this.close();
      RandomMemoModal.show(this.app(), this.opts.plugin, entries);
    });
  }
}

/** 随机漫步卡片弹窗：随机展示一条闪念，可连抽 / 打开原文 */
class RandomMemoModal extends Modal {
  private entries: JournalEntry[];
  private current: JournalEntry;
  private bodyEl: HTMLElement | null = null;

  private constructor(app: any, private plugin: import("./main").default, entries: JournalEntry[]) {
    super(app);
    this.entries = entries;
    this.current = entries[Math.floor(Math.random() * entries.length)];
  }

  static show(app: any, plugin: import("./main").default, entries: JournalEntry[]) {
    new RandomMemoModal(app, plugin, entries).open();
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("db-random-memo");
    const head = this.contentEl.createDiv({ cls: "db-random-memo-head" });
    head.createSpan({ cls: "db-random-memo-title", text: "随机漫步" });
    head.createSpan({ cls: "db-random-memo-count", text: `共 ${this.entries.length} 条` });
    this.bodyEl = this.contentEl.createDiv({ cls: "db-random-memo-body" });
    const btns = this.contentEl.createDiv({ cls: "db-random-memo-btns" });
    const again = this.contentEl.createEl("button", { cls: "db-random-memo-btn", text: "再来一条" });
    again.addEventListener("click", () => this.renderRandom());
    const open = this.contentEl.createEl("button", {
      cls: "db-random-memo-btn mod-cta",
      text: "打开原文",
    });
    open.addEventListener("click", () => {
      const file = this.app.vault.getAbstractFileByPath(this.current.filePath);
      if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
      this.close();
    });
    void btns;
    this.renderRandom();
  }

  private renderRandom() {
    if (!this.bodyEl) return;
    this.current = this.entries[Math.floor(Math.random() * this.entries.length)];
    this.bodyEl.empty();
    const e = this.current;
    const meta = this.bodyEl.createDiv({ cls: "db-random-memo-meta" });
    meta.createSpan({ text: e.date === moment().format("YYYY-MM-DD") ? (e.time ?? "今天") : `${e.date}${e.time ? " " + e.time : ""}` });
    if (e.sectionLabel) meta.createSpan({ text: e.sectionLabel });
    const body = this.bodyEl.createDiv({ cls: "db-random-memo-text" });
    void renderMarkdown(this.app, e.text, body, { sourcePath: e.filePath, component: this.plugin, lazyThreshold: 10 });
  }

  onClose() {
    this.contentEl.empty();
  }
}
