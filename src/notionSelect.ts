/**
 * notionSelect.ts — Notion 风格的下拉选择（单选 + 多选）
 *
 * 单选：触发器显示当前值（按名称哈希着色的 chip，同一名字永远同色）；点开是
 * 固定定位的浮层：顶部搜索框 + 选项行（chip 呈现，选中带勾）+ 可选的「创建」；
 * 键盘 ↑↓ 移动、Enter 选中、Esc 收起。
 *
 * 多选：触发器显示已选值的一排 chip（带 × 可移除）；浮层里点选项即切换勾选，
 * 浮层保持打开可连续选；搜索无精确匹配可现场新建；搜索为空按退格移除最后一个。
 *
 * 为什么不用原生 <select>：选项要按 Notion 的样子以彩色 chip 呈现，原生下拉样式不受控；
 * 浮层挂 body + fixed 锚定触发器，避开 sheet 滚动容器的裁剪，任何滚动/缩放即收起。
 * 同时只允许一个实例展开（openPop 单例，单选/多选共用）。
 */
import { setIcon } from "obsidian";

export interface NotionSelectOption {
  value: string;
  label: string;
}

export interface NotionSelectOpts {
  /** 选项；传函数则每次打开/输入时现取（列表可变时用，如账本新建后要出现） */
  options: NotionSelectOption[] | (() => NotionSelectOption[]);
  value: string;
  placeholder?: string;
  searchPlaceholder?: string;
  /** 搜索无精确匹配时给「创建」项；onCreate 返回要选中的选项 */
  allowCreate?: boolean;
  /**
   * 绑定模式：容器本身就是触发器（如追剧的状态徽标）。
   * 不画 chip/箭头、不挂点击监听——何时 open() 由调用方控制，选中后的展示也由调用方刷新。
   */
  bindTrigger?: boolean;
  triggerClass?: string;
  ariaLabel?: string;
  onSelect: (value: string) => void;
  onCreate?: (query: string) => NotionSelectOption | void;
  /** 浮层真的展开 / 收起时通知宿主（宿主用它同步页面状态，如淡出底部操作条） */
  onOpen?: () => void;
  onClose?: () => void;
}

export interface NotionMultiSelectOpts {
  /** 候选（值 = 显示文本）；传函数则每次打开/输入时现取（如标签 = 历史用过的全部标签） */
  options: string[] | (() => string[]);
  values: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** 搜索无精确匹配时给「创建」项；onCreate 返回规范化后的值（如去 #），不传用原文 */
  allowCreate?: boolean;
  triggerClass?: string;
  ariaLabel?: string;
  onChange: (values: string[]) => void;
  onCreate?: (query: string) => string | void;
  /** 浮层真的展开 / 收起时通知宿主（同单选） */
  onOpen?: () => void;
  onClose?: () => void;
}

/** chip 颜色档位（hue 轮），按名称哈希取档 */
const CHIP_HUES = [4, 24, 42, 84, 132, 168, 198, 226, 262, 292, 330];
function chipHue(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return CHIP_HUES[h % CHIP_HUES.length];
}
function chipColor(label: string): string {
  return `hsl(${chipHue(label)} 62% 52%)`;
}
/** 给自带 chip 展示的调用方用（同一份配色，保证同色系统一） */
export function notionChipColor(label: string): string {
  return chipColor(label);
}

/** 同时只允许一个下拉展开（单选/多选共用） */
let openPop: { close(): void } | null = null;

interface PopShell {
  pop: HTMLElement;
  input: HTMLInputElement;
  cleanup: () => void;
}

/** 浮层外壳：挂 body、锚定触发器（空间不足向上展开）、外部任何交互即收起（浮层内部滚动除外） */
function openPopoverShell(trigger: HTMLElement, searchPlaceholder: string, owner: { close(): void }): PopShell {
  const doc = trigger.ownerDocument;
  const pop = doc.body.createDiv({ cls: "db-ns-pop" });
  pop.createEl("input", {
    cls: "db-ns-search",
    attr: { type: "text", placeholder: searchPlaceholder ?? "搜索选项…", "aria-label": "搜索选项" },
  });
  const input = pop.querySelector("input") as HTMLInputElement;

  /* 锚定触发器：空间不足时向上展开，宽度不小于触发器 */
  const rect = trigger.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth || 1024;
  const vh = doc.documentElement.clientHeight || 768;
  const width = Math.max(rect.width, 240);
  const spaceBelow = vh - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const below = spaceBelow >= 150 || spaceBelow >= spaceAbove;
  pop.style.width = `${width}px`;
  pop.style.maxHeight = `${Math.min(320, Math.max(140, below ? spaceBelow : spaceAbove))}px`;
  pop.style.left = `${Math.min(Math.max(8, rect.left), Math.max(8, vw - width - 8))}px`;
  if (below) pop.style.top = `${rect.bottom + 6}px`;
  else pop.style.bottom = `${vh - rect.top + 6}px`;

  const onDocPointer = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && !pop.contains(t) && !trigger.contains(t)) owner.close();
  };
  const onScroll = (e: Event) => {
    const t = e.target as Node | null;
    if (t && pop.contains(t)) return;
    owner.close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); owner.close(); }
  };
  doc.addEventListener("pointerdown", onDocPointer, true);
  doc.addEventListener("scroll", onScroll, true);
  doc.addEventListener("keydown", onKey, true);
  const win = doc.defaultView;
  win?.addEventListener("resize", onScroll);
  input.focus();
  return {
    pop,
    input,
    cleanup: () => {
      doc.removeEventListener("pointerdown", onDocPointer, true);
      doc.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("keydown", onKey, true);
      win?.removeEventListener("resize", onScroll);
    },
  };
}

