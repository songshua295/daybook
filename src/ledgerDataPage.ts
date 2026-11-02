/**
 * ledgerDataPage.ts — 设置 → 「导入 / 导出」二级页（页内分步向导，不弹浮层、不新开标签）
 *
 * 步骤：menu（入口）→ file（选文件）→ detect（自动识别来源）→ columns（字段映射）
 *       → values（分类 / 账户对应）→ preview（勾选并确认）→ imported（结果）
 * 另有 export（导出账单）与 batches（导入记录，含整批撤销）。
 *
 * 安卓返回键：外层 LedgerPage 只保留一枚 popstate 哨兵；本页 handleBack() 逐回一步，
 * 退到底时回调 onExit() 回到设置菜单，由外层回收哨兵。
 */
import { App, Notice, Platform, moment, setIcon } from "obsidian";
import { ConfirmModal } from "./TodayPanel";
import type { LedgerImportBatch, LedgerKind, LedgerRecord } from "./ledgerStore";
import {
  BILL_FIELDS, BILL_SOURCES, EXPORT_COLUMNS, EXPORT_PRESETS, autoTarget, buildColumnMap, buildExportCsv,
  detectSheets, ensureValueMaps, existingSignatures, extractRows, fieldLabel, planImport, readBillFile,
  unassignedColumns, valueCounts,
} from "./ledgerBillIO";
import type { BillField, BillSheet, ColumnMap, DetectResult, ImportPlan, ParsedBillRow, ValueMaps } from "./ledgerBillIO";
import type { LedgerConfig, LedgerStore } from "./ledgerStore";
import type DaybookPlugin from "./main";

type IoStep = "menu" | "file" | "detect" | "columns" | "values" | "preview" | "imported" | "export" | "batches";

const STEP_TITLES: Record<IoStep, string> = {
  menu: "导入 / 导出", file: "选择账单文件", detect: "识别账单来源", columns: "字段映射",
  values: "分类与账户对应", preview: "核对并导入", imported: "导入完成", export: "导出账单", batches: "导入记录",
};

const KIND_LABEL: Record<LedgerKind, string> = { expense: "支出", income: "收入", transfer: "转账" };

const FORMAT_HINT = "支持 .xls / .xlsx / .csv：一木记账、随手记、挖财、钱迹、鲨鱼记账、支付宝、微信账单，以及本插件导出的模板。仅读取文件，不会改动原文件。";

export interface DataPageHost {
  app: App;
  plugin: DaybookPlugin;
  store: LedgerStore;
  onExit: () => void;      // 回到设置菜单（外层负责回收 popstate 哨兵）
  gotoPage: (page: "home" | "list") => void;
}

export class LedgerDataPage {
  private step: IoStep = "menu";
  private stack: IoStep[] = [];
  private destroyed = false;

  /* 文件与解析结果 */
  private fileName = "";
  private fileSize = 0;
  private sheets: BillSheet[] = [];
  private sheetIndex = 0;
  private detects: DetectResult[] = [];
  private sourceKey = "auto";
  private colMap: ColumnMap = {};
  private rows: ParsedBillRow[] = [];
  private sel: boolean[] = [];
  private maps: ValueMaps = { category: {}, account: {}, toAccount: {}, currency: {}, autoCreate: true };
  private busy = false;
  private previewLimit = 150;
  private statSelEl: HTMLElement | null = null;

  /* 导入选项 */
  private ledgerId = "";
  private skipDup = true;
  private forceKind: "" | LedgerKind = "";
  private lastPlan: ImportPlan | null = null;

  /* 导出选项 */
  private exportPreset = "daybook";
  private exportCols: string[] = EXPORT_PRESETS.daybook.cols.slice();
  private exportScope: "all" | "year" | "month" = "all";
  private exportWhen = moment().format("YYYY-MM");
  private exportLedger = "";
  private lastExport = "";

  constructor(private host: HTMLElement, private opts: DataPageHost) {}

  get cfg(): LedgerConfig { return this.opts.store.config; }

  destroy(): void { this.destroyed = true; }

  /** 返回键 / 返回按钮：还在向导里就退一步并返回 true；已在入口菜单则退出二级页返回 false */
  handleBack(): boolean {
    if (this.stack.length) {
      this.step = this.stack.pop()!;
      this.render();
      return true;
    }
    if (this.step !== "menu") { this.step = "menu"; this.render(); return true; }
    this.opts.onExit();
    return false;
  }

  /** 再次进入本页时回到入口菜单（清掉上一次没走完的向导状态里的步骤，数据仍可复用） */
  resetToMenu(): void { this.stack = []; this.step = "menu"; }

  private go(next: IoStep): void {
    this.stack.push(this.step);
    this.step = next;
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  /* ────────────────────────── 渲染骨架 ────────────────────────── */

  render(): void {
    if (this.destroyed) return;
    const host = this.host;
    host.empty();
    host.addClass("db-led-root");

    const head = host.createDiv({ cls: "db-led-subhead" });
    const atTop = this.step === "menu";
    const back = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": atTop ? "返回设置" : "上一步" } });
    setIcon(back.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
    back.createSpan({ text: atTop ? "返回" : "上一步" });
    back.addEventListener("click", () => this.handleBack());
    head.createSpan({ cls: "db-led-subhead-title", text: STEP_TITLES[this.step] });
    if (this.busy) head.createSpan({ cls: "db-led-subhead-tip", text: "处理中…" });

    const body = host.createDiv({ cls: "db-led-body" });
    switch (this.step) {
      case "menu": this.renderMenu(body); break;
      case "file": this.renderFile(body); break;
      case "detect": this.renderDetect(body); break;
      case "columns": this.renderColumns(body); break;
      case "values": this.renderValues(body); break;
      case "preview": this.renderPreview(body); break;
      case "imported": this.renderImported(body); break;
      case "export": this.renderExport(body); break;
      case "batches": this.renderBatches(body); break;
    }
  }

  /** 菜单行（与设置页同款） */
  private menuRow(parent: HTMLElement, label: string, sum: string, onClick: () => void): void {
    const btn = parent.createEl("button", { cls: "db-led-menu-row", attr: { type: "button" } });
    btn.createSpan({ cls: "db-led-menu-label", text: label });
    btn.createSpan({ cls: "db-led-menu-sum", text: sum });
    setIcon(btn.createSpan({ cls: "db-led-menu-chev" }), "chevron-right");
    btn.addEventListener("click", onClick);
  }

  private note(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: "db-led-note", text });
  }

