/**
 * dramaPage.ts — 追剧（drama）章节的页内 UI
 *
 * 结构：列表页（状态筛选 + 剧集卡片）+ 编辑二级页（页内整页替换，不弹浮层、不新开标签）。
 * 安卓返回键经 popstate 哨兵先退出编辑页，再交回 Obsidian。
 *
 * 编辑页是「属性页」：一行 = 图标 + 字段名（左）/ 值（右）。文本类的值本身就是输入框，
 * 就地改、随内容长高（不弹控件、不重绘行）；封面 / 链接点值就地展开控件，
 * 状态点值弹锚定菜单（Notion select 的交互）。
 * 点左侧字段名弹菜单，勾选它在本章列表卡片上显不显示（与「···」→ 显示字段 同一套开关）。
 * 安卓输入：按字段给 inputmode、回车按行序跳下一格（末行收键盘）、点空白处收键盘。
 *
 * 编辑页还是「草稿式」：字段改动只更新内存里的草稿，落库由出口决定——
 * 「确定」直接保存并收起；「返回」在真的改过（与打开时比）时先问「保存 / 不保存」，
 * 没改过就直接回列表；新建但连标题都没填时没什么可存，也直接回列表。
 * 删除走确认弹窗；列表页的「加一集」是一步动作，立刻写盘并只就地改写卡片数字，不重建封面。
 */
import { App, Menu, Modal, Notice, Platform, moment, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { ConfirmModal } from "./TodayPanel";
import { NotionMultiSelect, NotionSelect, notionChipColor } from "./notionSelect";
import {
  DramaFieldKey, DramaShow, DramaStatus, DramaStore, STATUS_INFO, STATUS_ORDER,
  coverList, dramaFieldOn, newDramaShow, progressOf,
} from "./dramaStore";
import {
  coverColor, coverInitial, pickLocalImageFile, pickVaultCover, resolveCover,
  tidyCoverInput, uploadCoverImage,
} from "./dramaCover";
import { PromptModal } from "./ledgerCategoryUI";
import { keywordMatch } from "./filters";
import type { SearchHit } from "./memoSearch";

type StatusFilter = "all" | DramaStatus;
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "全部" },
  ...STATUS_ORDER.map(k => ({ key: k as StatusFilter, label: STATUS_INFO[k].label })),
];

/** 让 div 伪按钮键盘可访问 */
function tappable(el: HTMLElement, ariaLabel: string, run: () => void): void {
  el.addClass("is-tap");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", ariaLabel);
  el.addEventListener("click", run);
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); run(); }
  });
}

const isUrl = (s: string): boolean => /^(https?:\/\/|obsidian:\/\/)/i.test(s.trim());

