/**
 * ledgerPage.ts — 记账（ledger）章节的六页 UI
 *
 * 页头不放页名/圆点：页名经 onPageTitle 并入顶栏章节标题（「记账 · 首页」），切页走顶栏「切换页面」菜单。
 * 记一笔 = 视图内底部浮层 sheet（不新开 tab）；编辑单条记录 = 页内整页二级页（移动端不再被浮层压掉可视面积）。
 * 安卓返回键经 popstate 哨兵逐层剥离。
 * 金额口径说明见 ledgerStore 头注释；页内「设置」同步展示给用户。
 */
import { App, Menu, Modal, Notice, Platform, moment, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { ConfirmModal } from "./TodayPanel";
import { LedgerDataPage } from "./ledgerDataPage";
import { lunarLabel } from "./lunar";
import { accountIconKey, allIconChoices, guessAccountIcon, iconLabel, renderAccountIcon } from "./accountIcons";
import { guessCategoryIcon, renderCategoryIcon } from "./categoryIcons";
import { activatable, CategoryEditModal, CategoryManager, editCategoryDialogs } from "./ledgerCategoryUI";
import { NotionMultiSelect, NotionSelect } from "./notionSelect";
import { scrollPageToTop } from "./pageScroll";
import { keywordMatch } from "./filters";
import type { SearchHit } from "./memoSearch";
import {
  EXPENSE_COLORS, INCOME_COLORS, Box, Slice,
  compactMoney, donutArcs, niceCeil, pctText, seriesPoints, smoothAreaPath, smoothPath, toSlices,
} from "./ledgerCharts";import {
  LedgerStore, LedgerRecord, LedgerConfig, LedgerKind, LedgerCategory, LedgerAccount,
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

/** 长按触发时的轻微震动（参照 TodayPanel 的内联做法，仅移动端有效，失败静默） */
function hapticTick(): void {
  try {
    const win = activeWindow as unknown as {
      Capacitor?: { Plugins?: Record<string, { impactLight?: (o: { style: string }) => Promise<unknown> } | undefined> };
      navigator?: { vibrate?: (pattern: number | number[]) => boolean };
    };
    void Promise.resolve(win.Capacitor?.Plugins?.Haptics?.impactLight?.({ style: "light" })).catch(() => {});
    win.navigator?.vibrate?.(10);
  } catch { /* 不支持则忽略 */ }
}

/**
 * 长按手势（移动端长按类别格子 = 编辑该分类；桌面按住鼠标左键同理）：
 * 按住 ~500ms 触发；提前松手或滑动超过 8px 视为普通点按 / 滚动，不触发。
 * 触发后吞掉松手紧跟的 click（先注册先执行，拦在格子自己的选中监听之前），
 * 否则编辑弹窗底下又把分类选中。contextmenu 一并拦掉，免得安卓长按弹系统菜单。
 */
function longPress(el: HTMLElement, run: () => void): void {
  let timer: number | null = null;
  let fired = false;
  let sx = 0;
  let sy = 0;
  const cancel = () => { if (timer !== null) { activeWindow.clearTimeout(timer); timer = null; } };
  el.addEventListener("click", e => {
    if (!fired) return;
    fired = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  });
  el.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    fired = false;
    sx = e.clientX;
    sy = e.clientY;
    /* 指针捕获：手指 / 鼠标滑出格子后 move / up 仍送达这里，滚动误触才能正确取消 */
    try { el.setPointerCapture(e.pointerId); } catch { /* 部分环境不支持，仍可用 */ }
    timer = activeWindow.setTimeout(() => {
      timer = null;
      fired = true;
      hapticTick();
      run();
    }, 500);
  });
  el.addEventListener("pointermove", e => {
    if (timer !== null && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel();
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("contextmenu", e => e.preventDefault());
}

interface Draft {
  id?: string; createdAt: number;
  date: string; kind: LedgerKind; amount: string; currency: string; rate: string;
  categoryId: string; subId: string; accountId: string; toAccountId: string; ledgerId: string;
  refund: string; discount: string; note: string; tags: string;
  reimbAccountId: string; reimbAmount: string; reimbDetail: string;
  address: string; creator: string; other: string; files: string;
  clock?: string; importBatchId?: string;
}

/**
 * 调整资产余额：差额二选一——「生成记录」记一条收入 / 支出（流水可追溯这笔调整），
 * 或「直接调整」改期初余额（不产生记录）。差额为正记收入、为负记支出。
 */
class AssetBalanceModal extends Modal {
  constructor(
    app: App,
    private opts: {
      store: LedgerStore;
      account: LedgerAccount;
      current: number;
      save: () => Promise<void>;
      onDone: () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const acct = this.opts.account;
    const sym = symbolOf(acct.currency || this.opts.store.config.baseCurrency);
    contentEl.createEl("h3", { text: `调整「${acct.name}」余额` });
    contentEl.createDiv({
      cls: "db-led-field-label",
      text: `当前余额 ${sym}${fmtMoney(this.opts.current)}，填入调整后的新余额。`,
    });
    const input = contentEl.createEl("input", {
      cls: "db-led-input db-led-input-num",
      attr: { type: "text", inputMode: "decimal", "aria-label": "新余额", placeholder: sym },
    });
    input.value = String(this.opts.current);
    input.focus();
    input.select();
    contentEl.createDiv({
      cls: "db-led-note",
      text: "「生成记录」：差额自动记为收入（调增）或支出（调减），流水里可追溯；「直接调整」：只改期初余额，不产生任何记录。",
    });

    const submit = (mode: "record" | "direct"): void => {
      const target = round2(parseFloat(input.value));
      if (!isFinite(target) || target < 0) { new Notice("请输入正确的余额"); return; }
      const delta = round2(target - this.opts.current);
      this.close();
      if (delta === 0) return;
      void (async () => {
        const store = this.opts.store;
        if (mode === "direct") {
          acct.opening = round2((acct.opening || 0) + delta);
          await this.opts.save();
          new Notice(`「${acct.name}」余额已调整为 ${sym}${fmtMoney(target)}（未生成记录）`);
        } else {
          const kind: LedgerKind = delta > 0 ? "income" : "expense";
          const cat = store.config.categories.find(c => c.kind === kind);
          await store.addRecord({
            id: makeRecordId(),
            date: moment().format("YYYY-MM-DD"),
            kind,
            amount: round2(Math.abs(delta)),
            categoryId: cat?.id ?? "",
            accountId: acct.id,
            ledgerId: store.config.ledgers[0]?.id ?? "",
            refund: 0,
            discount: 0,
            note: `余额调整：${sym}${fmtMoney(this.opts.current)} → ${sym}${fmtMoney(target)}`,
            tags: [],
            currency: acct.currency || store.config.baseCurrency,
            address: "",
            creator: store.config.username || "余额调整",
            other: "",
            files: [],
            createdAt: Date.now(),
          });
          new Notice(`差额 ${sym}${fmtMoney(Math.abs(delta))} 已记为${kind === "income" ? "收入" : "支出"}`);
        }
        this.opts.onDone();
      })();
    };

    const btns = contentEl.createDiv({ cls: "db-mood-modal-btns" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    const direct = btns.createEl("button", { text: "直接调整" });
    direct.onclick = () => submit("direct");
    const rec = btns.createEl("button", { text: "生成记录", cls: "mod-cta" });
    rec.onclick = () => submit("record");
  }

  onClose(): void { this.contentEl.empty(); }
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
  /** 资产详情二级页（账户 id，null = 不在详情）；统计 / 流水切换记在 assetView */
  private assetDetailId: string | null = null;
  private assetSentinelArmed = false;
  private assetView: "flow" | "stats" = "flow";
  /** SVG clipPath 需要文档内唯一 id，自增一次即可（整页重渲染也不复用旧节点） */
  private clipSeq = 0;
  private statsRange: "month" | "quarter" | "year" = "month";
  private overlay: HTMLElement | null = null;
  private sheetEl: HTMLElement | null = null;
  private sheetAdvOpen = false;
  /** 记一笔草稿（浮层内切到分类管理再回来时不丢） */
  private sheetDraft: Draft | null = null;
  /** 单条记录编辑页（null = 不在编辑）：整页二级页不弹 sheet，移动端可视面积不再被浮层压掉 */
  private editRec: Draft | null = null;
  private editSentinelArmed = false;
  /** 编辑页的表单容器（分类管理就地替换它） */
  private editFormEl: HTMLElement | null = null;
  /** 浮层当前显示的是分类管理页 */
  private mgrOpen = false;
  private mgrSentinelArmed = false;
  /** 分类管理「返回」按钮 go(-1) 丢哨兵引发的下一次 popstate 只吞一次（防误关表单） */
  private popSuppress = false;
  /** 分类管理页签记忆（设置页与浮层共用） */
  private catMgrKind: "expense" | "income" = "expense";
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
    this.store = new LedgerStore(app, plugin.settings, () => plugin.saveSettings());
    this.onPop = () => {
      /* 分类管理「返回」按钮自己 go(-1) 丢弃哨兵引发的那次 popstate：
         表单已同步重建，直接吞掉，别落进下面的分支把刚恢复的表单误关掉 */
      if (this.popSuppress) { this.popSuppress = false; return; }
      /* 分类管理压在记一笔 sheet / 编辑页之上：返回键先退回表单（下层哨兵仍压着） */
      if ((this.overlay || this.editRec) && this.mgrSentinelArmed) {
        this.mgrSentinelArmed = false;
        this.mgrOpen = false;
        if (this.editRec) { this.render(); return; }
        if (this.sheetEl && this.sheetDraft) this.buildSheet(this.sheetEl, this.sheetDraft, false);
        this.render();
        return;
      }
      /* 编辑单条记录的整页压在列表之上：返回键先退回列表（改动不落库，与 sheet 的关闭一致） */
      if (this.editRec) {
        this.editSentinelArmed = false;
        this.editRec = null;
        this.editFormEl = null;
        this.render();
        return;
      }
      /* 资产详情压在资产页之上（详情里点流水还会再压一层记录编辑页）：返回键先退回资产页 */
      if (this.assetDetailId) {
        this.assetSentinelArmed = false;
        this.assetDetailId = null;
        this.render();
        return;
      }
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
    if (this.editSentinelArmed) { back++; this.editSentinelArmed = false; this.editRec = null; }
    if (this.assetSentinelArmed) { back++; this.assetSentinelArmed = false; this.assetDetailId = null; }
    if (this.mgrSentinelArmed) { back++; this.mgrSentinelArmed = false; this.mgrOpen = false; }
    if (this.drillSentinelArmed) { back++; this.drillSentinelArmed = false; this.reportDrill = null; }
    if (this.iconSentinelArmed) { back++; this.iconSentinelArmed = false; this.iconPickFor = null; }
    if (this.subSentinelArmed) { back++; this.subSentinelArmed = false; this.settingsSub = null; }
    this.reclaimHistory(back);
    this.dataPage?.destroy();
    this.dataPage = null;
    this.sheetEl = null;
    this.editFormEl = null;
    this.detachVpListener();
  }

  /** 顶栏「切换页面」菜单用：当前页 + 全部页面 */
  getPageInfo(): { current: PageKind; pages: { key: PageKind; title: string }[] } {
    return { current: this.page, pages: PAGE_ORDER.map(p => ({ key: p, title: PAGE_TITLES[p] })) };
  }

  setPage(p: PageKind): void {
    /* 从二级页切走时回收哨兵，避免残留 history 记录（编辑页打开时顶栏仍可直达）。
       清理必须放在同页判断之前：下钻页 / 资产详情 / 设置子页等二级层盖在当前页上时
       this.page 不变，先早退会跳过拆层——切「被盖住的那一页」就第一次点不动了
       （如报表下钻页里切「报表」）。同页且无二级层时，重渲染 + 回顶也无害。 */
    let back = 0;
    if (this.mgrOpen) {
      if (this.mgrSentinelArmed) back++;
      this.mgrOpen = false;
      this.mgrSentinelArmed = false;
    }
    if (this.editRec) {
      if (this.editSentinelArmed) back++;
      this.editSentinelArmed = false;
      this.editRec = null;
      this.editFormEl = null;
    }
    if (this.assetDetailId) {
      if (this.assetSentinelArmed) back++;
      this.assetSentinelArmed = false;
      this.assetDetailId = null;
    }
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
    scrollPageToTop(this.host);
  }

  /**
   * 顶栏「···」→ 搜索记账：是否有未完成的记录编辑（整页编辑页 / 记一笔浮层）。
   * 搜索跳转会直接进另一条记录的编辑页，先把当前改动挡在门外。
   */
  isEditing(): boolean {
    return !!this.editRec || !!this.overlay;
  }

  /**
   * 全量记录关键词搜索：匹配备注 / 分类 / 账户 / 账本 / 标签 / 金额 / 日期。
   * 空关键词返回最近记录（弹窗打开时就有内容可看）。
   */
  searchRecords(keyword: string): SearchHit[] {
    const q = keyword.trim();
    return this.store.records
      .filter(r => !q || keywordMatch(this.recordSearchText(r), q))
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
      .slice(0, 300)
      .map((r): SearchHit => {
        const isTr = r.kind === "transfer";
        const cat = this.catOf(r.categoryId);
        const sub = cat?.subs.find(s => s.id === r.subId);
        const from = this.acctOf(r.accountId)?.name ?? "";
        const to = this.acctOf(r.toAccountId ?? "")?.name ?? "";
        const bits = [
          r.clock,
          isTr ? `${from} → ${to}` : from,
          r.note,
          r.tags?.map(t => `#${t}`).join(" "),
        ].filter((v): v is string => !!v);
        const sym = symbolOf(r.currency || this.cfg.baseCurrency);
        const sign = isTr ? "" : r.kind === "income" ? "+" : "-";
        return {
          id: r.id,
          date: r.date.slice(5),
          text: isTr ? "转账" : [cat?.name ?? "未分类", sub?.name].filter(Boolean).join(" · "),
          meta: bits.join(" · "),
          badge: `${sign}${sym}${fmtMoney(actualAmount(r))}`,
          badgeTone: isTr ? "tr" : r.kind === "income" ? "in" : "out",
        };
      });
  }

  /** 搜索里点中的记录：直接进整页编辑（与列表点行同一条路径） */
  openRecordById(id: string): void {
    const r = this.store.records.find(x => x.id === id);
    if (!r) return;
    this.openRecordEditor(this.draftFrom(r));
  }

  private recordSearchText(r: LedgerRecord): string {
    const cat = this.catOf(r.categoryId);
    const sub = cat?.subs.find(s => s.id === r.subId);
    return [
      r.date,
      r.clock ?? "",
      r.note,
      (r.tags ?? []).join(" "),
      cat?.name ?? "",
      sub?.name ?? "",
      this.acctOf(r.accountId)?.name ?? "",
      this.acctOf(r.toAccountId ?? "")?.name ?? "",
      this.ledgerName(r.ledgerId),
      r.kind === "expense" ? "支出" : r.kind === "income" ? "收入" : "转账",
      String(actualAmount(r)),
      r.currency || this.cfg.baseCurrency,
    ].join("\n");
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
    if (this.editRec) { this.renderRecordEditor(host); return; }
    if (this.assetDetailId) { this.renderAssetDetail(host); return; }
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
    const rowIcon = row.createDiv({ cls: `db-led-row-icon ${kls}` });
    if (!isTr && cat) renderCategoryIcon(rowIcon, cat.icon || guessCategoryIcon(cat.name), cat.name);
    else rowIcon.setText(isTr ? "转" : (cat?.name ?? "未")[0]);
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
    dayRecs.forEach(r => this.recordRow(card, r, () => this.openRecordEditor(this.draftFrom(r))));
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
    this.renderMonthNav(body, ym => this.store.monthRecords(ym, this.listLedgerId || undefined).length > 0);

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
        /* 没流水的日子整体降淡（日期数字变浅），和有账的日子一眼区分 */
        cell.addClass("is-norec");
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
      /* 整行可点 → 资产详情（历史流水 + 走势 / 转入转出 / 分类环形图 + 调整余额） */
      const row = c2.createDiv({ cls: "db-led-acct-row is-link" });
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
      const chev = row.createSpan({ cls: "db-led-acct-chev" });
      setIcon(chev, "chevron-right");
      row.addEventListener("click", () => this.openAssetDetail(b.account.id));
    });
    body.createDiv({
      cls: "db-led-note",
      text: "余额 = 期初余额 + 收入 − 实际支出（支出按 金额−优惠−退款 计）；转账只移动账户间余额，不计收支。点账户看历史流水与走势；期初与账户在「设置」里修改，余额也可在详情页调整。",
    });
  }

  /* ────────────────────────── 资产详情 ────────────────────────── */

  /** 点资产行：进整页二级页（历史流水 / 统计），安卓返回键经哨兵退回资产页 */
  private openAssetDetail(id: string): void {
    if (this.assetDetailId === id) return;
    this.assetDetailId = id;
    this.assetView = "flow";
    if (Platform.isMobileApp) {
      this.assetSentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-asset" }, "");
    }
    this.render();
    this.host.scrollIntoView({ block: "start" });
  }

  /** 返回资产页；reclaim=false 用于 popstate 路径（哨兵已被系统消费） */
  private closeAssetDetail(reclaim = true): void {
    const armed = this.assetSentinelArmed;
    this.assetSentinelArmed = false;
    this.assetDetailId = null;
    this.render();
    if (reclaim && armed) this.reclaimHistory(1);
  }

  /** 账户在某日（含当日）为止的余额；dateStr 空 = 含全部记录。口径与 accountBalances 完全一致 */
  private accountBalanceAt(accountId: string, dateStr: string): number {
    const acct = this.cfg.accounts.find(a => a.id === accountId);
    let bal = acct?.opening || 0;
    for (const r of this.store.records) {
      if (dateStr && r.date > dateStr) continue;
      const v = actualAmount(r);
      if (r.kind === "transfer") {
        if (r.accountId === accountId) bal -= v;
        else if (r.toAccountId === accountId) bal += v;
        continue;
      }
      if (r.accountId !== accountId) continue;
      bal += r.kind === "income" ? v : -v;
    }
    return round2(bal);
  }

  /** 资产详情：返回 + 标题 + 余额卡（可调整）+ 流水 / 统计两个视图 */
  private renderAssetDetail(host: HTMLElement): void {
    const acct = this.cfg.accounts.find(a => a.id === this.assetDetailId);
    if (!acct) { this.assetDetailId = null; this.render(); return; }
    const head = host.createDiv({ cls: "db-led-subhead" });
    const back = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": "返回资产" } });
    setIcon(back.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
    back.createSpan({ text: "返回" });
    back.addEventListener("click", () => this.closeAssetDetail());
    head.createSpan({ cls: "db-led-subhead-title", text: acct.name });

    const body = host.createDiv({ cls: "db-led-body" });

    /* 余额卡：当前余额 + 本月转入转出小字 + 「调整余额」入口 */
    const monthRecs = this.store.records.filter(r =>
      (r.accountId === acct.id || r.toAccountId === acct.id) && r.date.slice(0, 7) === this.month);
    let inSum = 0;
    let outSum = 0;
    monthRecs.forEach(r => {
      const v = actualAmount(r);
      if (r.kind === "transfer") {
        if (r.toAccountId === acct.id) inSum += v;
        else if (r.accountId === acct.id) outSum += v;
      } else if (r.kind === "income") inSum += v;
      else outSum += v;
    });
    const hero = this.card(body, "");
    hero.addClass("db-led-asset-hero");
    const heroRow = hero.createDiv({ cls: "db-led-asset-hero-row" });
    heroRow.createDiv({
      cls: "db-led-asset-balance",
      text: `${symbolOf(acct.currency)}${fmtMoney(this.accountBalanceAt(acct.id, ""))}`,
    });
    const editBtn = heroRow.createEl("button", {
      cls: "db-led-btn-ghost", attr: { type: "button", "aria-label": "调整余额" },
    });
    setIcon(editBtn.createSpan({ cls: "db-cat-upload-icon" }), "pencil");
    editBtn.createSpan({ text: "调整余额" });
    editBtn.addEventListener("click", () => new AssetBalanceModal(this.app, {
      store: this.store,
      account: acct,
      current: this.accountBalanceAt(acct.id, ""),
      save: () => this.saveCfg(),
      onDone: () => this.render(),
    }).open());
    hero.createDiv({
      cls: `db-led-asset-hero-sub${monthRecs.length ? "" : " is-empty"}`,
      text: monthRecs.length
        ? `${this.month.replace("-", "年")}月　转入 ${fmtMoney(round2(inSum))} · 转出 ${fmtMoney(round2(outSum))}`
        : `${this.month.replace("-", "年")}月暂无流水`,
    });

    /* 视图切换：流水（全部历史）/ 统计（走势 + 两张环形图） */
    const seg = body.createDiv({ cls: "db-led-seg is-tabs" });
    ([{ key: "flow" as const, label: "流水" }, { key: "stats" as const, label: "统计" }]).forEach(v => {
      const b = seg.createDiv({
        cls: `db-led-seg-btn${this.assetView === v.key ? " is-active" : ""}`, text: v.label,
      });
      b.addEventListener("click", () => {
        if (this.assetView === v.key) return;
        this.assetView = v.key;
        this.render();
      });
    });

    if (this.assetView === "flow") this.renderAssetFlow(body, acct);
    else this.renderAssetStats(body, acct);
  }

  /** 流水视图：该账户的全部历史，按天分组（点一条进记录编辑页） */
  private renderAssetFlow(body: HTMLElement, acct: LedgerAccount): void {
    const recs = this.store.records
      .filter(r => r.accountId === acct.id || r.toAccountId === acct.id)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    if (!recs.length) {
      body.createDiv({ cls: "db-led-empty", text: "该账户还没有流水记录。" });
      return;
    }
    this.renderDayGroups(body, recs);
  }

  /** 统计视图：所选月份的每日余额走势 + 本月转入 / 转出环形 + 本月支出分类环形（顶部月份导航切换） */
  private renderAssetStats(body: HTMLElement, acct: LedgerAccount): void {
    this.renderMonthNav(body, ym =>
      this.store.records.some(r => (r.accountId === acct.id || r.toAccountId === acct.id) && r.date.slice(0, 7) === ym));

    /* 1) 资产走势：所选月份内每一天的收盘余额（左右箭头切月） */
    const trendCard = this.card(body, "资产走势");
    this.renderDailyBalanceChart(trendCard, acct, this.month);

    /* 本月流水（转入 / 转出与分类图共用） */
    const recs = this.store.records.filter(r =>
      (r.accountId === acct.id || r.toAccountId === acct.id) && r.date.slice(0, 7) === this.month);
    let moneyIn = 0;
    let moneyOut = 0;
    let inCount = 0;
    let outCount = 0;
    recs.forEach(r => {
      const v = actualAmount(r);
      if (r.kind === "transfer") {
        if (r.toAccountId === acct.id) { moneyIn += v; inCount++; }
        else if (r.accountId === acct.id) { moneyOut += v; outCount++; }
      } else if (r.kind === "income") { moneyIn += v; inCount++; }
      else { moneyOut += v; outCount++; }
    });
    moneyIn = round2(moneyIn);
    moneyOut = round2(moneyOut);

    /* 2) 转入 / 转出环形（按月）：颜色按语义固定，不随大小换位 */
    const total = round2(moneyIn + moneyOut);
    const ioSlices: Slice[] = [];
    if (moneyIn > 0) {
      ioSlices.push({ label: "转入", total: moneyIn, count: inCount, frac: total > 0 ? moneyIn / total : 0, color: INCOME_COLORS[0] });
    }
    if (moneyOut > 0) {
      ioSlices.push({ label: "转出", total: moneyOut, count: outCount, frac: total > 0 ? moneyOut / total : 0, color: EXPENSE_COLORS[0] });
    }
    const ioCard = this.card(body, `${this.month.replace("-", "年")}月 转入 / 转出`);
    ioCard.addClass("db-led-rpt-card");
    const ioTop = ioCard.createDiv({ cls: "db-led-rpt-top" });
    this.reportDonut(ioTop.createDiv({ cls: "db-led-rpt-donut" }), ioSlices, "净流入", fmtMoney(round2(moneyIn - moneyOut)));
    const ioLegend = ioTop.createDiv({ cls: "db-led-rpt-legend" });
    if (!ioSlices.length) ioLegend.createDiv({ cls: "db-led-rpt-legend-empty", text: "本月暂无流水" });
    ioSlices.forEach(s => {
      const lrow = ioLegend.createDiv({ cls: "db-led-rpt-lg-row" });
      lrow.createSpan({ cls: "db-led-rpt-lg-dot" }).style.background = s.color;
      lrow.createSpan({ cls: "db-led-rpt-lg-name", text: s.label });
      lrow.createSpan({ cls: "db-led-rpt-lg-val", text: fmtMoney(s.total) });
      lrow.createSpan({ cls: "db-led-rpt-lg-pct", text: `${s.count}笔` });
    });

    /* 3) 支出分类环形（按月，仅该账户的支出） */
    const groups = new Map<string, number>();
    let expTotal = 0;
    recs.filter(r => r.kind === "expense").forEach(r => {
      const key = this.catOf(r.categoryId)?.name ?? "未分类";
      groups.set(key, round2((groups.get(key) || 0) + baseAmount(r, this.cfg)));
      expTotal += baseAmount(r, this.cfg);
    });
    const catCard = this.card(body, `${this.month.replace("-", "年")}月 支出分类`);
    catCard.addClass("db-led-rpt-card");
    const catTop = catCard.createDiv({ cls: "db-led-rpt-top" });
    const catSlices = toSlices([...groups].map(([label, t]) => ({ label, total: t })), EXPENSE_COLORS, REPORT_SLICES);
    this.reportDonut(catTop.createDiv({ cls: "db-led-rpt-donut" }), catSlices, "支出", fmtMoney(round2(expTotal)));
    const catLegend = catTop.createDiv({ cls: "db-led-rpt-legend" });
    if (!catSlices.length) catLegend.createDiv({ cls: "db-led-rpt-legend-empty", text: "本月暂无支出" });
    catSlices.forEach(s => {
      const lrow = catLegend.createDiv({ cls: "db-led-rpt-lg-row" });
      lrow.createSpan({ cls: "db-led-rpt-lg-dot" }).style.background = s.color;
      lrow.createSpan({ cls: "db-led-rpt-lg-name", text: s.label });
      lrow.createSpan({ cls: "db-led-rpt-lg-val", text: fmtMoney(s.total) });
      lrow.createSpan({ cls: "db-led-rpt-lg-pct", text: pctText(s.frac) });
    });
  }

  /**
   * 每日余额曲线：所选月份内 1 号到月末，每一天的收盘余额（含当日及之前的全部流水）。
   * 本月尚未过完的日子余额自然持平（没有未来流水），曲线到月末一路走平。
   * 走 reportTrend 的同一套图表 CSS，横轴只标 1 / 5 / 10 … / 月末，31 天全标会叠字。
   */
  private renderDailyBalanceChart(card: HTMLElement, acct: LedgerAccount, ym: string): void {
    const days = moment(`${ym}-01`).daysInMonth();
    const values: number[] = [];
    for (let d = 1; d <= days; d++) values.push(this.accountBalanceAt(acct.id, `${ym}-${pad2(d)}`));

    const head = card.createDiv({ cls: "db-led-rpt-chart-head" });
    head.createSpan({ cls: "db-led-rpt-chart-title", text: "每日余额" });
    head.createSpan({
      cls: "db-led-rpt-chart-sub",
      text: `${ym.replace("-", "年")}月 · 月初 ${fmtMoney(values[0])} → 月末 ${fmtMoney(values[values.length - 1])}`,
    });

    const chart = card.createDiv({ cls: "db-led-rpt-chart is-in" });
    const W = Math.max(240, Math.round(chart.clientWidth) || 320);
    const H = 150;
    const padT = 24;
    const right = 12;
    const box: Box = { x: 12, y: padT, w: W - 12 - right, h: H - padT - 26 };
    /* 余额曲线不强制 0 基线：按当月波动范围自适应，波动太小时也给足可视高度避免一条直线贴边 */
    const vMax = Math.max(...values);
    const vMin = Math.min(...values);
    const span = Math.max(vMax - vMin, Math.abs(vMax) * 0.02, 1);
    const hi = vMax + span * 0.1;
    const lo = vMin - span * 0.1;
    const pts = seriesPoints(values, box, hi, lo);

    const svg = this.svg(chart, "svg", {
      viewBox: `0 0 ${W} ${H}`, class: "db-led-rpt-svg", preserveAspectRatio: "xMidYMid meet",
    });
    const area = smoothAreaPath(pts, box.y + box.h);
    if (area) this.svg(svg, "path", { d: area, class: "db-led-rpt-area is-in" });
    const line = smoothPath(pts);
    if (line) this.svg(svg, "path", { d: line, class: "db-led-rpt-line is-in" });
    /* 数值标在 1 / 5 / 10 … / 月末这几天的点上（31 天全标必重叠），其余点只画点 */
    pts.forEach((p, i) => {
      const d = i + 1;
      const labeled = d === 1 || d === days || d % 5 === 0;
      this.svg(svg, "circle", {
        cx: p.x, cy: p.y, r: labeled ? 2.6 : 2,
        class: `db-led-rpt-pt${values[i] < 0 ? " is-neg" : ""}`,
      });
      if (!labeled) return;
      const t = this.svg(svg, "text", {
        x: Math.min(W - 14, Math.max(14, p.x)),
        y: Math.max(11, p.y - 7),
        class: "db-led-rpt-vtxt",
      });
      t.textContent = compactMoney(values[i]);
    });
    values.forEach((_, i) => {
      const d = i + 1;
      const t = this.svg(svg, "text", { x: pts[i] ? pts[i].x : 0, y: H - 6, class: "db-led-rpt-axis" });
      t.textContent = d === 1 || d === days || d % 5 === 0 ? String(d) : "";
    });
    const foot = chart.createDiv({ cls: "db-led-rpt-chart-foot" });
    foot.setText(`${ym.replace("-", "年")}月每日收盘余额；用上方箭头切换月份。`);
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
   * 支出卡（环形图 + 明细）、收入卡（同结构）、逐月收支双线面积图、收支对比横向柱、月收支差面积图。
   * 支出 / 收入不再各配一张走势图：两张图合并成一张双线图，省下一整块高度。
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
    this.renderMonthNav(body, ym => this.store.monthRecords(ym).length > 0);
    body.createDiv({ cls: "db-led-group-hint", text: "点环形图看分类明细，点逐月收支图看支出 / 收入明细。" });

    const months = this.reportMonths();
    const recs = this.store.monthRecords(this.month);
    (["expense", "income"] as LedgerKind[]).forEach(kind => this.reportSplitCard(body, kind, recs));
    this.reportFlowCard(body, months);
    this.reportCompareCard(body, recs);
    this.reportDiffCard(body, months);
  }

  /**
   * 月份切换条（视图页与报表页共用，切月走 stepMonth）。
   * hasData：传入时对「选中的这个月没有数据」降淡显示月份名，一眼区分有账 / 没账的月份。
   */
  private renderMonthNav(parent: HTMLElement, hasData?: (ym: string) => boolean): void {
    const nav = parent.createDiv({ cls: "db-led-monthnav" });
    const prev = nav.createEl("button", { cls: "db-led-nav-btn", attr: { type: "button", "aria-label": "上一月" } });
    setIcon(prev, "chevron-left");
    prev.addEventListener("click", () => this.stepMonth(-1));
    nav.createSpan({
      cls: `db-led-nav-label${hasData && !hasData(this.month) ? " is-empty" : ""}`,
      text: `${this.month.replace("-", "年")}月`,
    });
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

  /** 支出 / 收入卡：环形图 + 右侧明细（逐月走势统一放到下面的「逐月收支」双线图） */
  private reportSplitCard(body: HTMLElement, kind: LedgerKind, recs: LedgerRecord[]): void {
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

  /**
   * 逐月收支双线面积图：收入 / 支出共用一条 0 基线、一套纵轴刻度，
   * 一眼看出两条曲线的量级与走势；点图弹菜单挑方向进各自的逐月明细。
   */
  private reportFlowCard(body: HTMLElement, months: string[]): void {
    const card = this.card(body, "逐月收支");
    card.addClass("db-led-rpt-card db-led-rpt-flow");
    const outVals = months.map(ym => this.reportMonthTotal(ym, "expense"));
    const inVals = months.map(ym => this.reportMonthTotal(ym, "income"));
    const hasData = outVals.some(v => v !== 0) || inVals.some(v => v !== 0);

    const head = card.createDiv({ cls: "db-led-rpt-chart-head" });
    head.createSpan({ cls: "db-led-rpt-chart-title", text: "收支走势" });
    const key = head.createSpan({ cls: "db-led-rpt-chart-sub db-led-rpt-flow-key" });
    (["out", "in"] as const).forEach(tone => {
      const item = key.createSpan({ cls: "db-led-rpt-flow-key-item" });
      item.createSpan({ cls: `db-led-rpt-lg-dot is-${tone}` });
      item.createSpan({ text: tone === "out" ? "支出" : "收入" });
    });
    if (!hasData) key.createSpan({ text: "暂无数据" });

    const chart = card.createDiv({ cls: "db-led-rpt-chart is-flow" });
    const W = Math.max(240, Math.round(chart.clientWidth) || 320);
    const H = 164;
    const padT = 26;          // 顶部留出点上的数值标注
    const gutter = 12;
    const right = 12;
    const box: Box = { x: gutter, y: padT, w: W - gutter - right, h: H - padT - 24 };
    const hi = niceCeil(Math.max(0, ...outVals, ...inVals));
    const outPts = seriesPoints(outVals, box, hi, 0);
    const inPts = seriesPoints(inVals, box, hi, 0);
    const baseY = box.y + box.h;

    const svg = this.svg(chart, "svg", {
      viewBox: `0 0 ${W} ${H}`, class: "db-led-rpt-svg", preserveAspectRatio: "xMidYMid meet",
    });

    // 三条等分参考线 + 0 基线：两条曲线共用刻度，靠参考线读量级
    if (hasData) {
      [0.25, 0.5, 0.75].forEach(frac => {
        const y = baseY - box.h * frac;
        this.svg(svg, "line", { x1: box.x, y1: y, x2: W - right, y2: y, class: "db-led-rpt-grid" });
      });
      this.svg(svg, "line", { x1: box.x, y1: baseY, x2: W - right, y2: baseY, class: "db-led-rpt-zero" });
    }

    // 面积先画（收入在下、支出在上，交叠处自然混色），曲线后画保证清晰
    const outArea = smoothAreaPath(outPts, baseY);
    const inArea = smoothAreaPath(inPts, baseY);
    if (inArea) this.svg(svg, "path", { d: inArea, class: "db-led-rpt-area is-in" });
    if (outArea) this.svg(svg, "path", { d: outArea, class: "db-led-rpt-area is-out" });
    const inLine = smoothPath(inPts);
    const outLine = smoothPath(outPts);
    if (inLine) this.svg(svg, "path", { d: inLine, class: "db-led-rpt-line is-in" });
    if (outLine) this.svg(svg, "path", { d: outLine, class: "db-led-rpt-line is-out" });

    // 数值标注：两条线太近时，高的标在上、低的标在下，避免叠字
    const label = (p: { x: number; y: number }, v: number, tone: "out" | "in", below: boolean) => {
      const y = below ? Math.min(H - 21, p.y + 12) : Math.max(11, p.y - 7);
      const t = this.svg(svg, "text", {
        x: Math.min(W - 18, Math.max(18, p.x)), y, class: `db-led-rpt-vtxt is-${tone}`,
      });
      t.textContent = compactMoney(v);
    };
    if (hasData) {
      months.forEach((_, i) => {
        const o = outPts[i];
        const n = inPts[i];
        this.svg(svg, "circle", { cx: o.x, cy: o.y, r: 2.6, class: "db-led-rpt-pt is-out" });
        this.svg(svg, "circle", { cx: n.x, cy: n.y, r: 2.6, class: "db-led-rpt-pt is-in" });
        if (Math.abs(o.y - n.y) < 16) {
          const outIsUpper = o.y <= n.y;
          label(outIsUpper ? o : n, outIsUpper ? outVals[i] : inVals[i], outIsUpper ? "out" : "in", false);
          label(outIsUpper ? n : o, outIsUpper ? inVals[i] : outVals[i], outIsUpper ? "in" : "out", true);
        } else {
          label(o, outVals[i], "out", false);
          label(n, inVals[i], "in", false);
        }
      });
    }
    months.forEach((ym, i) => {
      const t = this.svg(svg, "text", {
        x: outPts[i] ? outPts[i].x : 0, y: H - 6, class: "db-led-rpt-axis",
      });
      t.textContent = this.monthLabel(ym);
    });

    const avg = (vals: number[]) => round2(vals.reduce((s, v) => s + v, 0) / (vals.length || 1));
    const foot = chart.createDiv({ cls: "db-led-rpt-chart-foot" });
    foot.setText(`支出月均 ${fmtMoney(avg(outVals))} ｜ 收入月均 ${fmtMoney(avg(inVals))}，点图看明细。`);

    this.tappable(chart, "查看逐月收支明细", () => {
      const menu = new Menu();
      menu.addItem(item => {
        item.setTitle("逐月支出明细").setIcon("trending-down");
        item.onClick(() => this.openReportDrill("trend-out"));
      });
      menu.addItem(item => {
        item.setTitle("逐月收入明细").setIcon("trending-up");
        item.onClick(() => this.openReportDrill("trend-in"));
      });
      const rect = chart.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left + 12, y: rect.top + 12 });
    });
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
    scrollPageToTop(this.host);
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
    this.renderMonthNav(body, ym => this.store.monthRecords(ym).length > 0);
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
    scrollPageToTop(this.host);
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
    scrollPageToTop(this.host);
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
    choice("", guess ? `自动 · ${iconLabel(guess)}` : "自动 · 首字", guess);
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

  /**
   * 分类管理（P2 风格）：支出/收入页签 + 新增分类 + 可展开/拖拽排序的卡片。
   * 与「记一笔」右上角「编辑」共用同一个 CategoryManager 组件。
   */
  private renderCategorySection(parent: HTMLElement, refresh: () => void): void {
    void refresh;   // 管理器原地重绘自身，页面其它部分不依赖此处
    new CategoryManager(this.app, parent, {
      store: this.store,
      save: () => this.saveCfg(),
      startKind: this.catMgrKind,
      onKindChange: k => { this.catMgrKind = k; },
    }).render();
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
      new NotionSelect(row, {
        options: () => cfg.currencies.map(c => ({ value: c.code, label: `${c.code} · ${c.name}` })),
        value: a.currency,
        searchPlaceholder: "搜索币种…",
        ariaLabel: "账户币种",
        onSelect: v => void (async () => { a.currency = v; await this.saveCfg(); })(),
      });
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

  /* ────────────────────────── 记一笔 sheet / 编辑记录页 ────────────────────────── */

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

  /** 打开「记一笔」sheet（新建专用；编辑单条记录走 openRecordEditor 整页）：只创建一次浮层，之后靠 buildSheet 原地重绘，避免反复 push/back history 产生竞态 */
  private openRecordSheet(draft: Draft): void {
    this.sheetDraft = draft;
    this.mgrOpen = false;
    const overlay = this.openOverlay();
    this.sheetEl = overlay.createDiv({ cls: "db-led-sheet" });
    this.buildSheet(this.sheetEl, draft, true);
  }

  /** 关闭 sheet 浮层（回收返回键哨兵）并清空引用 */
  private closeSheet(): void {
    this.sheetEl = null;
    this.sheetDraft = null;
    this.mgrOpen = false;
    const mgrArmed = this.mgrSentinelArmed;
    this.mgrSentinelArmed = false;
    this.closeOverlay();
    if (mgrArmed) this.reclaimHistory(1);
  }

  /* ────────────────────────── 编辑单条记录（整页二级页） ────────────────────────── */

  /**
   * 点列表里的一条记录：进整页二级页编辑，不再弹 sheet——浮层悬在视口底部，
   * 移动端顶部空一截遮罩、可视面积被压掉一截；整页铺开后表单从页头排到页尾。
   * 表单本体与「记一笔」共用 buildSheet（is-embed 只去掉浮层专属的限高 / 圆角 / 动画）。
   */
  private openRecordEditor(draft: Draft): void {
    this.editRec = draft;
    this.mgrOpen = false;
    /* 高级区沿用「记一笔」的规则：记录里高级字段有值就展开，空记录收着 */
    this.sheetAdvOpen = !!(draft.refund || draft.discount || draft.reimbAmount || draft.rate || draft.address || draft.other || draft.files);
    if (Platform.isMobileApp) {
      this.editSentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-record-edit" }, "");
    }
    this.render();
    scrollPageToTop(this.host);
  }

  /** 返回列表；reclaim=false 用于 popstate 路径（哨兵已被系统消费）。改动不落库，与 sheet 的关闭一致 */
  private closeRecordEditor(reclaim = true): void {
    let back = 0;
    if (this.mgrOpen && this.mgrSentinelArmed) back++;   // 分类管理还压在编辑页上
    if (this.editSentinelArmed) back++;
    this.mgrOpen = false;
    this.mgrSentinelArmed = false;
    this.editSentinelArmed = false;
    this.editRec = null;
    this.editFormEl = null;
    this.render();
    if (reclaim) this.reclaimHistory(back);
  }

  /** 编辑页：整页表单卡（buildSheet 复用；「返回」并进表单头行，与保存 / 删除条同款显隐） */
  private renderRecordEditor(host: HTMLElement): void {
    const draft = this.editRec;
    if (!draft) return;
    const body = host.createDiv({ cls: "db-led-body" });
    const form = body.createDiv({ cls: "db-led-sheet is-embed" });
    this.editFormEl = form;
    this.buildSheet(form, draft, false);
  }

  /** 保存 / 删除成功后的收尾：整页编辑页自己会重绘，sheet 则关浮层再刷列表 */
  private dismissRecordUi(reclaim = true): void {
    if (this.editRec) { this.closeRecordEditor(reclaim); return; }
    this.closeSheet();
    this.render();
  }

  /**
   * 表单右上角「编辑」：就地切到分类管理页（P2）——记一笔 sheet 与整页编辑页共用。
   * 草稿留在原处（sheetDraft / editRec），返回时原地重建表单；返回键为此另压一枚哨兵。
   */
  private openCategoryMgr(): void {
    const draft = this.editRec ?? this.sheetDraft;
    const holder = this.editRec ? this.editFormEl : this.sheetEl;
    if (!draft || !holder) return;
    this.mgrOpen = true;
    if (Platform.isMobileApp) {
      this.mgrSentinelArmed = true;
      window.history.pushState({ daybookBack: "ledger-catmgr" }, "");
    }
    holder.empty();
    holder.addClass("is-mgr");
    new CategoryManager(this.app, holder, {
      store: this.store,
      save: () => this.saveCfg(),
      onChange: () => { /* 管理器自己会原地重绘；回到表单时整层重建 */ },
      onBack: () => this.closeCategoryMgr(),
      startKind: draft.kind === "income" ? "income" : "expense",
      startOpenId: draft.categoryId || null,
    }).render();
  }

  /**
   * 从分类管理退回表单。表单在这里同步重建——不依赖 popstate 送达（按钮返回曾经
   * 卡在管理层：back() 之后 popstate 没接上，整条链路就断了）。哨兵用 go(-1) 静默
   * 丢弃，go(-1) 引发的那次 popstate 由 popSuppress 吞掉——否则它会落进 onPop 的
   * 编辑页 / sheet 分支，把刚恢复的表单整层误关掉。
   * 安卓返回键仍走 onPop 的 mgr 分支（哨兵被系统消费），与按钮路径互不干扰。
   */
  private closeCategoryMgr(): void {
    const armed = this.mgrSentinelArmed;
    this.mgrSentinelArmed = false;
    this.mgrOpen = false;
    if (this.editRec) {
      this.render();
    } else {
      const sheet = this.sheetEl;
      if (!sheet || !this.sheetDraft) { this.closeOverlay(); return; } // closeOverlay 自回收 sheet 哨兵
      this.buildSheet(sheet, this.sheetDraft, false);
      this.render();
    }
    if (armed && Platform.isMobileApp) {
      this.popSuppress = true;
      window.history.go(-1);
    }
  }

  /** 原地重绘 sheet 内容。chip 点击只改 draft 后调用本方法，不触碰 overlay / history。 */
  private buildSheet(sheet: HTMLElement, draft: Draft, isInitial: boolean): void {
    const cfg = this.cfg;
    const isNew = !draft.id;
    // 分类可能刚在管理页被删/二级被删：清掉草稿里的失效引用
    const draftCat = draft.categoryId ? cfg.categories.find(c => c.id === draft.categoryId) : undefined;
    if (draft.categoryId && !draftCat) { draft.categoryId = ""; draft.subId = ""; }
    else if (draftCat && draft.subId && !draftCat.subs.find(s => s.id === draft.subId)) draft.subId = "";
    sheet.empty();
    sheet.removeClass("is-mgr");

    /* 头部：整页编辑页 = 返回 + 收支切换（P1 顶栏样式：文字 + 下划线）+ 编辑分类；
       记一笔浮层 = 关闭 + 同款。返回与底部保存 / 删除条共用「有光标就收」的显隐 */
    const head = sheet.createDiv({ cls: "db-led-sheet-head" });
    let backEl: HTMLElement | null = null;
    if (this.editRec) {
      backEl = head.createEl("button", { cls: "db-led-back", attr: { type: "button", "aria-label": "返回列表" } });
      setIcon(backEl.createSpan({ cls: "db-led-back-icon" }), "chevron-left");
      backEl.createSpan({ text: "返回" });
      backEl.addEventListener("click", () => this.closeRecordEditor());
    } else {
      const close = head.createDiv({ cls: "db-led-sheet-close", attr: { role: "button", tabindex: "0", "aria-label": "关闭" } });
      setIcon(close, "x");
      close.addEventListener("click", () => this.closeSheet());
      close.addEventListener("keydown", e => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); this.closeSheet(); }
      });
    }
    const tabs = head.createDiv({ cls: "db-led-ktabs" });
    const mkTab = (label: string, kind: LedgerKind) => {
      const pick = () => {
        if (draft.kind === kind) return;
        draft.kind = kind;
        draft.categoryId = "";
        draft.subId = "";
        if (kind === "transfer" && (!draft.toAccountId || draft.toAccountId === draft.accountId)) {
          draft.toAccountId = cfg.accounts.find(a => !a.archived && a.id !== draft.accountId)?.id ?? "";
        }
        this.buildSheet(sheet, draft, false);
      };
      activatable(tabs.createDiv({
        cls: `db-led-ktab ${this.kindClass(kind)}${draft.kind === kind ? " is-active" : ""}`,
        text: label,
      }), label).addEventListener("click", pick);
    };
    mkTab("支出", "expense");
    mkTab("收入", "income");
    mkTab("转账", "transfer");
    const editBtn = head.createEl("button", { cls: "db-led-sheet-edit", attr: { type: "button", "aria-label": "编辑分类" } });
    editBtn.setText("编辑");
    editBtn.addEventListener("click", () => this.openCategoryMgr());

    const body = sheet.createDiv({ cls: "db-led-sheet-body" });
    const isTr = draft.kind === "transfer";

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

    /* 类别宫格（P1：圆图标 + 文字，有二级的带「···」角标；转账无类别）。
       点按 = 选中分类；长按 = 编辑该分类（一级 / 二级同一套弹窗，含删除迁移） */
    if (!isTr) {
      body.createDiv({ cls: "db-led-field-label", text: "类别" });
      const cats = cfg.categories.filter(c => c.kind === draft.kind);
      const COLS = 5;                     // 与 .db-led-catgrid 的列数保持一致，子类面板按行插入
      const grid = body.createDiv({ cls: "db-led-catgrid" });
      cats.forEach(c => {
        const cell = activatable(grid.createDiv({ cls: `db-led-catcell${draft.categoryId === c.id ? " is-active" : ""}` }), c.name);
        const circle = cell.createDiv({ cls: "db-led-catcircle" });
        renderCategoryIcon(circle, c.icon || guessCategoryIcon(c.name), c.name);
        if (c.subs.length) circle.createDiv({ cls: "db-led-catdot", text: "···" });
        cell.createDiv({ cls: "db-led-catname", text: c.name });
        /* 长按 = 编辑该分类（改名 / 图标 / 删除），与分类管理同一套弹窗；要先于 click 注册才能拦住误触 */
        longPress(cell, () => editCategoryDialogs(this.app, {
          store: this.store,
          save: () => this.saveCfg(),
          cat: c,
          onDone: () => this.buildSheet(sheet, draft, false),
        }));
        cell.addEventListener("click", () => {
          const on = draft.categoryId !== c.id;
          draft.categoryId = on ? c.id : "";
          if (!on) draft.subId = "";
          else if (draft.subId && !c.subs.find(s => s.id === draft.subId)) draft.subId = "";
          this.buildSheet(sheet, draft, false);
        });
      });

      /* 末尾「新增」= 新增大类（选完图标起名后直接选中） */
      const addCell = activatable(grid.createDiv({ cls: "db-led-catcell is-add" }), "新增分类");
      setIcon(addCell.createDiv({ cls: "db-led-catcircle" }), "plus");
      addCell.createDiv({ cls: "db-led-catname", text: "新增" });
      addCell.addEventListener("click", () => {
        new CategoryEditModal(this.app, {
          title: "新增分类",
          name: "",
          icon: "",
          kind: draft.kind === "income" ? "income" : "expense",
          canDelete: false,
          onSave: (name, icon) => void (async () => {
            const created: LedgerCategory = { id: uid(), name, icon, kind: draft.kind, subs: [] };
            cfg.categories.push(created);
            await this.saveCfg();
            draft.categoryId = created.id;
            draft.subId = "";
            this.buildSheet(sheet, draft, false);
          })(),
        }).open();
      });

      /* 子类面板：插到选中格所在行的行尾（固定 5 列跨整行），可选子类、可新增子类 */
      const selCat = cats.find(c => c.id === draft.categoryId);
      if (selCat && selCat.subs.length) {
        const panel = grid.createDiv({ cls: "db-led-catpanel" });
        const selIdx = cats.indexOf(selCat);
        const rowEnd = Math.min(grid.children.length - 1, (Math.floor(selIdx / COLS) + 1) * COLS - 1);
        grid.insertBefore(panel, grid.children[rowEnd + 1] ?? null);
        selCat.subs.forEach(s => {
          const cell = activatable(
            panel.createDiv({ cls: `db-led-catcell is-sub${draft.subId === s.id ? " is-active" : ""}` }),
            `${selCat.name} · ${s.name}`,
          );
          const circle = cell.createDiv({ cls: "db-led-catcircle" });
          renderCategoryIcon(circle, s.icon || guessCategoryIcon(s.name), s.name);
          cell.createDiv({ cls: "db-led-catname", text: s.name });
          /* 长按 = 编辑二级分类（改名 / 图标 / 删除） */
          longPress(cell, () => editCategoryDialogs(this.app, {
            store: this.store,
            save: () => this.saveCfg(),
            cat: selCat,
            sub: s,
            onDone: () => this.buildSheet(sheet, draft, false),
          }));
          cell.addEventListener("click", () => {
            draft.subId = draft.subId === s.id ? "" : s.id;
            this.buildSheet(sheet, draft, false);
          });
        });
        const addSub = activatable(panel.createDiv({ cls: "db-led-catcell is-add is-sub" }), "新增二级分类");
        setIcon(addSub.createDiv({ cls: "db-led-catcircle" }), "plus");
        addSub.createDiv({ cls: "db-led-catname", text: "新增" });
        addSub.addEventListener("click", () => {
          new CategoryEditModal(this.app, {
            title: `「${selCat.name}」新增二级分类`,
            name: "",
            icon: "",
            kind: selCat.kind === "income" ? "income" : "expense",
            canDelete: false,
            onSave: (name, icon) => void (async () => {
              const sub = { id: uid(), name, icon };
              selCat.subs.push(sub);
              await this.saveCfg();
              draft.categoryId = selCat.id;
              draft.subId = sub.id;
              this.buildSheet(sheet, draft, false);
            })(),
          }).open();
        });
      }
    }

    /* 账户 / 转入账户 / 账本（Notion 风格可搜索下拉） */
    const two = body.createDiv({ cls: "db-led-two" });
    const activeAccts = cfg.accounts.filter(a => !a.archived);
    const f1 = two.createDiv({ cls: "db-led-field" });
    f1.createDiv({ cls: "db-led-field-label", text: isTr ? "转出账户" : "账户" });
    new NotionSelect(f1, {
      options: () => cfg.accounts.filter(a => !a.archived).map(a => ({ value: a.id, label: a.name })),
      value: draft.accountId,
      placeholder: "请选择",
      searchPlaceholder: "搜索账户…",
      ariaLabel: isTr ? "转出账户" : "账户",
      onSelect: v => { draft.accountId = v; },
    });
    if (isTr) {
      const f3 = two.createDiv({ cls: "db-led-field" });
      f3.createDiv({ cls: "db-led-field-label", text: "转入账户" });
      new NotionSelect(f3, {
        options: [{ value: "", label: "请选择" }, ...activeAccts.map(a => ({ value: a.id, label: a.name }))],
        value: draft.toAccountId,
        placeholder: "请选择",
        searchPlaceholder: "搜索账户…",
        ariaLabel: "转入账户",
        onSelect: v => { draft.toAccountId = v; },
      });
    }
    const f2 = two.createDiv({ cls: "db-led-field" });
    f2.createDiv({ cls: "db-led-field-label", text: "账本" });
    new NotionSelect(f2, {
      options: () => cfg.ledgers.map(l => ({ value: l.id, label: l.name })),
      value: draft.ledgerId,
      placeholder: "请选择",
      searchPlaceholder: "搜索账本…",
      ariaLabel: "账本",
      allowCreate: true,
      onSelect: v => { draft.ledgerId = v; },
      onCreate: name => {
        const ledger = { id: uid(), name };
        cfg.ledgers.push(ledger);
        void this.saveCfg();
        return { value: ledger.id, label: ledger.name };
      },
    });

    /* 备注 / 标签 */
    const note = body.createEl("textarea", { cls: "db-led-textarea", attr: { placeholder: "备注", rows: "2", "aria-label": "备注" } });
    note.value = draft.note;
    note.addEventListener("input", () => { draft.note = note.value; });
    /* 标签：Notion 多选（彩色 chip，搜索历史标签或现场新建） */
    new NotionMultiSelect(body, {
      options: () => this.store.allTags(),
      values: draft.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
      placeholder: "添加标签",
      searchPlaceholder: "搜索标签…",
      allowCreate: true,
      ariaLabel: "标签",
      onChange: vs => { draft.tags = vs.join(","); },
      onCreate: q => q.replace(/[,，#]/g, "").trim(),
    });

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
      new NotionSelect(fr, {
        options: [{ value: "", label: "不报销" }, ...activeAccts.map(a => ({ value: a.id, label: a.name }))],
        value: draft.reimbAccountId,
        placeholder: "不报销",
        searchPlaceholder: "搜索账户…",
        ariaLabel: "报销账户",
        onSelect: v => { draft.reimbAccountId = v; },
      });
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
    /* 光标在输入框里时收起顶部「返回」与底部保存 / 删除条：移动端键盘顶上来，
       它们悬在键盘上方白占一截。收起延迟 ~150ms：点保存 / 删除的 mousedown 会先触发
       blur，立刻隐藏会吞掉跟发的 click；blur 落到另一个输入框（只是换字段）也不收，
       由 focusin 取消计时。监听挂在 body 上：buildSheet 原地重绘会换新 body，
       旧监听随旧节点一起丢弃。 */
    let footHideTimer: number | null = null;
    const isField = (node: EventTarget | null): node is HTMLElement => {
      const el = node as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true);
    };
    const setEditingHidden = (hidden: boolean) => {
      if (footHideTimer !== null) { activeWindow.clearTimeout(footHideTimer); footHideTimer = null; }
      const apply = (hidden: boolean) => {
        foot.toggleClass("is-inputting", hidden);
        backEl?.toggleClass("is-inputting", hidden);
      };
      if (!hidden) { apply(false); return; }
      footHideTimer = activeWindow.setTimeout(() => {
        footHideTimer = null;
        if (foot.isConnected) apply(true);
      }, 150);
    };
    body.addEventListener("focusin", (e: FocusEvent) => {
      if (isField(e.target)) setEditingHidden(true);
    });
    body.addEventListener("focusout", (e: FocusEvent) => {
      if (isField(e.relatedTarget)) return; // 光标只是在字段间移动
      setEditingHidden(false);
    });
    if (!isNew) {
      const del = foot.createEl("button", { cls: "db-led-del-big", attr: { type: "button" }, text: "删除" });
      del.addEventListener("click", () => {
        new ConfirmModal(this.app, "删除记录", "确定删除这笔记录吗？", "删除", () => {
          void (async () => { await this.store.deleteRecord(draft.id!); this.dismissRecordUi(); })();
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
          this.dismissRecordUi();
        } catch (e) {
          new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    });
    if (isInitial) amount.focus();
  }
}