  private primaryBtn(parent: HTMLElement, text: string, onClick: () => void): HTMLElement {
    const b = parent.createEl("button", { cls: "db-led-cta", attr: { type: "button" } });
    b.createSpan({ text });
    b.addEventListener("click", onClick);
    return b;
  }

  private footNav(parent: HTMLElement, nextText: string, onNext: () => void): void {
    const row = parent.createDiv({ cls: "db-led-io-foot" });
    const prev = row.createEl("button", { cls: "db-led-btn-ghost", attr: { type: "button" }, text: "上一步" });
    prev.addEventListener("click", () => this.handleBack());
    this.primaryBtn(row, nextText, onNext);
  }

  /* ────────────────────────── 入口菜单 ────────────────────────── */

  private renderMenu(body: HTMLElement): void {
    const list = body.createDiv({ cls: "db-led-card db-led-menu" });
    const done = this.opts.store.batches.filter(b => !b.undoneAt).length;
    this.menuRow(list, "导入账单", done ? `${done} 次导入` : "xls / xlsx / csv", () => { this.go("file"); });
    this.menuRow(list, "导出账单", "CSV（可选列）", () => this.go("export"));
    this.menuRow(list, "导入记录", this.opts.store.batches.length ? `${this.opts.store.batches.length} 条台账` : "可整批撤销", () => this.go("batches"));
    this.note(body, FORMAT_HINT);
    this.note(body, "导入前先在这里核对识别结果与分类、账户的对应关系；确认后才写入账本，并可随时在「导入记录」里整批撤销。");
  }

  /* ────────────────────────── 1. 选文件 ────────────────────────── */

  private renderFile(body: HTMLElement): void {
    const card = body.createDiv({ cls: "db-led-card db-led-io-card" });
    card.createDiv({ cls: "db-led-io-tip", text: "从手机 / 电脑选文件" });
    this.note(card, "选好账单文件后自动识别来源 App 或模板，识别错了可以在下一步手动改。");
    this.primaryBtn(card, "选择账单文件", () => this.pickFile());
    if (!Platform.isMobileApp) this.note(card, "也可以在下方填仓库里的文件路径（例如 Daily/ledger/账单.xls）。");

    const vcard = body.createDiv({ cls: "db-led-card" });
    vcard.createDiv({ cls: "db-led-card-title", text: "仓库内路径" });
    const row = vcard.createDiv({ cls: "db-led-io-vault" });
    const input = row.createEl("input", { cls: "db-led-input", attr: { type: "text", placeholder: "Daily/ledger/xxx.xls", "aria-label": "仓库文件路径" } });
    const btn = row.createEl("button", { cls: "db-led-btn-ghost", attr: { type: "button" }, text: "读取" });
    btn.addEventListener("click", () => void this.loadFromVault(input.value.trim()));
    const candidates = this.vaultCandidates();
    if (candidates.length) {
      const hint = vcard.createDiv({ cls: "db-led-io-files" });
      hint.createDiv({ cls: "db-led-group-hint", text: "仓库里像账单的文件：" });
      candidates.slice(0, 8).forEach(p => {
        const chip = hint.createEl("button", { cls: "db-led-chip db-led-chip-file", attr: { type: "button" }, text: p.split("/").slice(-1)[0] });
        chip.addEventListener("click", () => void this.loadFromVault(p));
      });
    }
    if (this.fileName) {
      const st = body.createDiv({ cls: "db-led-card db-led-io-loaded" });
      st.createDiv({ cls: "db-led-io-file-name", text: `${this.fileName}（${(this.fileSize / 1024).toFixed(0)} KB，${this.sheets.length} 个工作表）` });
      this.primaryBtn(st, "开始识别", () => this.parseAndDetect());
    }
  }

  private vaultCandidates(): string[] {
    const out: string[] = [];
    try {
      this.opts.app.vault.getFiles().forEach(f => {
        const ext = f.extension.toLowerCase();
        if (ext === "csv" || ext === "xls" || ext === "xlsx") out.push(f.path);
      });
    } catch (e) { /* 取不到就当没有 */ }
    return out;
  }

