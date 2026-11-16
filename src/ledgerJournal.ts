/**
 * ledgerJournal.ts — 记账记录的 hledger journal 读写层
 *
 * 存储形式（纯文本，肉眼可读、可直接用 hledger 记账软件打开）：
 *
 *   2026-10-19 12:36 * 沙县小吃 ; 编号:x1, 账本:l1, 币种:CNY, 优惠:5.00, 记录于:2026-10-19 12:36
 *       expenses:餐饮:午餐            ¥95.00
 *       assets:支付宝                 ¥-95.00
 *
 * 口径约定：
 * - 每笔交易 = 一条 hledger transaction，日期行 = 日期 [HH:mm] * 描述；行尾 `;` 后是插件元数据标签。
 * - 标签键一律中文、单冒号（表达约定与追剧/习惯一致）：编号（身份）、账本、币种/汇率（币种折算）、
 *   优惠/退款（原貌）、报销账户/报销金额/报销说明、标签、地点/经手人/备注/附件、记录于（创建时间，
 *   人读 `YYYY-MM-DD HH:mm`）、导入批次。旧英文键（id/led/cur/at…）与旧毫秒时间戳仍可读取。
 *   类型与分类/账户由分录账户名推导，时间由日期行表达，不再重复写 kind/cat/sub/acc/to/clock。
 * - 分录金额一律是「实际金额」：支出 = 金额 − 优惠 − 退款（写入分录，便于直接观看与 hledger 统计）；
 *   优惠/退款等原貌保存在标签里（优惠/退款），解析时反推回 amount。
 * - 支出分录 expenses:分类[:子分类]，收入分录 incomes:分类，账户分录 assets:账户。
 * - 转账 = 两条 assets 分录（转出为负、转入为正）。
 * - 多币种：金额带币种符号/代码（¥ $ EUR…），折算率存汇率标签（不影响分录平衡）。
 * - 手写交易（无编号标签）也能读入：分类/账户按名字自动注册进 config，id 用内容哈希生成，
 *   因此改完文件重新加载不会产生重复记录。描述里写分号会截断注释，写入时已转成全角。
 */
import { moment } from "obsidian";
import type { LedgerConfig, LedgerKind, LedgerRecord } from "./ledgerStore";

/** 金额保留两位小数（与 ledgerStore.round2 同口径；本地副本避免模块依赖） */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ── 币种符号 ── */

const CODE_TO_SYMBOL: Record<string, string> = {
  CNY: "¥", USD: "$", EUR: "€", GBP: "£", KRW: "₩", JPY: "JP¥", HKD: "HK$",
};
const SYMBOL_TO_CODE: Record<string, string> = {
  "HK$": "HKD", "JP¥": "JPY", "¥": "CNY", "￥": "CNY", "$": "USD", "€": "EUR", "£": "GBP", "₩": "KRW",
};

/* ── 金额格式化 / 解析 ── */

