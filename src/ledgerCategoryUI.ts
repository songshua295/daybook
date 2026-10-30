/**
 * ledgerCategoryUI.ts — 记账「分类管理」界面（参照手机记账 App 的分类编辑页）
 *
 * 两处复用：设置 → 分类管理（页内二级页），以及「记一笔」浮层右上角「编辑」
 * 打开的浮层内嵌页。分类卡片可展开看二级分类、点二级分类改名/删除、
 * 拖右侧手柄排序（Pointer Events，鼠标和触屏同一套）；删除带记录的分类时，
 * 先在弹窗里选好转移目标再把记录整批迁走。
 *
 * 分类图标来自 categoryIcons 的图标库，可选「自动」按分类名匹配。
 */
import { App, Modal, Notice, setIcon } from "obsidian";
import { ConfirmModal } from "./TodayPanel";
import { LedgerCategory, LedgerStore } from "./ledgerStore";
import { allCategoryIconGroups, guessCategoryIcon, renderCategoryIcon } from "./categoryIcons";
import { NotionSelect } from "./notionSelect";

const uid = () => `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** 让 div 具备按钮的键盘可达性（与 planSortSheet 同规则） */
export function activatable<T extends HTMLElement>(el: T, ariaLabel: string): T {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", ariaLabel);
  el.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); el.click(); }
  });
  return el;
}

/** 依次尝试候选图标名，取第一个真正渲染出 svg 的（Obsidian 内置集随版本增删） */
function tryIcon(el: HTMLElement, names: string[]): void {
  for (const name of names) {
    setIcon(el, name);
    if (el.querySelector("svg")) return;
  }
}

/* ────────────────────────── 通用输入弹窗 ────────────────────────── */

/** 单行输入弹窗（新增二级分类等） */
export class PromptModal extends Modal {
  constructor(
    app: App,
    private opts: { title: string; placeholder?: string; value?: string; confirmText?: string; onConfirm: (value: string) => void },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: this.opts.title });
    const input = this.contentEl.createEl("input", {
      cls: "db-led-input",
      attr: { type: "text", placeholder: this.opts.placeholder ?? "", "aria-label": this.opts.title },
    });
    input.value = this.opts.value ?? "";
    const btns = this.contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { text: this.opts.confirmText ?? "确定", cls: "mod-cta" });
    const submit = () => {
      const v = input.value.trim();
      if (!v) { new Notice("请输入名称"); input.focus(); return; }
      this.close();
      this.opts.onConfirm(v);
    };
    ok.onclick = submit;
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.repeat) { e.preventDefault(); submit(); } });
    input.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}

export interface CategoryEditOptions {
  title: string;
  name: string;
  /** 初始图标 key（空 = 自动按名匹配） */
  icon: string;
  kind: "expense" | "income";
  canDelete: boolean;
  /** 一级分类 false = 二级分类编辑（不显示图标库） */
  showIcon?: boolean;
  onDelete?: () => void;
  onSave: (name: string, icon: string) => void;
}

/** 分类编辑弹窗：名称 + 图标库（二级分类隐藏图标区）+ 删除 */
export class CategoryEditModal extends Modal {
  private selIcon = "";
  constructor(app: App, private opts: CategoryEditOptions) {
    super(app);
    this.selIcon = opts.icon;
  }

  onOpen(): void {
    this.modalEl.addClass("db-cat-modal");
    const content = this.contentEl;
    content.empty();
    content.createEl("h3", { text: this.opts.title });
    const showIcon = this.opts.showIcon !== false;

    const nameField = content.createDiv({ cls: "db-cat-modal-field" });
    nameField.createDiv({ cls: "db-led-field-label", text: "名称" });
    const name = nameField.createEl("input", {
      cls: "db-led-input",
      attr: { type: "text", placeholder: "分类名称", "aria-label": "分类名称" },
    });
    name.value = this.opts.name;

    if (showIcon) {
      content.createDiv({ cls: "db-cat-modal-label", text: "图标（选「自动」按名称匹配）" });
      const scroll = content.createDiv({ cls: "db-cat-icon-scroll" });
      const grid = scroll.createDiv({ cls: "db-led-icon-grid" });
      // 选中态全库唯一：统一从滚动区清掉旧的高亮
      const clearSel = () => scroll.querySelectorAll(".db-led-icon-cell.is-active").forEach(el => el.removeClass("is-active"));

      const autoCell = grid.createEl("button", {
        cls: `db-led-icon-cell${this.selIcon === "" ? " is-active" : ""}`,
        attr: { type: "button", "aria-label": "自动匹配图标" },
      });
      const autoImg = autoCell.createSpan({ cls: "db-led-icon-cell-img" });
      renderCategoryIcon(autoImg, guessCategoryIcon(this.opts.name), this.opts.name || "自动");
      autoCell.createSpan({ cls: "db-led-icon-cell-label", text: "自动" });
      autoCell.addEventListener("click", () => { this.selIcon = ""; clearSel(); autoCell.addClass("is-active"); });
      // 改名时「自动」的预览跟着变
      name.addEventListener("input", () => {
        if (this.selIcon !== "") return;
        renderCategoryIcon(autoImg, guessCategoryIcon(name.value), name.value || "自动");
      });

      allCategoryIconGroups().forEach(group => {
        scroll.createDiv({ cls: "db-cat-icon-group-title", text: group.title });
        const ggrid = scroll.createDiv({ cls: "db-led-icon-grid" });
        group.items.forEach(def => {
          const cell = ggrid.createEl("button", {
            cls: `db-led-icon-cell${this.selIcon === def.key ? " is-active" : ""}`,
            attr: { type: "button", "aria-label": `${def.label}图标` },
          });
          renderCategoryIcon(cell.createSpan({ cls: "db-led-icon-cell-img" }), def.key, def.label);
          cell.createSpan({ cls: "db-led-icon-cell-label", text: def.label });
          cell.addEventListener("click", () => { this.selIcon = def.key; clearSel(); cell.addClass("is-active"); });
        });
      });
    }

    const btns = content.createDiv({ cls: "db-mood-modal-btns" });
    if (this.opts.canDelete && this.opts.onDelete) {
      const del = btns.createEl("button", { text: "删除", cls: "mod-warning" });
      del.onclick = () => { this.close(); this.opts.onDelete?.(); };
    }
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { text: "保存", cls: "mod-cta" });
    ok.onclick = () => {
      const v = name.value.trim();
      if (!v) { new Notice("请输入分类名称"); name.focus(); return; }
      this.close();
      this.opts.onSave(v, this.selIcon);
    };
    name.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}

/** 删除分类弹窗：分类下有记录时先选转移目标 */
export class CategoryDeleteModal extends Modal {
  constructor(
    app: App,
    private opts: { catName: string; count: number; targets: LedgerCategory[]; onConfirm: (targetId: string) => void },
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    const { catName, count, targets } = this.opts;
    this.contentEl.createEl("h3", { text: "删除分类" });
    let targetId = "";
    if (count > 0 && targets.length) {
      this.contentEl.createEl("p", { text: `「${catName}」下有 ${count} 条记录，删除后会转移到所选分类（其二级分类引用一并清除）：` });
      const field = this.contentEl.createDiv({ cls: "db-cat-modal-field" });
      field.createDiv({ cls: "db-led-field-label", text: "转移到" });
      targetId = targets[0].id;
      new NotionSelect(field, {
        options: targets.map(t => ({ value: t.id, label: t.name })),
        value: targetId,
        searchPlaceholder: "搜索分类…",
        ariaLabel: "转移目标分类",
        onSelect: v => { targetId = v; },
      });
    } else if (count > 0) {
      this.contentEl.createEl("p", { text: `「${catName}」下有 ${count} 条记录，没有其它同类型分类可转移，删除后这些记录将显示为「未分类」。` });
    } else {
      this.contentEl.createEl("p", { text: `确定删除「${catName}」？该分类下没有记录。` });
    }
    const btns = this.contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { text: "删除", cls: "mod-warning" });
    ok.onclick = () => { this.close(); this.opts.onConfirm(targetId); };
  }

  onClose(): void { this.contentEl.empty(); }
}

/* ────────────────────────── 分类管理器（P2） ────────────────────────── */

export interface CategoryManagerOptions {
  store: LedgerStore;
  /** 持久化 config.json */
  save: () => Promise<void>;
  /** 数据变化后通知调用方（调用方自行决定是否重绘外部视图） */
  onChange?: () => void;
  /** 有 = 以浮层内嵌页方式运行（带返回按钮） */
  onBack?: () => void;
  startKind?: "expense" | "income";
  onKindChange?: (k: "expense" | "income") => void;
  /** 初始展开的分类（从记一笔跳转时 = 当前选中的分类） */
  startOpenId?: string | null;
}

/** 分类管理：支出/收入页签 + 新增分类 + 可展开/拖拽排序的分类卡片列表 */
export class CategoryManager {
  private kind: "expense" | "income";
  private expanded = new Set<string>();
  private rootEl: HTMLElement | null = null;

  constructor(
    private app: App,
    private container: HTMLElement,
    private opts: CategoryManagerOptions,
  ) {
    this.kind = opts.startKind === "income" ? "income" : "expense";
    if (opts.startOpenId) this.expanded.add(opts.startOpenId);
  }

  private get cfg() { return this.opts.store.config; }

  /** 原地重绘（保留展开态与滚动位置）；重绘前清掉上一次的根节点 */
  render(): void {
    const scroll = this.rootEl?.scrollTop ?? 0;
    this.rootEl?.remove();
    const root = this.container.createDiv({ cls: "db-catmgr" });
    this.rootEl = root;

    if (this.opts.onBack) {
      const head = root.createDiv({ cls: "db-led-subhead" });
      const back = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": "返回记一笔" } });
      setIcon(back.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
      back.createSpan({ text: "返回" });
      back.addEventListener("click", () => this.opts.onBack?.());
      head.createSpan({ cls: "db-led-subhead-title", text: "分类管理" });
    }

    const tabs = root.createDiv({ cls: "db-led-seg is-tabs" });
    (["expense", "income"] as const).forEach(k => {
      const b = tabs.createDiv({ cls: `db-led-seg-btn${this.kind === k ? " is-active" : ""}`, text: k === "expense" ? "支出" : "收入" });
      b.addEventListener("click", () => {
        if (this.kind === k) return;
        this.kind = k;
        this.opts.onKindChange?.(k);
        this.render();
      });
    });

    const add = root.createEl("button", { cls: "db-catmgr-add", attr: { type: "button" } });
    setIcon(add.createSpan({ cls: "db-catmgr-add-icon" }), "plus");
    add.createSpan({ text: "新增分类" });
    add.addEventListener("click", () => this.openEditModal(null));

    const cats = this.cfg.categories.filter(c => c.kind === this.kind);
    if (!cats.length) {
      root.createDiv({ cls: "db-led-empty", text: "还没有分类，点上面「新增分类」建一个。" });
      return;
    }
    const list = root.createDiv({ cls: "db-catmgr-list" });
    cats.forEach(cat => this.renderCatCard(list, cat));

    if (scroll > 0) root.scrollTop = scroll;
  }

  private renderCatCard(list: HTMLElement, cat: LedgerCategory): void {
    const open = this.expanded.has(cat.id);
    const card = list.createDiv({ cls: `db-catmgr-cat${open ? " is-open" : ""}` });
    card.dataset.catId = cat.id;
    const head = card.createDiv({ cls: "db-catmgr-cat-head", attr: { role: "button", tabindex: "0", "aria-expanded": String(open) } });
    const chev = head.createSpan({ cls: "db-catmgr-chev" });
    tryIcon(chev, ["chevron-right", "play"]);

    const icon = head.createSpan({ cls: "db-catmgr-icon" });
    renderCategoryIcon(icon, cat.icon || guessCategoryIcon(cat.name), cat.name);
    head.createSpan({ cls: "db-catmgr-name", text: cat.name });

    const edit = head.createEl("button", { cls: "db-catmgr-edit", attr: { type: "button", "aria-label": `编辑「${cat.name}」`, title: "编辑" } });
    tryIcon(edit, ["pencil", "pen"]);
    edit.addEventListener("click", e => { e.stopPropagation(); this.openEditModal(cat); });

    const grip = head.createEl("button", { cls: "db-catmgr-grip", attr: { type: "button", "aria-label": `拖动排序「${cat.name}」`, title: "拖动排序" } });
    tryIcon(grip, ["grip-vertical", "grip-horizontal", "menu"]);
    grip.addEventListener("pointerdown", e => this.startDrag(e, grip, card, list));

    const body = card.createDiv({ cls: "db-catmgr-cat-body" });
    const subs = body.createDiv({ cls: "db-catmgr-subs" });
    cat.subs.forEach(s => {
      const cell = activatable(subs.createDiv({ cls: "db-led-catcell is-sub" }), `编辑二级分类「${s.name}」`);
      cell.createDiv({ cls: "db-led-catcircle", text: s.name.trim().slice(0, 1) || "?" });
      cell.createDiv({ cls: "db-led-catname", text: s.name });
      cell.addEventListener("click", () => this.openSubModal(cat, s));
    });
    const addSub = activatable(subs.createDiv({ cls: "db-led-catcell is-add" }), "新增二级分类");
    setIcon(addSub.createDiv({ cls: "db-led-catcircle" }), "plus");
    addSub.createDiv({ cls: "db-led-catname", text: "新增" });
    addSub.addEventListener("click", () => {
      new PromptModal(this.app, {
        title: `「${cat.name}」添加二级分类`,
        placeholder: "二级分类名称",
        onConfirm: v => void (async () => {
          cat.subs.push({ id: uid(), name: v });
          this.expanded.add(cat.id);
          await this.opts.save();
          this.render();
          this.opts.onChange?.();
        })(),
      }).open();
    });

    const toggle = () => {
      const next = !card.hasClass("is-open");
      card.toggleClass("is-open", next);
      if (next) this.expanded.add(cat.id); else this.expanded.delete(cat.id);
      head.setAttribute("aria-expanded", String(next));
    };
    head.addEventListener("click", e => { if ((e.target as HTMLElement).closest("button")) return; toggle(); });
    head.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); toggle(); }
    });
  }

  /** 新增 / 编辑一级分类（cat = null 表示新增） */
  private openEditModal(cat: LedgerCategory | null): void {
    const kind = this.kind;
    new CategoryEditModal(this.app, {
      title: cat ? "编辑分类" : "新增分类",
      name: cat?.name ?? "",
      icon: cat?.icon ?? "",
      kind,
      canDelete: !!cat,
      onDelete: cat ? () => this.deleteCategory(cat) : undefined,
      onSave: (name, icon) => void (async () => {
        if (cat) {
          cat.name = name;
          cat.icon = icon;
        } else {
          const created: LedgerCategory = { id: uid(), name, icon, kind, subs: [] };
          this.cfg.categories.push(created);
          this.expanded.add(created.id);
        }
        await this.opts.save();
        this.render();
        this.opts.onChange?.();
      })(),
    }).open();
  }

  /** 删除分类：有记录时先选转移目标，再把记录整批迁走 */
  private deleteCategory(cat: LedgerCategory): void {
    const count = this.opts.store.records.filter(r => r.categoryId === cat.id).length;
    const targets = this.cfg.categories.filter(c => c.kind === cat.kind && c.id !== cat.id);
    new CategoryDeleteModal(this.app, {
      catName: cat.name,
      count,
      targets,
      onConfirm: targetId => void (async () => {
        if (targetId) await this.opts.store.retargetCategory(cat.id, targetId);
        const idx = this.cfg.categories.indexOf(cat);
        if (idx >= 0) this.cfg.categories.splice(idx, 1);
        this.expanded.delete(cat.id);
        await this.opts.save();
        this.render();
        this.opts.onChange?.();
        new Notice(count && targetId ? `已删除「${cat.name}」，${count} 条记录已转移` : `已删除「${cat.name}」`);
      })(),
    }).open();
  }

  /** 编辑 / 删除二级分类 */
  private openSubModal(cat: LedgerCategory, sub: { id: string; name: string }): void {
    new CategoryEditModal(this.app, {
      title: `编辑二级分类 · ${cat.name}`,
      name: sub.name,
      icon: "",
      kind: cat.kind === "income" ? "income" : "expense",
      canDelete: true,
      showIcon: false,
      onDelete: () => {
        const count = this.opts.store.records.filter(r => r.categoryId === cat.id && r.subId === sub.id).length;
        new ConfirmModal(
          this.app,
          "删除二级分类",
          count
            ? `「${cat.name} · ${sub.name}」下有 ${count} 条记录，删除后这些记录只保留一级分类。`
            : `确定删除二级分类「${sub.name}」？`,
          "删除",
          () => void (async () => {
            if (count) await this.opts.store.clearSubRecords(cat.id, sub.id);
            cat.subs = cat.subs.filter(s => s.id !== sub.id);
            await this.opts.save();
            this.render();
            this.opts.onChange?.();
          })(),
        ).open();
      },
      onSave: name => void (async () => {
        sub.name = name;
        await this.opts.save();
        this.render();
        this.opts.onChange?.();
      })(),
    }).open();
  }

  /** 拖拽排序：按住手柄，指针压到哪张卡片就把拖动卡插到它前/后半格 */
  private startDrag(e: PointerEvent, grip: HTMLElement, card: HTMLElement, list: HTMLElement): void {
    const cards = list.querySelectorAll(".db-catmgr-cat");
    if (cards.length < 2) return;
    e.preventDefault();
    card.addClass("is-dragging");
    try { grip.setPointerCapture(e.pointerId); } catch { /* 部分环境不支持捕获，仍可拖 */ }
    const doc = card.ownerDocument;

    const onMove = (ev: PointerEvent) => {
      const hit = doc.elementFromPoint(ev.clientX, ev.clientY);
      const over = hit ? hit.closest(".db-catmgr-cat") as HTMLElement | null : null;
      if (!over || over === card || !list.contains(over)) return;
      const r = over.getBoundingClientRect();
      list.insertBefore(card, ev.clientY < r.top + r.height / 2 ? over : over.nextSibling);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      card.removeClass("is-dragging");
      void this.applyOrder(list);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  }

  /** 拖完按 DOM 顺序写回 config（只重排当前页签下的类别，其它类型不动） */
  private async applyOrder(list: HTMLElement): Promise<void> {
    const ids = Array.from(list.children)
      .map(el => (el as HTMLElement).dataset.catId)
      .filter((v): v is string => !!v);
    if (!ids.length) return;
    const byId = new Map(this.cfg.categories.map(c => [c.id, c] as const));
    let i = 0;
    this.cfg.categories = this.cfg.categories
      .map(c => (c.kind === this.kind ? byId.get(ids[i++]) ?? c : c));
    await this.opts.save();
    this.render();
    this.opts.onChange?.();
  }
}