/** 搜索框的 ↑↓ 高亮移动（单选/多选共用） */
function bindArrowNav(input: HTMLInputElement, rows: () => HTMLElement[], getIdx: () => number, setIdx: (i: number) => void): void {
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = rows();
    if (!list.length) return;
    const next = e.key === "ArrowDown"
      ? (getIdx() + 1) % list.length
      : (getIdx() - 1 + list.length) % list.length;
    setIdx(next);
    list.forEach((r, i) => r.toggleClass("is-kbd", i === next));
    list[next].scrollIntoView({ block: "nearest" });
  });
}

/* ────────────────────────── 单选 ────────────────────────── */

export class NotionSelect {
  private trigger: HTMLElement;
  private pop: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private rows: HTMLElement[] = [];
  private values: string[] = [];
  private activeIdx = -1;
  private cleanup: (() => void) | null = null;
  private cur: string;

  constructor(private container: HTMLElement, private opts: NotionSelectOpts) {
    this.cur = opts.value;
    if (opts.bindTrigger) {
      /* 绑定模式：容器就是触发器。不画 chip、不挂点击监听——重复打开同一锚点
         也不会叠监听器；何时 open() 与选中后的展示刷新都由调用方负责 */
      this.trigger = container;
      this.trigger.setAttribute("aria-haspopup", "listbox");
      this.trigger.setAttribute("aria-expanded", "false");
      return;
    }
    this.trigger = container.createEl("button", {
      cls: `db-ns-trigger${opts.triggerClass ? ` ${opts.triggerClass}` : ""}`,
      attr: {
        type: "button",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
      },
    });
    this.paintTrigger();
    this.trigger.addEventListener("click", () => (this.pop ? this.close() : this.open()));
  }

  getValue(): string { return this.cur; }

  setValue(v: string): void {
    this.cur = v;
    this.paintTrigger();
  }

  private options(): NotionSelectOption[] {
    return typeof this.opts.options === "function" ? this.opts.options() : this.opts.options;
  }

  private paintTrigger(): void {
    if (this.opts.bindTrigger) return;   // 触发器展示由调用方自己画（如状态徽标）
    const opt = this.options().find(o => o.value === this.cur);
    this.trigger.empty();
    const chip = this.trigger.createSpan({
      cls: `db-ns-chip${opt ? "" : " is-empty"}`,
      text: opt ? opt.label : (this.opts.placeholder ?? "请选择"),
    });
    if (opt) chip.style.setProperty("--ns-chip", chipColor(opt.label));
    setIcon(this.trigger.createSpan({ cls: "db-ns-chev" }), "chevron-down");
  }