function fmtNumber(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 金额 → journal 分录写法：¥-1,234.56 / 100.00 USD */
export function fmtAmount(value: number, currency: string): string {
  const neg = value < 0 ? "-" : "";
  const abs = fmtNumber(Math.abs(value));
  const symbol = CODE_TO_SYMBOL[currency];
  if (symbol) return `${symbol}${neg}${abs}`;
  return `${neg}${abs} ${currency}`;
}

/** 分录金额文本 → { 数值, 币种? }；解析失败返回 null（忽略 `@`/`@@` 价格部分） */
export function parseAmount(raw: string): { value: number; code?: string } | null {
  const s = raw.replace(/@@.*$/, "").replace(/@[^@]*$/, "").trim();
  const m = s.match(/^(HK\$|JP¥|[¥￥$€£₩]|[A-Z]{2,4})?\s*(-?[\d,]+(?:\.\d+)?)\s*([A-Z]{2,4})?$/);
  if (!m) return null;
  const value = parseFloat(m[2].replace(/,/g, ""));
  if (!isFinite(value)) return null;
  let code: string | undefined;
  if (m[3]) code = m[3];
  else if (m[1]) code = SYMBOL_TO_CODE[m[1]] ?? (m[1].length === 3 ? m[1] : undefined);
  return { value, code };
}

/* ── 账户名（hledger account） ── */

/** 分段清洗：冒号转全角、空白折叠；hledger 账户段内不允许冒号与连续空格 */
function sanitizeSegment(raw: string): string {
  return (raw || "").replace(/:/g, "：").replace(/\s+/g, " ").trim() || "未知";
}

const EXPENSE_ROOT = "expenses";
const INCOME_ROOT = "incomes";
const ASSET_ROOT = "assets";

/* ── 标签（行尾 ; 注释里的 键:值；键一律中文，旧英文键只读兼容） ── */

type Tags = Record<string, string>;

/** 文件里的标签键（中文或旧英文）→ 内部键（英文小写）；未知键原样保留 */
const TAG_KEY_ALIASES: Record<string, string> = {
  "编号": "id", "账本": "led", "币种": "cur", "汇率": "rate",
  "优惠": "disc", "退款": "ref",
  "报销账户": "reb", "报销金额": "ramt", "报销说明": "rdet",
  "标签": "t", "地点": "addr", "经手人": "by", "备注": "oth",
  "记录于": "at", "导入批次": "batch", "附件": "f",
  // 旧英文键（只读兼容）
  id: "id", led: "led", cur: "cur", rate: "rate", disc: "disc", ref: "ref",
  reb: "reb", ramt: "ramt", rdet: "rdet", t: "t", addr: "addr", by: "by",
  oth: "oth", at: "at", batch: "batch", f: "f", clock: "clock",
};

/** 内部键 → 中文键（写盘用；只写中文，不再产生英文键） */
const TAG_FIELD_NAMES: Record<string, string> = {
  id: "编号", led: "账本", cur: "币种", rate: "汇率",
  disc: "优惠", ref: "退款", reb: "报销账户", ramt: "报销金额", rdet: "报销说明",
  t: "标签", addr: "地点", by: "经手人", oth: "备注", at: "记录于", batch: "导入批次", f: "附件",
};

function encodeTagValue(v: string): string {
  return v.replace(/,/g, "，").replace(/[\r\n]+/g, " ").trim();
}

function serializeTags(tags: Tags): string {
  const parts = Object.entries(tags)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}:${v}`);
  return parts.length ? ` ; ${parts.join(", ")}` : "";
}

function parseTags(comment: string | undefined): Tags {
  const out: Tags = {};
  if (!comment) return out;
  for (const piece of comment.split(",")) {
    const idx = piece.indexOf(":");
    if (idx <= 0) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    if (k) out[TAG_KEY_ALIASES[k] ?? k] = v;
  }
  return out;
}

/** 毫秒 → 人读 `YYYY-MM-DD HH:mm`（文件里不出现时间戳）；无值返回空（标签整体省略） */
function fmtRecordTime(ms: number | undefined): string {
  if (!ms) return "";
  return moment(ms).format("YYYY-MM-DD HH:mm");
}

/** `记录于` 值 → 毫秒；兼容旧毫秒时间戳与人读格式，解析失败返回 0（调用方兜底 now） */
function parseRecordTime(val: string | undefined): number {
  const v = (val ?? "").trim();
  if (!v) return 0;
  if (/^\d+$/.test(v)) return parseInt(v, 10) || 0; // 旧格式：毫秒时间戳
  const m = moment(v, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD"], true);
  return m.isValid() ? m.valueOf() : 0;
}

/* ── 描述 ── */

/** 无备注时交易描述的默认值（序列化与解析共用，保证 round-trip 不把分类名误存成备注） */
export function defaultDescription(r: Pick<LedgerRecord, "kind" | "categoryId" | "subId" | "accountId" | "toAccountId">, cfg: LedgerConfig): string {
  const cat = cfg.categories.find(c => c.id === r.categoryId);
  if (r.kind === "transfer") {
    const from = cfg.accounts.find(a => a.id === r.accountId)?.name ?? "转出账户";
    const to = cfg.accounts.find(a => a.id === r.toAccountId)?.name ?? "转入账户";
    return `${from} → ${to}`;
  }
  if (r.kind === "income") {
    const sub = cat?.subs.find(s => s.id === r.subId)?.name;
    return sub ? `${cat?.name ?? "收入"}·${sub}` : cat?.name ?? "收入";
  }
  const sub = cat?.subs.find(s => s.id === r.subId)?.name;
  return sub ? `${cat?.name ?? "支出"}·${sub}` : cat?.name ?? "支出";
}

function txDescription(r: LedgerRecord, cfg: LedgerConfig): string {
  const raw = (r.note || "").trim() || defaultDescription(r, cfg);
  // 分号会截断行尾注释，换成全角；换行压平。行首的 * 不剥（hledger 状态符只取日期后的一个，描述里的 * 会原样保留）
  return raw.replace(/;/g, "；").replace(/[\r\n]+/g, " ").trim() || "（无描述）";
}

/* ── 分类 / 账户的解析期注册（手写交易也能落到 config） ── */

export interface JournalNameResolver {
  /** 按名字找支出/收入分类，没有则注册（返回 id） */
  ensureCategory(kind: LedgerKind, name: string, subName?: string): { categoryId: string; subId?: string };
  /** 按名字找账户，没有则注册（币种用 fallbackCurrency） */
  ensureAccount(name: string, fallbackCurrency: string): string;
}

/** 在给定 config 上建一个会就地注册新名字的 resolver（load 后若注册过需 saveConfig） */
export function makeNameResolver(cfg: LedgerConfig): JournalNameResolver {
  let uid = 0;
  const newId = () => `c${Date.now().toString(36)}${(uid++).toString(36)}${Math.floor(Math.random() * 1e3)}`;
  return {
    ensureCategory(kind, name, subName) {
      const cleanName = sanitizeSegment(name);
      let cat = cfg.categories.find(c => c.kind === kind && c.name === cleanName);
      if (!cat) {
        cat = { id: newId(), name: cleanName, kind, subs: [] };
        cfg.categories.push(cat);
      }
      if (!subName) return { categoryId: cat.id };
      const cleanSub = sanitizeSegment(subName);
      let sub = cat.subs.find(s => s.name === cleanSub);
      if (!sub) {
        sub = { id: newId(), name: cleanSub };
        cat.subs.push(sub);
      }
      return { categoryId: cat.id, subId: sub.id };
    },
    ensureAccount(name, fallbackCurrency) {
      const cleanName = sanitizeSegment(name);
      let acc = cfg.accounts.find(a => a.name === cleanName);
      if (!acc) {
        acc = { id: newId(), name: cleanName, currency: fallbackCurrency, opening: 0 };
        cfg.accounts.push(acc);
      }
      return acc.id;
    },
  };
}

/* ── 序列化 ── */

function recordTags(r: LedgerRecord): Tags {
  // 只写「分录本身表达不了」的信息（身份、账本、币种、优惠/退款、报销、标签、附件、排序）。
  // 键一律中文（TAG_FIELD_NAMES）；kind / cat / sub / acc / to 都能从分录账户名推导，
  // 时间已写在日期行里，创建时间用人读「记录于」表达，不再出现毫秒时间戳。
  const tags: Tags = {
    [TAG_FIELD_NAMES.id]: r.id,
    [TAG_FIELD_NAMES.led]: r.ledgerId,
    [TAG_FIELD_NAMES.cur]: r.currency,
    [TAG_FIELD_NAMES.rate]: r.rate !== undefined ? String(r.rate) : "",
    [TAG_FIELD_NAMES.disc]: r.discount ? r.discount.toFixed(2) : "",
    [TAG_FIELD_NAMES.ref]: r.refund ? r.refund.toFixed(2) : "",
    [TAG_FIELD_NAMES.reb]: r.reimbAccountId ?? "",
    [TAG_FIELD_NAMES.ramt]: r.reimbAmount ? String(r.reimbAmount) : "",
    [TAG_FIELD_NAMES.rdet]: r.reimbDetail ?? "",
    [TAG_FIELD_NAMES.t]: (r.tags ?? []).join("|"),
    [TAG_FIELD_NAMES.addr]: r.address ?? "",
    [TAG_FIELD_NAMES.by]: r.creator ?? "",
    [TAG_FIELD_NAMES.oth]: r.other ?? "",
    [TAG_FIELD_NAMES.at]: fmtRecordTime(r.createdAt),
    [TAG_FIELD_NAMES.batch]: r.importBatchId ?? "",
    [TAG_FIELD_NAMES.f]: (r.files ?? []).join("|"),
  };
  return tags;
}

function postingLine(account: string, amount: string, width: number): string {
  const pad = " ".repeat(Math.max(2, width - account.length));
  return `    ${account}${pad}${amount}`;
}

/**
 * 某一年的记录 → journal 文本（按日期升序，hledger 习惯）。
 * 收/支金额 = 实际金额（支出扣掉优惠与退款），优惠/退款原貌在标签里。
 */
export function serializeYearJournal(records: LedgerRecord[], cfg: LedgerConfig): string {
  const sorted = [...records].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.clock ?? "").localeCompare(b.clock ?? "") ||
    (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const out: string[] = [
    `; Daybook 记账 · hledger journal · 本文件由年份数据整体生成（${new Date().getFullYear()} 年及任意年份均可）`,
    "; 每笔交易：日期 [时间] * 描述 ; 插件元数据（编号 等）→ 分类/账户两行分录",
    "; 分录金额 = 实际金额（支出已扣优惠/退款）；手动改分录金额即可改账，请保留行尾 编号 标签",
    "",
  ];

  for (const r of sorted) {
    const cur = r.currency || cfg.baseCurrency;
    const clock = r.clock && /^\d{1,2}:\d{2}$/.test(r.clock) ? ` ${r.clock}` : "";
    const header = `${r.date}${clock} * ${txDescription(r, cfg)}${serializeTags(recordTags(r))}`;
    out.push(header);

    const actual = r.kind === "expense"
      ? round2(Math.max(0, r.amount - (r.discount || 0) - (r.refund || 0)))
      : round2(r.amount);

    const entries: { account: string; amount: number }[] = [];
    if (r.kind === "expense") {
      const cat = cfg.categories.find(c => c.id === r.categoryId);
      const sub = cat?.subs.find(s => s.id === r.subId)?.name;
      const seg = cat ? (sub ? `${sanitizeSegment(cat.name)}:${sanitizeSegment(sub)}` : sanitizeSegment(cat.name)) : "未分类";
      entries.push({ account: `${EXPENSE_ROOT}:${seg}`, amount: actual });
      entries.push({ account: `${ASSET_ROOT}:${sanitizeSegment(cfg.accounts.find(a => a.id === r.accountId)?.name ?? "未知账户")}`, amount: -actual });
    } else if (r.kind === "income") {
      const cat = cfg.categories.find(c => c.id === r.categoryId);
      const sub = cat?.subs.find(s => s.id === r.subId)?.name;
      const seg = cat ? (sub ? `${sanitizeSegment(cat.name)}:${sanitizeSegment(sub)}` : sanitizeSegment(cat.name)) : "收入";
      entries.push({ account: `${ASSET_ROOT}:${sanitizeSegment(cfg.accounts.find(a => a.id === r.accountId)?.name ?? "未知账户")}`, amount: actual });
      entries.push({ account: `${INCOME_ROOT}:${seg}`, amount: -actual });
    } else {
      entries.push({ account: `${ASSET_ROOT}:${sanitizeSegment(cfg.accounts.find(a => a.id === r.accountId)?.name ?? "转出账户")}`, amount: -actual });
      entries.push({ account: `${ASSET_ROOT}:${sanitizeSegment(cfg.accounts.find(a => a.id === r.toAccountId)?.name ?? "转入账户")}`, amount: actual });
    }
    const width = Math.max(...entries.map(e => e.account.length)) + 2;
    for (const e of entries) out.push(postingLine(e.account, fmtAmount(e.amount, cur), width));
    out.push("");
  }

  return out.join("\n");
}

/* ── 解析 ── */

interface RawPosting {
  account: string;
  amount: number;
  code?: string;
}

function splitAccountAmount(line: string): { account: string; amountRaw: string } | null {
  const m = line.match(/^\s+(.+?)(?:\s{2,}|\s+)(\S.*?)\s*$/);
  if (!m) return null;
  // 尝试从右往左剥离金额：右侧应能被 parseAmount 识别
  const account = m[1].trim();
  const amountRaw = m[2].trim();
  return parseAmount(amountRaw) ? { account, amountRaw } : null;
}

function accountRoot(account: string): { root: string; segs: string[] } {
  const idx = account.indexOf(":");
  const root = (idx >= 0 ? account.slice(0, idx) : account).trim().toLowerCase();
  const segs = idx >= 0
    ? account.slice(idx + 1).split(":").map(s => s.trim()).filter(Boolean)
    : [];
  return { root, segs };
}

function deterministicId(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h * 31) + seed.charCodeAt(i)) >>> 0;
  return `h${h.toString(36)}${seed.length.toString(36)}`;
}

export interface ParsedJournal {
  records: LedgerRecord[];
  /** 解析期注册过新分类/账户（config 需要落盘） */
  configDirty: boolean;
}

/**
 * journal 文本 → 记录数组。容错：无 id 标签的手写交易也接受（id 用内容哈希）；
 * 无法识别的行跳过。now 供补默认 createdAt/时间戳（测试可注入）。
 */
export function parseYearJournal(
  text: string,
  cfg: LedgerConfig,
  resolver: JournalNameResolver,
  now: number = Date.now()
): ParsedJournal {
  const records: LedgerRecord[] = [];
  let configDirty = false;
  const lines = text.split(/\r?\n/);

  let i = 0;
  const fail = (msg: string, line: string) => { console.warn(`[Daybook journal] ${msg}：${line}`); };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*[;#]/.test(line)) { i++; continue; }

    const headerMatch = line.match(
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?\s*[*!]?\s*([^;]*?)\s*(?:;\s*(.*))?$/
    );
    if (!headerMatch) { fail("跳过无法识别的行", line); i++; continue; }

    const [, ys, ms, ds, hs, mins, descRaw, commentRaw] = headerMatch;
    const date = `${ys}-${ms.padStart(2, "0")}-${ds.padStart(2, "0")}`;
    const headerTime = hs !== undefined ? `${hs.padStart(2, "0")}:${mins}` : undefined;
    const tags = parseTags(commentRaw);
    const desc = (descRaw ?? "").trim();

    // 收集分录
    const postings: RawPosting[] = [];
    i++;
    while (i < lines.length) {
      const pl = lines[i];
      if (!pl.trim()) { i++; break; }
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(pl.trim())) break; // 下一条交易（无空行分隔）
      if (/^\s*[;#]/.test(pl)) { i++; continue; }
      const split = splitAccountAmount(pl);
      if (!split) { fail("跳过无法解析的分录", pl); i++; continue; }
      const amt = parseAmount(split.amountRaw);
      if (amt) postings.push({ account: split.account, amount: amt.value, code: amt.code });
      i++;
    }

    if (postings.length === 0) { fail("交易没有可用分录", line); continue; }

    // 判定类型与金额
    const kind: LedgerKind =
      postings.some(p => accountRoot(p.account).root === EXPENSE_ROOT) ? "expense"
        : postings.some(p => accountRoot(p.account).root === INCOME_ROOT) ? "income"
          : "transfer";

    let value = 0;
    const assets = postings.filter(p => accountRoot(p.account).root === ASSET_ROOT);
    if (kind === "expense") {
      const ep = postings.find(p => accountRoot(p.account).root === EXPENSE_ROOT)!;
      value = Math.abs(ep.amount);
    } else if (kind === "income") {
      const asset = assets.find(p => p.amount > 0) ?? assets[0] ?? postings.find(p => accountRoot(p.account).root !== INCOME_ROOT);
      value = Math.abs(asset?.amount ?? 0);
    } else {
      const outP = assets.find(p => p.amount < 0);
      value = Math.abs(outP?.amount ?? assets[0]?.amount ?? 0);
    }

    // 分类 / 账户映射（未知的自动注册）
    let categoryId = "", subId: string | undefined, accountId = "", toAccountId: string | undefined;
    const cur = tags.cur || postings.find(p => p.code)?.code || cfg.baseCurrency;
    for (const p of postings) {
      const { root, segs } = accountRoot(p.account);
      if (root === EXPENSE_ROOT || root === INCOME_ROOT) {
        const k: LedgerKind = root === EXPENSE_ROOT ? "expense" : "income";
        const got = resolver.ensureCategory(k, segs[0] ?? "未分类", segs[1]);
        categoryId = got.categoryId; subId = got.subId;
        configDirty = true;
      } else if (root === ASSET_ROOT) {
        const id = resolver.ensureAccount(segs.join("：") || "未知账户", cur);
        configDirty = true;
        if (kind === "transfer" && p.amount < 0) accountId = id;
        else if (kind === "transfer" && p.amount > 0) { if (!toAccountId) toAccountId = id; }
        else if (!accountId) accountId = id;
      }
    }
    if (kind === "transfer" && !accountId) accountId = assets[0] ? resolver.ensureAccount("未知账户", cur) : "";
    if (!accountId && !toAccountId) { fail("交易缺少可识别账户", line); continue; }

    const disc = round2(parseFloat(tags.disc || "0") || 0);
    const ref = round2(parseFloat(tags.ref || "0") || 0);
    const defaultDesc = defaultDescription(
      { kind, categoryId, subId, accountId, toAccountId },
      cfg
    );
    const note = desc && desc !== defaultDesc ? desc : "";

    const createdAt = parseRecordTime(tags.at) || now;
    records.push({
      id: tags.id || deterministicId(`${date}|${headerTime ?? ""}|${desc}|${value}|${kind}`),
      date,
      kind,
      amount: kind === "expense" ? round2(value + disc + ref) : round2(value),
      categoryId,
      subId,
      accountId,
      toAccountId,
      ledgerId: tags.led || cfg.ledgers[0]?.id || "",
      refund: ref,
      discount: disc,
      note,
      tags: (tags.t || "").split("|").map(t => t.trim()).filter(Boolean),
      reimbAccountId: tags.reb || undefined,
      reimbAmount: tags.ramt ? parseFloat(tags.ramt) : undefined,
      reimbDetail: tags.rdet || undefined,
      currency: cur,
      rate: tags.rate ? parseFloat(tags.rate) : undefined,
      address: tags.addr || "",
      creator: tags.by || "",
      other: tags.oth || "",
      files: (tags.f || "").split("|").map(f => f.trim()).filter(Boolean),
      createdAt,
      clock: tags.clock || headerTime,
      importBatchId: tags.batch || undefined,
    });
  }

  return { records, configDirty };
}
