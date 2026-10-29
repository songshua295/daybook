/**
 * ledgerPage.ts — 记账（ledger）章节的六页 UI
 *
 * 页头不放页名/圆点：页名经 onPageTitle 并入顶栏章节标题（「记账 · 首页」），切页走顶栏「切换页面」菜单。
 * 记一笔/编辑 = 视图内底部浮层 sheet（不新开 tab），安卓返回键经 popstate 哨兵逐层剥离。
 * 金额口径说明见 ledgerStore 头注释；页内「设置」同步展示给用户。
 */
import { App, Notice, Platform, moment, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { ConfirmModal } from "./TodayPanel";
import { LedgerDataPage } from "./ledgerDataPage";
import { lunarLabel } from "./lunar";
import { accountIconKey, allIconChoices, guessAccountIcon, iconLabel, renderAccountIcon } from "./accountIcons";
import {
  EXPENSE_COLORS, INCOME_COLORS, Box, Slice,
  compactMoney, donutArcs, niceCeil, pctText, seriesPoints, smoothAreaPath, smoothPath, toSlices,
} from "./ledgerCharts";
import {
  LedgerStore, LedgerRecord, LedgerConfig, LedgerKind,
  actualAmount, baseAmount, fmtMoney, round2, summarize, categoryStats,
  accountBalances, reimbTotal, makeRecordId,
} from "./ledgerStore";

type PageKind = "home" | "list" | "assets" | "stats" | "report" | "settings";
const PAGE_ORDER: PageKind[] = ["home", "list", "assets", "stats", "report", "settings"];
const PAGE_TITLES: Record<PageKind, string> = { home: "首页", list: "视图", assets: "资产", stats: "统计", report: "报表", settings: "设置" };

/** 设置二级页（菜单行 → 页内整页，不弹浮层） */
type SettingsSub = "ledgers" | "accounts" | "categories" | "currencies" | "data" | "other";
const SUB_TITLES: Record<SettingsSub, string> = { ledgers: "账本管理", accounts: "账户管理", categories: "分类管理", currencies: "币种管理", data: "导入 / 导出", other: "其他设置" };

/** 「视图」页的呈现方式：日历（月历格子 + 当天流水）/ 流水（按天分组的列表）。新增视图只需往这里加一项。 */
type ViewMode = "calendar" | "list";
const VIEW_MODES: { key: ViewMode; label: string }[] = [{ key: "calendar", label: "日历" }, { key: "list", label: "流水" }];

/**
 * 「报表」页的统计维度。
 * 小类 = 记录的二级分类；该一级分类没有配二级时回落到一级分类名（否则这类记录在图上会挤成「未选小类」）。
 * 大类 = 一级分类；账户 = 资金账户。标签 / 角色口径暂不做报表。
 */
type ReportDim = "sub" | "cat" | "account";
const REPORT_DIMS: { key: ReportDim; label: string }[] = [
  { key: "sub", label: "小类" }, { key: "cat", label: "大类" }, { key: "account", label: "账户" },
];
const REPORT_MONTHS = 6;      // 逐月图看半年
const REPORT_SLICES = 7;      // 环形图最多 7 块，其余并进「其他」
const REPORT_DRILL_SLICES = 12;  // 下钻明细页要看得更细，环形图放宽到 12 块

/**
 * 报表下钻：点环形图 → 该字段每一项的金额 / 笔数 / 占比；点趋势图 → 逐月明细（含环比）。
 * 命名里带口径（out 支出 / in 收入 / net 结余），donut 一系还跟着顶部字段切换走。
 */
type ReportDrill = "donut-out" | "donut-in" | "trend-out" | "trend-in" | "trend-net";
const WEEK_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

/** 日历格子里的紧凑金额：整数不带小数，过万折成「1.2万」，避免窄列被撑破 */
function calMoney(n: number): string {
  const a = round2(Math.abs(n));
  let s: string;
  if (a >= 10000) s = (a / 10000).toFixed(a >= 100000 ? 0 : 1) + "万";
  else s = Math.round(a * 100) % 100 === 0 ? String(Math.round(a)) : a.toFixed(2);
  return n < 0 ? `-${s}` : s;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: "¥", JPY: "JP¥", USD: "$", EUR: "€", GBP: "£", HKD: "HK$", TWD: "NT$", KRW: "₩", AUD: "A$", CAD: "C$",
};
const symbolOf = (code: string) => CURRENCY_SYMBOL[code] ?? `${code} `;
const uid = () => `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const num = (s: string): number => { const n = parseFloat(s); return isFinite(n) && n > 0 ? n : 0; };
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

interface Draft {
  id?: string; createdAt: number;
  date: string; kind: LedgerKind; amount: string; currency: string; rate: string;
  categoryId: string; subId: string; accountId: string; toAccountId: string; ledgerId: string;
  refund: string; discount: string; note: string; tags: string;
  reimbAccountId: string; reimbAmount: string; reimbDetail: string;
  address: string; creator: string; other: string; files: string;
  clock?: string; importBatchId?: string;
}

export class LedgerPage {
  private store: LedgerStore;
  private page: PageKind = "home";
  private month = moment().format("YYYY-MM");
  private listLedgerId = "";
  private listKind: "all" | LedgerKind = "all";
  /** 视图页当前呈现方式与日历选中日 */
  private viewMode: ViewMode = "calendar";
  private selDate = moment().format("YYYY-MM-DD");
  /** 报表页：分组字段（小类 / 大类 / 账户）；月份沿用 this.month */
  private reportDim: ReportDim = "sub";
  /** 报表下钻页（null = 在报表主页）；哨兵让安卓返回键先退回报表主页 */
  private reportDrill: ReportDrill | null = null;
  private drillSentinelArmed = false;
  /** SVG clipPath 需要文档内唯一 id，自增一次即可（整页重渲染也不复用旧节点） */
  private clipSeq = 0;
  private statsRange: "month" | "quarter" | "year" = "month";
  private overlay: HTMLElement | null = null;
  private sheetEl: HTMLElement | null = null;
  private sheetAdvOpen = false;
  /** 当前设置二级页（null = 设置菜单页本身）；sentinel 支持安卓返回键退回菜单 */
  private settingsSub: SettingsSub | null = null;
  private subSentinelArmed = false;
  /** 导入 / 导出二级页（向导状态都在这个类里） */
  private dataPage: LedgerDataPage | null = null;
  /** 账户图标选择页（账户管理之下的三级页，null = 不在选择图标） */
  private iconPickFor: string | null = null;
  private iconSentinelArmed = false;
  private sentinelArmed = false;
  private destroyed = false;
  private onPop: (e: PopStateEvent) => void;
  /* 键盘让位：安卓 adjustPan 机型布局视口不随键盘收缩，fixed 底部浮层会被键盘盖住，
     用 visualViewport 几何把 sheet 底边抬到键盘上方（几何只允许在浮层打开期间读取） */
  private idleInnerH = 0;
  private lastKb = -1;
  private vpSync: () => void;
  /** 页名上报给顶栏章节标题（「记账 · 首页」），由 JournalView 注入 */
  onPageTitle: ((title: string) => void) | null = null;

  constructor(
    private app: App,
    private plugin: DaybookPlugin,
    private host: HTMLElement,
  ) {
    this.store = new LedgerStore(app, plugin.settings);
    this.onPop = () => {
      if (this.overlay && this.sentinelArmed) {
        this.sentinelArmed = false;
        this.closeOverlay(false);
        return;
      }
      /* 报表明细页压在报表页之上：返回键先退回报表页（哨兵已被系统消费） */
      if (this.reportDrill) {
        this.drillSentinelArmed = false;
        this.reportDrill = null;
        this.render();
        return;
      }
      if (!this.settingsSub || !this.subSentinelArmed) return;
      /* 图标选择页压在账户管理之上：返回键先退这一层（哨兵已被系统消费，不再重压） */
      if (this.iconPickFor) {
        this.iconPickFor = null;
        this.iconSentinelArmed = false;
        this.render();
        return;
      }
      this.subSentinelArmed = false;               // 这枚哨兵已被系统消费
      /* 导入/导出是个多步向导：返回键先在向导里退一步，退到底才回设置菜单 */
      const stillInside = this.settingsSub === "data" && !!this.dataPage && this.dataPage.handleBack();
      if (stillInside) {
        if (Platform.isMobileApp) {
          window.history.pushState({ daybookBack: "ledger-settings-sub" }, "");
          this.subSentinelArmed = true;            // 重新压一枚，保证每层都能被返回键剥掉
        }
        return;
      }
      this.settingsSub = null;
      this.render();
    };
    window.addEventListener("popstate", this.onPop);
    this.vpSync = () => this.syncKeyboardInset();
  }

  async mount(): Promise<void> {
    await this.store.load();
    if (this.destroyed || !this.host.isConnected) return;
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener("popstate", this.onPop);
    if (this.overlay) { const armed = this.sentinelArmed; this.sentinelArmed = false; this.overlay.remove(); this.overlay = null; if (armed && Platform.isMobileApp) window.history.back(); }
    let back = 0;
    if (this.drillSentinelArmed) { back++; this.drillSentinelArmed = false; this.reportDrill = null; }
    if (this.iconSentinelArmed) { back++; this.iconSentinelArmed = false; this.iconPickFor = null; }
    if (this.subSentinelArmed) { back++; this.subSentinelArmed = false; this.settingsSub = null; }
    this.reclaimHistory(back);
    this.dataPage?.destroy();
    this.dataPage = null;
    this.sheetEl = null;
    this.detachVpListener();
  }

  /** 顶栏「切换页面」菜单用：当前页 + 全部页面 */
  getPageInfo(): { current: PageKind; pages: { key: PageKind; title: string }[] } {
    return { current: this.page, pages: PAGE_ORDER.map(p => ({ key: p, title: PAGE_TITLES[p] })) };
  }

  setPage(p: PageKind): void {
    if (this.page === p) return;
    /* 从设置二级页切走时回收哨兵并回到菜单层，避免残留 history 记录 */
    let back = 0;
    if (this.reportDrill) {
      if (this.drillSentinelArmed) back++;
      this.drillSentinelArmed = false;
      this.reportDrill = null;
    }
    if (this.iconPickFor) {
      if (this.iconSentinelArmed) back++;
      this.iconSentinelArmed = false;
      this.iconPickFor = null;
    }
    if (this.settingsSub) {
      if (this.subSentinelArmed) back++;
      this.subSentinelArmed = false;
      this.settingsSub = null;
    }
    this.reclaimHistory(back);
    this.page = p;
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  /** 退掉 n 枚自己压进去的返回键哨兵（只在手机端有历史可退） */
  private reclaimHistory(n: number): void {
    if (n > 0 && Platform.isMobileApp) window.history.go(-n);
  }

  /* ── 键盘让位（仅浮层打开期间挂监听） ── */

  private attachVpListener(): void {
    const vp = activeWindow.visualViewport;
    if (!vp) return;
    vp.addEventListener("resize", this.vpSync);
    vp.addEventListener("scroll", this.vpSync);
  }

  private detachVpListener(): void {
    const vp = activeWindow.visualViewport;
    if (!vp) return;
    vp.removeEventListener("resize", this.vpSync);
    vp.removeEventListener("scroll", this.vpSync);
  }

  private syncKeyboardInset(): void {
    if (!this.overlay) return;
    const vp = activeWindow.visualViewport;
    const innerH = Math.round(activeWindow.innerHeight);
    if (!vp || innerH <= 0) return;
    if (innerH > (this.idleInnerH || 0)) this.idleInnerH = innerH; // 键盘未弹出时的基线（adjustResize 机型会收缩）
    const scaleOk = vp.scale === 1;
    // 键盘遮挡布局视口底部的量：pan 模式用 height+offsetTop；收缩量超过一半屏高视为瞬态异常
    let kb = 0;
    if (scaleOk) {
      const visibleBottom = Math.round(vp.height + vp.offsetTop);
      if (visibleBottom > innerH / 2) kb = Math.max(0, innerH - visibleBottom);
    }
    // adjustResize 机型：布局视口本身已收缩，fixed bottom:0 本就贴着键盘顶，不再叠加抬升
    if (this.idleInnerH > 0 && innerH < this.idleInnerH - 5) kb = 0;
    if (kb === this.lastKb) return;
    this.lastKb = kb;
    this.overlay.style.bottom = kb > 0 ? `${kb}px` : "";
  }

  /* ────────────────────────── 基础渲染 ────────────────────────── */

  private get cfg(): LedgerConfig { return this.store.config; }

  private catOf(id: string) { return this.cfg.categories.find(c => c.id === id); }
  private acctOf(id: string) { return this.cfg.accounts.find(a => a.id === id); }
  private ledgerName(id: string) { return this.cfg.ledgers.find(l => l.id === id)?.name ?? "默认账本"; }

  private catLabel(r: LedgerRecord): string {
    const cat = this.catOf(r.categoryId);
    const sub = cat?.subs.find(s => s.id === r.subId);
    return [cat?.name ?? "未分类", sub?.name].filter(Boolean).join(" · ");
  }

  private render(): void {
    if (this.destroyed) return;
    const host = this.host;
    host.empty();
    host.addClass("db-led-root");
    this.onPageTitle?.(PAGE_TITLES[this.page]);
    if (this.settingsSub) { this.renderSettingsSub(host); return; }
    if (this.reportDrill) { this.renderReportDrill(host); return; }

    /* 首页不建页头：正文里有大 CTA「添加一条新记账」，避免两个记一笔入口 */
    if (this.page !== "home") {
      const header = host.createDiv({ cls: "db-led-header" });
      const addBtn = header.createEl("button", {
        cls: "db-led-add", attr: { type: "button", "aria-label": "记一笔", title: "记一笔" },
      });
      setIcon(addBtn.createSpan({ cls: "db-led-add-icon" }), "plus");
      addBtn.createSpan({ text: "记一笔" });
      addBtn.addEventListener("click", () => this.openRecordSheet(this.blankDraft("expense")));
    }

    const body = host.createDiv({ cls: "db-led-body" });
    switch (this.page) {
      case "home": this.renderHome(body); break;
      case "list": this.renderList(body); break;
      case "assets": this.renderAssets(body); break;
      case "stats": this.renderStats(body); break;
      case "report": this.renderReport(body); break;
      case "settings": this.renderSettings(body); break;
    }
  }

  /** 小节卡片：标题 + 内容 */
  private card(parent: HTMLElement, title: string): HTMLElement {
    const card = parent.createDiv({ cls: "db-led-card" });
    if (title) card.createDiv({ cls: "db-led-card-title", text: title });
    return card;
  }

  private kindClass(kind: LedgerKind): string {
    return kind === "transfer" ? "is-tr" : kind === "income" ? "is-in" : "is-out";
  }

  private recordRow(parent: HTMLElement, r: LedgerRecord, onClick: () => void): void {
    const row = parent.createDiv({ cls: "db-led-row" });
    const isTr = r.kind === "transfer";
    const kls = this.kindClass(r.kind);
    const cat = this.catOf(r.categoryId);
    const initial = isTr ? "转" : (cat?.name ?? "未")[0];
    row.createDiv({ cls: `db-led-row-icon ${kls}`, text: initial });
    const mid = row.createDiv({ cls: "db-led-row-mid" });
    mid.createDiv({ cls: "db-led-row-title", text: isTr ? "转账" : this.catLabel(r) });
    const subBits: string[] = [];
    if (r.clock) subBits.push(r.clock);
    if (isTr) {
      const from = this.acctOf(r.accountId)?.name ?? "?";
      const to = this.acctOf(r.toAccountId ?? "")?.name ?? "?";
      subBits.push(`${from} → ${to}`);
    }
    if (r.note) subBits.push(r.note);
    if (r.tags?.length) subBits.push(r.tags.map(t => `#${t}`).join(" "));
    if (subBits.length) mid.createDiv({ cls: "db-led-row-sub", text: subBits.join(" · ") });
    const amt = actualAmount(r);
    const isBase = (r.currency || this.cfg.baseCurrency) === this.cfg.baseCurrency;
    const right = row.createDiv({ cls: "db-led-row-right" });
    const sign = isTr ? "" : r.kind === "income" ? "+" : "-";
    right.createDiv({
      cls: `db-led-row-amount ${kls}`,
      text: `${sign}${symbolOf(r.currency || this.cfg.baseCurrency)}${fmtMoney(amt)}`,
    });
    const acctName = this.acctOf(r.accountId)?.name ?? "";
    if (acctName) right.createDiv({ cls: "db-led-row-acct", text: isTr ? `${acctName} → ${this.acctOf(r.toAccountId ?? "")?.name ?? "?"}` : acctName });
    if (!isBase) right.createDiv({ cls: "db-led-row-base", text: `≈${symbolOf(this.cfg.baseCurrency)}${fmtMoney(baseAmount(r, this.cfg))}` });
    row.addEventListener("click", onClick);
  }

  /** 一天的记录：日期行（M月D日 周X + 收/支/转彩色合计）在卡片外，行内容在白卡里 */
  private dayCard(parent: HTMLElement, date: string, dayRecs: LedgerRecord[]): void {
    const d = moment(date);
    const wrap = parent.createDiv({ cls: "db-led-day" });
    const head = wrap.createDiv({ cls: "db-led-day-head" });
    head.createSpan({ cls: "db-led-day-date", text: `${d.format("M月D日")} ${WEEK[d.day()]}` });
    const daySum = summarize(dayRecs, this.cfg);
    const trSum = round2(dayRecs.filter(r => r.kind === "transfer").reduce((s, r) => s + baseAmount(r, this.cfg), 0));
    const sums = head.createSpan({ cls: "db-led-day-sums" });
    const part = (label: string, value: number, cls: string) => {
      const p = sums.createSpan({ cls: "db-led-day-part" });
      p.createSpan({ cls: "db-led-day-k", text: label });
      p.createSpan({ cls: `db-led-day-v ${cls}`, text: fmtMoney(value) });
    };
    part("收", daySum.income, "is-in");
    part("支", daySum.expense, "is-out");
    if (trSum > 0) part("转", trSum, "is-tr");
    const card = wrap.createDiv({ cls: "db-led-card db-led-day-card" });
    dayRecs.forEach(r => this.recordRow(card, r, () => this.openRecordSheet(this.draftFrom(r))));
  }

  /** 按日期分组（新→旧）渲染一组记录 */
  private renderDayGroups(parent: HTMLElement, recs: LedgerRecord[]): void {
    const byDate = new Map<string, LedgerRecord[]>();
    recs.forEach(r => { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date)!.push(r); });
    [...byDate.keys()].sort((a, b) => b.localeCompare(a)).forEach(date => this.dayCard(parent, date, byDate.get(date)!));
  }

  /* ────────────────────────── 首页 ────────────────────────── */

  private renderHome(body: HTMLElement): void {
    const cur = moment().format("YYYY-MM");
    const monthRecs = this.store.monthRecords(cur);
    const sum = summarize(monthRecs, this.cfg);

    /* 概览卡：本月收入 / 结余 / 支出（参照记账 App 首页头部卡） */
    const hero = body.createDiv({ cls: "db-led-card db-led-hero" });
    const grid = hero.createDiv({ cls: "db-led-hero-grid" });
    const cell = (label: string, value: number) => {
      const el = grid.createDiv({ cls: "db-led-hero-cell" });
      el.createDiv({ cls: "db-led-hero-label", text: label });
      el.createDiv({ cls: "db-led-hero-value", text: `${value < 0 ? "-" : ""}${fmtMoney(Math.abs(value))}` });
    };
    cell("本月收入", sum.income);
    cell("本月结余", sum.net);
    cell("本月支出", sum.expense);

    /* 大 CTA：添加一条新记账 */
    const cta = body.createEl("button", { cls: "db-led-cta", attr: { type: "button" } });
    setIcon(cta.createSpan({ cls: "db-led-cta-icon" }), "square-pen");
    cta.createSpan({ text: "添加一条新记账" });
    cta.addEventListener("click", () => this.openRecordSheet(this.blankDraft("expense")));

    const recent = this.store.records.slice(0, 30);
    if (recent.length) {
      this.renderDayGroups(body, recent);
    } else {
      body.createDiv({ cls: "db-led-empty", text: "还没有记录，点上面「添加一条新记账」开始第一笔吧。数据保存在 日记目录/ledger/ 下。" });
    }
  }

  /* ────────────────────────── 视图（流水） ────────────────────────── */

  private renderList(body: HTMLElement): void {
    this.renderViewTabs(body);
    this.renderMonthNav(body);

    const filters = body.createDiv({ cls: "db-led-filters" });
    const ledgerSel = filters.createEl("select", { cls: "db-led-select", attr: { "aria-label": "选择账本" } });
    ledgerSel.createEl("option", { value: "", text: "全部账本" });
    this.cfg.ledgers.forEach(l => ledgerSel.createEl("option", { value: l.id, text: l.name }));
    ledgerSel.value = this.listLedgerId;
    ledgerSel.addEventListener("change", () => { this.listLedgerId = ledgerSel.value; this.render(); });
    (["all", "expense", "income", "transfer"] as const).forEach(k => {
      const chip = filters.createDiv({
        cls: `db-led-chip${this.listKind === k ? " is-active" : ""}`,
        text: k === "all" ? "全部" : k === "expense" ? "支出" : k === "income" ? "收入" : "转账",
      });
      chip.addEventListener("click", () => { this.listKind = k; this.render(); });
    });

    const recs = this.store.monthRecords(this.month, this.listLedgerId || undefined)
      .filter(r => this.listKind === "all" || r.kind === this.listKind);

    if (this.viewMode === "calendar") { this.renderCalendar(body, recs); return; }
    if (!recs.length) {
      body.createDiv({ cls: "db-led-empty", text: "本月还没有符合条件的记录。" });
      return;
    }
    this.renderDayGroups(body, recs);
  }

  /** 视图切换标签（日历 / 流水）：一排等宽分段按钮 */
  private renderViewTabs(parent: HTMLElement): void {
    const seg = parent.createDiv({ cls: "db-led-seg is-tabs" });
    VIEW_MODES.forEach(v => {
      const b = seg.createDiv({ cls: `db-led-seg-btn${this.viewMode === v.key ? " is-active" : ""}`, text: v.label });
      b.addEventListener("click", () => {
        if (this.viewMode === v.key) return;
        this.viewMode = v.key;
        this.clampSelDate();
        this.render();
      });
    });
  }

  private stepMonth(delta: number): void {
    this.month = moment(this.month + "-01").add(delta, "month").format("YYYY-MM");
    this.clampSelDate();
    this.render();
  }

  /** 换月后选中日要跟着落进新月份：本月看今天，其它月看该月最后一笔，都没有就落在 1 号 */
  private clampSelDate(): void {
    if (this.selDate.slice(0, 7) === this.month) return;
    if (this.month === moment().format("YYYY-MM")) { this.selDate = moment().format("YYYY-MM-DD"); return; }
    const latest = this.store.monthRecords(this.month, this.listLedgerId || undefined)[0];
    this.selDate = latest ? latest.date : `${this.month}-01`;
  }

  /** 日历视图：月历格子里有流水的日子显示收/支金额，没有的显示节气 / 农历；下方接选中日的流水 */
  private renderCalendar(body: HTMLElement, recs: LedgerRecord[]): void {
    interface DayCell { exp: number; inc: number; tr: number; recs: LedgerRecord[] }
    const byDate = new Map<string, DayCell>();
    recs.forEach(r => {
      const g = byDate.get(r.date) || { exp: 0, inc: 0, tr: 0, recs: [] as LedgerRecord[] };
      const v = baseAmount(r, this.cfg);
      if (r.kind === "expense") g.exp += v; else if (r.kind === "income") g.inc += v; else g.tr += v;
      g.recs.push(r);
      byDate.set(r.date, g);
    });

    const card = body.createDiv({ cls: "db-led-card db-led-cal" });
    const sum = summarize(recs, this.cfg);
    const msum = card.createDiv({ cls: "db-led-cal-sum" });
    const part = (parent: HTMLElement, label: string, value: string, cls: string) => {
      const p = parent.createSpan({ cls: "db-led-day-part" });
      p.createSpan({ cls: "db-led-day-k", text: label });
      p.createSpan({ cls: `db-led-day-v ${cls}`, text: value });
    };
    part(msum, "收", fmtMoney(sum.income), "is-in");
    part(msum, "支", fmtMoney(sum.expense), "is-out");
    part(msum, "余", fmtMoney(sum.net), sum.net >= 0 ? "is-in" : "is-out");

    const week = card.createDiv({ cls: "db-led-cal-week" });
    WEEK_SHORT.forEach(w => week.createDiv({ cls: "db-led-cal-wd", text: w }));

    const first = moment(this.month + "-01");
    const days = first.daysInMonth();
    const lead = first.day();                       // 1 号前面空几格（周日开头）
    const cells = Math.ceil((lead + days) / 7) * 7;
    const todayStr = moment().format("YYYY-MM-DD");
    const grid = card.createDiv({ cls: "db-led-cal-grid" });
    for (let i = 0; i < cells; i++) {
      const cell = grid.createDiv({ cls: "db-led-cal-cell" });
      const dayNum = i - lead + 1;
      if (dayNum < 1 || dayNum > days) { cell.addClass("is-blank"); continue; }
      const dow = i % 7;
      if (dow === 0 || dow === 6) cell.addClass("is-weekend");
      const ds = `${this.month}-${pad2(dayNum)}`;
      cell.createDiv({ cls: "db-led-cal-d", text: String(dayNum) });
      const lines = cell.createDiv({ cls: "db-led-cal-lines" });
      const line = (cls: string, text: string) => lines.createDiv({ cls: `db-led-cal-line ${cls}`, text });
      const g = byDate.get(ds);
      if (g) {
        if (g.exp) line("is-out", `-${calMoney(g.exp)}`);
        if (g.inc) line("is-in", `+${calMoney(g.inc)}`);
        if (g.tr) line("is-tr", `转${calMoney(g.tr)}`);
        if (!g.exp && !g.inc && !g.tr) line("", lunarLabel(ds));
      } else {
        const lab = lunarLabel(ds);
        if (lab) line("", lab);
      }
      if (ds === todayStr) cell.addClass("is-today");
      if (ds === this.selDate) cell.addClass("is-sel");
      cell.addEventListener("click", () => {
        if (this.selDate === ds) return;
        this.selDate = ds;
        this.render();
      });
    }

    const dayRecs = (byDate.get(this.selDate) || { recs: [] as LedgerRecord[] }).recs;
    if (dayRecs.length) this.dayCard(body, this.selDate, dayRecs);
    else body.createDiv({ cls: "db-led-empty", text: `${moment(this.selDate).format("M月D日")} 还没有记录。` });
  }

  /* ────────────────────────── 资产 ────────────────────────── */

  private renderAssets(body: HTMLElement): void {
    const bals = accountBalances(this.store.records, this.cfg);
    const net = round2(bals.reduce((s, b) => s + b.balanceBase, 0));
    const base = this.cfg.baseCurrency;

    const c = this.card(body, "净资产");
    c.createDiv({ cls: "db-led-net", text: `${symbolOf(base)}${fmtMoney(net)}` });
    c.createDiv({ cls: "db-led-net-sub", text: `共 ${bals.length} 个账户 ｜ 待报销合计 ${symbolOf(base)}${fmtMoney(reimbTotal(this.store.records, this.cfg))}` });

    const c2 = this.card(body, "账户");
    bals.forEach(b => {
      const row = c2.createDiv({ cls: "db-led-acct-row" });
      const ic = row.createSpan({ cls: "db-led-acct-icon" });
      renderAccountIcon(ic, accountIconKey(b.account), b.account.name);
      row.createSpan({ cls: "db-led-acct-name", text: b.account.name });
      const val = row.createSpan({ cls: "db-led-acct-val" });
      if (b.account.currency === base) {
        val.setText(`${symbolOf(base)}${fmtMoney(b.balance)}`);
      } else {
        val.setText(`${symbolOf(b.account.currency)}${fmtMoney(b.balance)}`);
        val.createSpan({ cls: "db-led-acct-conv", text: `≈${symbolOf(base)}${fmtMoney(b.balanceBase)}` });
      }
      val.toggleClass("is-neg", b.balanceBase < 0);
    });
    body.createDiv({
      cls: "db-led-note",
      text: "余额 = 期初余额 + 收入 − 实际支出（支出按 金额−优惠−退款 计）；转账只移动账户间余额，不计收支。期初与账户在「设置」里修改。",
    });
  }

  /* ────────────────────────── 统计 ────────────────────────── */

  private statsMonths(): string[] {
    const m = moment();
    if (this.statsRange === "month") return [m.format("YYYY-MM")];
    if (this.statsRange === "quarter") return [2, 1, 0].map(i => m.clone().subtract(i, "month").format("YYYY-MM"));
    const months: string[] = [];
    const y = m.year();
    for (let i = 0; i <= m.month(); i++) months.push(moment({ year: y, month: i }).format("YYYY-MM"));
    return months;
  }

  private renderStats(body: HTMLElement): void {
    const chips = body.createDiv({ cls: "db-led-filters" });
    const defs: { key: typeof this.statsRange; label: string }[] = [
      { key: "month", label: "本月" }, { key: "quarter", label: "近3月" }, { key: "year", label: "本年" },
    ];
    defs.forEach(d => {
      const chip = chips.createDiv({ cls: `db-led-chip${this.statsRange === d.key ? " is-active" : ""}`, text: d.label });
      chip.addEventListener("click", () => { this.statsRange = d.key; this.render(); });
    });

    const months = this.statsMonths();
    const recs = this.store.records.filter(r => months.includes(r.date.slice(0, 7)));
    const sum = summarize(recs, this.cfg);

    const c0 = this.card(body, "区间收支");
    const grid = c0.createDiv({ cls: "db-led-sum" });
    const cell = (label: string, cls: string, value: number) => {
      const el = grid.createDiv({ cls: `db-led-sum-cell ${cls}` });
      el.createDiv({ cls: "db-led-sum-label", text: label });
      el.createDiv({ cls: "db-led-sum-value", text: fmtMoney(Math.abs(value)) });
    };
    cell("支出", "is-out", -sum.expense);
    cell("收入", "is-in", sum.income);
    cell("结余", sum.net >= 0 ? "is-in" : "is-out", sum.net);

    (["expense", "income"] as LedgerKind[]).forEach(kind => {
      const stats = categoryStats(recs, this.cfg, kind);
      if (!stats.length) return;
      const c = this.card(body, kind === "expense" ? "支出分类" : "收入分类");
      this.bars(c, stats, stats[0].total || 1);
    });

    if (months.length > 1) {
      const c = this.card(body, "月度趋势");
      const wrap = c.createDiv({ cls: "db-led-trend" });
      const data = months.map(ym => ({ ym, ...summarize(this.store.monthRecords(ym), this.cfg) }));
      const max = Math.max(1, ...data.map(d => Math.max(d.expense, d.income)));
      data.forEach(d => {
        const col = wrap.createDiv({ cls: "db-led-trend-col" });
        const bars = col.createDiv({ cls: "db-led-trend-bars" });
        const be = bars.createDiv({ cls: "db-led-trend-bar is-out" });
        be.style.height = `${Math.max(2, d.expense / max * 100)}%`;
        const bi = bars.createDiv({ cls: "db-led-trend-bar is-in" });
        bi.style.height = `${Math.max(2, d.income / max * 100)}%`;
        col.createDiv({ cls: "db-led-trend-label", text: d.ym.slice(5) + "月" });
      });
    }
    if (!recs.length) body.createDiv({ cls: "db-led-empty", text: "该区间暂无记录。" });
  }

  /** 分类占比条（fill 宽度为静态布局，不做过渡动画） */
  private bars(parent: HTMLElement, stats: { name: string; total: number; items: LedgerRecord[] }[], max: number): void {
    const base = this.cfg.baseCurrency;
    stats.forEach(s => {
      const row = parent.createDiv({ cls: "db-led-bar-row" });
      const head = row.createDiv({ cls: "db-led-bar-head" });
      head.createSpan({ cls: "db-led-bar-name", text: s.name });
      head.createSpan({ cls: "db-led-bar-val", text: `${symbolOf(base)}${fmtMoney(s.total)} · ${Math.round(s.total / max * 100)}%` });
      const bar = row.createDiv({ cls: "db-led-bar" });
      const fill = bar.createDiv({ cls: "db-led-bar-fill" });
      fill.style.width = `${Math.min(100, s.total / max * 100)}%`;
    });
  }

  /* ────────────────────────── 报表 ────────────────────────── */

  /**
   * 报表页：最上面是统计字段切换（小类 / 大类 / 账户），下面依次是
   * 支出卡（环形图 + 明细 + 逐月面积图）、收入卡（同结构）、收支对比横向柱、月收支差面积图。
   * 环形图与逐月图都按当前字段口径走，金额一律折算基准币。
   */
  private renderReport(body: HTMLElement): void {
    const seg = body.createDiv({ cls: "db-led-seg is-tabs" });
    REPORT_DIMS.forEach(d => {
      const b = seg.createDiv({ cls: `db-led-seg-btn${this.reportDim === d.key ? " is-active" : ""}`, text: d.label });
      b.addEventListener("click", () => {
        if (this.reportDim === d.key) return;
        this.reportDim = d.key;
        this.render();
      });
    });
    this.renderMonthNav(body);
    body.createDiv({ cls: "db-led-group-hint", text: "点环形图看分类明细，点面积图看逐月明细。" });

    const months = this.reportMonths();
    const recs = this.store.monthRecords(this.month);
    (["expense", "income"] as LedgerKind[]).forEach(kind => this.reportSplitCard(body, kind, months, recs));
    this.reportCompareCard(body, recs);
    this.reportDiffCard(body, months);
  }

  /** 月份切换条（视图页与报表页共用，切月走 stepMonth） */
  private renderMonthNav(parent: HTMLElement): void {
    const nav = parent.createDiv({ cls: "db-led-monthnav" });
    const prev = nav.createEl("button", { cls: "db-led-nav-btn", attr: { type: "button", "aria-label": "上一月" } });
    setIcon(prev, "chevron-left");
    prev.addEventListener("click", () => this.stepMonth(-1));
    nav.createSpan({ cls: "db-led-nav-label", text: `${this.month.replace("-", "年")}月` });
    const next = nav.createEl("button", { cls: "db-led-nav-btn", attr: { type: "button", "aria-label": "下一月" } });
    setIcon(next, "chevron-right");
    next.addEventListener("click", () => this.stepMonth(1));
  }

  /** 报表的逐月区间：截至当前查看月份往前的 REPORT_MONTHS 个自然月 */
  private reportMonths(): string[] {
    const out: string[] = [];
    for (let i = REPORT_MONTHS - 1; i >= 0; i--) {
      out.push(moment(this.month + "-01").subtract(i, "month").format("YYYY-MM"));
    }
    return out;
  }

  /** 按当前字段把记录分组求和（基准币口径）：小类无二级时回落到一级分类。笔数用于下钻明细。 */
  private reportGroups(kind: LedgerKind, recs: LedgerRecord[]): { label: string; total: number; count: number }[] {
    const map = new Map<string, { total: number; count: number }>();
    recs.forEach(r => {
      if (r.kind !== kind) return;
      let label: string;
      if (this.reportDim === "account") {
        label = this.acctOf(r.accountId)?.name ?? "未知账户";
      } else {
        const cat = this.catOf(r.categoryId);
        if (this.reportDim === "cat") label = cat?.name ?? "未分类";
        else {
          const sub = cat && cat.subs.length ? cat.subs.find(s => s.id === r.subId) : undefined;
          label = sub ? sub.name : (cat?.name ?? "未分类");
        }
      }
      const cur = map.get(label) || { total: 0, count: 0 };
      cur.total += baseAmount(r, this.cfg);
      cur.count += 1;
      map.set(label, cur);
    });
    const out: { label: string; total: number; count: number }[] = [];
    map.forEach((v, label) => out.push({ label, total: round2(v.total), count: v.count }));
    return out;
  }

  /** 某月某口径的金额与笔数（下钻明细用）：net = 收 − 支，笔数只算非转账记录 */
  private reportMonthStat(ym: string, kind: LedgerKind | "net"): { total: number; count: number } {
    const recs = this.store.monthRecords(ym).filter(r => r.kind !== "transfer");
    const use = kind === "net" ? recs : recs.filter(r => r.kind === kind);
    const total = kind === "net"
      ? summarize(recs, this.cfg).net
      : round2(use.reduce((s, r) => s + baseAmount(r, this.cfg), 0));
    return { total, count: use.length };
  }

  /** 某月某方向的合计（逐月图的数据源，与分组字段无关，按整月口径） */
  private reportMonthTotal(ym: string, kind: LedgerKind): number {
    return this.reportMonthStat(ym, kind).total;
  }

  private monthLabel(ym: string): string { return `${parseInt(ym.slice(5), 10)}月`; }

  /** 支出 / 收入卡：环形图 + 右侧明细，下面接该方向的逐月面积图 */
  private reportSplitCard(body: HTMLElement, kind: LedgerKind, months: string[], recs: LedgerRecord[]): void {
    const isOut = kind === "expense";
    const slices = toSlices(this.reportGroups(kind, recs), isOut ? EXPENSE_COLORS : INCOME_COLORS, REPORT_SLICES);
    const total = round2(slices.reduce((s, x) => s + x.total, 0));

    const card = this.card(body, isOut ? "支出" : "收入");
    card.addClass("db-led-rpt-card");

    const top = card.createDiv({ cls: "db-led-rpt-top" });
    const donutHost = top.createDiv({ cls: "db-led-rpt-donut" });
    this.reportDonut(donutHost, slices, isOut ? "总支出" : "总收入", fmtMoney(total));
    this.tappable(donutHost, `查看${isOut ? "支出" : "收入"}分类明细`,
      () => this.openReportDrill(isOut ? "donut-out" : "donut-in"));

    const legend = top.createDiv({ cls: "db-led-rpt-legend" });
    if (!slices.length) {
      legend.createDiv({ cls: "db-led-rpt-legend-empty", text: isOut ? "本月暂无支出数据" : "本月暂无收入数据" });
    }
    slices.forEach(s => {
      const row = legend.createDiv({ cls: "db-led-rpt-lg-row" });
      row.createSpan({ cls: "db-led-rpt-lg-dot" }).style.background = s.color;
      row.createSpan({ cls: "db-led-rpt-lg-name", text: s.label });
      row.createSpan({ cls: "db-led-rpt-lg-val", text: fmtMoney(s.total) });
      row.createSpan({ cls: "db-led-rpt-lg-pct", text: pctText(s.frac) });
    });

    const series = months.map(ym => this.reportMonthTotal(ym, kind));
    const chart = this.reportTrend(card, isOut ? "逐月支出" : "逐月收入", months, series, isOut ? "out" : "in");
    this.tappable(chart, isOut ? "查看逐月支出明细" : "查看逐月收入明细",
      () => this.openReportDrill(isOut ? "trend-out" : "trend-in"));
  }

  /** 环形图：扇区由 ledgerCharts 算好角度，中心文字用 HTML 叠一层（不跟 SVG 缩放） */
  private reportDonut(host: HTMLElement, slices: Slice[], label: string, centerValue: string): void {
    const S = 120, c = S / 2;
    const box = host.createDiv({ cls: "db-led-rpt-donut-box" });
    const svg = this.svg(box, "svg", { viewBox: `0 0 ${S} ${S}`, class: "db-led-rpt-donut-svg" });
    const arcs = donutArcs(slices.map(s => s.total), c, c, 57, 39);
    if (!arcs.length) this.svg(svg, "circle", { cx: c, cy: c, r: 48, class: "db-led-rpt-donut-empty" });
    arcs.forEach(a => this.svg(svg, "path", { d: a.d, fill: slices[a.index].color }));
    const mid = box.createDiv({ cls: "db-led-rpt-donut-mid" });
    mid.createDiv({ cls: "db-led-rpt-donut-k", text: label });
    mid.createDiv({ cls: "db-led-rpt-donut-v", text: centerValue });
  }

  /**
   * 逐月面积图（平滑曲线 + 曲线到基线的填充 + 点上周数值 + 底部月份小字）。
   * tone = "diff" 时基线是 0 轴，正负各用一次 clipPath 上色，其余两档单色。
   * big = 下钻页的大图：更高、带横向网格与左侧刻度，数值改由下方明细列表给出，点上不再标数字。
   */
  private reportTrend(
    card: HTMLElement, title: string, months: string[], values: number[],
    tone: "out" | "in" | "diff", big = false,
  ): HTMLElement {
    const head = card.createDiv({ cls: "db-led-rpt-chart-head" });
    head.createSpan({ cls: "db-led-rpt-chart-title", text: title });
    const hasData = values.some(v => v !== 0);
    const peak = values.reduce((bi, v, i) => (Math.abs(v) > Math.abs(values[bi]) ? i : bi), 0);
    head.createSpan({
      cls: "db-led-rpt-chart-sub",
      text: hasData ? `最高 ${this.monthLabel(months[peak])}` : "暂无数据",
    });

    // 先建容器再量宽度：viewBox 用实测像素做 1:1 映射，SVG 里的数字才是设定字号
    const chart = card.createDiv({ cls: `db-led-rpt-chart is-${tone}${big ? " is-big" : ""}` });
    const W = Math.max(240, Math.round(chart.clientWidth) || 320);
    const H = big ? 200 : 140;
    const padT = big ? 14 : 24;
    const gutter = big ? 42 : 12;
    const right = 12;
    const box: Box = { x: gutter, y: padT, w: W - gutter - right, h: H - padT - 26 };
    const absMax = niceCeil(values.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    const hi = absMax;
    const lo = tone === "diff" ? -absMax : 0;
    const pts = seriesPoints(values, box, hi, lo);
    const baseY = box.y + box.h - (box.h * (0 - lo)) / ((hi - lo) || 1);

    const svg = this.svg(chart, "svg", {
      viewBox: `0 0 ${W} ${H}`, class: "db-led-rpt-svg", preserveAspectRatio: "xMidYMid meet",
    });

    // 网格与左侧刻度画在面积之下，只在大图里出现（小图靠点上周的数值就能读）
    if (big && hasData) {
      for (let i = 0; i <= 4; i++) {
        const frac = i / 4;
        const y = box.y + box.h - box.h * frac;
        this.svg(svg, "line", { x1: box.x, y1: y, x2: W - right, y2: y, class: "db-led-rpt-grid" });
        const t = this.svg(svg, "text", { x: box.x - 6, y: y + 3, class: "db-led-rpt-ytxt" });
        t.textContent = compactMoney(lo + (hi - lo) * frac);
      }
    }

    const area = smoothAreaPath(pts, baseY);
    if (tone === "diff" && area) {
      const id = `db-rpt-clip-${++this.clipSeq}`;
      const defs = this.svg(svg, "defs", {});
      const above = this.svg(defs, "clipPath", { id: `${id}-above` });
      this.svg(above, "rect", { x: 0, y: 0, width: W, height: baseY });
      const below = this.svg(defs, "clipPath", { id: `${id}-below` });
      this.svg(below, "rect", { x: 0, y: baseY, width: W, height: H - baseY });
      this.svg(svg, "path", { d: area, class: "db-led-rpt-area is-pos", "clip-path": `url(#${id}-above)` });
      this.svg(svg, "path", { d: area, class: "db-led-rpt-area is-neg", "clip-path": `url(#${id}-below)` });
      this.svg(svg, "line", { x1: box.x, y1: baseY, x2: W - right, y2: baseY, class: "db-led-rpt-zero" });
    } else if (area) {
      this.svg(svg, "path", { d: area, class: `db-led-rpt-area is-${tone}` });
    }
    const line = smoothPath(pts);
    if (line) this.svg(svg, "path", { d: line, class: `db-led-rpt-line is-${tone}` });

    pts.forEach((p, i) => {
      const v = values[i];
      this.svg(svg, "circle", { cx: p.x, cy: p.y, r: 2.6, class: `db-led-rpt-pt${v < 0 ? " is-neg" : ""}` });
      if (!hasData || big) return;
      const t = this.svg(svg, "text", {
        x: Math.min(W - 18, Math.max(18, p.x)),
        y: tone === "diff" && v < 0 ? p.y + 12 : Math.max(11, p.y - 7),
        class: "db-led-rpt-vtxt",
      });
      t.textContent = compactMoney(v);
    });
    months.forEach((ym, i) => {
      const t = this.svg(svg, "text", {
        x: pts[i] ? pts[i].x : 0, y: H - 6, class: "db-led-rpt-axis",
      });
      t.textContent = this.monthLabel(ym);
    });

    if (!big) {
      const avg = round2(values.reduce((s, v) => s + Math.abs(v), 0) / (values.length || 1));
      const foot = chart.createDiv({ cls: "db-led-rpt-chart-foot" });
      if (tone === "diff") foot.setText("柱形在零轴上方为结余、下方为超支，金额均已折算基准币。");
      else foot.setText(`月均 ${fmtMoney(avg)} ｜ 共 ${months.length} 个月，随上方月份切换联动。`);
    }
    return chart;
  }

  /** 本月 支出 / 收入 / 结余 横向柱对比（长度按三者最大绝对值归一） */
  private reportCompareCard(body: HTMLElement, recs: LedgerRecord[]): void {
    const sum = summarize(recs, this.cfg);
    const card = this.card(body, "收支对比");
    card.addClass("db-led-rpt-cmp");
    const max = Math.max(1, sum.expense, sum.income, Math.abs(sum.net));
    const row = (label: string, value: number, cls: string) => {
      const r = card.createDiv({ cls: "db-led-rpt-cmp-row" });
      r.createSpan({ cls: "db-led-rpt-cmp-k", text: label });
      const track = r.createDiv({ cls: "db-led-rpt-cmp-track" });
      track.createDiv({ cls: `db-led-rpt-cmp-fill ${cls}` }).style.width = `${Math.max(1.5, Math.abs(value) / max * 100)}%`;
      r.createSpan({ cls: `db-led-rpt-cmp-v ${cls}`, text: fmtMoney(value) });
    };
    row("支出", sum.expense, "is-out");
    row("收入", sum.income, "is-in");
    row("结余", sum.net, sum.net >= 0 ? "is-in" : "is-out");
    card.createDiv({ cls: "db-led-rpt-cmp-foot", text: `本月共 ${recs.length} 笔，转账不计收支。` });
  }

  /** 逐月 收 − 支 面积图 */
  private reportDiffCard(body: HTMLElement, months: string[]): void {
    const card = this.card(body, "月收支差");
    const nets = months.map(ym => {
      const s = summarize(this.store.monthRecords(ym), this.cfg);
      return s.net;
    });
    const chart = this.reportTrend(card, "结余走势", months, nets, "diff");
    this.tappable(chart, "查看逐月结余明细", () => this.openReportDrill("trend-net"));
  }

  /** 图表本身就是入口：加 is-tap 态 + 键盘可触发，不额外配按钮 */
  private tappable(el: HTMLElement, ariaLabel: string, run: () => void): void {
    el.addClass("is-tap");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", ariaLabel);
    el.addEventListener("click", run);
    el.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); run(); }
    });
  }

  private reportDimLabel(): string {
    const d = REPORT_DIMS.find(x => x.key === this.reportDim);
    return d ? d.label : "小类";
  }

  /** 下钻页标题：环形图跟着顶部字段走（小类支出），趋势图固定「逐月 X」 */
  private reportDrillTitle(d: ReportDrill): string {
    if (d === "donut-out" || d === "donut-in") {
      return `${this.reportDimLabel()}${d === "donut-out" ? "支出" : "收入"}`;
    }
    return d === "trend-in" ? "逐月收入" : d === "trend-net" ? "逐月结余" : "逐月支出";
  }

  /** 打开报表下钻页：视图内整页替换（不弹浮层、不新开标签），安卓返回键经哨兵退回报表页 */
  private openReportDrill(d: ReportDrill): void {
    if (this.reportDrill === d) return;
    this.reportDrill = d;
    if (Platform.isMobileApp) {
      this.drillSentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-report-drill" }, "");
    }
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  /** 返回报表主页；reclaim=false 用于 popstate 路径（哨兵已被系统消费） */
  private closeReportDrill(reclaim = true): void {
    const armed = this.drillSentinelArmed;
    this.drillSentinelArmed = false;
    this.reportDrill = null;
    this.render();
    if (reclaim && armed) this.reclaimHistory(1);
  }

  /** 下钻页：返回 + 标题 + 月份切换，正文按环形 / 趋势两套口径渲染 */
  private renderReportDrill(host: HTMLElement): void {
    const d = this.reportDrill;
    if (!d) return;
    const head = host.createDiv({ cls: "db-led-subhead" });
    const back = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": "返回报表" } });
    setIcon(back.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
    back.createSpan({ text: "返回" });
    back.addEventListener("click", () => this.closeReportDrill());
    head.createSpan({ cls: "db-led-subhead-title", text: this.reportDrillTitle(d) });

    const body = host.createDiv({ cls: "db-led-body" });
    this.renderMonthNav(body);
    const months = this.reportMonths();
    if (d === "donut-out" || d === "donut-in") this.reportDrillPie(body, d === "donut-out" ? "expense" : "income");
    else this.reportDrillTrend(body, d, months);
  }

  /** 环形下钻：大字合计 + 大环形图 + 每项金额 / 笔数 / 占比与长度条 */
  private reportDrillPie(body: HTMLElement, kind: LedgerKind): void {
    const isOut = kind === "expense";
    const recs = this.store.monthRecords(this.month);
    const slices = toSlices(this.reportGroups(kind, recs), isOut ? EXPENSE_COLORS : INCOME_COLORS, REPORT_DRILL_SLICES);
    const total = round2(slices.reduce((s, x) => s + x.total, 0));

    const top = this.card(body, "");
    top.addClass("db-led-rptd-card");
    const hero = top.createDiv({ cls: "db-led-rptd-hero" });
    hero.createDiv({ cls: "db-led-rptd-total", text: fmtMoney(total) });
    hero.createDiv({ cls: "db-led-rptd-cap", text: `${this.month.replace("-", "年")}月${isOut ? "支出" : "收入"}` });
    this.reportDonut(hero.createDiv({ cls: "db-led-rpt-donut is-big" }), slices, "占比", `${slices.length} 项`);

    const list = this.card(body, "分类明细");
    list.addClass("db-led-rptd-list");
    if (!slices.length) {
      list.createDiv({ cls: "db-led-rpt-legend-empty", text: isOut ? "本月暂无支出数据" : "本月暂无收入数据" });
      return;
    }
    const max = slices.reduce((m, s) => Math.max(m, s.total), 0) || 1;
    slices.forEach(s => {
      const row = list.createDiv({ cls: "db-led-rptd-row" });
      const line = row.createDiv({ cls: "db-led-rptd-line" });
      line.createSpan({ cls: "db-led-rpt-lg-dot" }).style.background = s.color;
      line.createSpan({ cls: "db-led-rptd-name", text: s.label });
      line.createSpan({ cls: "db-led-rptd-amt", text: fmtMoney(s.total) });
      line.createSpan({ cls: "db-led-rptd-cnt", text: `${s.count}笔` });
      line.createSpan({ cls: "db-led-rptd-pct", text: pctText(s.frac) });
      const bar = row.createDiv({ cls: "db-led-rptd-bar" });
      const fill = bar.createDiv({ cls: "db-led-rptd-fill" });
      fill.style.width = `${Math.max(1.5, s.total / max * 100)}%`;
      fill.style.background = s.color;
    });
  }

  /**
   * 趋势下钻：大字合计 + 平均 + 带刻度的大图 + 逐月明细（金额 / 环比 / 笔数）。
   * 环比配色按「好坏」而非正负：支出涨了是坏事（红），收入与结余涨了是好事（绿）。
   */
  private reportDrillTrend(body: HTMLElement, d: ReportDrill, months: string[]): void {
    const tone: "out" | "in" | "diff" = d === "trend-in" ? "in" : d === "trend-net" ? "diff" : "out";
    const kind: LedgerKind | "net" = tone === "diff" ? "net" : tone === "in" ? "income" : "expense";
    const name = tone === "diff" ? "结余" : tone === "in" ? "收入" : "支出";
    const rows = months.map(ym => {
      const st = this.reportMonthStat(ym, kind);
      return { ym, total: st.total, count: st.count };
    });
    const values = rows.map(r => r.total);
    const sum = round2(values.reduce((s, v) => s + v, 0));
    const avg = round2(sum / (values.length || 1));

    const top = this.card(body, "");
    top.addClass("db-led-rptd-card");
    const hero = top.createDiv({ cls: "db-led-rptd-hero" });
    hero.createDiv({ cls: "db-led-rptd-total", text: fmtMoney(sum) });
    hero.createDiv({ cls: "db-led-rptd-cap", text: `${months.length}个月平均${name} ${fmtMoney(avg)}` });
    this.reportTrend(top, `逐月${name}`, months, values, tone, true);

    const list = this.card(body, "逐月明细");
    list.addClass("db-led-rptd-list");
    const max = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
    // 明细只列有数据的月份；环比仍然跟上一个自然月比
    const shown = rows.filter(r => r.count > 0);
    if (!shown.length) {
      list.createDiv({ cls: "db-led-rpt-legend-empty", text: `近 ${months.length} 个月暂无${name}数据` });
      return;
    }
    shown.forEach(r => {
      const i = months.indexOf(r.ym);
      const prev = i > 0 ? rows[i - 1].total : 0;
      const row = list.createDiv({ cls: "db-led-rptd-row" });
      const line = row.createDiv({ cls: "db-led-rptd-line" });
      line.createSpan({ cls: "db-led-rptd-ym", text: r.ym });
      line.createSpan({ cls: "db-led-rptd-amt", text: fmtMoney(r.total) });
      const delta = i === 0 || prev === 0 ? null : (r.total - prev) / Math.abs(prev);
      if (delta === null) line.createSpan({ cls: "db-led-rptd-delta", text: i === 0 ? "—" : "新增" });
      else {
        const up = delta > 0;
        const good = tone === "out" ? !up : up;
        line.createSpan({ cls: `db-led-rptd-delta ${good ? "is-good" : "is-bad"}`, text: `${up ? "↑" : "↓"} ${pctText(delta)}` });
      }
      line.createSpan({ cls: "db-led-rptd-cnt", text: `${r.count}笔` });
      const bar = row.createDiv({ cls: "db-led-rptd-bar" });
      const fill = bar.createDiv({ cls: `db-led-rptd-fill${r.total < 0 ? " is-neg" : ""}` });
      fill.style.width = `${Math.max(1.5, Math.abs(r.total) / max * 100)}%`;
    });
  }

  /** 建 SVG 节点：图表全部走 createElementNS，不用 innerHTML 拼串（避免注入与主题样式丢失） */
  private svg(parent: Element, tag: string, attrs: Record<string, string | number>): SVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(k => el.setAttribute(k, String(attrs[k])));
    parent.appendChild(el);
    return el;
  }

  /* ────────────────────────── 设置（页内） ────────────────────────── */

  private async saveCfg(): Promise<void> { await this.store.saveConfig(); }

  private renderSettings(body: HTMLElement): void {
    const cfg = this.cfg;

    /* 设置页 = 菜单列表，每项点击进入页内二级页 */
    const rows: { key: SettingsSub; title: string; summary: string }[] = [
      { key: "ledgers", title: SUB_TITLES.ledgers, summary: `${cfg.ledgers.length} 个账本` },
      { key: "accounts", title: SUB_TITLES.accounts, summary: `${cfg.accounts.filter(a => !a.archived).length} 个账户` },
      { key: "categories", title: SUB_TITLES.categories, summary: `${cfg.categories.length} 个类别` },
      { key: "currencies", title: SUB_TITLES.currencies, summary: `基准 ${cfg.baseCurrency} · ${cfg.currencies.length} 种` },
      {
        key: "data", title: SUB_TITLES.data,
        summary: this.store.batches.filter(b => !b.undoneAt).length
          ? `${this.store.batches.filter(b => !b.undoneAt).length} 次导入`
          : "账单导入 / CSV 导出",
      },
      { key: "other", title: SUB_TITLES.other, summary: cfg.username || "未设置" },
    ];
    const list = body.createDiv({ cls: "db-led-card db-led-menu" });
    rows.forEach(r => {
      const btn = list.createEl("button", { cls: "db-led-menu-row", attr: { type: "button" } });
      btn.createSpan({ cls: "db-led-menu-label", text: r.title });
      btn.createSpan({ cls: "db-led-menu-sum", text: r.summary });
      setIcon(btn.createSpan({ cls: "db-led-menu-chev" }), "chevron-right");
      btn.addEventListener("click", () => this.openSettingsSub(r.key));
    });
  }

  /** 打开设置二级页：整页替换为子页内容（视图内导航，不弹浮层、不新开标签） */
  private openSettingsSub(key: SettingsSub): void {
    if (this.settingsSub === key) return;
    this.settingsSub = key;
    if (key === "data") this.dataPage?.resetToMenu();
    if (Platform.isMobileApp) {
      this.subSentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-settings-sub" }, "");
    }
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  /** 返回设置菜单；reclaim=false 用于 popstate 路径（哨兵已被系统消费） */
  private closeSettingsSub(reclaim = true): void {
    let back = 0;
    if (this.iconSentinelArmed) back++;
    if (this.subSentinelArmed) back++;
    this.iconSentinelArmed = false;
    this.iconPickFor = null;
    this.subSentinelArmed = false;
    this.settingsSub = null;
    this.render();
    if (reclaim) this.reclaimHistory(back);
  }

  /** 打开账户图标选择页（账户管理之下的三级页，同样是页内整页 + 返回键哨兵） */
  private openIconPicker(accountId: string): void {
    if (this.iconPickFor === accountId) return;
    this.iconPickFor = accountId;
    if (Platform.isMobileApp) {
      this.iconSentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-icon-pick" }, "");
    }
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  private closeIconPicker(): void {
    const armed = this.iconSentinelArmed;
    this.iconSentinelArmed = false;
    this.iconPickFor = null;
    this.render();
    if (armed) this.reclaimHistory(1);
  }

  /** 设置二级页：返回按钮 + 标题 + 对应组内容 */
  private renderSettingsSub(host: HTMLElement): void {
    const key = this.settingsSub!;
    if (key === "accounts" && this.iconPickFor) { this.renderIconPicker(host); return; }
    if (key === "data") {
      if (!this.dataPage) {
        this.dataPage = new LedgerDataPage(host, {
          app: this.app, plugin: this.plugin, store: this.store,
          onExit: () => this.closeSettingsSub(),
          gotoPage: (p) => { this.settingsSub = null; this.setPage(p); },
        });
      }
      this.dataPage.render();
      return;
    }
    const head = host.createDiv({ cls: "db-led-subhead" });
    const back = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": "返回设置" } });
    setIcon(back.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
    back.createSpan({ text: "返回" });
    back.addEventListener("click", () => this.closeSettingsSub());
    head.createSpan({ cls: "db-led-subhead-title", text: SUB_TITLES[key] });
    const body = host.createDiv({ cls: "db-led-body" });
    const refresh = () => this.render();
    if (key === "ledgers") this.renderLedgerSection(body, refresh);
    else if (key === "accounts") this.renderAccountSection(body, refresh);
    else if (key === "categories") this.renderCategorySection(body, refresh);
    else if (key === "currencies") this.renderCurrencySection(body, refresh);
    else this.renderOtherSection(body, refresh);
  }

  /** 图标选择页：一个「自动」+ 图标库网格，点一下即写入 config.json 并退回账户管理 */
  private renderIconPicker(host: HTMLElement): void {
    const acct = this.cfg.accounts.find(a => a.id === this.iconPickFor);
    if (!acct) { this.iconPickFor = null; this.render(); return; }
    const head = host.createDiv({ cls: "db-led-subhead" });
    const back = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": "返回账户管理" } });
    setIcon(back.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
    back.createSpan({ text: "返回" });
    back.addEventListener("click", () => this.closeIconPicker());
    head.createSpan({ cls: "db-led-subhead-title", text: `图标：${acct.name}` });
    const body = host.createDiv({ cls: "db-led-body" });
    body.createDiv({ cls: "db-led-group-hint", text: "支付宝、微信这类平台用官方 logo；银行卡、现金等用通用图标。选「自动」会按账户名匹配。" });
    const grid = body.createDiv({ cls: "db-led-icon-grid" });
    const cur = acct.icon || "";
    const choice = (key: string, label: string, iconKey: string) => {
      const btn = grid.createEl("button", { cls: `db-led-icon-cell${cur === key ? " is-active" : ""}`, attr: { type: "button" } });
      const ic = btn.createSpan({ cls: "db-led-icon-cell-img" });
      renderAccountIcon(ic, iconKey, acct.name);
      btn.createSpan({ cls: "db-led-icon-cell-label", text: label });
      btn.addEventListener("click", async () => {
        acct.icon = key;
        await this.saveCfg();
        this.closeIconPicker();
        new Notice(key ? `「${acct.name}」图标已设为${label}` : `「${acct.name}」按账户名自动匹配`);
      });
    };
    const guess = guessAccountIcon(acct.name);
    choice("", `自动 · ${iconLabel(guess)}`, guess);
    allIconChoices().forEach(c => choice(c.key, c.label, c.key));
  }

  /** 其他设置：创建用户 + 金额口径说明 */
  private renderOtherSection(parent: HTMLElement, refresh: () => void): void {
    void refresh;
    const cfg = this.cfg;
    const urow = parent.createDiv({ cls: "db-led-set-row" });
    urow.createSpan({ cls: "db-led-set-label", text: "创建用户" });
    const uname = urow.createEl("input", { cls: "db-led-input", attr: { type: "text", placeholder: "默认写入每笔记录的创建用户", "aria-label": "创建用户" } });
    uname.value = cfg.username;
    uname.addEventListener("change", async () => { cfg.username = uname.value.trim(); await this.saveCfg(); });
    parent.createDiv({
      cls: "db-led-note",
      text: `金额口径：支出实际支出 = 金额 − 优惠 − 退款；收入实际 = 金额；转账不计收支、只增减转出/转入账户余额。多币种记录可按笔覆盖汇率。数据文件：${this.store.dir}/`,
    });
  }

  /** 分类管理内容：折叠区内按 支出 / 收入 两组，类别本身用原生手风琴条目 */
  private renderCategorySection(parent: HTMLElement, refresh: () => void): void {
    const cfg = this.cfg;
    (["expense", "income"] as LedgerKind[]).forEach(kind => {
      const gc = parent.createDiv({ cls: "db-led-group-inner" });
      gc.createDiv({ cls: "db-led-group-hint", text: kind === "expense" ? "支出类别" : "收入类别" });
      const cats = cfg.categories.filter(c => c.kind === kind);
      cats.forEach(cat => {
        const item = gc.createDiv({ cls: "db-set-item db-led-cat-item" });
        const headEl = item.createDiv({ cls: "db-set-item-head", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
        const name = headEl.createEl("input", { cls: "db-led-input", attr: { type: "text", "aria-label": "类别名" } });
        name.value = cat.name;
        name.addEventListener("change", async () => { const v = name.value.trim(); if (v) { cat.name = v; await this.saveCfg(); } });
        headEl.createSpan({ cls: "db-led-sub-count", text: cat.subs.length ? `${cat.subs.length} 个二级` : "无二级" });
        const chev = headEl.createDiv({ cls: "db-set-item-chev" });
        setIcon(chev, "chevron-right");
        this.delBtn(headEl, async () => {
          new ConfirmModal(this.app, "删除类别", `确定删除「${cat.name}」及其二级分类？已有记录不受影响，将显示为“未分类”。`, "删除", () => {
            void (async () => {
              const idx = cfg.categories.indexOf(cat);
              if (idx >= 0) cfg.categories.splice(idx, 1);
              await this.saveCfg(); refresh();
            })();
          }).open();
        });
        const inner = item.createDiv({ cls: "db-set-item-body" });
        cat.subs.forEach((s, si) => {
          const srow = inner.createDiv({ cls: "db-led-subrow" });
          const sname = srow.createEl("input", { cls: "db-led-input", attr: { type: "text", "aria-label": "二级分类名" } });
          sname.value = s.name;
          sname.addEventListener("change", async () => { const v = sname.value.trim(); if (v) { s.name = v; await this.saveCfg(); } });
          this.delBtn(srow, async () => { cat.subs.splice(si, 1); await this.saveCfg(); refresh(); });
        });
        const addSub = inner.createEl("button", { cls: "db-led-add", attr: { type: "button" }, text: "+ 添加二级分类" });
        addSub.addEventListener("click", async () => { cat.subs.push({ id: uid(), name: "新分类" }); await this.saveCfg(); refresh(); });
        const toggle = () => {
          const open = !item.hasClass("is-open");
          item.toggleClass("is-open", open);
          chev.toggleClass("is-open", open);
          headEl.setAttribute("aria-expanded", String(open));
        };
        headEl.addEventListener("click", e => { if ((e.target as HTMLElement).closest("input, button, select")) return; toggle(); });
      });
      this.addLink(gc, kind === "expense" ? "添加支出类别" : "添加收入类别", async () => {
        cfg.categories.push({ id: uid(), name: "新类别", kind, subs: [] });
        await this.saveCfg(); refresh();
      });
    });
  }

  /** 账本管理内容（折叠区内，直接排行） */
  private renderLedgerSection(parent: HTMLElement, refresh: () => void): void {
    const cfg = this.cfg;
    cfg.ledgers.forEach((l, i) => parent.appendChild(this.textRow(l.name, "账本名", async v => {
      if (v) { cfg.ledgers[i].name = v; await this.saveCfg(); }
    }, async () => {
      const used = this.store.records.filter(r => r.ledgerId === l.id).length;
      new ConfirmModal(this.app, "删除账本", used ? `「${l.name}」下还有 ${used} 条记录，删除后记录仍保留但不再按此账本归类。` : `确定删除「${l.name}」？`, "删除", () => {
        void (async () => { cfg.ledgers.splice(i, 1); await this.saveCfg(); refresh(); })();
      }).open();
    })));
    this.addLink(parent, "添加账本", async () => { cfg.ledgers.push({ id: uid(), name: "新账本" }); await this.saveCfg(); refresh(); });
  }

  /** 账户管理内容（余额规则见资产页说明） */
  private renderAccountSection(parent: HTMLElement, refresh: () => void): void {
    const cfg = this.cfg;
    cfg.accounts.forEach((a, i) => {
      const row = parent.createDiv({ cls: "db-led-set-row" });
      const wrap = row.createDiv({ cls: "db-led-set-name" });
      const iconBtn = wrap.createEl("button", {
        cls: "db-led-acct-icon is-btn", attr: { type: "button", "aria-label": `选择「${a.name}」的图标`, title: "选择图标" },
      });
      renderAccountIcon(iconBtn, accountIconKey(a), a.name);
      iconBtn.addEventListener("click", () => this.openIconPicker(a.id));
      const name = wrap.createEl("input", { cls: "db-led-input", attr: { type: "text", "aria-label": "账户名" } });
      name.value = a.name;
      name.addEventListener("change", async () => {
        const v = name.value.trim();
        if (!v) return;
        a.name = v;
        await this.saveCfg();
        if (!a.icon) renderAccountIcon(iconBtn, accountIconKey(a), a.name);   // 自动匹配时跟着改名换图标
      });
      const cur = row.createEl("select", { cls: "db-led-select", attr: { "aria-label": "账户币种" } });
      cfg.currencies.forEach(c => cur.createEl("option", { value: c.code, text: c.code }));
      cur.value = a.currency;
      cur.addEventListener("change", async () => { a.currency = cur.value; await this.saveCfg(); });
      const open = row.createEl("input", { cls: "db-led-input db-led-input-num", attr: { type: "text", inputMode: "decimal", placeholder: "期初", "aria-label": "期初余额" } });
      open.value = String(a.opening || "");
      open.addEventListener("change", async () => { const v = parseFloat(open.value); a.opening = isFinite(v) ? round2(v) : 0; await this.saveCfg(); });
      this.delBtn(row, async () => {
        const used = this.store.records.filter(r => r.accountId === a.id || r.toAccountId === a.id).length;
        new ConfirmModal(this.app, "删除账户", used ? `「${a.name}」还有 ${used} 条流水，删除后不再计入净资产。` : `确定删除「${a.name}」？`, "删除", () => {
          void (async () => { cfg.accounts.splice(i, 1); await this.saveCfg(); refresh(); })();
        }).open();
      });
    });
    this.addLink(parent, "添加账户", async () => { cfg.accounts.push({ id: uid(), name: "新账户", currency: cfg.baseCurrency, opening: 0 }); await this.saveCfg(); refresh(); });
  }

  /** 币种管理内容（含基准币切换） */
  private renderCurrencySection(parent: HTMLElement, refresh: () => void): void {
    const cfg = this.cfg;
    parent.createDiv({ cls: "db-led-group-hint", text: "1 该币种 ≈ rate 基准币" });
    cfg.currencies.forEach((c, i) => {
      const row = parent.createDiv({ cls: "db-led-set-row" });
      const code = row.createEl("input", { cls: "db-led-input db-led-input-code", attr: { type: "text", "aria-label": "币种代码" } });
      code.value = c.code;
      code.addEventListener("change", async () => {
        const v = code.value.trim().toUpperCase();
        if (v) { const old = c.code; c.code = v; if (cfg.baseCurrency === old) cfg.baseCurrency = v; await this.saveCfg(); refresh(); }
      });
      const name = row.createEl("input", { cls: "db-led-input", attr: { type: "text", "aria-label": "币种名" } });
      name.value = c.name;
      name.addEventListener("change", async () => { c.name = name.value.trim(); await this.saveCfg(); });
      const rate = row.createEl("input", { cls: "db-led-input db-led-input-num", attr: { type: "text", inputMode: "decimal", placeholder: "1", "aria-label": "汇率" } });
      rate.value = String(c.rate);
      rate.addEventListener("change", async () => { const v = parseFloat(rate.value); if (isFinite(v) && v > 0) { c.rate = v; await this.saveCfg(); } });
      const baseChip = row.createDiv({ cls: `db-led-chip db-led-chip-base${cfg.baseCurrency === c.code ? " is-active" : ""}`, text: "基准" });
      baseChip.addEventListener("click", async () => { cfg.baseCurrency = c.code; await this.saveCfg(); refresh(); });
      if (cfg.baseCurrency !== c.code) this.delBtn(row, async () => {
        new ConfirmModal(this.app, "删除币种", `确定删除「${c.name}(${c.code})」？使用它的历史记录将按汇率 1 折算。`, "删除", () => {
          void (async () => { cfg.currencies.splice(i, 1); await this.saveCfg(); refresh(); })();
        }).open();
      });
    });
    this.addLink(parent, "添加币种", async () => { cfg.currencies.push({ code: "USD", name: "美元", rate: 7.2 }); await this.saveCfg(); refresh(); });
  }

  /** 名称输入 + 删除按钮 的通用行（账本等简单项） */
  private textRow(value: string, label: string, onChange: (v: string) => Promise<void>, onDelete: () => Promise<void>): HTMLElement {
    const row = document.createElement("div");
    row.className = "db-led-set-row";
    const input = row.createEl("input", { cls: "db-led-input", attr: { type: "text", "aria-label": label } });
    input.value = value;
    input.addEventListener("change", () => void onChange(input.value.trim()));
    this.delBtn(row, () => void onDelete());
    return row;
  }

  private delBtn(row: HTMLElement, onClick: () => void): void {
    const b = row.createEl("button", { cls: "db-led-del", attr: { type: "button", "aria-label": "删除", title: "删除" } });
    setIcon(b, "trash-2");
    b.addEventListener("click", onClick);
  }

  private addLink(card: HTMLElement, text: string, onClick: () => void): void {
    const b = card.createEl("button", { cls: "db-led-add", attr: { type: "button" }, text: `+ ${text}` });
    b.addEventListener("click", onClick);
  }

  /* ────────────────────────── 记一笔 / 编辑 sheet ────────────────────────── */

  private blankDraft(kind: LedgerKind): Draft {
    const firstLedger = this.cfg.ledgers[0]?.id ?? "";
    const firstAcct = this.cfg.accounts.find(a => !a.archived)?.id ?? "";
    return {
      createdAt: Date.now(), date: moment().format("YYYY-MM-DD"), kind,
      amount: "", currency: this.cfg.baseCurrency, rate: "",
      categoryId: "", subId: "", accountId: firstAcct, toAccountId: "", ledgerId: firstLedger,
      refund: "", discount: "", note: "", tags: "",
      reimbAccountId: "", reimbAmount: "", reimbDetail: "",
      address: "", creator: this.cfg.username, other: "", files: "",
      clock: "",
    };
  }

  private draftFrom(r: LedgerRecord): Draft {
    return {
      id: r.id, createdAt: r.createdAt, date: r.date, kind: r.kind,
      amount: String(r.amount), currency: r.currency || this.cfg.baseCurrency, rate: r.rate != null ? String(r.rate) : "",
      categoryId: r.categoryId || "", subId: r.subId || "", accountId: r.accountId || "", toAccountId: r.toAccountId || "", ledgerId: r.ledgerId || "",
      refund: r.refund ? String(r.refund) : "", discount: r.discount ? String(r.discount) : "",
      note: r.note || "", tags: (r.tags || []).join(", "),
      reimbAccountId: r.reimbAccountId || "", reimbAmount: r.reimbAmount ? String(r.reimbAmount) : "", reimbDetail: r.reimbDetail || "",
      address: r.address || "", creator: r.creator || "", other: r.other || "", files: (r.files || []).join(", "),
      clock: r.clock || "", importBatchId: r.importBatchId,
    };
  }

  /**
   * 记一笔浮层：挂在 document.body 上、fixed 锚视口（与计划「分组/排序」底面板同盒型）。
   * 不能放在滚动容器内用 absolute：.db-journal-root 是滚动容器，absolute inset:0 的浮层
   * 会被拉成整页内容高度——白色遮罩盖住内容、sheet 沉到滚动底部（移动端 bug 的根因）。
   */
  private openOverlay(): HTMLElement {
    this.closeOverlay();
    const overlay = document.body.createDiv({ cls: "db-led-overlay" });
    this.overlay = overlay;
    this.attachVpListener();
    this.lastKb = -1;
    this.syncKeyboardInset();
    if (Platform.isMobileApp) {
      this.sentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-sheet" }, "");
    }
    return overlay;
  }

  private closeOverlay(reclaim = true): void {
    if (!this.overlay) return;
    const armed = this.sentinelArmed;
    this.sentinelArmed = false;
    this.overlay.remove();
    this.overlay = null;
    this.detachVpListener();
    this.lastKb = -1;
    if (reclaim && armed && Platform.isMobileApp) window.history.back();
  }

  /** 打开记一笔/编辑 sheet：只创建一次浮层，之后靠 buildSheet 原地重绘，避免反复 push/back history 产生竞态 */
  private openRecordSheet(draft: Draft): void {
    const overlay = this.openOverlay();
    this.sheetEl = overlay.createDiv({ cls: "db-led-sheet" });
    this.buildSheet(this.sheetEl, draft, true);
  }

  /** 关闭 sheet 浮层（回收返回键哨兵）并清空引用 */
  private closeSheet(): void {
    this.sheetEl = null;
    this.closeOverlay();
  }

  /** 原地重绘 sheet 内容。chip 点击只改 draft 后调用本方法，不触碰 overlay / history。 */
  private buildSheet(sheet: HTMLElement, draft: Draft, isInitial: boolean): void {
    const cfg = this.cfg;
    const isNew = !draft.id;
    sheet.empty();

    const head = sheet.createDiv({ cls: "db-led-sheet-head" });
    head.createSpan({ cls: "db-led-sheet-title", text: isNew ? "记一笔" : "编辑记录" });
    const close = head.createDiv({ cls: "db-led-sheet-close", attr: { role: "button", "aria-label": "关闭" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeSheet());

    const body = sheet.createDiv({ cls: "db-led-sheet-body" });

    /* 收支切换（支出 / 收入 / 转账） */
    const isTr = draft.kind === "transfer";
    const seg = body.createDiv({ cls: "db-led-seg" });
    const mk = (label: string, kind: LedgerKind) => {
      const b = seg.createDiv({ cls: `db-led-seg-btn ${this.kindClass(kind)}${draft.kind === kind ? " is-active" : ""}`, text: label });
      b.addEventListener("click", () => {
        if (draft.kind === kind) return;
        draft.kind = kind;
        draft.categoryId = "";
        draft.subId = "";
        if (kind === "transfer" && (!draft.toAccountId || draft.toAccountId === draft.accountId)) {
          draft.toAccountId = cfg.accounts.find(a => !a.archived && a.id !== draft.accountId)?.id ?? "";
        }
        this.buildSheet(sheet, draft, false);
      });
    };
    mk("支出", "expense");
    mk("收入", "income");
    mk("转账", "transfer");

    /* 金额 + 日期 */
    const amtRow = body.createDiv({ cls: "db-led-amount-row" });
    const amount = amtRow.createEl("input", {
      cls: "db-led-amount", attr: { type: "text", inputMode: "decimal", placeholder: "0.00", "aria-label": "金额" },
    });
    amount.value = draft.amount;
    amount.addEventListener("input", () => { draft.amount = amount.value; });
    const date = amtRow.createEl("input", { cls: "db-led-date", attr: { type: "date", "aria-label": "日期" } });
    date.value = draft.date;
    date.addEventListener("change", () => { if (date.value) draft.date = date.value; });

    /* 币种 chips */
    if (cfg.currencies.length > 1) {
      const curRow = body.createDiv({ cls: "db-led-chips" });
      cfg.currencies.forEach(c => {
        const chip = curRow.createDiv({ cls: `db-led-chip${draft.currency === c.code ? " is-active" : ""}`, text: `${symbolOf(c.code)} ${c.code}` });
        chip.addEventListener("click", () => { if (draft.currency !== c.code) { draft.currency = c.code; this.buildSheet(sheet, draft, false); } });
      });
    }

    /* 类别 + 二级（转账无类别，只显示金额流转方向） */
    if (!isTr) {
      body.createDiv({ cls: "db-led-field-label", text: "类别" });
      const cats = cfg.categories.filter(c => c.kind === draft.kind);
      const catGrid = body.createDiv({ cls: "db-led-cats" });
      cats.forEach(c => {
        const chip = catGrid.createDiv({ cls: `db-led-cat${draft.categoryId === c.id ? " is-active" : ""}`, text: c.name });
        chip.addEventListener("click", () => {
          draft.categoryId = draft.categoryId === c.id ? "" : c.id;
          if (draft.subId && c.subs.find(s => s.id === draft.subId) === undefined) draft.subId = "";
          this.buildSheet(sheet, draft, false);
        });
      });
      const selCat = cats.find(c => c.id === draft.categoryId);
      if (selCat && selCat.subs.length) {
        body.createDiv({ cls: "db-led-field-label", text: "二级分类" });
        const subGrid = body.createDiv({ cls: "db-led-cats" });
        const mkChip = (label: string, id: string) => {
          const chip = subGrid.createDiv({ cls: `db-led-chip${draft.subId === id ? " is-active" : ""}`, text: label });
          chip.addEventListener("click", () => { draft.subId = draft.subId === id ? "" : id; this.buildSheet(sheet, draft, false); });
        };
        selCat.subs.forEach(s => mkChip(s.name, s.id));
      }
    }

    /* 账户 / 转入账户 / 账本 */
    const two = body.createDiv({ cls: "db-led-two" });
    const activeAccts = cfg.accounts.filter(a => !a.archived);
    const f1 = two.createDiv({ cls: "db-led-field" });
    f1.createDiv({ cls: "db-led-field-label", text: isTr ? "转出账户" : "账户" });
    const acctSel = f1.createEl("select", { cls: "db-led-select", attr: { "aria-label": "账户" } });
    activeAccts.forEach(a => acctSel.createEl("option", { value: a.id, text: a.name }));
    acctSel.value = draft.accountId;
    acctSel.addEventListener("change", () => { draft.accountId = acctSel.value; });
    if (isTr) {
      const f3 = two.createDiv({ cls: "db-led-field" });
      f3.createDiv({ cls: "db-led-field-label", text: "转入账户" });
      const toSel = f3.createEl("select", { cls: "db-led-select", attr: { "aria-label": "转入账户" } });
      toSel.createEl("option", { value: "", text: "请选择" });
      activeAccts.forEach(a => toSel.createEl("option", { value: a.id, text: a.name }));
      toSel.value = draft.toAccountId;
      toSel.addEventListener("change", () => { draft.toAccountId = toSel.value; });
    }
    const f2 = two.createDiv({ cls: "db-led-field" });
    f2.createDiv({ cls: "db-led-field-label", text: "账本" });
    const ledSel = f2.createEl("select", { cls: "db-led-select", attr: { "aria-label": "账本" } });
    cfg.ledgers.forEach(l => ledSel.createEl("option", { value: l.id, text: l.name }));
    ledSel.value = draft.ledgerId;
    ledSel.addEventListener("change", () => { draft.ledgerId = ledSel.value; });

    /* 备注 / 标签 */
    const note = body.createEl("textarea", { cls: "db-led-textarea", attr: { placeholder: "备注", rows: "2", "aria-label": "备注" } });
    note.value = draft.note;
    note.addEventListener("input", () => { draft.note = note.value; });
    const tags = body.createEl("input", { cls: "db-led-input", attr: { type: "text", placeholder: "标签，逗号分隔", "aria-label": "标签" } });
    tags.value = draft.tags;
    tags.addEventListener("input", () => { draft.tags = tags.value; });

    /* 高级区（展开状态记在实例上，重绘后不丢） */
    if (isInitial) {
      this.sheetAdvOpen = !!(draft.refund || draft.discount || draft.reimbAmount || draft.rate || draft.address || draft.other || draft.files);
    }
    const adv = body.createDiv({ cls: "db-led-adv" + (this.sheetAdvOpen ? " is-open" : "") });
    const advHead = adv.createDiv({ cls: "db-led-adv-head" });
    advHead.createSpan({ text: isTr ? "多币种 / 更多" : "退款 / 优惠 / 报销 / 多币种 / 更多" });
    setIcon(advHead.createSpan({ cls: "db-led-adv-chev" }), "chevron-down");
    const advBody = adv.createDiv({ cls: "db-led-adv-body" });
    advHead.addEventListener("click", () => {
      this.sheetAdvOpen = !this.sheetAdvOpen;
      adv.toggleClass("is-open", this.sheetAdvOpen);
    });

    type DraftStrKey = "refund" | "discount" | "reimbAmount" | "reimbDetail" | "rate" | "address" | "creator" | "other" | "files";
    const mkField = (label: string, ph: string, key: DraftStrKey, inputMode = false): void => {
      const f = advBody.createDiv({ cls: "db-led-field" });
      f.createDiv({ cls: "db-led-field-label", text: label });
      const el = f.createEl("input", { cls: "db-led-input", attr: { type: "text", placeholder: ph, "aria-label": label, ...(inputMode ? { inputMode: "decimal" } : {}) } });
      el.value = draft[key];
      el.addEventListener("input", () => { draft[key] = el.value; });
    };
    if (!isTr) {
      mkField("退款", "已退回金额", "refund", true);
      mkField("优惠", "优惠/折扣金额", "discount", true);
      const fr = advBody.createDiv({ cls: "db-led-field" });
      fr.createDiv({ cls: "db-led-field-label", text: "报销账户（垫付归属）" });
      const reimbSel = fr.createEl("select", { cls: "db-led-select", attr: { "aria-label": "报销账户" } });
      reimbSel.createEl("option", { value: "", text: "不报销" });
      cfg.accounts.filter(a => !a.archived).forEach(a => reimbSel.createEl("option", { value: a.id, text: a.name }));
      reimbSel.value = draft.reimbAccountId;
      reimbSel.addEventListener("change", () => { draft.reimbAccountId = reimbSel.value; });
      mkField("报销金额", "可报销的金额", "reimbAmount", true);
      mkField("报销明细", "发票号 / 明细说明", "reimbDetail");
    }
    mkField("汇率", `1 ${draft.currency} = ? ${cfg.baseCurrency}（空按币种表）`, "rate", true);
    mkField("地址", "商家地址 / 地点", "address");
    mkField("创建用户", "默认取设置中的用户名", "creator");
    mkField("其他", "自定义字段", "other");
    mkField("附件", "![[链接]] 或路径，逗号分隔", "files");

    /* 保存 */
    const foot = sheet.createDiv({ cls: "db-led-sheet-foot" });
    if (!isNew) {
      const del = foot.createEl("button", { cls: "db-led-del-big", attr: { type: "button" }, text: "删除" });
      del.addEventListener("click", () => {
        new ConfirmModal(this.app, "删除记录", "确定删除这笔记录吗？", "删除", () => {
          void (async () => { await this.store.deleteRecord(draft.id!); this.closeSheet(); this.render(); })();
        }).open();
      });
    }
    const save = foot.createEl("button", { cls: "db-led-save", attr: { type: "button" }, text: isNew ? "记一笔" : "保存" });
    save.addEventListener("click", () => {
      const amt = parseFloat(draft.amount);
      if (!isFinite(amt) || amt <= 0) { new Notice("请填写金额"); amount.focus(); return; }
      if (draft.kind === "transfer") {
        if (!draft.toAccountId) { new Notice("请选择转入账户"); return; }
        if (draft.toAccountId === draft.accountId) { new Notice("转入账户不能与转出账户相同"); return; }
      } else if (!draft.categoryId) { new Notice("请选择类别"); return; }
      const rate = parseFloat(draft.rate);
      const rec: LedgerRecord = {
        id: draft.id ?? makeRecordId(),
        date: draft.date || moment().format("YYYY-MM-DD"),
        kind: draft.kind,
        amount: round2(amt),
        categoryId: draft.kind === "transfer" ? "" : draft.categoryId,
        subId: draft.kind === "transfer" ? undefined : (draft.subId || undefined),
        accountId: draft.accountId || (cfg.accounts[0]?.id ?? ""),
        toAccountId: draft.kind === "transfer" ? draft.toAccountId : undefined,
        ledgerId: draft.ledgerId || (cfg.ledgers[0]?.id ?? ""),
        refund: round2(num(draft.refund)),
        discount: round2(num(draft.discount)),
        note: draft.note.trim(),
        tags: draft.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
        reimbAccountId: draft.reimbAccountId || undefined,
        reimbAmount: draft.reimbAccountId ? round2(num(draft.reimbAmount)) : num(draft.reimbAmount) ? round2(num(draft.reimbAmount)) : undefined,
        reimbDetail: draft.reimbDetail.trim() || undefined,
        currency: draft.currency || cfg.baseCurrency,
        rate: isFinite(rate) && rate > 0 ? rate : undefined,
        address: draft.address.trim(),
        creator: draft.creator.trim() || cfg.username,
        other: draft.other.trim(),
        files: draft.files.split(/[,，]/).map(t => t.trim()).filter(Boolean),
        createdAt: draft.createdAt,
        clock: draft.clock || undefined,
        importBatchId: draft.importBatchId,
      };
      void (async () => {
        try {
          if (isNew) await this.store.addRecord(rec); else await this.store.updateRecord(rec);
          this.closeSheet();
          this.render();
        } catch (e) {
          new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    });
    if (isInitial) amount.focus();
  }
}