/** 链接太长在属性行里会撑破，去掉协议只留可读主体 */
function shortUrl(url: string): string {
  const raw = url.trim();
  if (/^obsidian:\/\//i.test(raw)) return "库内文件";
  const body = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return body.length > 34 ? `${body.slice(0, 34)}…` : body;
}

/** 编辑页（属性页）里的行；一次只有一行处于编辑态 */
type EditorRow =
  | "cover" | "title" | "originalName" | "category" | "tags" | "status"
  | "episodes" | "totalEpisodes" | "next" | "douban" | "finishedAt";

/** field 有值 = 这一行对应列表卡片上的某个可显隐字段（点字段名可切换） */
interface RowDef {
  key: EditorRow;
  icon: string;
  label: string;
  field?: DramaFieldKey;
}

const EDITOR_ROWS: RowDef[] = [
  { key: "cover", icon: "image", label: "封面", field: "cover" },
  { key: "title", icon: "text", label: "标题" },
  { key: "originalName", icon: "languages", label: "原名 / 别名", field: "originalName" },
  { key: "category", icon: "film", label: "影视类型", field: "category" },
  { key: "tags", icon: "list", label: "标签", field: "tags" },
  { key: "status", icon: "flag", label: "状态", field: "status" },
  { key: "episodes", icon: "hash", label: "集数", field: "episodes" },
  { key: "totalEpisodes", icon: "sigma", label: "总集数" },
  { key: "next", icon: "play", label: "下一集直达", field: "next" },
  { key: "douban", icon: "link", label: "豆瓣 URL", field: "douban" },
  { key: "finishedAt", icon: "calendar", label: "看完时间", field: "dates" },
];

/**
 * 文本类属性：值本身就是输入框，直接在上面改、随内容长高，
 * 不做「展示态 ↔ 弹个输入框」的切换（切换会把行撑高、把键盘顶掉）。
 * 其余几类各有自己的控件：封面（选图按钮）、状态（Notion 下拉）、
 * 影视类型（Notion 下拉 + 可新建）、标签（Notion 多选）、链接（可点 + 铅笔）。
 */
const FIELD_ROWS: EditorRow[] = [
  "title", "originalName", "episodes", "totalEpisodes", "finishedAt",
];

/** textarea 高度跟随内容：先放开量一次自然高度再写回（overflow:hidden 保证不出滚动条） */
function sizeField(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * 只输数字也能得到日期：满 4 位在年后补 "-"，满 6 位在月后补 "-"，最多留 8 位数字。
 * 安卓配合 inputmode=numeric 就是「20261029 → 2026-10-29」，不用切符号键盘找横杠。
 */
function formatDateDigits(raw: string): string {
  const d = raw.replace(/[^\d]/g, "").slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}

/** 卡片里「加一集」需要就地改写的节点（封面不在里面，避免重新加载抖动）；字段被关掉时对应节点就不存在 */
interface CardRefs {
  card: HTMLElement;
  statusEl: HTMLElement | null;
  countEl: HTMLElement | null;
  datesEl: HTMLElement | null;
  fillEl: HTMLElement | null;
  pctEl: HTMLElement | null;
}

/** 计数文案：有总集数写「12 / 1250」，未定写「12 集」 */
function countText(s: DramaShow): string {
  return `${s.episodes}${s.totalEpisodes > 0 ? ` / ${s.totalEpisodes}` : " 集"}`;
}

/** 时间行文案：看完的显示看完日期，其余显示添加日期 */
function datesText(s: DramaShow): string {
  return s.finishedAt ? `看完于 ${s.finishedAt}` : `添加于 ${moment(s.createdAt).format("YYYY-MM-DD")}`;
}

/** 草稿指纹：只比业务字段，时间戳不参与「是否改过」的判断 */
function draftKey(s: DramaShow): string {
  return JSON.stringify({ ...s, createdAt: 0, updatedAt: 0 });
}

/**
 * 退出编辑页时的「保存 / 不保存」询问。
 * 只有这两个按钮：点遮罩或 ESC 关闭视为反悔，留在编辑页继续改。
 */
class DramaExitModal extends Modal {
  constructor(
    app: App,
    private onSave: () => void,
    private onDiscard: () => void,
    private onClosed: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("h3", { text: "要保存这次的修改吗？" });
    el.createEl("p", { text: "选「不保存」会放弃这一轮的改动，直接回到追剧列表。" });
    const btns = el.createDiv({ cls: "db-mood-modal-btns" });
    const no = btns.createEl("button", { text: "不保存", attr: { type: "button" } });
    no.onclick = () => { this.close(); this.onDiscard(); };
    const yes = btns.createEl("button", { text: "保存", cls: "mod-cta", attr: { type: "button" } });
    yes.onclick = () => { this.close(); this.onSave(); };
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }
}

export class DramaPage {
  /** 每次渲染后通知宿主（JournalView 用它同步 AI 悬浮球显隐：编辑二级页开着要收起） */
  onRendered: (() => void) | null = null;

  private store: DramaStore;
  private filter: StatusFilter = "all";
  /** 编辑中的草稿（null = 在列表页）；哨兵让返回键先退出编辑页 */
  private editing: DramaShow | null = null;
  private editSentinelArmed = false;
  /** 新建条目第一次落库后转 false，后续改动走 update */
  private editIsNew = false;
  /** 打开编辑页 / 上次保存时的指纹，用来判断「这一轮到底改没改」 */
  private editSaved = "";
  /** 询问弹窗已经开着就别再叠一层（返回键连按） */
  private exitAsking = false;
  private destroyed = false;
  private onPop: (e: PopStateEvent) => void;
  /** 列表页当前挂载的卡片节点引用（id → 可局部更新的片段） */
  private cards: Record<string, CardRefs> = {};
  /** 本次视图已解码过的封面 src → 原图宽高比：重渲染时跳过占位层，避免相框闪一下 */
  private coverCache: Record<string, number> = {};
  /** 多封面时随机展示的下标（一次会话内同一部剧稳定，重绘不换图） */
  private coverPick: Record<string, number> = {};
  /** 编辑页封面行是否展开成「全部封面 + 增删」；未展开只显示一张随机小图 */
  private coverOpen = false;

  constructor(
    private app: App,
    private plugin: DaybookPlugin,
    private host: HTMLElement,
  ) {
    this.store = new DramaStore(app, plugin.settings);
    this.onPop = () => {
      if (!this.editing) return;
      if (this.hasEdits()) {
        // 返回键否决不了，只能把哨兵续上：让弹窗决定去留，选完再由 closeEditor 退掉
        if (Platform.isMobileApp) {
          window.history.pushState({ daybookBack: "drama-editor" }, "");
          this.editSentinelArmed = true;
        }
        this.askExit();
        return;
      }
      this.editSentinelArmed = false;
      this.editing = null;
      this.render();
    };
    window.addEventListener("popstate", this.onPop);
    /* 键盘弹起 / 收起、可视区几何变化时重新校准：正在输入的那一行必须露在键盘上沿之上，
       否则会「输入到一半看不到自己在改哪个字」。 */
    const sync = () => this.revealTypingRow();
    /* Obsidian 收缩工作区 / webview 自身随键盘调整都会走到 resize */
    this.listen(window, "resize", sync);
    const vp = window.visualViewport;
    if (vp) {
      this.listen(vp, "resize", sync);
      this.listen(vp, "scroll", sync);
    }
    /* 事件名只有 keyboardWillShow / keyboardWillHide 这一对（JournalView 用的就是它们），
       window 上并不存在 "keyboardDid…"，监听错名字等于没有监听。
       弹起：把这一行抬到键盘之上并淡出操作条；收起：就算焦点还留在文本格里，
       也要把那条透明的「返回 / 确定」放回来，不然用户会以为按钮丢了。 */
    this.listen(window, "keyboardWillShow", () => {
      if (!this.isInputFocused()) return;
      this.setTyping(true, this.host.ownerDocument.activeElement as HTMLElement);
    });
    this.listen(window, "keyboardWillHide", () => this.setTyping(false));
  }

  /** 注册一个需要成对清理的监听（本页不是 Component，拿不到 registerEvent） */
  private listen(target: EventTarget, type: string, fn: () => void): void {
    target.addEventListener(type, fn);
    this.kbCleanups.push(() => target.removeEventListener(type, fn));
  }

  async mount(): Promise<void> {
    await this.store.load();
    if (this.destroyed || !this.host.isConnected) return;
    this.render();
  }

  /** 字段显隐改完后由顶栏「···」面板调用：只重建列表，编辑页正开着时不打扰 */
  refresh(): void {
    if (this.destroyed || !this.host.isConnected || this.editing) return;
    this.render();
  }

  /** 当前是否停在编辑二级页（面板据此决定要不要即时刷新列表） */
  isEditing(): boolean {
    return !!this.editing;
  }

  /**
   * 顶栏搜索：按剧名 / 原名 / 类型 / 标签 / 状态 / 日期匹配。
   * 空关键词返回全部（弹窗打开时就有内容可看）。
   */
  searchShows(keyword: string): SearchHit[] {
    const q = keyword.trim();
    return this.store.shows
      .filter(s => !q || keywordMatch(this.showSearchText(s), q))
      .map((s): SearchHit => ({
        id: s.id,
        date: moment(s.updatedAt).format("YYYY-MM-DD").slice(5),
        text: s.title,
        meta: [
          s.originalName,
          s.category,
          s.tags.map(t => `#${t}`).join(" "),
          countText(s),
        ].filter(Boolean).join(" · "),
        badge: STATUS_INFO[s.status].label,
      }));
  }

  /** 搜索里点中的剧：直接进编辑二级页（与点卡片标题同一条路径） */
  openShowById(id: string): void {
    const s = this.store.byId(id);
    if (s) this.openEditor(s, false);
  }

  private showSearchText(s: DramaShow): string {
    return [
      s.title,
      s.originalName,
      s.category,
      s.tags.join(" "),
      STATUS_INFO[s.status].label,
      s.finishedAt,
      moment(s.createdAt).format("YYYY-MM-DD"),
      String(s.episodes),
      String(s.totalEpisodes),
      s.nextEpisodeUrl,
      s.doubanUrl,
    ].join("\n");
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener("popstate", this.onPop);
    this.kbCleanups.forEach(off => off());
    this.kbCleanups = [];
    if (this.typingReveal) { window.clearTimeout(this.typingReveal); this.typingReveal = null; }
    if (this.fieldsRo) { this.fieldsRo.disconnect(); this.fieldsRo = null; }
    this.actionsEl = null;
    this.typing = false;
    this.popCount = 0;
    this.host.removeClass("is-typing");
    this.host.removeClass("is-popping");
    if (this.editSentinelArmed && Platform.isMobileApp) window.history.back();
    this.editing = null;
    this.editSentinelArmed = false;
    this.exitAsking = false;
  }

  /* ────────────────────────── 渲染入口 ────────────────────────── */

  private render(): void {
    if (this.destroyed) return;
    const host = this.host;
    host.empty();
    host.addClass("db-drama-root");
    // 整页重建后旧的节点引用全部作废
    this.cards = {};
    this.actionsEl = null;
    /* 旧节点连同焦点一起没了，focusout 不会再触发：输入态必须在这里归零，
       否则淡出的操作条就再也不会回来 */
    this.typing = false;
    host.removeClass("is-typing");
    /* 浮层不在本次重建的树里，计数一并归零；旧浮层若还开着，关掉时会被钳回 0 */
    this.popCount = 0;
    host.removeClass("is-popping");
    /* editing 在进入 render 前已是终值：编辑二级页的进出在这里一并通知宿主 */
    this.onRendered?.();
    if (this.editing) { this.renderEditor(host); return; }
    if (this.fieldsRo) { this.fieldsRo.disconnect(); this.fieldsRo = null; }
    this.renderList(host);
  }

  /* ────────────────────────── 列表页 ────────────────────────── */

  private visibleShows(): DramaShow[] {
    return this.store.shows.filter(s => this.filter === "all" || s.status === this.filter);
  }

  private renderList(host: HTMLElement): void {
    const body = host.createDiv({ cls: "db-drama-body" });
    const counts = this.store.statusCounts();

    const head = body.createDiv({ cls: "db-drama-head" });
    head.createDiv({
      cls: "db-drama-sum",
      text: this.store.shows.length
        ? `共 ${this.store.shows.length} 部 · 追更中 ${counts.following} · 已完结 ${counts.done}`
        : "数据存在 追剧目录/shows.md",
    });
    const add = head.createEl("button", { cls: "db-drama-add", attr: { type: "button" } });
    setIcon(add.createSpan({ cls: "db-drama-add-icon" }), "plus");
    add.createSpan({ text: "新增剧集" });
    add.addEventListener("click", () => this.openEditor(newDramaShow(), true));

    const chips = body.createDiv({ cls: "db-drama-chips" });
    FILTERS.forEach(f => {
      const n = f.key === "all" ? this.store.shows.length : counts[f.key];
      const chip = chips.createEl("button", {
        cls: `db-drama-chip${this.filter === f.key ? " is-active" : ""}`,
        attr: { type: "button" },
      });
      chip.createSpan({ text: f.label });
      chip.createSpan({ cls: "db-drama-chip-n", text: String(n) });
      chip.addEventListener("click", () => {
        if (this.filter === f.key) return;
        this.filter = f.key;
        this.render();
      });
    });

    const shows = this.visibleShows();
    if (!shows.length) {
      body.createDiv({
        cls: "db-drama-empty",
        text: this.store.shows.length
          ? `没有「${FILTERS.find(f => f.key === this.filter)?.label ?? ""}」状态的剧。`
          : "还没有追剧记录，点「新增剧集」记下第一部，之后每天点「加一集」就行。",
      });
      return;
    }
    const list = body.createDiv({ cls: "db-drama-list" });
    shows.forEach(s => this.showCard(list, s));
  }

  /** 卡片：按 settings.dramaFields 决定显示哪些字段（标题和「加一集」恒定） */
  private showCard(parent: HTMLElement, show: DramaShow): void {
    const on = (key: DramaFieldKey): boolean => dramaFieldOn(this.plugin.settings.dramaFields, key);
    const card = parent.createDiv({ cls: `db-drama-card${on("cover") ? "" : " is-bare"}` });
    // 「加一集」之后 store 里换成新对象，交互一律按 id 现取，别拿着渲染时的旧快照
    const fresh = (): DramaShow | null => this.store.byId(show.id);
    const openEdit = (): void => { const cur = fresh(); if (cur) this.openEditor(cur, false); };
    const s = show;

    if (on("cover")) {
      const cover = card.createDiv({ cls: "db-drama-cover" });
      this.paintCover(cover, s);
      tappable(cover, `编辑《${s.title}》`, openEdit);
    }

    const main = card.createDiv({ cls: "db-drama-main" });

    const titleRow = main.createDiv({ cls: "db-drama-title-row" });
    const titleBtn = titleRow.createEl("button", {
      cls: "db-drama-title-btn",
      attr: { type: "button", "aria-label": `编辑《${s.title}》` },
    });
    titleBtn.createSpan({ cls: "db-drama-title", text: s.title });
    if (on("originalName") && s.originalName) titleBtn.createSpan({ cls: "db-drama-original", text: s.originalName });
    titleBtn.addEventListener("click", openEdit);
    const statusEl = on("status")
      ? titleRow.createSpan({
        cls: `db-drama-status is-${STATUS_INFO[s.status].tone}`,
        text: STATUS_INFO[s.status].label,
      })
      : null;
    /* Notion 数据库卡片的内联属性编辑：点状态徽标弹锚定菜单就地改，不进编辑页 */
    if (statusEl) tappable(statusEl, `修改《${s.title}》状态`, () => this.openCardStatusMenu(statusEl, s.id));

    const pills = main.createDiv({ cls: "db-drama-pills" });
    if (on("category") && s.category) pills.createSpan({ cls: "db-drama-cat", text: s.category });
    if (on("tags")) s.tags.forEach(t => pills.createSpan({ cls: "db-drama-tag", text: t }));
    if (!pills.children.length) pills.remove();

    const prog = main.createDiv({ cls: "db-drama-prog" });
    const meta = prog.createDiv({ cls: "db-drama-meta" });
    const countEl = on("episodes") ? meta.createSpan({ cls: "db-drama-count", text: countText(s) }) : null;
    let fillEl: HTMLElement | null = null;
    let pctEl: HTMLElement | null = null;
    if (on("progress") && s.totalEpisodes > 0) {
      const frac = progressOf(s);
      const bar = meta.createDiv({ cls: "db-drama-bar" });
      fillEl = bar.createDiv({ cls: "db-drama-fill" });
      fillEl.style.width = `${Math.round(frac * 1000) / 10}%`;
      pctEl = meta.createSpan({ cls: "db-drama-pct", text: `${Math.round(frac * 100)}%` });
    }
    const datesEl = on("dates") ? meta.createSpan({ cls: "db-drama-dates", text: datesText(s) }) : null;
    if (!meta.children.length) prog.remove();

    const foot = main.createDiv({ cls: "db-drama-foot" });
    const bump = foot.createEl("button", { cls: "db-drama-bump", attr: { type: "button", "aria-label": `《${s.title}》加一集` } });
    setIcon(bump.createSpan({ cls: "db-drama-bump-icon" }), "plus");
    bump.createSpan({ text: "加一集" });
    bump.addEventListener("click", () => void this.bump(s.id));
    if (on("next") && isUrl(s.nextEpisodeUrl)) {
      const next = foot.createEl("button", { cls: "db-drama-link", attr: { type: "button", "aria-label": `打开《${s.title}》下一集` } });
      setIcon(next.createSpan({ cls: "db-drama-link-icon" }), "play");
      next.createSpan({ text: "下一集" });
      next.addEventListener("click", () => { const cur = fresh(); void this.openUrl(cur ? cur.nextEpisodeUrl : s.nextEpisodeUrl); });
    }
    if (on("douban") && isUrl(s.doubanUrl)) {
      const db = foot.createEl("button", { cls: "db-drama-link is-secondary", attr: { type: "button", "aria-label": `打开《${s.title}》豆瓣页面` } });
      setIcon(db.createSpan({ cls: "db-drama-link-icon" }), "book-open");
      db.createSpan({ text: "豆瓣" });
      db.addEventListener("click", () => { const cur = fresh(); void this.openUrl(cur ? cur.doubanUrl : s.doubanUrl); });
    }

    /* 整卡可点（Notion 卡片的交互）：按钮、封面、状态徽标自己有行为，点其余空白处都进编辑 */
    card.addEventListener("click", (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest || t.closest("button, .db-drama-cover, .db-drama-status")) return;
      openEdit();
    });

    this.cards[s.id] = { card, statusEl, countEl, datesEl, fillEl, pctEl };
  }

  /**
   * 局部刷新：只改写计数 / 进度 / 状态 / 日期这几处文字，封面节点原样不动。
   * 「加一集」原本走整页 render，重建 img 会让封面重新解码闪一下。
   */
  private patchCard(s: DramaShow): boolean {
    const r = this.cards[s.id];
    if (!r) return false;
    if (r.card) r.card.toggleClass("is-bare", !dramaFieldOn(this.plugin.settings.dramaFields, "cover"));
    if (r.countEl) r.countEl.setText(countText(s));
    if (r.fillEl) {
      const pct = Math.round(progressOf(s) * 1000) / 10;
      r.fillEl.style.width = `${pct}%`;
      if (r.pctEl) r.pctEl.setText(`${Math.round(progressOf(s) * 100)}%`);
    }
    if (r.datesEl) r.datesEl.setText(datesText(s));
    const st = r.statusEl;
    if (st) {
      STATUS_ORDER.forEach(k => st.removeClass(`is-${STATUS_INFO[k].tone}`));
      st.addClass(`is-${STATUS_INFO[s.status].tone}`);
      st.setText(STATUS_INFO[s.status].label);
    }
    return true;
  }

  /**
   * 封面：固定 2:3 相框（小圆角 + 细边框），图片按原图比例择优呈现，而不是把原图甩上去。
   * 竖版海报直接裁切填满；横版 / 方形 / 超长图改用完整显示 + 自身模糊放大当底，
   * 避免把横海报硬裁成一条。比例要等图片解码完才知道，所以先挂 is-loading 占位。
   * 封面是文件类型可放多张：列表/未展开时只随机展示其中一张（一次会话内稳定，重绘不换图）。
   */
  private paintCover(box: HTMLElement, s: DramaShow): void {
    this.paintCoverInto(box, this.pickCoverRef(s), s.title);
  }

  /** 多封面时随机取一张：一次会话内同一部剧稳定（coverPick 记住下标），下次打开再随机 */
  private pickCoverRef(s: DramaShow): string {
    const list = coverList(s);
    if (!list.length) return "";
    let i = this.coverPick[s.id];
    if (i === undefined || i >= list.length) {
      i = Math.floor(Math.random() * list.length);
      this.coverPick[s.id] = i;
    }
    return list[i];
  }

  private paintCoverInto(box: HTMLElement, ref: string, title: string): void {
    const resolved = ref ? resolveCover(this.app, ref) : null;
    if (!resolved) { this.paintFallback(box, title); return; }
    // 这次会话已经解码过的封面：直接按上次的比例出图，不再铺占位（重渲染时就不闪一下）
    const known = this.coverCache[resolved.src];
    if (known === undefined) box.addClass("is-loading");
    else if (known > 0 && (known > 0.86 || known < 0.48)) box.addClass("is-fit");
    // 底图与主图同一个 src（浏览器复用缓存），仅在 is-fit 时可见，铺满后模糊成背景
    box.createEl("img", {
      cls: "db-drama-img is-bg",
      attr: { src: resolved.src, alt: "", "aria-hidden": "true", loading: "lazy" },
    });
    const img = box.createEl("img", {
      cls: "db-drama-img",
      attr: { src: resolved.src, alt: title, loading: "lazy" },
    });
    img.addEventListener("load", () => {
      box.removeClass("is-loading");
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      const ratio = w && h ? w / h : 0;
      if (known === undefined) this.coverCache[resolved.src] = ratio;
      if (!ratio) return;
      // 相框比例 2:3 ≈ 0.667，偏离太多就整体显示，否则裁切填满
      box.toggleClass("is-fit", ratio > 0.86 || ratio < 0.48);
    });
    img.addEventListener("error", () => {
      box.empty();
      this.paintFallback(box, title);
    });
  }

  /** 首字色块兜底：底色按标题哈希取（同一部剧颜色稳定），高光与内描边交给样式 */
  private paintFallback(box: HTMLElement, title: string): void {
    box.removeClass("is-loading");
    const block = box.createDiv({ cls: "db-drama-fallback", text: coverInitial(title) });
    block.style.background = coverColor(title);
  }

  private openUrl(url: string): void {
    const target = url.trim();
    if (!target) return;
    try {
      activeWindow.open(target, "_blank");
    } catch (e) {
      new Notice("无法打开链接");
    }
  }

  /**
   * 加一集：状态没变（没追到完结）时走局部刷新，只改数字和进度条；
   * 追完结局时状态、筛选、顶部计数都会变，才整页重建。
   */
  private async bump(id: string): Promise<void> {
    const cur = this.store.byId(id);
    if (!cur) return;
    const wasStatus = cur.status;
    const next = await this.store.bumpEpisode(id, moment().format("YYYY-MM-DD"));
    if (!next || this.destroyed || !this.host.isConnected || this.editing) return;
    if (wasStatus !== next.status || !this.patchCard(next)) this.render();
    new Notice(`《${next.title}》已看 ${next.episodes}${next.totalEpisodes > 0 ? ` / ${next.totalEpisodes}` : ""}`);
  }

  /** 列表卡片上直接改状态（Notion 数据库卡片的内联属性编辑）：搜索下拉，当前项打勾 */
  private openCardStatusMenu(anchor: HTMLElement, id: string): void {
    const cur = this.store.byId(id);
    if (!cur) return;
    new NotionSelect(anchor, {
      bindTrigger: true,
      options: STATUS_ORDER.map(k => ({ value: k, label: STATUS_INFO[k].label })),
      value: cur.status,
      searchPlaceholder: "搜索状态…",
      ariaLabel: `修改《${cur.title}》状态`,
      onSelect: v => void this.changeStatus(id, v as DramaStatus),
    }).open();
  }

  /** 状态就地落库：状态变了（牵动筛选和顶部计数）整页重建，没变只就地改卡片文字 */
  private async changeStatus(id: string, k: DramaStatus): Promise<void> {
    const cur = this.store.byId(id);
    if (!cur) return;
    const wasStatus = cur.status;
    await this.store.updateShow({
      ...cur,
      status: k,
      finishedAt: k === "done" && !cur.finishedAt ? moment().format("YYYY-MM-DD") : cur.finishedAt,
      updatedAt: Date.now(),
    });
    /* updateShow 不回读：落库后按 id 现取规范化后的条目 */
    const next = this.store.byId(id);
    if (!next || this.destroyed || !this.host.isConnected || this.editing) return;
    if (wasStatus !== next.status || !this.patchCard(next)) this.render();
  }

  /* ────────────────────────── 编辑二级页 ────────────────────────── */

  private openEditor(show: DramaShow, isNew: boolean): void {
    /* 新建回来的条目未必属于当前筛选状态（默认追更中），先把筛选回到「全部」，
       避免保存后回到列表看不到自己刚加的剧 */
    if (isNew) this.filter = "all";
    const draft: DramaShow = { ...show, tags: show.tags.slice() };
    this.editing = draft;
    this.editIsNew = isNew;
    this.editRow = null;
    this.coverOpen = false;   // 每次进编辑页封面行都从随机小图开始
    /* 指纹以磁盘上的条目为基准：草稿和它不一致才算「改过」 */
    this.editSaved = draftKey(isNew ? draft : (this.store.byId(show.id) ?? show));
    if (Platform.isMobileApp && !this.editSentinelArmed) {
      this.editSentinelArmed = true;
      window.history.pushState({ daybookBack: "drama-editor" }, "");
    }
    if (this.destroyed || !this.host.isConnected) return;
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  /** 这一轮草稿有没有实质改动；新建但标题还没填 = 没什么可存，算没改 */
  private hasEdits(): boolean {
    const s = this.editing;
    if (!s) return false;
    if (this.editIsNew && !s.title.trim()) return false;
    return draftKey(s) !== this.editSaved;
  }

  private closeEditor(reclaim = true): void {
    const armed = this.editSentinelArmed;
    this.editSentinelArmed = false;
    this.editing = null;
    this.editSaved = "";
    this.editRow = null;
    this.rowPainters = {};
    this.propNameEls = {};
    this.propFields = {};
    this.propSubEl = null;
    this.subheadTitleEl = null;
    this.render();
    if (reclaim && armed && Platform.isMobileApp) window.history.back();
  }

  /** 只改草稿，不写盘；文本格靠 syncFields 回填，整页不重建 */
  private patchDraft(patch: Partial<DramaShow>): void {
    const cur = this.editing;
    if (!cur) return;
    this.editing = { ...cur, ...patch };
    this.syncFields();
  }

  /** 把草稿回填到各文本格（正在输入的那格跳过，免得光标跳走）+ 刷新标题 / 计数副文字 */
  private syncFields(): void {
    const s = this.editing;
    if (!s) return;
    const active = this.host.ownerDocument.activeElement;
    Object.keys(this.propFields).forEach(k => {
      const el = this.propFields[k];
      if (!el.isConnected || el === active) return;
      const v = this.fieldValue(k as EditorRow);
      if (el.value !== v) { el.value = v; sizeField(el); }
    });
    if (this.subheadTitleEl) {
      this.subheadTitleEl.setText(s.title || (this.editIsNew ? "新增剧集" : "编辑剧集"));
    }
    if (this.propSubEl) {
      this.propSubEl.setText(s.episodes && s.totalEpisodes > 0
        ? `/ ${s.totalEpisodes} · ${Math.round(progressOf(s) * 100)}%` : "");
      this.propSubEl.toggleClass("is-hidden", !(s.episodes && s.totalEpisodes > 0));
    }
  }

  /**
   * 自动增高是按「当前宽度能排几行」算的，宽度一变行数就错：
   * 拖 PC 侧栏、手机转屏、键盘顶起可视区都会改列宽，这里统一重量一遍。
   */
  private resizeAllFields(): void {
    Object.keys(this.propFields).forEach(k => {
      const el = this.propFields[k];
      if (el.isConnected) sizeField(el);
    });
  }

  private observeFieldWidth(el: HTMLElement): void {
    if (typeof ResizeObserver !== "function") return;
    /* 每次进编辑页都是新的一棵树：旧 observer 指向已卸载的节点，必须先断 */
    if (this.fieldsRo) this.fieldsRo.disconnect();
    const ro = new ResizeObserver(() => this.resizeAllFields());
    ro.observe(el);
    this.fieldsRo = ro;
  }

  /** 文本格的当前草稿值 */
  private fieldValue(key: EditorRow): string {
    const s = this.editing;
    if (!s) return "";
    switch (key) {
      case "cover": return s.cover;
      case "title": return s.title;
      case "originalName": return s.originalName;
      case "category": return s.category;
      case "tags": return s.tags.join(", ");
      case "episodes": return s.episodes ? String(s.episodes) : "";
      case "totalEpisodes": return s.totalEpisodes ? String(s.totalEpisodes) : "";
      case "finishedAt": return s.finishedAt;
      case "next": return s.nextEpisodeUrl;
      case "douban": return s.doubanUrl;
    }
    return "";
  }

  /** 文本格的内容写回草稿：数字格夹紧、标签切分、日期只认写完整的真日期 */
  private fieldPatch(key: EditorRow, raw: string): Partial<DramaShow> {
    const v = raw.trim();
    switch (key) {
      case "cover": return { cover: tidyCoverInput(v) };
      case "title": return { title: v };
      case "originalName": return { originalName: v };
      case "category": return { category: v };
      case "tags": return { tags: splitTags(v) };
      case "episodes": return { episodes: positiveInt(v) };
      case "totalEpisodes": return { totalEpisodes: positiveInt(v) };
      /* 日期是「要么完整、要么不动草稿」：边打字边把半成品写进去会真的把已有日期冲掉 */
      case "finishedAt":
        if (!v) return { finishedAt: "" };
        return moment(v, "YYYY-MM-DD", true).isValid() ? { finishedAt: v } : {};
      case "next": return { nextEpisodeUrl: v };
      case "douban": return { doubanUrl: v };
    }
    return {};
  }

  /**
   * 文本格的输入提示。inputMode 决定安卓弹哪种键盘：数字格直接出小键盘，
   * 链接格出带 ".com / /" 的网址键盘，并且都关掉首字母大写和拼写检查。
   */
  private fieldHint(key: EditorRow): {
    placeholder: string; aria: string; numeric?: boolean; date?: boolean; inputMode?: string; noCaps?: boolean;
  } {
    switch (key) {
      case "cover": return { placeholder: "![[封面.jpg]] 或 https://…", aria: "封面引用文本", noCaps: true };
      case "title": return { placeholder: "剧集名称", aria: "标题" };
      case "originalName": return { placeholder: "如 名探偵コナン", aria: "原名" };
      case "category": return { placeholder: "电视剧 / 动漫 / 电影…", aria: "影视类型" };
      case "tags": return { placeholder: "动作, 悬疑（逗号或空格分隔）", aria: "标签" };
      case "episodes": return { placeholder: "已看", aria: "集数", numeric: true, inputMode: "numeric" };
      case "totalEpisodes": return { placeholder: "未定", aria: "总集数", numeric: true, inputMode: "numeric" };
      case "finishedAt": return { placeholder: "YYYY-MM-DD", aria: "看完时间", date: true, inputMode: "numeric", noCaps: true };
      case "next": return { placeholder: "https://…", aria: "下一集直达链接", inputMode: "url", noCaps: true };
      case "douban": return { placeholder: "https://movie.douban.com/subject/…", aria: "豆瓣 URL", inputMode: "url", noCaps: true };
    }
    return { placeholder: "", aria: "值" };
  }

  /**
   * 落库：新建走 addShow（之后转成更新），已有走 updateShow。
   * 标题为空时 store 会直接拒绝，这里给一句提示，返回 false 让调用方别收起。
   */
  private async saveDraft(): Promise<boolean> {
    const draft = this.editing;
    if (!draft) return true;
    if (!draft.title.trim()) {
      new Notice("先填写标题，才能保存");
      return false;
    }
    const wasNew = this.editIsNew;
    const payload: DramaShow = { ...draft, updatedAt: Date.now() };
    if (wasNew) await this.store.addShow(payload);
    else await this.store.updateShow(payload);
    this.editIsNew = false;
    /* 用磁盘上的回读值重置基准：normalizeShow 会修剪、夹紧，草稿要和它对齐 */
    const stored = this.store.byId(payload.id);
    if (stored) this.editing = { ...stored, tags: stored.tags.slice() };
    this.editSaved = draftKey(this.editing ?? payload);
    return true;
  }

  /** 出口一：确定。文本格是边打字边写草稿的，这里只需检查有没有改动 */
  private confirmEditor(): void {
    if (!this.editing) return;
    void (async () => {
      if (this.hasEdits() && !(await this.saveDraft())) return;
      if (this.destroyed || !this.host.isConnected) return;
      this.closeEditor();
    })();
  }

  /** 出口二：返回。没改过直接走，改过就问一句「保存 / 不保存」 */
  private requestClose(): void {
    if (!this.hasEdits()) { this.closeEditor(); return; }
    this.askExit();
  }

  private askExit(): void {
    if (this.exitAsking || !this.editing) return;
    this.exitAsking = true;
    new DramaExitModal(
      this.app,
      // 保存失败（标题空着）就留在编辑页继续改：哨兵还在，返回键不会漏到 Obsidian
      () => void (async () => { if (await this.saveDraft()) this.closeEditor(); })(),
      () => this.closeEditor(),
      () => { this.exitAsking = false; },
    ).open();
  }

  /** 字段行：图标 + 字段名（左） / 值（右） */
  private editRow: EditorRow | null = null;
  /** 每行自己的重绘函数：进出编辑只刷涉及的两行，不重建整页 */
  private rowPainters: Record<string, () => void> = {};
  private propNameEls: Record<string, HTMLElement> = {};
  /** 文本类属性格：值本身就是输入框，草稿变了要回填（正在输入的那格除外） */
  private propFields: Record<string, HTMLTextAreaElement> = {};
  /** 计数行值后面的「/ 总集数 · 百分比」，随输入实时重算 */
  private propSubEl: HTMLElement | null = null;
  private subheadTitleEl: HTMLElement | null = null;
  /** 属性区宽度变化（拖 PC 侧栏 / 转屏 / 键盘）时重新量每格高度 */
  private fieldsRo: ResizeObserver | null = null;
  /** 底部操作条节点：键盘弹起时要把它抬到键盘上方，别压在正在输入的行上 */
  private actionsEl: HTMLElement | null = null;
  /** 当前有文本格在输入（决定操作条抬不抬） */
  private typing = false;
  /** 编辑页里开着的 Notion 浮层数（状态 / 影视类型 / 标签）：开着时和输入态一样淡出操作条 */
  private popCount = 0;
  /** 键盘弹起有动画，系统等那一下「滚进视野」往往只露个边，停稳后再校准一次 */
  private typingReveal: number | null = null;
  /** 键盘 / 视口监听的成对清理（本页不是 Component，用不了 registerEvent） */
  private kbCleanups: Array<() => void> = [];

  private renderEditor(host: HTMLElement): void {
    const s = this.editing;
    if (!s) return;
    this.rowPainters = {};
    this.propNameEls = {};
    this.propFields = {};
    this.propSubEl = null;

    const head = host.createDiv({ cls: "db-drama-subhead" });
    this.subheadTitleEl = head.createSpan({
      cls: "db-drama-subhead-title", text: this.editIsNew ? "新增剧集" : s.title || "编辑剧集",
    });

    const body = host.createDiv({ cls: "db-drama-body is-form" });
    const props = body.createDiv({ cls: "db-drama-card is-form is-props" });
    props.createDiv({ cls: "db-drama-props-head", text: "属性" });
    EDITOR_ROWS.forEach(def => this.propRow(props, def));
    props.createDiv({
      cls: "db-drama-props-note",
      text: "值可以直接改；点字段名可以选择它在列表卡片里显不显示。",
    });
    props.createDiv({
      cls: "db-drama-created",
      text: `创建时间：${moment(s.createdAt).format("YYYY-MM-DD HH:mm")}`,
    });

    /* 删除 */
    if (!this.editIsNew) {
      const del = body.createEl("button", { cls: "db-drama-del", attr: { type: "button", "aria-label": `删除《${s.title}》` } });
      setIcon(del.createSpan({ cls: "db-drama-del-icon" }), "trash-2");
      del.createSpan({ text: "删除这部剧" });
      del.addEventListener("click", () => {
        new ConfirmModal(this.app, "删除剧集", `确定删除《${s.title}》？shows.md 里这个小节会被移除。`, "删除", () => {
          void (async () => {
            await this.store.removeShow(s.id);
            // 先落回收列表：closeEditor 负责退掉哨兵并重渲染
            this.closeEditor();
          })();
        }).open();
      });
    }

    /* 底部悬浮操作条：贴在容器底部，滚到表单中段也能退出，不必划回顶部找返回键。
       「返回」会检查草稿——改过就问保存/不保存，没改过直接回列表；「确定」有改动就存。 */
    const actions = host.createDiv({ cls: "db-drama-actions" });
    this.actionsEl = actions;
    const back = actions.createEl("button", { cls: "db-drama-act is-ghost", attr: { type: "button", "aria-label": "返回追剧列表" } });
    setIcon(back.createSpan({ cls: "db-drama-act-icon" }), "chevron-left");
    back.createSpan({ text: "返回" });
    back.addEventListener("click", () => this.requestClose());
    const ok = actions.createEl("button", { cls: "db-drama-act is-primary", attr: { type: "button", "aria-label": "保存并返回追剧列表" } });
    setIcon(ok.createSpan({ cls: "db-drama-act-icon" }), "check");
    ok.createSpan({ text: "确定" });
    ok.addEventListener("click", () => this.confirmEditor());
    /* 安卓：点空白处收起键盘。软键盘不吃「点别处就自动失焦」这一套，不收的话
       它会一直顶住下半屏，底部那条「返回 / 确定」被压在键盘下面看不见也点不到。
       挂在 body 上（每次渲染重建，监听器随行内容一起消失），控件本身不触发。 */
    body.addEventListener("pointerdown", (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      /* 值格区域是「点这里要输入」，不能先收键盘再聚焦（键盘会闪一下） */
      if (!t || !t.closest || t.closest("textarea, button, input, select, .db-drama-prop-value")) return;
      const doc = body.ownerDocument;
      const active = doc.activeElement;
      if (active && active !== doc.body && typeof (active as HTMLElement).blur === "function") {
        (active as HTMLElement).blur();
      }
    });
    /* 输入态由焦点决定：文本格拿到焦点就开始校准，焦点离开（含点到按钮 / 空白）就停止。
       挂在 body 上：每次渲染都是新节点，监听器不会像挂在 host 那样一遍遍叠。 */
    body.addEventListener("focusin", (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      this.setTyping(!!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT"), t || undefined);
    });
    body.addEventListener("focusout", (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && body.contains(next)) return;
      this.setTyping(false);
    });
    /* 首屏按草稿校准一次：计数行的「/ 总集数 · 百分比」等副文字要有正确显隐 */
    this.syncFields();
    /* 属性区宽度一变就重量各行高度（列宽影响文本格能排几行） */
    this.observeFieldWidth(body);
  }

  /** 一行属性：左列字段名（可点开显隐菜单），右列值。文本类值本身就是输入框，就地改 */
  private propRow(parent: HTMLElement, def: RowDef): void {
    const isField = FIELD_ROWS.indexOf(def.key) >= 0;
    const row = parent.createDiv({ cls: `db-drama-prop${isField ? " is-field" : ""}` });
    const name = row.createDiv({ cls: "db-drama-prop-name" });
    setIcon(name.createSpan({ cls: "db-drama-prop-icon" }), def.icon);
    name.createSpan({ cls: "db-drama-prop-label", text: def.label });
    this.propNameEls[def.key] = name;
    if (def.field) {
      name.toggleClass("is-off", !dramaFieldOn(this.plugin.settings.dramaFields, def.field));
      tappable(name, `${def.label}：设置在列表里是否显示`, () => this.openPropMenu(def));
    }

    const cell = row.createDiv({ cls: "db-drama-prop-value" });
    /* 文本类字段：一次画好就不再重绘（重绘会打断输入），值随草稿由 syncFields 回填 */
    if (isField) {
      this.propField(cell, def, { flow: true });
      return;
    }
    const paint = (): void => {
      cell.empty();
      row.toggleClass("is-edit", this.editRow === def.key);
      if (this.editRow === def.key) this.propEdit(cell, def);
      else this.propView(cell, def);
    };
    this.rowPainters[def.key] = paint;
    paint();
  }

  /** 只让涉及的行重绘（进入 / 退出编辑）；文本行不在这里，永不重绘 */
  private setEditRow(key: EditorRow | null): void {
    if (this.editRow === key) return;
    const prev = this.editRow;
    this.editRow = key;
    if (prev && this.rowPainters[prev]) this.rowPainters[prev]();
    if (key && this.rowPainters[key]) this.rowPainters[key]();
  }

  /** 展示态：只有非文本行会走到这里（封面缩略图 / 状态徽标 / 可点链接） */
  private propView(cell: HTMLElement, def: RowDef): void {
    const s = this.editing;
    if (!s) return;
    const start = (): void => this.setEditRow(def.key);
    let editAria = `编辑${def.label}`;
    switch (def.key) {
      case "cover": {
        /* 封面是文件类型（可多张）：未展开只随机展示一张小图，点开才列出全部并可增删 */
        if (this.coverOpen) this.paintCoverExpanded(cell, def);
        else this.paintCoverMini(cell, def);
        return;
      }
      case "category": {
        /* Notion select：影视类型以彩色 chip 呈现，点开搜索已有类型或现场新建 */
        const chip = cell.createSpan({
          cls: `db-ns-chip${s.category ? "" : " is-empty"}`,
          text: s.category || "未设置",
        });
        if (s.category) chip.style.setProperty("--ns-chip", notionChipColor(s.category));
        tappable(chip, "选择影视类型", () => this.openCategorySelect(def, chip));
        return;
      }
      case "tags": {
        /* Notion multi-select：标签以彩色 chip 多选，可搜索已用标签或现场新建 */
        new NotionMultiSelect(cell, {
          options: () => this.store.allTags(),
          values: s.tags,
          placeholder: "空",
          searchPlaceholder: "搜索标签…",
          allowCreate: true,
          ariaLabel: "编辑标签",
          onChange: vs => this.patchDraft({ tags: vs }),
          onCreate: q => q.replace(/^#/, "").replace(/[,，]/g, "").trim(),
          onOpen: () => this.syncPopCount(1),
          onClose: () => this.syncPopCount(-1),
        });
        return;
      }
      case "status": {
        const badge = cell.createSpan({
          cls: `db-drama-status is-${STATUS_INFO[s.status].tone}`,
          text: STATUS_INFO[s.status].label,
        });
        /* Notion select 的交互：点徽标弹搜索下拉选状态，不整行换成控件 */
        tappable(badge, "选择状态", () => this.openStatusMenu(def, badge));
        return;
      }
      case "next":
        this.propLinkView(cell, s.nextEpisodeUrl, `打开《${s.title}》下一集`, start);
        return;
      case "douban":
        this.propLinkView(cell, s.doubanUrl, `打开《${s.title}》豆瓣页面`, start);
        return;
      default:
        return;
    }
    tappable(cell, editAria, start);
  }

  /** 链接类字段：值本身就是可点的链接，改链接走右侧铅笔 */
  private propLinkView(cell: HTMLElement, url: string, aria: string, start: () => void): void {
    if (!isUrl(url)) {
      cell.createSpan({ cls: "db-drama-prop-empty", text: "空" });
      tappable(cell, "填写链接", start);
      return;
    }
    const link = cell.createEl("button", { cls: "db-drama-prop-link", attr: { type: "button", "aria-label": aria } });
    link.createSpan({ cls: "db-drama-prop-link-text", text: shortUrl(url) });
    link.addEventListener("click", () => this.openUrl(url));
    const edit = cell.createEl("button", {
      cls: "db-drama-prop-edit", attr: { type: "button", "aria-label": "修改链接" },
    });
    setIcon(edit, "pencil");
    edit.addEventListener("click", start);
  }

  /**
   * 就地文本格：值本身就是输入框，没有「展示态 ↔ 编辑态」的来回切换。
   * 边打字边写草稿（不重绘、不打断输入法），高度随内容自动长。
   * 安卓键盘相关：按字段给 inputmode（数字格出小键盘、链接格出网址键盘）、
   * 关首字母大写与拼写检查、回车按行序跳下一格（最后一格才是「完成」收键盘）。
   */
  private propField(cell: HTMLElement, def: RowDef, opts?: {
    focus?: boolean; onEnter?: () => void; onBlur?: () => void; flow?: boolean;
  }): void {
    const s = this.editing;
    if (!s) return;
    const hint = this.fieldHint(def.key);
    const flow = !!opts && opts.flow === true;
    /* 属性页里文本行的排布顺序就是填写顺序：中间行回车跳下一格，末行回车收键盘 */
    const isLastFlow = FIELD_ROWS.indexOf(def.key) === FIELD_ROWS.length - 1;
    const el = cell.createEl("textarea", {
      cls: `db-drama-prop-field${hint.numeric ? " is-num" : ""}`,
      attr: {
        rows: "1",
        spellcheck: "false",
        placeholder: hint.placeholder,
        "aria-label": hint.aria,
        enterkeyhint: flow && !isLastFlow ? "next" : "done",
      },
    });
    el.value = this.fieldValue(def.key);
    if (hint.inputMode) el.setAttribute("inputmode", hint.inputMode);
    if (hint.noCaps) {
      el.setAttribute("autocapitalize", "off");
      el.setAttribute("autocomplete", "off");
    }
    this.propFields[def.key] = el;
    /* 触控热区：值那一格上下各垫了 10px 才够 44px，点到垫高处也要当成「要点这格」。
       只在文本行挂（这些行永不重绘），编辑态行的 cell 会被反复重绘，监听器会累积。 */
    if (flow) {
      cell.addEventListener("click", (e: MouseEvent) => { if (e.target === cell) el.focus(); });
    }
    /* 中文输入法选词期间会连发 input，这时改写 value / 重量高度会把候选串打断 */
    let composing = false;
    const normalize = (): string => {
      if (hint.date) return formatDateDigits(el.value);
      if (hint.numeric) return el.value.replace(/[^\d]/g, "");
      /* 属性值都是单行语义：粘贴带进来换行会把列表卡片的那一行撑坏，收成空格 */
      return el.value.replace(/[\r\n]+/g, " ");
    };
    const write = (): void => {
      const raw = normalize();
      if (el.value !== raw) el.value = raw;
      this.patchDraft(this.fieldPatch(def.key, raw));
      sizeField(el);
      /* 这一格会随内容长高：长到被键盘或操作条压住时顶回可见区，只在它正被输入时管 */
      if (this.host.ownerDocument.activeElement === el) this.revealAboveKeyboard(el);
    };
    el.addEventListener("input", () => { if (!composing) write(); });
    el.addEventListener("compositionstart", () => { composing = true; });
    el.addEventListener("compositionend", () => { composing = false; write(); });
    el.addEventListener("blur", () => {
      composing = false;
      /* 日期没写满就离开：留一个「看着像日期但没入库」的半成品最坑，退回草稿值并说一句 */
      if (hint.date && el.value && !moment(el.value, "YYYY-MM-DD", true).isValid()) {
        new Notice("看完时间要写完整（YYYY-MM-DD），没写完的不算");
        el.value = this.fieldValue(def.key);
        sizeField(el);
      }
      write();
      if (opts && opts.onBlur) opts.onBlur();
    });
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      /* 属性值都是单行，没有「Shift+Enter 换行」这回事：回车一律当成这一格填完 */
      e.preventDefault();
      write();
      /* 回车 = 这一格填完：能跳就跳下一格（键盘不收起），末行 / 编辑态行则收键盘 */
      if (flow && this.focusNextField(def.key)) return;
      if (opts && opts.onEnter) opts.onEnter();
      el.blur();
    });
    sizeField(el);
    if (opts && opts.focus) {
      try { el.focus(); } catch (err) { /* 聚焦失败不影响编辑 */ }
    }

    /* 计数行：值右边挂「/ 总集数 · 百分比」，随输入实时重算 */
    if (def.key === "episodes") this.propSubEl = cell.createSpan({ cls: "db-drama-prop-sub is-hidden" });
    /* 类型行：把库里已有的类型做成一键选项（值仍是普通文本，可随便写新的） */
    if (def.key === "category") {
      const cats = this.store.allCategories();
      if (cats.length) {
        const aux = cell.createDiv({ cls: "db-drama-prop-aux" });
        const chips = aux.createDiv({ cls: "db-drama-chips is-inline" });
        const nodes: HTMLElement[] = [];
        cats.forEach(c => {
          const chip = chips.createEl("button", {
            cls: `db-drama-chip is-mini${s.category === c ? " is-active" : ""}`,
            attr: { type: "button", "aria-label": `类型设为 ${c}` }, text: c,
          });
          chip.addEventListener("click", () => {
            this.patchDraft({ category: c });
            nodes.forEach(n => n.toggleClass("is-active", n === chip));
            el.value = c;
            sizeField(el);
          });
          nodes.push(chip);
        });
      }
    }
    /* 看完时间行：给一个「今天」，手机上少敲一串数字 */
    if (def.key === "finishedAt") {
      const aux = cell.createDiv({ cls: "db-drama-prop-aux" });
      const today = aux.createEl("button", {
        cls: `db-drama-mini${s.finishedAt ? " is-hidden" : ""}`,
        attr: { type: "button", "aria-label": "看完时间填今天" }, text: "今天",
      });
      today.addEventListener("click", () => {
        const v = moment().format("YYYY-MM-DD");
        this.patchDraft({ finishedAt: v });
        /* 触控时输入框可能还占着焦点，syncFields 会跳过它 —— 这里直接回填一次 */
        el.value = v;
        sizeField(el);
        today.addClass("is-hidden");
      });
    }
  }

  /**
   * 回车跳下一格：属性页是一列定高的短字段，安卓软键盘右下角那颗键按系统惯例
   * 应该是「下一项」，只有最后一格才是「完成」。键盘不收起，视线不离开编辑区。
   */
  private focusNextField(key: EditorRow): boolean {
    const i = FIELD_ROWS.indexOf(key);
    if (i < 0) return false;
    for (let j = i + 1; j < FIELD_ROWS.length; j++) {
      const next = this.propFields[FIELD_ROWS[j]];
      if (!next || !next.isConnected) continue;
      try {
        next.focus();
        /* 聚焦默认把光标放到开头，接着输入会插到前面：跳格是来「补写」的，放末尾 */
        const len = next.value.length;
        next.setSelectionRange(len, len);
      } catch (err) { return false; }
      return true;
    }
    return false;
  }

  /**
   * 让正在输入的这一格落在「键盘之上、操作条之上」的真实可见区里。
   * 只读几何量做判断，不参与任何布局尺寸计算：
   * - 可见底缘 = visualViewport（键盘顶 / 系统平移后的真实下沿）；拿不到就交给系统自己滚
   * - 再往上让开底部操作条那一段：它是 sticky，贴在可见区底边，行停在它下面等于没露出来
   * 已经完整露出来就一动不动，免得每敲一个字都抖一次页面。
   */
  private revealAboveKeyboard(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const vp = window.visualViewport;
    let bottom = vp && vp.height > 0 ? vp.height + vp.offsetTop : rect.bottom;
    /* 输入期间操作条是淡出的（背景透明，字压在它上面也看得见），就别再把它算成障碍 */
    const bar = this.actionsEl;
    if (!this.typing && bar && bar.isConnected) bottom = Math.min(bottom, bar.getBoundingClientRect().top);
    if (rect.bottom <= bottom - 8 && rect.top >= 0) return;
    /* 自己就比可见区还高（长标题 + 小屏 + 键盘）：居中也救不了，反而每次敲字都抖一下 */
    if (rect.height >= bottom - 8) return;
    el.scrollIntoView({ block: "center" });
  }

  /** 焦点是否停在本页的文本格上（决定操作条淡不淡、要不要校准位置） */
  private isInputFocused(): boolean {
    const a = this.host.ownerDocument.activeElement as HTMLElement | null;
    if (!a) return false;
    const tag = a.tagName;
    return (tag === "TEXTAREA" || tag === "INPUT") && this.host.contains(a);
  }

  /** 输入中：几何一变（键盘换高度 / 弹起动画结束 / 视口滚动）就重新把这一行露出来 */
  private revealTypingRow(): void {
    if (!this.typing || this.destroyed) return;
    const active = this.host.ownerDocument.activeElement as HTMLElement | null;
    if (active && active.tagName === "TEXTAREA" && this.host.contains(active)) {
      this.revealAboveKeyboard(active);
    }
  }

  /** 进出输入态：记下来才好决定要不要持续校准 */
  private setTyping(on: boolean, el?: HTMLElement): void {
    this.typing = on;
    /* 底部那条「返回 / 确定」是 sticky，正好停在键盘上沿，会把正在输入的行压住。
       输入期间由 TS 打一个 is-typing 让它淡出（CSS 里不用 :has），键盘一收就回来。 */
    this.host.toggleClass("is-typing", on);
    if (this.typingReveal) { window.clearTimeout(this.typingReveal); this.typingReveal = null; }
    if (!on || !el) return;
    this.revealAboveKeyboard(el);
    /* 键盘弹起有 ~300ms 动画，系统那一下「滚进视野」常常只露个边，等它停稳再校准一次 */
    this.typingReveal = window.setTimeout(() => {
      this.typingReveal = null;
      if (this.destroyed || !el.isConnected) return;
      if (this.host.ownerDocument.activeElement === el) this.revealAboveKeyboard(el);
    }, 320);
  }

  /**
   * Notion 浮层（状态 / 类型 / 标签）展开 / 收起时同步：开着就给宿主打 is-popping，
   * 触屏上由 CSS 把底部操作条淡出——浮层自带搜索框，键盘一样会顶到操作条上沿。
   * 焦点在浮层的搜索框里，编辑页的 focusin / isInputFocused 都看不到它，只能靠回调。
   */
  private syncPopCount(delta: number): void {
    this.popCount = Math.max(0, this.popCount + delta);
    this.host.toggleClass("is-popping", this.popCount > 0);
  }

  /** 非文本行的编辑态：链接（就地文本格）；封面/状态/类型/标签都是 Notion 控件，不进编辑态 */
  private propEdit(cell: HTMLElement, def: RowDef): void {
    const s = this.editing;
    if (!s) return;
    const commit = (patch: Partial<DramaShow>): void => {
      this.patchDraft(patch);
      this.setEditRow(null);
    };
    switch (def.key) {
      case "next":
        this.propField(cell, def, {
          focus: true, onEnter: () => this.setEditRow(null), onBlur: () => this.setEditRow(null),
        });
        break;
      case "douban":
        this.propField(cell, def, {
          focus: true, onEnter: () => this.setEditRow(null), onBlur: () => this.setEditRow(null),
        });
        break;
    }
  }

  /** 点字段名：勾选这条字段在列表卡片上显不显示（与「显示字段」抽屉同一套开关） */
  private openPropMenu(def: RowDef): void {
    const field = def.field;
    if (!field) return;
    const on = dramaFieldOn(this.plugin.settings.dramaFields, field);
    const menu = new Menu();
    menu.addItem(item => {
      item.setTitle("在列表卡片显示");
      if (on) item.setIcon("check");
      item.onClick(() => {
        const st = this.plugin.settings;
        if (!st.dramaFields) st.dramaFields = {};
        st.dramaFields[field] = !on;
        void this.plugin.saveSettings();
        /* 字段名压暗 = 这一项不进列表，不用再刷新整页 */
        const nameEl = this.propNameEls[def.key];
        if (nameEl) nameEl.toggleClass("is-off", on);
        new Notice(on ? `列表卡片不再显示「${def.label}」` : `列表卡片已显示「${def.label}」`);
      });
    });
    const anchor = this.propNameEls[def.key];
    if (anchor && anchor.isConnected) {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    } else {
      menu.showAtMouseEvent(new MouseEvent("click"));
    }
  }

  /** 点状态徽标：Notion select 选状态。选中即写草稿，当前项打勾 */
  private openStatusMenu(def: RowDef, anchor: HTMLElement): void {
    const s = this.editing;
    if (!s) return;
    new NotionSelect(anchor, {
      bindTrigger: true,
      options: STATUS_ORDER.map(k => ({ value: k, label: STATUS_INFO[k].label })),
      value: s.status,
      searchPlaceholder: "搜索状态…",
      ariaLabel: "选择状态",
      onSelect: v => {
        const cur = this.editing;
        if (!cur) return;
        const k = v as DramaStatus;
        this.patchDraft({
          status: k,
          /* 改成「已完结」且没写过日期时自动补今天，和原来的分段按钮同一行为 */
          finishedAt: k === "done" && !cur.finishedAt ? moment().format("YYYY-MM-DD") : cur.finishedAt,
        });
        /* 徽标是静态画的：重绘这一行让新状态立即可见 */
        const repaint = this.rowPainters[def.key];
        if (repaint) repaint();
      },
      onOpen: () => this.syncPopCount(1),
      onClose: () => this.syncPopCount(-1),
    }).open();
  }

  /** 影视类型：Notion select——已有类型按名称着色可搜索，没有就现场新建（正是「F栋」那种用法） */
  private openCategorySelect(def: RowDef, anchor: HTMLElement): void {
    const s = this.editing;
    if (!s) return;
    new NotionSelect(anchor, {
      bindTrigger: true,
      options: () => this.store.allCategories().map(c => ({ value: c, label: c })),
      value: s.category,
      placeholder: "未设置",
      searchPlaceholder: "搜索类型…",
      ariaLabel: "选择影视类型",
      allowCreate: true,
      onSelect: v => {
        this.patchDraft({ category: v });
        const repaint = this.rowPainters[def.key];
        if (repaint) repaint();
      },
      onCreate: q => ({ value: q, label: q }),
      onOpen: () => this.syncPopCount(1),
      onClose: () => this.syncPopCount(-1),
    }).open();
  }


  /* ── 封面组（文件类型，可多张）：未展开随机一张小图，展开列出全部并可增删 ── */

  private repaintCover(def: RowDef): void {
    const repaint = this.rowPainters[def.key];
    if (repaint) repaint();
  }

  /** 写回封面组：covers 为准，cover 恒同步第一张（旧字段兼容旧版本） */
  private patchCovers(list: string[]): void {
    this.patchDraft({ covers: list, cover: list[0] ?? "" });
  }

  /** 展示态：随机一张的小图（不渲染文件名/大小，不占页面） */
  private paintCoverMini(cell: HTMLElement, def: RowDef): void {
    const s = this.editing;
    if (!s) return;
    const list = coverList(s);
    const box = cell.createDiv({ cls: "db-drama-cover is-mini is-tap" });
    this.paintCoverInto(box, this.pickCoverRef(s), s.title);
    tappable(box, list.length > 1 ? `展开全部 ${list.length} 张封面` : "编辑封面", () => {
      this.coverOpen = true;
      this.repaintCover(def);
    });
  }

  /** 展开态：全部封面以大一点的图平铺，每张可移除；入口有库里选择/本地上传/粘贴链接 */
  private paintCoverExpanded(cell: HTMLElement, def: RowDef): void {
    const s = this.editing;
    if (!s) return;
    const wrap = cell.createDiv({ cls: "db-drama-cover-set" });
    coverList(s).forEach((ref, i) => {
      const tile = wrap.createDiv({ cls: "db-drama-cover-tile" });
      const box = tile.createDiv({ cls: "db-drama-cover is-tile" });
      this.paintCoverInto(box, ref, s.title);
      const del = tile.createSpan({
        cls: "db-drama-cover-del",
        attr: { role: "button", "aria-label": `移除第 ${i + 1} 张封面`, title: "移除" },
      });
      setIcon(del, "x");
      del.addEventListener("click", e => {
        e.stopPropagation();
        const cur = this.editing;
        if (!cur) return;
        const next = coverList(cur).filter((_, j) => j !== i);
        this.patchCovers(next);
        if (!next.length) this.coverOpen = false;   // 删空了回到随机小图占位态
        this.repaintCover(def);
      });
      del.addEventListener("keydown", e => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); del.click(); }
      });
    });
    const btns = cell.createDiv({ cls: "db-drama-mini-btns" });
    const pick = btns.createEl("button", { cls: "db-drama-mini", attr: { type: "button", "aria-label": "从库中选择封面" } });
    setIcon(pick.createSpan({ cls: "db-drama-mini-icon" }), "image");
    pick.createSpan({ text: "库里选择" });
    pick.addEventListener("click", () => pickVaultCover(this.app, embed => {
      const cur = this.editing;
      if (!cur || this.destroyed) return;
      this.patchCovers([...coverList(cur), embed]);
      this.repaintCover(def);
    }));
    const up = btns.createEl("button", { cls: "db-drama-mini", attr: { type: "button", "aria-label": "上传本地图片作为封面" } });
    setIcon(up.createSpan({ cls: "db-drama-mini-icon" }), "upload");
    up.createSpan({ text: "本地上传" });
    up.addEventListener("click", () => void this.uploadCover(def));
    const link = btns.createEl("button", { cls: "db-drama-mini", attr: { type: "button", "aria-label": "粘贴封面链接或引用文本" } });
    setIcon(link.createSpan({ cls: "db-drama-mini-icon" }), "link");
    link.createSpan({ text: "链接" });
    link.addEventListener("click", () => {
      new PromptModal(this.app, {
        title: "添加封面",
        placeholder: "https://… 或 ![[cover.jpg]]",
        confirmText: "添加",
        onConfirm: v => {
          const ref = tidyCoverInput(v);
          const cur = this.editing;
          if (!ref || !cur) return;
          this.patchCovers([...coverList(cur), ref]);
          this.repaintCover(def);
        },
      }).open();
    });
    if (coverList(s).length) {
      const collapse = btns.createEl("button", { cls: "db-drama-mini is-ghost", attr: { type: "button", "aria-label": "收起封面列表" } });
      setIcon(collapse.createSpan({ cls: "db-drama-mini-icon" }), "chevron-up");
      collapse.createSpan({ text: "收起" });
      collapse.addEventListener("click", () => {
        this.coverOpen = false;
        this.repaintCover(def);
      });
    }
  }

  private async uploadCover(def: RowDef): Promise<void> {
    const file = await pickLocalImageFile(this.host);
    if (!file || this.destroyed) return;
    const embed = await uploadCoverImage(this.app, `${this.store.dir}/covers`, file);
    if (!embed) return;
    const cur = this.editing;
    if (!cur) return;
    this.patchCovers([...coverList(cur), embed]);
    this.repaintCover(def);
  }
}

/** 标签切分：逗号 / 顿号 / 空格都当分隔符 */
function splitTags(raw: string): string[] {
  const out: string[] = [];
  raw.split(/[,，、\s]+/).forEach(t => {
    const v = t.replace(/^#/, "").trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

function positiveInt(raw: string): number {
  const n = parseInt(raw, 10);
  return isFinite(n) && n > 0 ? n : 0;
}
