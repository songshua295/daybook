/**
 * ledgerStore.ts — 记账（ledger）类型的数据层
 *
 * 存储（v5 起，hledger journal 纯文本，可肉眼阅读、可直接用 hledger 打开）：
 *   <ledgerFolder>/config.json          账本/账户/两级类别/币种/用户名（结构配置仍是 JSON）
 *   <ledgerFolder>/YYYY.<ext>           按年一个 journal 文件（默认 .obsidian/记账/2026.journal）
 *   <ledgerFolder>/imports.json         批量导入台账
 *   <ledgerFolder>/export/              导出账单
 *   同目录 .bak = 上一次成功写入前的副本；解析失败自动回落 .bak，仍失败则停用该年份数据并提示（绝不静默清空）
 *
 * journal 格式详见 ledgerJournal.ts 头注释。金额口径：
 *   支出实际支出 = 金额 − 优惠 − 退款（不小于 0），journal 分录里写实际金额；
 *   收入实际 = 金额；转账（transfer）不计收支，只在转出/转入账户间移动余额（toAccountId 为转入账户）。
 *   多币种：记录带 currency + 可选 rate（折算 1 单位该币种 = 多少基准币），
 *   未写 rate 时取币种表当前 rate；基准币 rate 恒为 1。
 */
import { App, Notice, normalizePath } from "obsidian";
import type { DaybookSettings } from "./settings";
import { DEFAULT_LEDGER_EXT, DEFAULT_LEDGER_FOLDER } from "./settings";
import { parseYearJournal, serializeYearJournal, makeNameResolver } from "./ledgerJournal";

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

/** 一次批量导入的台账（存 <ledgerFolder>/imports.json，用于展示与整批撤销） */
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
  /** 二级分类；icon 可为图标库 key、emoji 或 data URL，空 = 按名称自动匹配 */
  subs: { id: string; name: string; icon?: string }[];
  icon?: string;             // 图标库 key、emoji 或 data URL；空 = 按分类名自动匹配
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
  balance: number;
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

/** 旧版 journal 头行会写 kind/cat/sub/acc/to/clock 等冗余标签：检测到就整体重写一次 */
const LEGACY_TAG_RE = /^\d{4}-\d{2}-\d{2}[^\n]*;[^\n]*\b(?:kind|cat|sub|acc|to|clock):/m;

export class LedgerStore {
  config: LedgerConfig = defaultLedgerConfig();
  records: LedgerRecord[] = [];
  batches: LedgerImportBatch[] = [];
  private loaded = false;

  constructor(
    private app: App,
    private settings: DaybookSettings,
    /** 迁移完成后把 settings.ledgerMigratedV2 等旗标落盘用 */
    private persistSettings?: () => Promise<void>
  ) {}

  get dir(): string {
    const custom = (this.settings.ledgerFolder ?? "").trim().replace(/\/+$/, "");
    return normalizePath(custom || DEFAULT_LEDGER_FOLDER);
  }

  /** journal 文件后缀（不带点）；非法值回退 journal */
  get ext(): string {
    const e = (this.settings.ledgerFileExt ?? DEFAULT_LEDGER_EXT).trim().replace(/^\.+/, "");
    return /^[A-Za-z0-9]{1,8}$/.test(e) ? e : DEFAULT_LEDGER_EXT;
  }

  private pathOf(file: string): string {
    return normalizePath(`${this.dir}/${file}`);
  }

  recordsFilePath(year: string): string {
    return this.pathOf(`${year}.${this.ext}`);
  }

  /* ── 安全读写：临时文件 + 改名原子落盘，旧内容保留为 .bak，解析失败可回落 ── */

