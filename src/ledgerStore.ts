/**
 * ledgerStore.ts — 记账（ledger）类型的数据层
 *
 * 存储：<日记目录>/ledger/config.json（账本/账户/两级类别/币种/用户名）
 *       <日记目录>/ledger/records-YYYY.json（每年一个 JSON 数组文件）
 *
 * 金额口径（在页内「设置」也会向用户说明）：
 *   支出实际支出 = 金额 − 优惠 − 退款（不小于 0）；收入实际 = 金额；
 *   转账（transfer）不计收支，只在转出/转入账户间移动余额（toAccountId 为转入账户）。
 *   多币种：记录带 currency + 可选 rate（折算 1 单位该币种 = 多少基准币），
 *   未写 rate 时取币种表当前 rate；基准币 rate 恒为 1。
 */
import { App, normalizePath } from "obsidian";
import type { DaybookSettings } from "./settings";

export type LedgerKind = "income" | "expense" | "transfer";

export interface LedgerRecord {
  id: string;
  date: string;              // YYYY-MM-DD（日期）
  kind: LedgerKind;          // 收支类型
  amount: number;            // 金额（原始币种，交易原价）
  categoryId: string;        // 类别
  subId?: string;            // 二级分类
  accountId: string;         // 账户（转账时为转出账户）
  toAccountId?: string;      // 转入账户（仅转账）
  ledgerId: string;          // 账本
  refund: number;            // 退款
  discount: number;          // 优惠
  note: string;              // 备注
  tags: string[];            // 标签
  reimbAccountId?: string;   // 报销账户（垫付归属）
  reimbAmount?: number;      // 报销金额
  reimbDetail?: string;      // 报销明细
  currency: string;          // 币种代码（多币种）
  rate?: number;             // 折算率快照（缺省用币种表当前值）
  address: string;           // 地址
  creator: string;           // 创建用户
  other: string;             // 其他
  files: string[];           // 附件（wiki 链接/路径）
  createdAt: number;
  clock?: string;            // HH:mm（批量导入时保留原账单里的时间，用于同日排序与展示）
  importBatchId?: string;    // 属于哪一次「批量导入」，可在导入记录里整批撤销
}

/** 一次批量导入的台账（存 <日记目录>/ledger/imports.json，用于展示与整批撤销） */
export interface LedgerImportBatch {
  id: string;
  at: number;                    // 导入时间戳
  file: string;                  // 来源文件名
  source: string;                // 模板标签，如「一木记账」
  ledgerId: string;              // 落到的账本
  count: number;                 // 本次写入的记录条数
  createdCategories: string[];   // 本次新建的类别名（展示用）
  createdAccounts: string[];     // 本次新建的账户名
  undoneAt?: number;             // 撤销时间（记录已删除，台账保留）
}

export interface LedgerAccount {
  id: string;
  name: string;
  currency: string;          // 账户币种
  opening: number;           // 期初余额
  archived?: boolean;
  icon?: string;             // 图标 key（见 accountIcons）；空 = 按账户名自动匹配
}

export interface LedgerCategory {
  id: string;
  name: string;
  kind: LedgerKind;
  subs: { id: string; name: string }[];
  icon?: string;             // 图标 key（见 categoryIcons）；空 = 按分类名自动匹配
}

export interface LedgerCurrency {
  code: string;              // 如 CNY / USD
  name: string;
  rate: number;              // 1 该币种 = rate 基准币
}

export interface LedgerConfig {
  ledgers: { id: string; name: string }[];
  accounts: LedgerAccount[];
  categories: LedgerCategory[];
  currencies: LedgerCurrency[];
  baseCurrency: string;
  username: string;
}