  open(): void {
    if (this.pop) return;
    if (openPop && openPop !== this) openPop.close();
    openPop = this;
    const shell = openPopoverShell(this.trigger, this.opts.searchPlaceholder ?? "搜索选项…", this);
    this.pop = shell.pop;
    this.input = shell.input;
    this.cleanup = shell.cleanup;
    this.trigger.setAttribute("aria-expanded", "true");
    this.pop.createDiv({ cls: "db-ns-hint", text: this.opts.allowCreate ? "选择一项或新建" : "选择一项" });
    const list = this.pop.createDiv({ cls: "db-ns-list" });

    const renderRows = () => {
      const q = (this.input?.value ?? "").trim().toLowerCase();
      const all = this.options();
      const shown = all.filter(o => !q || o.label.toLowerCase().includes(q));
      list.empty();
      this.rows = [];
      this.values = [];
      if (!all.length) {
        list.createDiv({ cls: "db-ns-empty", text: "暂无选项" });
        return;
      }
      if (!shown.length && !this.opts.allowCreate) {
        list.createDiv({ cls: "db-ns-empty", text: "没有匹配的选项" });
      }
      shown.forEach(o => {
        const row = list.createDiv({
          cls: `db-ns-row${o.value === this.cur ? " is-sel" : ""}`,
          attr: { role: "option", "aria-selected": String(o.value === this.cur) },
        });
        const chip = row.createSpan({ cls: "db-ns-chip", text: o.label });
        chip.style.setProperty("--ns-chip", chipColor(o.label));
        if (o.value === this.cur) setIcon(row.createSpan({ cls: "db-ns-check" }), "check");
        row.addEventListener("click", () => this.pick(o.value));
        this.rows.push(row);
        this.values.push(o.value);
      });
      if (this.opts.allowCreate && q && !shown.some(o => o.label.toLowerCase() === q)) {
        const raw = this.input!.value.trim();
        const row = list.createDiv({ cls: "db-ns-row is-create", attr: { role: "option" } });
        setIcon(row.createSpan({ cls: "db-ns-plus" }), "plus");
        row.createSpan({ cls: "db-ns-chip", text: raw });
        row.addEventListener("click", () => {
          const opt = this.opts.onCreate?.(raw);
          if (opt) {
            this.cur = opt.value;
            this.opts.onSelect(opt.value);
          }
          this.close();
          this.paintTrigger();
        });
        this.rows.push(row);
        this.values.push("");
      }
      /* 默认高亮：当前选中项，否则第一行 */
      const selIdx = this.values.indexOf(this.cur);
      this.activeIdx = selIdx >= 0 ? selIdx : this.rows.length ? 0 : -1;
      this.rows.forEach((r, i) => r.toggleClass("is-kbd", i === this.activeIdx));
    };
    renderRows();
    this.input.addEventListener("input", () => renderRows());
    bindArrowNav(this.input, () => this.rows, () => this.activeIdx, i => { this.activeIdx = i; });
    this.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        if (this.activeIdx >= 0) this.rows[this.activeIdx].click();
      }
    });
    this.opts.onOpen?.();
  }

  private pick(v: string): void {
    this.cur = v;
    this.opts.onSelect(v);
    this.paintTrigger();
    this.close();
  }

  close(): void {
    const wasOpen = !!this.pop;
    if (openPop === this) openPop = null;
    this.cleanup?.();
    this.cleanup = null;
    this.pop?.remove();
    this.pop = null;
    this.input = null;
    this.rows = [];
    this.trigger.setAttribute("aria-expanded", "false");
    if (wasOpen) this.opts.onClose?.();
  }
}

/* ────────────────────────── 多选 ────────────────────────── */

export class NotionMultiSelect {
  private trigger: HTMLElement;
  private pop: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private rows: HTMLElement[] = [];
  private activeIdx = -1;
  private cleanup: (() => void) | null = null;
  private cur: string[];

  constructor(private container: HTMLElement, private opts: NotionMultiSelectOpts) {
    this.cur = opts.values.slice();
    this.trigger = container.createEl("button", {
      cls: `db-ns-trigger db-ns-mult${opts.triggerClass ? ` ${opts.triggerClass}` : ""}`,
      attr: {
        type: "button",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        ...(opts.ariaLabel ? { "aria-label": opts.ariaLabel } : {}),
      },
    });
    this.paintTrigger();
    this.trigger.addEventListener("click", () => (this.pop ? this.close() : this.open()));
  }

  getValue(): string[] { return this.cur.slice(); }

  setValue(vs: string[]): void {
    this.cur = vs.slice();
    this.paintTrigger();
  }

  private options(): string[] {
    return typeof this.opts.options === "function" ? this.opts.options() : this.opts.options;
  }

  private paintTrigger(): void {
    this.trigger.empty();
    const wrap = this.trigger.createSpan({ cls: "db-ns-mult-chips" });
    if (!this.cur.length) wrap.createSpan({ cls: "db-ns-chip is-empty", text: this.opts.placeholder ?? "空" });
    this.cur.forEach(v => {
      const chip = wrap.createSpan({ cls: "db-ns-chip" });
      chip.style.setProperty("--ns-chip", chipColor(v));
      chip.createSpan({ cls: "db-ns-chip-text", text: v });
      const x = chip.createSpan({
        cls: "db-ns-chip-x",
        attr: { role: "button", "aria-label": `移除 ${v}`, title: "移除" },
      });
      setIcon(x, "x");
      x.addEventListener("click", e => { e.stopPropagation(); this.remove(v); });
    });
    setIcon(this.trigger.createSpan({ cls: "db-ns-chev" }), "chevron-down");
  }