  private pickFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xls,.xlsx,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";
    input.style.display = "none";
    document.body.appendChild(input);
    const clean = () => { if (input.parentNode) input.parentNode.removeChild(input); };
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      clean();
      if (!file) return;
      const done = (buf: ArrayBuffer): void => void this.loadFromBytes(new Uint8Array(buf), file.name, file.size);
      if (typeof file.arrayBuffer === "function") void file.arrayBuffer().then(done);
      else {
        const fr = new FileReader();
        fr.onload = () => done(fr.result as ArrayBuffer);
        fr.onerror = () => new Notice("读取文件失败");
        fr.readAsArrayBuffer(file);
      }
    });
    input.addEventListener("cancel", clean);
    input.click();
  }

  private async loadFromVault(path: string): Promise<void> {
    if (!path) { new Notice("请先填写文件路径"); return; }
    try {
      const buf = await this.opts.app.vault.adapter.readBinary(path);
      await this.loadFromBytes(new Uint8Array(buf), path.split("/").slice(-1)[0], buf.byteLength);
    } catch (e) {
      new Notice(`读不到 ${path}，请确认路径是否正确、文件是否在仓库内`);
    }
  }

  private async loadFromBytes(bytes: Uint8Array, name: string, size: number): Promise<void> {
    this.fileName = name; this.fileSize = size || bytes.byteLength;
    this.busy = true; this.render();
    /* 让「处理中」先画出来，再跑可能上百毫秒的 Excel 解析 */
    await new Promise<void>(r => setTimeout(r, 40));
    let sheets: BillSheet[] = [];
    let err = "";
    try { sheets = readBillFile(bytes, name); }
    catch (e) { err = e && e.message ? String(e.message) : String(e); }
    this.busy = false;
    if (err || !sheets.length) {
      new Notice(err ? `解析失败：${err}` : "没能在文件里找到表格数据");
      this.fileName = ""; this.sheets = [];
      this.render();
      return;
    }
    this.sheets = sheets;
    this.go("detect");
    this.detectAndPrepare();
  }

  /* ────────────────────────── 2. 识别来源 ────────────────────────── */

  /** 从「选择文件」回到识别步骤：重新按当前文件识别一次 */
  private parseAndDetect(): void {
    this.go("detect");
    this.detectAndPrepare();
  }

  private detectAndPrepare(): void {
    this.detects = detectSheets(this.sheets);
    const top = this.detects[0];
    this.sheetIndex = top ? top.sheetIndex : 0;
    this.sourceKey = top ? top.key : "auto";
    this.rebuildMapping();
  }

  private currentSheet(): BillSheet | null { return this.sheets[this.sheetIndex] ?? this.sheets[0] ?? null; }

  private currentSource() {
    return BILL_SOURCES.find(s => s.key === this.sourceKey) ?? BILL_SOURCES[BILL_SOURCES.length - 1];
  }

  /** 换来源 / 换工作表：重置字段映射，值映射尽量保留同名条目 */
  private rebuildMapping(keepValues = false): void {
    const sh = this.currentSheet();
    if (!sh) return;
    this.colMap = buildColumnMap(this.currentSource(), sh);
    const sigs = existingSignatures(this.opts.store.records, this.cfg);
    this.rows = extractRows(sh, this.colMap, this.currentSource(), sigs);
    this.sel = this.rows.map(r => !r.error);
    this.maps = keepValues ? ensureValueMaps(this.cfg, this.rows, this.maps)
      : ensureValueMaps(this.cfg, this.rows, { category: {}, account: {}, toAccount: {}, currency: {}, autoCreate: this.maps.autoCreate });
    if (!this.ledgerId) this.ledgerId = this.cfg.ledgers[0]?.id ?? "";
    this.previewLimit = 150;
  }

  private renderDetect(body: HTMLElement): void {
    const sh = this.currentSheet();
    if (!sh) { this.note(body, "文件里没有可识别的工作表"); return; }
    const best = this.detects.filter(d => d.sheetIndex === this.sheetIndex);
    const top = best.find(d => d.key === this.sourceKey) ?? best[0];
    const card = body.createDiv({ cls: "db-led-card" });
    card.createDiv({ cls: "db-led-card-title", text: "自动识别结果" });
    const big = card.createDiv({ cls: "db-led-io-detect" });
    big.createSpan({ cls: "db-led-io-detect-name", text: this.currentSource().label });
    const conf = top ? Math.max(0, Math.min(100, Math.round((top.score / Math.max(1, top.maxScore)) * 100))) : 0;
    big.createSpan({ cls: `db-led-io-detect-conf${conf >= 70 ? " is-good" : conf >= 40 ? " is-mid" : ""}`, text: `置信度 ${conf}%` });
    if (top && top.required.length) {
      card.createDiv({ cls: "db-led-io-miss", text: `必要字段还没找到列：${top.required.map(fieldLabel).join("、")}，请在下一步手动指定。` });
    }
    this.note(card, this.currentSource().hint);

    const row = body.createDiv({ cls: "db-led-card db-led-io-selects" });
    const srcSel = row.createEl("select", { cls: "db-led-select", attr: { "aria-label": "账单来源" } });
    BILL_SOURCES.forEach(s => srcSel.createEl("option", { value: s.key, text: s.key === this.sourceKey ? `${s.label}（当前）` : s.label }));
    srcSel.value = this.sourceKey;
    srcSel.addEventListener("change", () => { this.sourceKey = srcSel.value; this.rebuildMapping(); this.render(); });
    if (this.sheets.length > 1) {
      const sheetSel = row.createEl("select", { cls: "db-led-select", attr: { "aria-label": "工作表" } });
      this.sheets.forEach((s, i) => sheetSel.createEl("option", { value: String(i), text: `工作表：${s.name || "第" + (i + 1) + "个"}（${s.rows.length} 行）` }));
      sheetSel.value = String(this.sheetIndex);
      sheetSel.addEventListener("change", () => { this.sheetIndex = Number(sheetSel.value); this.rebuildMapping(); this.render(); });
    }

    const hcard = body.createDiv({ cls: "db-led-card" });
    hcard.createDiv({ cls: "db-led-card-title", text: `表头（第 ${this.currentSheet()!.headerRow + 1} 行，共 ${sh.rows.length} 行数据）` });
    const chips = hcard.createDiv({ cls: "db-led-io-headers" });
    sh.headers.forEach((h, i) => {
      const used = this.usedColumns().indexOf(i) >= 0;
      const c = chips.createDiv({ cls: `db-led-io-header${used ? " is-used" : ""}`, text: h || `第 ${i + 1} 列` });
      void c;
    });

    const sum = this.rows.filter(r => !r.error);
    this.note(body, `按当前映射可解析 ${sum.length} / ${this.rows.length} 行；不确定的列可以在「字段映射」里逐列改。`);
    this.footNav(body, "下一步：字段映射", () => this.go("columns"));
  }

  private usedColumns(): number[] {
    const out: number[] = [];
    (Object.keys(this.colMap) as BillField[]).forEach(f => { const v = this.colMap[f]; if (v != null) out.push(v); });
    return out;
  }

  /* ────────────────────────── 3. 字段映射 ────────────────────────── */

  private columnOptions(exclude?: BillField): { value: string; text: string }[] {
    const sh = this.currentSheet();
    if (!sh) return [];
    const taken: Record<number, BillField> = {};
    (Object.keys(this.colMap) as BillField[]).forEach(f => { if (f !== exclude) { const v = this.colMap[f]; if (v != null) taken[v] = f; } });
    const opts = [{ value: "-1", text: "（不使用）" }];
    sh.headers.forEach((h, i) => {
      const label = (h || `第 ${i + 1} 列`).slice(0, 24);
      const by = taken[i] ? ` ← 已用于「${fieldLabel(taken[i])}」` : "";
      opts.push({ value: String(i), text: `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i + 1 : ""} 列 · ${label}${by}` });
    });
    return opts;
  }

  private renderColumns(body: HTMLElement): void {
    const sh = this.currentSheet();
    if (!sh) return;
    const groups: (BillField[])[] = [["date", "kind", "amount"], ["incomeAmount", "expenseAmount"], ["category", "subcategory", "account", "toAccount", "ledger"], ["currency", "refund", "discount", "time", "note", "tags", "creator"]];
    groups.forEach((grp, gi) => {
      const card = body.createDiv({ cls: "db-led-card" });
      if (gi === 0) card.createDiv({ cls: "db-led-card-title", text: "必要字段" });
      else if (gi === 1) card.createDiv({ cls: "db-led-card-title", text: "收入 / 支出分列（有分列时优先用分列）" });
      else if (gi === 2) card.createDiv({ cls: "db-led-card-title", text: "分类与账户" });
      else card.createDiv({ cls: "db-led-card-title", text: "其他字段" });
      grp.forEach(f => this.mapRow(card, f));
    });

    const left = unassignedColumns(sh, this.colMap);
    const card = body.createDiv({ cls: "db-led-card" });
    card.createDiv({ cls: "db-led-card-title", text: left.length ? `文件里还没用到的列（${left.length} 列）` : "所有列都已安排" });
    if (!left.length) this.note(card, "确认无误后进入下一步。");
    left.forEach(i => {
      const row = card.createDiv({ cls: "db-led-map-row" });
      row.createSpan({ cls: "db-led-map-name", text: (sh.headers[i] || `第 ${i + 1} 列`).slice(0, 18) });
      const sel = row.createEl("select", { cls: "db-led-select db-led-map-to", attr: { "aria-label": "这一列对应哪个字段" } });
      sel.createEl("option", { value: "", text: "（忽略这一列）" });
      BILL_FIELDS.forEach(d => sel.createEl("option", { value: d.field, text: d.label }));
      sel.addEventListener("change", () => {
        const f = sel.value as BillField;
        if (!f) return;
        this.colMap[f] = i;
        this.rebuildMapping(true);
        this.render();
      });
    });

    this.footNav(body, "下一步：分类与账户", () => { this.rebuildMapping(true); this.go("values"); });
  }

  private mapRow(card: HTMLElement, f: BillField): void {
    const def = BILL_FIELDS.find(d => d.field === f)!;
    const row = card.createDiv({ cls: "db-led-map-row" });
    const lab = row.createSpan({ cls: "db-led-map-name", text: def.label });
    if (f === "date" || f === "amount") lab.addClass("is-req");
    const sel = row.createEl("select", { cls: "db-led-select db-led-map-to", attr: { "aria-label": def.label + "对应的列" } });
    this.columnOptions(f).forEach(o => sel.createEl("option", { value: o.value, text: o.text }));
    sel.value = String(this.colMap[f] ?? -1);
    sel.addEventListener("change", () => {
      const v = Number(sel.value);
      if (v < 0) delete this.colMap[f]; else this.colMap[f] = v;
      this.rebuildMapping(true);
      this.render();
    });
    const sample = this.sampleFor(f);
    if (sample) row.createSpan({ cls: "db-led-map-sample", text: sample });
  }

  private sampleFor(f: BillField): string {
    const sh = this.currentSheet();
    const col = this.colMap[f];
    if (!sh || col == null || col < 0) return "";
    const hit = sh.rows.find(r => (r[col] ?? "") !== "");
    return hit ? String(hit[col]).slice(0, 14) : "";
  }

  /* ────────────────────────── 4. 值映射 ────────────────────────── */

  private renderValues(body: HTMLElement): void {
    const cfg = this.cfg;
    const autoCard = body.createDiv({ cls: "db-led-card db-led-io-card" });
    autoCard.createDiv({ cls: "db-led-card-title", text: "匹配不到时怎么办" });
    this.switchRow(autoCard, "自动新建同名的分类 / 账户", this.maps.autoCreate, v => {
      this.maps.autoCreate = v;
      (["category", "account", "toAccount", "currency"] as const).forEach(key => {
        const table = this.maps[key];
        Object.keys(table).forEach(v => { if (table[v] === "") table[v] = this.defaultTarget(key, v); });
      });
      this.render();
    });
    this.switchRow(autoCard, "跳过重复记录（同日期同时刻同金额同账户同备注）", this.skipDup, v => { this.skipDup = v; this.render(); });
    const kindRow = autoCard.createDiv({ cls: "db-led-io-inline" });
    kindRow.createSpan({ cls: "db-led-set-label", text: "强制方向" });
    const ksel = kindRow.createEl("select", { cls: "db-led-select", attr: { "aria-label": "强制收支方向" } });
    [["", "按文件里的类型列"], ["expense", "全部记为支出"], ["income", "全部记为收入"], ["transfer", "全部记为转账"]]
      .forEach(([v, t]) => ksel.createEl("option", { value: v, text: t }));
    ksel.value = this.forceKind;
    ksel.addEventListener("change", () => { this.forceKind = ksel.value as "" | LedgerKind; this.render(); });
    if (this.forceKind === "transfer") this.note(autoCard, "整批按转账导入时，每一行都需要能解析出「转入账户」，否则会在校验时被标为无效。");

    /* 账本 */
    const lcard = body.createDiv({ cls: "db-led-card" });
    lcard.createDiv({ cls: "db-led-card-title", text: "导入到哪个账本" });
    const lrow = lcard.createDiv({ cls: "db-led-io-inline" });
    lrow.createSpan({ cls: "db-led-set-label", text: "目标账本" });
    const lsel = lrow.createEl("select", { cls: "db-led-select", attr: { "aria-label": "目标账本" } });
    cfg.ledgers.forEach(l => lsel.createEl("option", { value: l.id, text: l.name }));
    lsel.value = this.ledgerId || cfg.ledgers[0]?.id || "";
    lsel.addEventListener("change", () => { this.ledgerId = lsel.value; });
    this.note(lcard, "文件里的「账本」列只作为参考展示，所有记录统一导入到所选账本，避免一次导入凭空多出好几个账本。");

    this.valueCard(body, "category", "类别", (value) => this.categoryOptions(value));
    this.valueCard(body, "account", "账户", (value) => this.accountOptions("account", value));
    if (valueCounts(this.rows, r => r.toAccount).size) this.valueCard(body, "toAccount", "转入账户", (value) => this.accountOptions("toAccount", value));
    if (valueCounts(this.rows, r => r.currency).size) this.valueCard(body, "currency", "币种", (value) => this.currencyOptions(value));

    this.footNav(body, "下一步：核对记录", () => { this.previewLimit = 150; this.go("preview"); });
  }

  private defaultTarget(key: "category" | "account" | "toAccount" | "currency", value: string): string {
    if (key === "currency") return autoTarget("currency", value, this.cfg, this.rows);
    if (key === "account" || key === "toAccount") return autoTarget("account", value, this.cfg, this.rows);
    return autoTarget("category", value, this.cfg, this.rows);
  }

  private switchRow(card: HTMLElement, label: string, on: boolean, onChange: (v: boolean) => void): void {
    const row = card.createDiv({ cls: "db-led-switch-row" });
    row.createSpan({ cls: "db-led-set-label", text: label });
    const btn = row.createEl("button", { cls: `db-led-switch${on ? " is-on" : ""}`, attr: { type: "button", role: "switch", "aria-checked": String(on), "aria-label": label } });
    btn.createSpan({ cls: "db-led-switch-knob" });
    btn.addEventListener("click", () => onChange(!on));
  }

  private categoryOptions(value: string): { value: string; text: string }[] {
    const kind: LedgerKind = this.valueKindOf("category", value);
    const out = [{ value: "", text: "忽略（记为未分类）" }];
    this.cfg.categories.filter(c => c.kind === kind).forEach(c => out.push({ value: `id:${c.id}`, text: `已有 · ${c.name}` }));
    out.push({ value: "new", text: `＋ 新建「${value}」${kind === "income" ? "（收入类别）" : ""}` });
    out.push({ value: "__new", text: "＋ 新建其他名称…" });
    return out;
  }

  private accountOptions(_key: "account" | "toAccount", value: string): { value: string; text: string }[] {
    const out = [{ value: "", text: "忽略（不记账户）" }];
    this.cfg.accounts.filter(a => !a.archived).forEach(a => out.push({ value: `id:${a.id}`, text: `已有 · ${a.name}` }));
    out.push({ value: "new", text: `＋ 新建账户「${value}」` });
    out.push({ value: "__new", text: "＋ 新建其他名称…" });
    return out;
  }

  private currencyOptions(value: string): { value: string; text: string }[] {
    const out = [{ value: "", text: `忽略（按基准币 ${this.cfg.baseCurrency} 记）` }];
    this.cfg.currencies.forEach(c => out.push({ value: `id:${c.code}`, text: `${c.code} · ${c.name}` }));
    out.push({ value: "__new", text: "＋ 新币种代码…" });
    return out;
  }

  /** 源值主要出现在哪种收支里（决定新建类别挂到哪一组） */
  private valueKindOf(key: "category", value: string): LedgerKind {
    let inc = 0, exp = 0;
    this.rows.forEach(r => { if (r.category === value) { if (r.kind === "income") inc++; else exp++; } });
    return inc > exp ? "income" : "expense";
  }

  private valueCard(body: HTMLElement, key: "category" | "account" | "toAccount" | "currency", label: string, opts: (v: string) => { value: string; text: string }[]): void {
    const table = this.maps[key];
    const of = (r: ParsedBillRow): string => key === "category" ? r.category : key === "account" ? r.account : key === "toAccount" ? r.toAccount : r.currency;
    const counts = valueCounts(this.rows, of);
    if (!counts.size) return;
    const entries: [string, number][] = [];
    counts.forEach((c, v) => entries.push([v, c]));
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
    const matched = entries.filter(([v]) => (table[v] ?? "").indexOf("id:") === 0).length;
    const creating = entries.filter(([v]) => { const t = table[v] ?? ""; return t === "new" || t.indexOf("new:") === 0; }).length;
    const ignored = entries.filter(([v]) => (table[v] ?? "") === "").length;
    const card = body.createDiv({ cls: "db-led-card" });
    card.createDiv({
      cls: "db-led-card-title",
      text: `${label}对应（${entries.length} 项：匹配 ${matched} · 新建 ${creating}${ignored ? ` · 忽略 ${ignored}` : ""}）`,
    });
    entries.forEach(([v, count]) => {
      const row = card.createDiv({ cls: "db-led-map-row" });
      row.createSpan({ cls: "db-led-map-name", text: `${v} ×${count}` });
      const options = opts(v);
      const sel = row.createEl("select", { cls: "db-led-select db-led-map-to", attr: { "aria-label": `${v} 对应哪个${label}` } });
      options.forEach(o => sel.createEl("option", { value: o.value, text: o.text }));
      const cur = table[v] ?? "";
      sel.value = options.some(o => o.value === cur) ? cur : "";
      const custom = row.createEl("input", { cls: "db-led-input db-led-map-custom", attr: { type: "text", placeholder: "新名称", "aria-label": `${v} 的新名称` } });
      const wantCustom = cur.indexOf("__new") === 0 || cur.indexOf("new:") === 0;
      custom.style.display = wantCustom ? "block" : "none";
      custom.value = cur.indexOf("new:") === 0 ? cur.slice(4) : v;
      custom.addEventListener("change", () => {
        const nm = custom.value.trim();
        this.maps[key][v] = nm ? `new:${nm}` : "new";
        this.render();
      });
      sel.addEventListener("change", () => {
        if (sel.value === "__new") { this.maps[key][v] = `new:${custom.value.trim() || v}`; this.render(); return; }
        this.maps[key][v] = sel.value;
        this.render();
      });
    });
  }

  /* ────────────────────────── 5. 预览与勾选 ────────────────────────── */

  private countSel(): number { return this.sel.reduce((n, v, i) => n + (v && !this.rows[i].error ? 1 : 0), 0); }

  private renderPreview(body: HTMLElement): void {
    const rows = this.rows;
    const invalid = rows.filter(r => r.error).length;
    const dup = rows.filter(r => r.dup && !r.error).length;
    const bar = body.createDiv({ cls: "db-led-card db-led-io-bar" });
    const stat = bar.createDiv({ cls: "db-led-io-stat" });
    stat.createSpan({ text: `共 ${rows.length} 行` });
    this.statSelEl = stat.createSpan({ cls: "is-sel", text: `已选 ${this.countSel()}` });
    if (invalid) stat.createSpan({ cls: "is-bad", text: `无效 ${invalid}` });
    if (dup) stat.createSpan({ cls: this.skipDup ? "is-dup" : "is-warn", text: `重复 ${dup}${this.skipDup ? "（不导入）" : ""}` });
    const tools = bar.createDiv({ cls: "db-led-io-tools" });
    const chip = (text: string, fn: () => void) => { const c = tools.createEl("button", { cls: "db-led-chip", attr: { type: "button" }, text }); c.addEventListener("click", fn); };
    chip("全选", () => { this.sel = rows.map(() => true); this.render(); });
    chip("全不选", () => { this.sel = rows.map(() => false); this.render(); });
    chip("仅有效", () => { this.sel = rows.map(r => !r.error); this.render(); });
    chip("取消重复", () => { this.sel = this.sel.map((v, i) => v && !rows[i].dup); this.render(); });

    const card = body.createDiv({ cls: "db-led-card db-led-io-list" });
    const shown = Math.min(this.previewLimit, rows.length);
    for (let i = 0; i < shown; i++) this.previewRow(card, i);
    if (rows.length > shown) {
      const more = card.createEl("button", { cls: "db-led-add", attr: { type: "button" }, text: `显示更多（还有 ${rows.length - shown} 行）` });
      more.addEventListener("click", () => { this.previewLimit += 300; this.render(); });
    }

    this.primaryBtn(body, `导入选中的 ${this.countSel()} 条`, () => void this.commit());
    this.note(body, "导入后会生成一条「导入记录」台账，可按批次整批撤销；撤销只删这批记录，不会删这次顺手新建的分类和账户。");
    const back = body.createEl("button", { cls: "db-led-btn-ghost db-led-io-back", attr: { type: "button" }, text: "上一步：分类与账户" });
    back.addEventListener("click", () => this.handleBack());
  }

  private previewRow(card: HTMLElement, i: number): void {
    const r = this.rows[i];
    const row = card.createDiv({ cls: `db-led-io-row${r.error ? " is-bad" : ""}${r.dup ? " is-dup" : ""}` });
    const cb = row.createEl("input", { cls: "db-led-check", attr: { type: "checkbox", "aria-label": `第 ${r.line} 行` } });
    cb.checked = !!this.sel[i];
    cb.disabled = !!r.error;
    cb.addEventListener("change", () => {
      this.sel[i] = cb.checked;
      this.statSelEl?.setText(`已选 ${this.countSel()}`);
    });
    const mid = row.createDiv({ cls: "db-led-io-mid" });
    const t = moment(r.date, "YYYY-MM-DD");
    mid.createDiv({ cls: "db-led-io-title", text: `${t.isValid() ? t.format("M月D日") : r.date || "日期异常"}${r.clock ? " " + r.clock : ""} · 第 ${r.line} 行` });
    const mapText = this.mappingText(r);
    mid.createDiv({ cls: "db-led-io-sub", text: mapText });
    if (r.error) mid.createDiv({ cls: "db-led-io-err", text: r.error });
    else if (r.dup) mid.createDiv({ cls: "db-led-io-err", text: r.dup });
    else if (r.warn) mid.createDiv({ cls: "db-led-io-warn", text: r.warn });
    const right = row.createDiv({ cls: "db-led-io-right" });
    const kind = this.forceKind || r.kind;
    const sign = kind === "income" ? "+" : kind === "expense" ? "-" : "";
    right.createDiv({ cls: `db-led-io-amount is-${kind === "transfer" ? "tr" : kind === "income" ? "in" : "out"}`, text: `${sign}${r.amount.toFixed(2)}` });
    right.createDiv({ cls: "db-led-io-kind", text: KIND_LABEL[kind] });
  }

  private mappingText(r: ParsedBillRow): string {
    const bits: string[] = [];
    const catName = r.category ? this.targetName("category", this.maps.category[r.category] ?? "", r.category) : "";
    if (r.kind !== "transfer" && catName) bits.push(`类别 ${r.category} → ${catName}`);
    if (r.subcategory) bits.push(`二级 ${r.subcategory} → ${this.subTargetName(catName, r.subcategory)}`);
    if (r.account) bits.push(`账户 ${r.account} → ${this.targetName("account", this.maps.account[r.account] ?? "", r.account)}`);
    if (r.toAccount) bits.push(`转入 ${r.toAccount} → ${this.targetName("account", this.maps.toAccount[r.toAccount] ?? "", r.toAccount)}`);
    if (r.note) bits.push(r.note);
    return bits.join(" · ") || "（无分类与账户）";
  }

  /** 二级分类会挂到解析出的类别下：已有同名 → 原名；否则提示将新建 */
  private subTargetName(catName: string, sub: string): string {
    if (!catName || catName.indexOf("未分类") === 0) return sub;
    const cat = this.cfg.categories.find(c => c.name === catName);
    if (cat && cat.subs.some(s => s.name === sub)) return sub;
    return `新建 ${sub}`;
  }

  private targetName(kind: "category" | "account" | "currency", target: string, source: string): string {
    if (!target) return kind === "currency" ? `基准币 ${this.cfg.baseCurrency}` : "未分类";
    if (target.indexOf("id:") === 0) {
      const id = target.slice(3);
      if (kind === "category") return this.cfg.categories.find(c => c.id === id)?.name ?? "?";
      if (kind === "account") return this.cfg.accounts.find(a => a.id === id)?.name ?? "?";
      return id;
    }
    if (target === "new") return `新建 ${source}`;
    if (target.indexOf("new:") === 0) return `新建 ${target.slice(4)}`;
    return source;
  }

  private async commit(): Promise<void> {
    if (this.busy) return;
    const plan = planImport(this.cfg, this.rows, this.sel, this.maps, {
      ledgerId: this.ledgerId || this.cfg.ledgers[0]?.id || "",
      skipDup: this.skipDup, autoCreate: this.maps.autoCreate, forceKind: this.forceKind || undefined,
    });
    if (!plan.records.length) { new Notice("没有可导入的记录（可能被全部取消勾选，或都判为重复）"); return; }
    this.busy = true; this.render();
    const batch: LedgerImportBatch = {
      id: plan.batchId, at: Date.now(), file: this.fileName, source: this.currentSource().label,
      ledgerId: plan.records[0]?.ledgerId ?? "", count: plan.records.length,
      createdCategories: plan.createdCategories, createdAccounts: plan.createdAccounts,
    };
    try {
      await this.opts.store.addRecordsBulk(plan.records, batch);
      await this.opts.store.saveConfig();
    } catch (e) {
      this.busy = false;
      new Notice("写入失败，请查看控制台");
      console.error("Daybook ledger import:", e);
      return;
    }
    this.busy = false;
    this.lastPlan = plan;
    this.stack = [];
    this.step = "imported";
    this.render();
  }

  private renderImported(body: HTMLElement): void {
    const plan = this.lastPlan;
    if (!plan) { this.opts.onExit(); return; }
    const card = body.createDiv({ cls: "db-led-card db-led-io-done" });
    card.createDiv({ cls: "db-led-card-title", text: "导入完成" });
    const grid = card.createDiv({ cls: "db-led-hero-grid" });
    const cell = (label: string, value: string) => {
      const el = grid.createDiv({ cls: "db-led-hero-cell" });
      el.createDiv({ cls: "db-led-hero-label", text: label });
      el.createDiv({ cls: "db-led-hero-value", text: value });
    };
    cell("写入记录", `${plan.records.length} 条`);
    cell("新建类别", `${plan.createdCategories.length} 个`);
    cell("新建账户", `${plan.createdAccounts.length} 个`);
    if (plan.skippedDup) this.note(card, `跳过 ${plan.skippedDup} 条重复记录。`);
    if (plan.skippedError) this.note(card, `忽略 ${plan.skippedError} 条无效记录（日期 / 金额 / 转账账户不全）。`);
    if (plan.createdCategories.length) this.note(card, `新建类别：${plan.createdCategories.join("、")}`);
    if (plan.createdAccounts.length) this.note(card, `新建账户：${plan.createdAccounts.join("、")}`);
    const row = body.createDiv({ cls: "db-led-io-tools" });
    const b1 = row.createEl("button", { cls: "db-led-chip", attr: { type: "button" }, text: "去流水看看" });
    b1.addEventListener("click", () => { this.opts.onExit(); this.opts.gotoPage("list"); });
    const b2 = row.createEl("button", { cls: "db-led-chip", attr: { type: "button" }, text: "导入记录" });
    b2.addEventListener("click", () => this.go("batches"));
    const b3 = row.createEl("button", { cls: "db-led-chip", attr: { type: "button" }, text: "再导一份" });
    b3.addEventListener("click", () => { this.stack = []; this.step = "menu"; this.render(); });
    this.note(body, "撤销入口：设置 → 导入 / 导出 → 导入记录，可按这一次导入整批撤销。");
  }

  /* ────────────────────────── 导入记录（批次台账） ────────────────────────── */

  private renderBatches(body: HTMLElement): void {
    const list = this.opts.store.batches;
    if (!list.length) { this.note(body, "还没有过批量导入记录。"); return; }
    const card = body.createDiv({ cls: "db-led-card db-led-io-batches" });
    card.createDiv({ cls: "db-led-card-title", text: `导入记录（${list.length} 次）` });
    list.forEach(b => {
      const live = this.opts.store.batchCount(b.id);
      const row = card.createDiv({ cls: `db-led-batch${b.undoneAt || !live ? " is-undone" : ""}` });
      const mid = row.createDiv({ cls: "db-led-batch-mid" });
      mid.createDiv({ cls: "db-led-batch-file", text: b.file });
      const bits = [moment(b.at).format("YYYY-MM-DD HH:mm"), b.source, `${live} 条`];
      if (b.undoneAt) bits.push(`已于 ${moment(b.undoneAt).format("MM-DD HH:mm")} 撤销`);
      mid.createDiv({ cls: "db-led-batch-sub", text: bits.join(" · ") });
      const extra: string[] = [];
      if (b.createdCategories.length) extra.push(`新建类别 ${b.createdCategories.length}`);
      if (b.createdAccounts.length) extra.push(`新建账户 ${b.createdAccounts.length}`);
      if (extra.length) mid.createDiv({ cls: "db-led-batch-sub", text: extra.join(" · ") });
      const btn = row.createEl("button", { cls: "db-led-btn-ghost db-led-batch-undo", attr: { type: "button" }, text: "撤销" });
      if (!live) btn.disabled = true;
      btn.addEventListener("click", () => {
        new ConfirmModal(this.opts.app, "撤销这次导入", `将删除这 ${live} 条由「${b.file}」导入的记录。这次新建的分类和账户会保留（可在分类 / 账户管理里手工清理）。`, "撤销", () => {
          void (async () => {
            const n = await this.opts.store.undoBatch(b.id);
            new Notice(`已撤销 ${n} 条记录`);
            this.render();
          })();
        }).open();
      });
    });
    this.note(body, "台账保存在记账文件夹的 imports.json，撤销后仍保留这一条台账（标记已撤销），方便追溯。");
  }

  /* ────────────────────────── 导出 ────────────────────────── */

  private exportRecords(): LedgerRecord[] {
    const all = this.opts.store.records;
    const byLedger = this.exportLedger ? all.filter(r => r.ledgerId === this.exportLedger) : all;
    if (this.exportScope === "year") return byLedger.filter(r => r.date.startsWith(this.exportWhen.slice(0, 4)));
    if (this.exportScope === "month") return byLedger.filter(r => r.date.startsWith(this.exportWhen));
    return byLedger;
  }

  private renderExport(body: HTMLElement): void {
    const card = body.createDiv({ cls: "db-led-card" });
    card.createDiv({ cls: "db-led-card-title", text: "导出范围" });
    const row = card.createDiv({ cls: "db-led-io-inline" });
    const scope = row.createEl("select", { cls: "db-led-select", attr: { "aria-label": "导出范围" } });
    [["all", "全部记录"], ["year", "按年"], ["month", "按月"]].forEach(([v, t]) => scope.createEl("option", { value: v, text: t }));
    scope.value = this.exportScope;
    const when = row.createEl("input", { cls: "db-led-input", attr: { type: "text", "aria-label": "年份或月份", placeholder: this.exportScope === "year" ? "2026" : "2026-06" } });
    when.value = this.exportWhen;
    when.style.display = this.exportScope === "all" ? "none" : "";
    scope.addEventListener("change", () => { this.exportScope = scope.value as "all" | "year" | "month"; this.render(); });
    when.addEventListener("change", () => {
      const v = when.value.trim();
      if (/^\d{4}(-\d{2})?$/.test(v)) this.exportWhen = v; else new Notice("请输入 2026 或 2026-06 这样的格式");
      this.render();
    });
    const lrow = card.createDiv({ cls: "db-led-io-inline" });
    lrow.createSpan({ cls: "db-led-set-label", text: "账本" });
    const lsel = lrow.createEl("select", { cls: "db-led-select", attr: { "aria-label": "导出哪个账本" } });
    lsel.createEl("option", { value: "", text: "全部账本" });
    this.cfg.ledgers.forEach(l => lsel.createEl("option", { value: l.id, text: l.name }));
    lsel.value = this.exportLedger;
    lsel.addEventListener("change", () => { this.exportLedger = lsel.value; });
    const n = this.exportRecords().length;
    card.createDiv({ cls: "db-led-io-count", text: `当前范围 ${n} 条记录` });

    const pcard = body.createDiv({ cls: "db-led-card" });
    pcard.createDiv({ cls: "db-led-card-title", text: "导出格式" });
    const psel = pcard.createEl("select", { cls: "db-led-select", attr: { "aria-label": "导出模板" } });
    Object.keys(EXPORT_PRESETS).forEach(k => psel.createEl("option", { value: k, text: EXPORT_PRESETS[k].label }));
    psel.value = this.exportPreset;
    psel.addEventListener("change", () => {
      this.exportPreset = psel.value;
      this.exportCols = (EXPORT_PRESETS[this.exportPreset]?.cols ?? []).slice();
      this.render();
    });
    this.note(pcard, "想再导回本插件，选「Daybook 模板」，导入时会自动识别为同一格式。");

    const ccard = body.createDiv({ cls: "db-led-card" });
    ccard.createDiv({ cls: "db-led-card-title", text: `导出列（已选 ${this.exportCols.length} / ${EXPORT_COLUMNS.length}）` });
    const chips = ccard.createDiv({ cls: "db-led-io-chips" });
    EXPORT_COLUMNS.forEach(c => {
      const on = this.exportCols.indexOf(c.key) >= 0;
      const chip = chips.createEl("button", { cls: `db-led-chip${on ? " is-active" : ""}`, attr: { type: "button" }, text: c.label });
      chip.addEventListener("click", () => {
        const i = this.exportCols.indexOf(c.key);
        if (i >= 0) this.exportCols.splice(i, 1); else this.exportCols.push(c.key);
        this.render();
      });
    });

    this.primaryBtn(body, "导出 CSV 到仓库", () => void this.doExport());
    if (this.lastExport) {
      this.note(body, `上次导出：${this.lastExport}`);
      const copy = body.createEl("button", { cls: "db-led-btn-ghost", attr: { type: "button" }, text: "复制内容到剪贴板" });
      copy.addEventListener("click", () => {
        void (async () => {
          try {
            const text = await this.opts.app.vault.adapter.read(this.lastExport);
            await navigator.clipboard.writeText(text);
            new Notice("已复制");
          } catch (e) { new Notice("复制失败，可在仓库里直接打开该文件"); }
        })();
      });
    }
    this.note(body, "导出文件写入 ledger/export/ 目录，文件名带日期；CSV 头带 BOM，Excel / WPS 打开不乱码。");
  }

  private async doExport(): Promise<void> {
    const cols = EXPORT_COLUMNS.filter(c => this.exportCols.indexOf(c.key) >= 0);
    if (!cols.length) { new Notice("至少选一个导出列"); return; }
    const recs = this.exportRecords();
    if (!recs.length) { new Notice("当前范围没有记录"); return; }
    const csv = buildExportCsv(recs.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.clock || "").localeCompare(b.clock || "")), this.cfg, cols);
    const name = `账单导出-${moment().format("YYYYMMDD-HHmmss")}.csv`;
    try {
      const path = await this.opts.store.writeExport(name, csv);
      this.lastExport = path;
      new Notice(`已导出 ${recs.length} 条到 ${path}`);
      this.render();
    } catch (e) {
      console.error("Daybook ledger export:", e);
      new Notice("导出失败，请查看控制台");
    }
  }
}