export function defaultLedgerConfig(): LedgerConfig {
  const uid = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  return {
    ledgers: [{ id: uid(), name: "日常账本" }],
    accounts: [
      { id: uid(), name: "现金", currency: "CNY", opening: 0 },
      { id: uid(), name: "支付宝", currency: "CNY", opening: 0 },
      { id: uid(), name: "微信", currency: "CNY", opening: 0 },
      { id: uid(), name: "银行卡", currency: "CNY", opening: 0 },
      { id: uid(), name: "信用卡", currency: "CNY", opening: 0 },
    ],
    categories: [
      { id: uid(), name: "餐饮", kind: "expense", subs: [{ id: uid(), name: "早餐" }, { id: uid(), name: "午餐" }, { id: uid(), name: "晚餐" }, { id: uid(), name: "饮品" }] },
      { id: uid(), name: "交通", kind: "expense", subs: [{ id: uid(), name: "通勤" }, { id: uid(), name: "打车" }] },
      { id: uid(), name: "购物", kind: "expense", subs: [{ id: uid(), name: "日用" }, { id: uid(), name: "服饰" }] },
      { id: uid(), name: "居住", kind: "expense", subs: [{ id: uid(), name: "房租" }, { id: uid(), name: "水电" }] },
      { id: uid(), name: "娱乐", kind: "expense", subs: [] },
      { id: uid(), name: "医疗", kind: "expense", subs: [] },
      { id: uid(), name: "工资", kind: "income", subs: [] },
      { id: uid(), name: "奖金", kind: "income", subs: [] },
      { id: uid(), name: "副业", kind: "income", subs: [] },
      { id: uid(), name: "报销", kind: "income", subs: [] },
    ],
    currencies: [{ code: "CNY", name: "人民币", rate: 1 }],
    baseCurrency: "CNY",
    username: "",
  };
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function makeRecordId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 一条记录在“实际现金流”口径下的金额（原始币种） */
export function actualAmount(r: LedgerRecord): number {
  if (r.kind === "expense") return round2(Math.max(0, r.amount - (r.discount || 0) - (r.refund || 0)));
  return round2(r.amount);
}

/** 折算到基准币 */
export function baseAmount(r: LedgerRecord, cfg: LedgerConfig): number {
  const cur = r.currency || cfg.baseCurrency;
  if (cur === cfg.baseCurrency) return actualAmount(r);
  const rate = r.rate ?? cfg.currencies.find(c => c.code === cur)?.rate ?? 1;
  return round2(actualAmount(r) * rate);
}

export function fmtMoney(n: number): string {
  const s = Math.abs(n) >= 10000
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toFixed(2);
  return s;
}

export interface MonthSummary {
  expense: number;
  income: number;
  net: number;
  count: number;
}

export function summarize(records: LedgerRecord[], cfg: LedgerConfig): MonthSummary {
  let expense = 0, income = 0;
  for (const r of records) {
    if (r.kind === "transfer") continue;
    const v = baseAmount(r, cfg);
    if (r.kind === "expense") expense += v; else income += v;
  }
  return { expense: round2(expense), income: round2(income), net: round2(income - expense), count: records.length };
}

export interface CategoryStat {
  categoryId: string;
  name: string;
  total: number;
  items: LedgerRecord[];
}

export function categoryStats(records: LedgerRecord[], cfg: LedgerConfig, kind: LedgerKind): CategoryStat[] {
  const map = new Map<string, CategoryStat>();
  for (const r of records) {
    if (r.kind !== kind) continue;
    const cat = cfg.categories.find(c => c.id === r.categoryId);
    const key = r.categoryId || "_none";
    if (!map.has(key)) map.set(key, { categoryId: key, name: cat?.name ?? "未分类", total: 0, items: [] });
    const s = map.get(key)!;
    s.total += baseAmount(r, cfg);
    s.items.push(r);
  }
  return [...map.values()].map(s => ({ ...s, total: round2(s.total) })).sort((a, b) => b.total - a.total);
}

export interface AccountBalance {
  account: LedgerAccount;
  /** 按账户自身币种计的余额 */
  balance: number;
  /** 折算到基准币的余额 */
  balanceBase: number;
}

export function accountBalances(all: LedgerRecord[], cfg: LedgerConfig): AccountBalance[] {
  return cfg.accounts.filter(a => !a.archived).map(account => {
    let bal = account.opening || 0;
    for (const r of all) {
      const v = actualAmount(r);
      if (r.kind === "transfer") {
        if (r.accountId === account.id) bal -= v;
        else if (r.toAccountId === account.id) bal += v;
        continue;
      }
      if (r.accountId !== account.id) continue;
      bal += r.kind === "income" ? v : -v;
    }
    const cur = cfg.currencies.find(c => c.code === account.currency);
    const rate = account.currency === cfg.baseCurrency ? 1 : (cur?.rate ?? 1);
    return { account, balance: round2(bal), balanceBase: round2(bal * rate) };
  });
}

/** 待报销合计：所有记录了的报销金额之和 −（若用户后续用收入类别“报销”收款则不计，这里仅展示登记值） */
export function reimbTotal(all: LedgerRecord[], cfg: LedgerConfig): number {
  let t = 0;
  for (const r of all) {
    if (r.reimbAmount && r.reimbAmount > 0) t += (() => {
      const cur = r.currency || cfg.baseCurrency;
      const rate = cur === cfg.baseCurrency ? 1 : (r.rate ?? cfg.currencies.find(c => c.code === cur)?.rate ?? 1);
      return r.reimbAmount * rate;
    })();
  }
  return round2(t);
}

const yearOf = (dateStr: string) => (dateStr || "").slice(0, 4);

export class LedgerStore {
  config: LedgerConfig = defaultLedgerConfig();
  records: LedgerRecord[] = [];
  batches: LedgerImportBatch[] = [];
  private loaded = false;

  constructor(private app: App, private settings: DaybookSettings) {}

  get dir(): string {
    const folder = this.settings.diaryFolder.trim().replace(/\/$/, "");
    return normalizePath(`${folder}/ledger`);
  }

  private pathOf(file: string): string {
    return normalizePath(`${this.dir}/${file}`);
  }

  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    this.config = defaultLedgerConfig();
    this.records = [];
    this.batches = [];
    try {
      if (await adapter.exists(this.pathOf("config.json"))) {
        const raw = JSON.parse(await adapter.read(this.pathOf("config.json")));
        this.config = {
          ...defaultLedgerConfig(),
          ...raw,
          ledgers: Array.isArray(raw.ledgers) && raw.ledgers.length ? raw.ledgers : defaultLedgerConfig().ledgers,
          accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
          categories: Array.isArray(raw.categories) ? raw.categories : [],
          currencies: Array.isArray(raw.currencies) && raw.currencies.length ? raw.currencies : defaultLedgerConfig().currencies,
        };
      }
      if (await adapter.exists(this.dir)) {
        const listing = await adapter.list(this.dir);
        if (await adapter.exists(this.pathOf("imports.json"))) {
          try {
            const arr = JSON.parse(await adapter.read(this.pathOf("imports.json")));
            if (Array.isArray(arr)) this.batches = arr;
          } catch (e) { /* 坏文件按无台账处理 */ }
        }
        const files = listing.files
          .filter(f => /records-\d{4}\.json$/.test(f))
          .sort();
        for (const f of files) {
          try {
            const arr = JSON.parse(await adapter.read(f));
            if (Array.isArray(arr)) this.records.push(...arr);
          } catch (e) { /* 坏文件跳过，保存时会被重写 */ }
        }
      }
    } catch (e) {
      console.error("Daybook ledger: 读取失败", e);
    }
    this.sortRecords();
    this.loaded = true;
  }

  private sortRecords(): void {
    this.records.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }

  async saveConfig(): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.write(this.pathOf("config.json"), JSON.stringify(this.config, null, 2));
  }

  private async ensureDir(): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.dir))) {
        await this.app.vault.adapter.mkdir(this.dir);
      }
    } catch (e) { /* 已存在时忽略 */ }
  }

  /** 把某一年集合写回 records-YYYY.json */
  private async persistYear(year: string): Promise<void> {
    if (!/^\d{4}$/.test(year)) return;
    await this.ensureDir();
    const arr = this.records.filter(r => yearOf(r.date) === year);
    await this.app.vault.adapter.write(this.pathOf(`records-${year}.json`), JSON.stringify(arr, null, 2));
  }

  async addRecord(rec: LedgerRecord): Promise<void> {
    this.records.unshift(rec);
    this.sortRecords();
    await this.persistYear(yearOf(rec.date));
  }

  async updateRecord(rec: LedgerRecord): Promise<void> {
    const idx = this.records.findIndex(r => r.id === rec.id);
    if (idx < 0) return this.addRecord(rec);
    const oldYear = yearOf(this.records[idx].date);
    this.records[idx] = rec;
    this.sortRecords();
    await this.persistYear(yearOf(rec.date));
    if (oldYear !== yearOf(rec.date)) await this.persistYear(oldYear);
  }

  async deleteRecord(id: string): Promise<void> {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;
    this.records = this.records.filter(r => r.id !== id);
    await this.persistYear(yearOf(rec.date));
  }

  /**
   * 批量写入（导入用）：一次性按年份分组落盘，避免 3000 条记录重复重写同一个文件 3000 次。
   * 传入的批次台账会一并写入，任何一步失败都会把已改坏的年份重算，保证文件与内存一致。
   */
  async addRecordsBulk(recs: LedgerRecord[], batch?: LedgerImportBatch): Promise<void> {
    if (!recs.length) { if (batch) await this.saveBatches(); return; }
    const years = new Set<string>();
    recs.forEach(r => years.add(yearOf(r.date)));
    this.records = recs.concat(this.records);
    this.sortRecords();
    for (const y of years) await this.persistYear(y);
    if (batch) {
      this.batches = [batch, ...this.batches];
      await this.saveBatches();
    }
  }

  /** 撤销一次批量导入：只删这批记录，不动这次顺手新建的分类/账户（它们可能已被别的记录引用） */
  async undoBatch(id: string): Promise<number> {
    const years = new Set<string>();
    let n = 0;
    this.records = this.records.filter(r => {
      if (r.importBatchId !== id) return true;
      years.add(yearOf(r.date));
      n++;
      return false;
    });
    for (const y of years) await this.persistYear(y);
    const b = this.batches.find(x => x.id === id);
    if (b) { b.undoneAt = Date.now(); b.count = 0; await this.saveBatches(); }
    return n;
  }

  async saveBatches(): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.write(this.pathOf("imports.json"), JSON.stringify(this.batches, null, 2));
  }

  /**
   * 把某类别的全部记录转移到另一类别（删除分类时用）。
   * 二级分类属于原类别，转移后一并清掉；返回转移条数。
   */
  async retargetCategory(fromId: string, toId: string): Promise<number> {
    const years = new Set<string>();
    let n = 0;
    this.records.forEach(r => {
      if (r.categoryId !== fromId) return;
      r.categoryId = toId;
      if (r.subId) r.subId = undefined;
      years.add(yearOf(r.date));
      n++;
    });
    for (const y of years) await this.persistYear(y);
    return n;
  }

  /** 清掉引用某二级分类的记录的 subId（删除二级分类时用），记录保留在一级分类下 */
  async clearSubRecords(categoryId: string, subId: string): Promise<number> {
    const years = new Set<string>();
    let n = 0;
    this.records.forEach(r => {
      if (r.categoryId !== categoryId || r.subId !== subId) return;
      r.subId = undefined;
      years.add(yearOf(r.date));
      n++;
    });
    for (const y of years) await this.persistYear(y);
    return n;
  }

  /** 导出账单文件到 <日记目录>/ledger/export/，返回仓库内路径 */
  async writeExport(fileName: string, text: string): Promise<string> {
    const safe = fileName.replace(/[\\/:*?"<>|]/g, "_");
    const dir = normalizePath(`${this.dir}/export`);
    await this.ensureDir();
    try { if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir); } catch (e) { /* 已存在 */ }
    const path = normalizePath(`${dir}/${safe}`);
    await this.app.vault.adapter.write(path, text);
    return path;
  }

  /** 某批次的记录条数（实时值，台账里的 count 可能已被单条删除影响） */
  batchCount(id: string): number {
    return this.records.reduce((n, r) => n + (r.importBatchId === id ? 1 : 0), 0);
  }

  /** 某月（YYYY-MM）记录，可再按账本过滤 */
  monthRecords(ym: string, ledgerId?: string): LedgerRecord[] {
    return this.records.filter(r => r.date.startsWith(ym) && (!ledgerId || r.ledgerId === ledgerId));
  }

  allTags(): string[] {
    const set = new Set<string>();
    this.records.forEach(r => (r.tags || []).forEach(t => t && set.add(t)));
    return [...set];
  }

  get isLoaded(): boolean { return this.loaded; }
}