  private commit(next: string[]): void {
    this.cur = next;
    this.opts.onChange(this.cur.slice());
    this.paintTrigger();
    if (this.pop) this.renderRows();   // 浮层开着时同步勾选态
  }

  private remove(v: string): void {
    if (!this.cur.includes(v)) return;
    this.commit(this.cur.filter(x => x !== v));
  }

  private toggle(v: string): void {
    this.commit(this.cur.includes(v) ? this.cur.filter(x => x !== v) : [...this.cur, v]);
  }

  open(): void {
    if (this.pop) return;
    if (openPop && openPop !== this) openPop.close();
    openPop = this;
    const shell = openPopoverShell(this.trigger, this.opts.searchPlaceholder ?? "搜索标签…", this);
    this.pop = shell.pop;
    this.input = shell.input;
    this.cleanup = shell.cleanup;
    this.trigger.setAttribute("aria-expanded", "true");
    this.pop.createDiv({ cls: "db-ns-hint", text: this.opts.allowCreate ? "选择多项或新建" : "选择多项" });
    const list = this.pop.createDiv({ cls: "db-ns-list" });

    this.renderRows = () => {
      const q = (this.input?.value ?? "").trim().toLowerCase();
      /* 候选 = 外部选项 + 已选值（刚新建还没入库的值也要能看到、能取消勾选） */
      const all = [...new Set([...this.options(), ...this.cur])];
      const shown = all.filter(o => !q || o.toLowerCase().includes(q));
      list.empty();
      this.rows = [];
      if (!all.length && !this.opts.allowCreate) {
        list.createDiv({ cls: "db-ns-empty", text: "暂无选项" });
        return;
      }
      if (!shown.length && !this.opts.allowCreate) {
        list.createDiv({ cls: "db-ns-empty", text: "没有匹配的选项" });
      }
      shown.forEach(o => {
        const sel = this.cur.includes(o);
        const row = list.createDiv({
          cls: `db-ns-row${sel ? " is-sel" : ""}`,
          attr: { role: "option", "aria-selected": String(sel) },
        });
        const chip = row.createSpan({ cls: "db-ns-chip", text: o });
        chip.style.setProperty("--ns-chip", chipColor(o));
        if (sel) setIcon(row.createSpan({ cls: "db-ns-check" }), "check");
        row.addEventListener("click", () => this.toggle(o));
        this.rows.push(row);
      });
      if (this.opts.allowCreate && q && !all.some(o => o.toLowerCase() === q)) {
        const raw = this.input!.value.trim();
        const row = list.createDiv({ cls: "db-ns-row is-create", attr: { role: "option" } });
        setIcon(row.createSpan({ cls: "db-ns-plus" }), "plus");
        row.createSpan({ cls: "db-ns-chip", text: raw });
        row.addEventListener("click", () => this.create(raw));
        this.rows.push(row);
      }
      /* 默认高亮第一个；重绘（切换勾选）后保持高亮在原地 */
      this.activeIdx = this.rows.length ? Math.min(Math.max(0, this.activeIdx), this.rows.length - 1) : -1;
      this.rows.forEach((r, i) => r.toggleClass("is-kbd", i === this.activeIdx));
    };
    this.renderRows();
    this.input.addEventListener("input", () => this.renderRows());
    bindArrowNav(this.input, () => this.rows, () => this.activeIdx, i => { this.activeIdx = i; });
    this.input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.repeat) {
        e.preventDefault();
        if (this.activeIdx >= 0) this.rows[this.activeIdx].click();
      } else if (e.key === "Backspace" && !this.input!.value && this.cur.length) {
        /* 搜索为空按退格：移除最后一个已选值（Notion 同款） */
        e.preventDefault();
        this.commit(this.cur.slice(0, -1));
      }
    });
    this.opts.onOpen?.();
  }

  private renderRows: () => void = () => {};

  /** 现场新建：onCreate 规范化（如去 #），写进已选并清空搜索继续选 */
  private create(raw: string): void {
    const norm = this.opts.onCreate?.(raw);
    const v = (typeof norm === "string" ? norm : raw).trim();
    if (!v) return;
    if (!this.cur.includes(v)) this.commit([...this.cur, v]);
    else { this.paintTrigger(); this.renderRows(); }
    if (this.input) this.input.value = "";
    this.renderRows();
  }

  close(): void {
    const wasOpen = !!this.pop;
    if (openPop === this) openPop = null;
    this.cleanup?.();
    this.cleanup = null;
    this.pop?.remove();
    this.pop = null;
    this.input = null;
    this.rows = [];
    this.trigger.setAttribute("aria-expanded", "false");
    if (wasOpen) this.opts.onClose?.();
  }
}