  private async ensureDir(): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.dir))) {
        await this.app.vault.adapter.mkdir(this.dir);
      }
    } catch (e) { /* 已存在时忽略 */ }
  }

  private async writeAtomic(path: string, text: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const tmp = `${path}.tmp`;
    const bak = `${path}.bak`;
    await this.ensureDir();
    await adapter.write(tmp, text);
    try { if (await adapter.exists(bak)) await adapter.remove(bak); } catch (e) { /* 清理失败不阻塞 */ }
    try { if (await adapter.exists(path)) await adapter.rename(path, bak); } catch (e) { /* 首次写入无旧文件 */ }
    await adapter.rename(tmp, path);
  }

  /** 读文件并解析：目标损坏时自动回落 .bak；两者都坏返回 null（调用方必须提示而不是当空数据） */
  private async readWithBackup<T>(path: string, parse: (text: string) => T): Promise<T | null> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(path)) {
      try {
        return await parse(await adapter.read(path));
      } catch (e) {
        console.error("Daybook ledger: 文件解析失败，尝试 .bak", path, e);
      }
    }
    const bak = `${path}.bak`;
    if (await adapter.exists(bak)) {
      try {
        const parsed = await parse(await adapter.read(bak));
        new Notice(`⚠️ 记账文件损坏，已从备份恢复：${path}`);
        return parsed;
      } catch (e) {
        console.error("Daybook ledger: 备份文件也损坏", bak, e);
      }
    }
    return null;
  }

  async load(): Promise<void> {
    this.config = defaultLedgerConfig();
    this.records = [];
    this.batches = [];
    this.configDirty = false;
    let settingsDirty = false;
    const legacyYears = new Set<string>();
    try {
      await this.ensureDir();
      let justMigrated = false;
      if (!this.settings.ledgerMigratedV2) {
        const status = await this.migrateFromLegacyJson();
        if (status !== "failed") {
          this.settings.ledgerMigratedV2 = true;
          settingsDirty = true;
        }
        if (status === "migrated") justMigrated = true;
        // status === "failed"：旧 JSON 已读进内存按旧数据继续用（只读兜底），旗标不置，下次启动重试
      }

      if (justMigrated) {
        // 迁移时已从旧数据读入内存并写好新文件，无需重复读
      } else if (this.settings.ledgerMigratedV2) {
        if (await this.app.vault.adapter.exists(this.pathOf("config.json"))) {
          const raw = await this.readWithBackup<Partial<LedgerConfig> | null>(this.pathOf("config.json"), t => JSON.parse(t));
          if (raw && typeof raw === "object") {
            this.config = {
              ...defaultLedgerConfig(),
              ...raw,
              ledgers: Array.isArray(raw.ledgers) && raw.ledgers.length ? raw.ledgers : defaultLedgerConfig().ledgers,
              accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
              categories: Array.isArray(raw.categories) ? raw.categories : [],
              currencies: Array.isArray(raw.currencies) && raw.currencies.length ? raw.currencies : defaultLedgerConfig().currencies,
            };
          }
        }
        if (await this.app.vault.adapter.exists(this.pathOf("imports.json"))) {
          const raw = await this.readWithBackup<unknown>(this.pathOf("imports.json"), t => JSON.parse(t));
          if (Array.isArray(raw)) this.batches = raw;
        }
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(this.dir)) {
          const listing = await adapter.list(this.dir);
          const files = listing.files
            .filter(f => new RegExp(`/(\\d{4})\\.${this.ext}$`).test(f))
            .sort();
          for (const f of files) {
            let rawText = "";
            const parsed = await this.readWithBackup<{ records: LedgerRecord[]; configDirty: boolean }>(f, t => {
              rawText = t;
              const out = parseYearJournal(t, this.config, makeNameResolver(this.config));
              return out;
            });
            if (parsed === null) {
              new Notice(`⚠️ 记账年份文件无法解析，已停用该年份数据（原文件与 .bak 保留）：${f}`);
              continue;
            }
            this.records.push(...parsed.records);
            if (parsed.configDirty) this.configDirty = true;
            const ym = f.match(/(\d{4})\.[^/]+$/);
            if (ym && LEGACY_TAG_RE.test(rawText)) legacyYears.add(ym[1]);
          }
        }
        if (this.configDirty) await this.saveConfig();
        // 旧文件里的冗余标签（kind/cat/sub/acc/to/clock）一次性重写掉；校验不一致就跳过该年
        if (legacyYears.size) await this.compactLegacyTags(legacyYears);
      }
    } catch (e) {
      console.error("Daybook ledger: 读取失败", e);
      new Notice("记账数据读取失败，详见控制台");
    }
    this.sortRecords();
    this.loaded = true;
    if (settingsDirty && this.persistSettings) await this.persistSettings();
  }

  /** 解析 journal 时注册过新分类/账户（config 需要落盘） */
  private configDirty = false;

  /** 迁移期把悬空的分类/账户引用改挂到「未分类 / 未知账户」（就地修改 this.records / this.config） */
  private normalizeOrphanRefs(): void {
    const ensure = makeNameResolver(this.config);
    const uncategorized: Partial<Record<LedgerKind, { categoryId: string }>> = {};
    const unknownAccount = (currency: string): string => ensure.ensureAccount("未知账户", currency);
    const unknownCategory = (kind: LedgerKind): string => {
      if (!uncategorized[kind]) uncategorized[kind] = ensure.ensureCategory(kind, "未分类");
      return uncategorized[kind]!.categoryId;
    };
    for (const r of this.records) {
      const cat = this.config.categories.find(c => c.id === r.categoryId);
      if (cat) {
        if (r.subId && !cat.subs.some(s => s.id === r.subId)) r.subId = undefined;
      } else if (r.kind === "transfer") {
        r.categoryId = "";
        r.subId = undefined;
      } else {
        r.categoryId = unknownCategory(r.kind);
        r.subId = undefined;
      }
      if (!r.accountId || !this.config.accounts.some(a => a.id === r.accountId)) {
        r.accountId = unknownAccount(r.currency || this.config.baseCurrency);
      }
      if (r.toAccountId && !this.config.accounts.some(a => a.id === r.toAccountId)) {
        r.toAccountId = unknownAccount(r.currency || this.config.baseCurrency);
      }
      if (!r.ledgerId) r.ledgerId = this.config.ledgers[0]?.id ?? "";
    }
  }

  /**
   * 迁移结果：
   * - "none"     没有旧数据（全新安装），直接置旗标
   * - "migrated" 已把旧 JSON 转为 journal 并校验通过（数据已在本对象内存里）
   * - "failed"   校验/写盘失败，本会话回退用旧 JSON 数据，旗标不置（下次启动重试）
   */
  private async migrateFromLegacyJson(): Promise<"none" | "migrated" | "failed"> {
    const adapter = this.app.vault.adapter;
    const folder = this.settings.diaryFolder.trim().replace(/\/+$/, "");
    const oldDir = normalizePath(`${folder}/ledger`);
    try {
      if (!(await adapter.exists(oldDir))) return "none";

      // 旧 config / imports 先读进来（无论是否有记录文件）
      const oldConfigPath = normalizePath(`${oldDir}/config.json`);
      if (await adapter.exists(oldConfigPath)) {
        try {
          const raw = JSON.parse(await adapter.read(oldConfigPath));
          this.config = {
            ...defaultLedgerConfig(),
            ...raw,
            ledgers: Array.isArray(raw.ledgers) && raw.ledgers.length ? raw.ledgers : defaultLedgerConfig().ledgers,
            accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
            categories: Array.isArray(raw.categories) ? raw.categories : [],
            currencies: Array.isArray(raw.currencies) && raw.currencies.length ? raw.currencies : defaultLedgerConfig().currencies,
          };
        } catch (e) { /* 旧 config 损坏就用默认值 */ }
      }
      const oldImportsPath = normalizePath(`${oldDir}/imports.json`);
      if (await adapter.exists(oldImportsPath)) {
        try {
          const arr = JSON.parse(await adapter.read(oldImportsPath));
          if (Array.isArray(arr)) this.batches = arr;
        } catch (e) { /* 坏台账按无台账 */ }
      }

      // 读旧记录（解析失败的年份跳过，原文件保留）
      const listing = await adapter.list(oldDir);
      const oldFiles = listing.files.filter(f => /records-\d{4}\.json$/.test(f)).sort();
      for (const f of oldFiles) {
        try {
          const arr = JSON.parse(await adapter.read(f));
          if (Array.isArray(arr)) this.records.push(...arr);
        } catch (e) {
          console.warn("Daybook ledger: 迁移时旧文件解析失败，跳过", f, e);
        }
      }
      this.sortRecords();
      if (this.records.length === 0 && oldFiles.length === 0) return "none";

      // 规范化悬空引用：分类/账户已被删除（或为空）的记录改挂「未分类 / 未知账户」，
      // 与 journal 解析回读的行为一致，保证迁移后内存态与重启后 journal 读态逐字段相同
      this.normalizeOrphanRefs();

      // 内存 round-trip 校验：按年序列化再解析回读，条数必须一致，否则不写盘
      const years = [...new Set(this.records.map(r => yearOf(r.date)).filter(y => /^\d{4}$/.test(y)))].sort();
      const texts = new Map<string, string>();
      for (const y of years) {
        const yearRecords = this.records.filter(r => yearOf(r.date) === y);
        const text = serializeYearJournal(yearRecords, this.config);
        const back = parseYearJournal(text, this.config, makeNameResolver(this.config));
        if (back.records.length !== yearRecords.length) {
          new Notice(`记账迁移中止：${y} 年数据校验不一致（${yearRecords.length} → ${back.records.length}），已按旧数据继续使用`);
          console.error("Daybook ledger: 迁移校验失败", y, yearRecords, back.records);
          return "failed";
        }
        texts.set(y, text);
      }

      // 落盘：config + imports + 各年 journal
      await this.saveConfig();
      await this.saveBatches();
      for (const y of years) {
        await this.writeAtomic(this.recordsFilePath(y), texts.get(y)!);
      }
      new Notice(`✅ 记账数据已迁移为 hledger journal（${this.dir}）；旧 JSON 保留在 ${oldDir}，确认无误后可手动删除`);
      return "migrated";
    } catch (e) {
      console.error("Daybook ledger: 迁移失败", e);
      new Notice("记账旧数据迁移失败，本次仍按旧 JSON 读取（下次启动自动重试）");
      return "failed";
    }
  }

  private sortRecords(): void {
    this.records.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }

  async saveConfig(): Promise<void> {
    await this.writeAtomic(this.pathOf("config.json"), JSON.stringify(this.config, null, 2));
  }

  /** 把某一年集合写回 YYYY.<ext> journal */
  private async persistYear(year: string): Promise<void> {
    if (!/^\d{4}$/.test(year)) return;
    const arr = this.records.filter(r => yearOf(r.date) === year);
    await this.writeAtomic(this.recordsFilePath(year), serializeYearJournal(arr, this.config));
  }

  /**
   * 一次性把旧文件里的冗余标签（kind/cat/sub/acc/to/clock）重写掉。
   * 写盘前用序列化结果再解析一遍，条数与 id 集合不一致就跳过该年（宁可留旧格式也不丢记录）。
   */
  private async compactLegacyTags(years: Set<string>): Promise<void> {
    let done = 0;
    for (const y of years) {
      const rows = this.records.filter(r => yearOf(r.date) === y);
      if (!rows.length) continue;
      const text = serializeYearJournal(rows, this.config);
      try {
        const checkCfg = JSON.parse(JSON.stringify(this.config)) as LedgerConfig;
        const back = parseYearJournal(text, checkCfg, makeNameResolver(checkCfg));
        const beforeIds = rows.map(r => r.id).sort().join(",");
        const afterIds = back.records.map(r => r.id).sort().join(",");
        if (back.records.length !== rows.length || beforeIds !== afterIds) {
          console.warn("Daybook ledger: 精简元数据校验不一致，跳过该年份", y);
          continue;
        }
        await this.writeAtomic(this.recordsFilePath(y), text);
        done++;
      } catch (e) {
        console.error("Daybook ledger: 精简元数据失败", y, e);
      }
    }
    if (done) {
      new Notice(`已精简 ${done} 个年份的记账元数据（旧文件备份为 .bak）`);
    }
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
    await this.writeAtomic(this.pathOf("imports.json"), JSON.stringify(this.batches, null, 2));
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

  /** 导出账单文件到 <ledgerFolder>/export/，返回仓库内路径 */
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
