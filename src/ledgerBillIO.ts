/**
 * ledgerBillIO.ts — 账单文件的解析 / 模板识别 / 字段与值映射 / 生成记录（纯逻辑层，不碰 DOM、不依赖 obsidian）
 *
 * 支持的输入：
 *   .xls（BIFF8）/ .xlsx —— 经 SheetJS core 构建读取（仅在使用时才 require，避免拖慢插件启动）
 *   .csv / .txt          —— 本模块自带轻量解析（自动判定分隔符、引号转义、UTF-8 BOM 与 GB18030 兜底）
 *
 * 识别流程：先把文件摊成若干「表」（每个工作表一张，自动定位表头行），
 * 再用各模板的表头别名打分选出最像的来源 App；模板只给「默认映射」，
 * 之后由界面上的字段映射 / 值映射覆写，所以模板命中错误也能手工改。
 *
 * 金额一律存正数，收支方向由 kind 决定（与本插件其余口径一致）。
 */
import type { LedgerConfig, LedgerKind, LedgerRecord } from "./ledgerStore";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const makeBillId = (): string => `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/* ────────────────────────── 规范字段 ────────────────────────── */

export type BillField =
  | "date" | "time" | "kind" | "amount" | "incomeAmount" | "expenseAmount"
  | "category" | "subcategory" | "account" | "toAccount" | "ledger"
  | "note" | "tags" | "refund" | "discount" | "currency" | "creator";

export interface BillFieldDef { field: BillField; label: string; group: "必要" | "分类与账户" | "金额" | "其他"; }

export const BILL_FIELDS: BillFieldDef[] = [
  { field: "date", label: "日期", group: "必要" },
  { field: "kind", label: "收支类型", group: "必要" },
  { field: "amount", label: "金额", group: "必要" },
  { field: "incomeAmount", label: "收入金额（分列）", group: "金额" },
  { field: "expenseAmount", label: "支出金额（分列）", group: "金额" },
  { field: "currency", label: "币种", group: "金额" },
  { field: "discount", label: "优惠", group: "金额" },
  { field: "refund", label: "退款", group: "金额" },
  { field: "category", label: "类别", group: "分类与账户" },
  { field: "subcategory", label: "二级分类", group: "分类与账户" },
  { field: "account", label: "账户", group: "分类与账户" },
  { field: "toAccount", label: "转入账户", group: "分类与账户" },
  { field: "ledger", label: "账本", group: "分类与账户" },
  { field: "time", label: "时间", group: "其他" },
  { field: "note", label: "备注", group: "其他" },
  { field: "tags", label: "标签", group: "其他" },
  { field: "creator", label: "创建用户", group: "其他" },
];

export const fieldLabel = (f: BillField): string => BILL_FIELDS.find(d => d.field === f)?.label ?? f;

/* ────────────────────────── 模板 ────────────────────────── */

export interface BillSource {
  key: string;
  label: string;
  /** 字段 → 该来源常用的表头写法（归一化后比较） */
  map: Partial<Record<BillField, string[]>>;
  /** signed：金额列带正负；split：收入/支出各占一列；abs：金额恒正 + 类型列 */
  amountMode: "signed" | "split" | "abs";
  /** 转账的两个账户写在同一格里（如「微信->支付宝」） */
  transferInOneCell?: boolean;
  hint: string;
}

export const BILL_SOURCES: BillSource[] = [
  {
    key: "yimu", label: "一木记账", amountMode: "signed",
    hint: "导出为 xls/xlsx：日期、收支类型、金额（支出为负）、类别、二级分类、账户、账本、退款、优惠、备注……",
    map: {
      date: ["日期", "交易日期", "记账时间"], time: ["时间"], kind: ["收支类型", "类型"],
      amount: ["金额", "交易金额"], category: ["类别", "分类", "项目分类"], subcategory: ["二级分类", "子分类", "项目子类"],
      account: ["账户", "所属账户", "钱包账户"], toAccount: ["转入账户", "关联账户", "对方账户"], ledger: ["账本"],
      note: ["备注", "说明"], tags: ["标签"], refund: ["退款"], discount: ["优惠"], currency: ["多币种", "币种", "货币"],
      creator: ["创建用户", "记帐人", "创建人"],
    },
  },
  {
    key: "suishouji", label: "随手记", amountMode: "split",
    hint: "随手记 / 随手记团队版导出的流水表：交易时间、交易类型、收入、支出、项目分类、账户、交易对方、备注",
    map: {
      date: ["交易时间", "日期", "发生时间"], time: ["时间"], kind: ["交易类型", "收支类型"],
      incomeAmount: ["收入", "收入金额", "收入(元)", "收入（元）"], expenseAmount: ["支出", "支出金额", "支出(元)", "支出（元）"],
      amount: ["交易金额", "金额"], category: ["项目分类", "分类", "类别"], subcategory: ["项目子类", "二级分类", "子类"],
      account: ["账户", "钱包钱包", "资金来源"], toAccount: ["转入账户", "对应账户", "目标账户"], ledger: ["账本", "账本名称"],
      note: ["备注", "说明", "交易备注"], tags: ["标签", "成员", "标签列表"], currency: ["币种", "货币"], creator: ["创建人", "记帐人"],
    },
  },
  {
    key: "waicai", label: "挖财记账", amountMode: "split",
    hint: "挖财账单流水：记账日期、记账类型、收入金额、支出金额、分类、账户、备注、标签",
    map: {
      date: ["记账日期", "交易日期", "日期"], time: ["记账时间", "时间"], kind: ["记账类型", "类型"],
      incomeAmount: ["收入金额", "收入"], expenseAmount: ["支出金额", "支出"], amount: ["金额", "交易金额"],
      category: ["分类", "类别", "一级分类"], subcategory: ["二级分类", "子分类"], account: ["账户", "账户名称"],
      toAccount: ["转入账户", "关联账户"], ledger: ["账本"], note: ["备注", "摘要"], tags: ["标签"], currency: ["币种"], creator: ["创建人"],
    },
  },
  {
    key: "qianji", label: "钱迹", amountMode: "signed",
    hint: "钱迹导出的 CSV：交易时间、记账类型、交易金额、一级分类、二级分类、账户、关联账户、备注、标签",
    map: {
      date: ["交易时间", "日期"], time: ["时间"], kind: ["记账类型", "交易类型"],
      amount: ["交易金额", "金额"], category: ["一级分类", "分类", "类别"], subcategory: ["二级分类", "子分类"],
      account: ["账户", "账户名"], toAccount: ["关联账户", "转入账户"], note: ["备注"], tags: ["标签"],
      currency: ["币种"], ledger: ["账本"], creator: ["创建人"],
    },
  },
  {
    key: "shark", label: "鲨鱼记账", amountMode: "abs",
    hint: "鲨鱼记账导出：日期、类型、分类、金额、账户、备注",
    map: {
      date: ["日期", "记账日期"], time: ["时间"], kind: ["类型", "收支类型"], amount: ["金额"],
      category: ["分类", "类别"], subcategory: ["子分类", "二级分类"], account: ["账户"], toAccount: ["转入账户"],
      note: ["备注"], tags: ["标签"], currency: ["币种"], ledger: ["账本"], creator: ["创建人"],
    },
  },
  {
    key: "alipay", label: "支付宝账单", amountMode: "split", transferInOneCell: false,
    hint: "支付宝交易明细 CSV（GB 编码）：交易时间、交易分类、交易对方、商品说明、收/支、金额(元)、收付款方式",
    map: {
      date: ["交易时间", "交易创建时间", "日期"], kind: ["收/支", "收支", "收 支"], amount: ["金额(元)", "金额（元）", "金额"],
      incomeAmount: ["金额(元)"], expenseAmount: ["金额(元)"], category: ["交易分类", "分类"], subcategory: ["二级分类"],
      account: ["收付款方式", "付款银行", "支付渠道"], toAccount: ["对应账户"], note: ["交易对方", "商品说明", "备注"],
      tags: ["标签"], refund: ["退款金额"], discount: ["优惠金额"], currency: ["币种"], creator: ["创建人"], ledger: ["账本"],
    },
  },
  {
    key: "wechat", label: "微信支付账单", amountMode: "split",
    hint: "微信支付账单 CSV：交易时间、交易类型、交易对方、商品、收/支、金额(元)、支付方式、当前状态、备注",
    map: {
      date: ["交易时间", "日期"], kind: ["收/支", "收支"], amount: ["金额(元)", "金额"],
      incomeAmount: ["金额(元)"], expenseAmount: ["金额(元)"], category: ["交易类型", "分类"], subcategory: ["二级分类"],
      account: ["支付方式", "支付银行"], toAccount: ["转入账户"], note: ["商品", "备注", "交易对方"],
      tags: ["标签"], refund: ["退款金额"], discount: ["优惠金额"], currency: ["币种"], creator: ["创建人"], ledger: ["账本"],
    },
  },
  {
    key: "daybook", label: "Daybook 模板", amountMode: "abs",
    hint: "本插件「导出账单」生成的 CSV，列名与这里一致，可直接原样回灌。",
    map: {
      date: ["日期"], time: ["时间"], kind: ["收支类型"], amount: ["金额"], category: ["类别"], subcategory: ["二级分类"],
      account: ["账户"], toAccount: ["转入账户"], ledger: ["账本"], note: ["备注"], tags: ["标签"],
      refund: ["退款"], discount: ["优惠"], currency: ["币种"], creator: ["创建用户"],
    },
  },
  {
    key: "auto", label: "通用识别", amountMode: "signed",
    hint: "不确定来源时选它：按常见写法（日期/时间/类型/金额/分类/账户/备注…）逐列猜测，再手工调整映射。",
    map: {
      date: ["日期", "交易日期", "记账日期", "交易时间", "时间", "date"], time: ["时间", "时刻", "time"],
      kind: ["收支类型", "类型", "交易类型", "记账类型", "收/支", "type"], amount: ["金额", "交易金额", "记账金额", "amount", "钱"],
      incomeAmount: ["收入", "收入金额"], expenseAmount: ["支出", "支出金额"], category: ["类别", "分类", "交易分类", "一级分类", "项目分类"],
      subcategory: ["二级分类", "子分类", "子类"], account: ["账户", "账户名", "支付方式", "收付款方式", "资金账户"],
      toAccount: ["转入账户", "关联账户", "对应账户"], ledger: ["账本", "账户组"], note: ["备注", "说明", "商品", "摘要", "交易对方"],
      tags: ["标签"], refund: ["退款", "退款金额"], discount: ["优惠", "优惠金额"], currency: ["币种", "货币", "多币种"], creator: ["创建用户", "创建人", "记帐人"],
    },
  },
];

/* 去掉别名数组里的空位（保持上面的书写自由） */
BILL_SOURCES.forEach(s => {
  const m = s.map as Record<string, string[]>;
  Object.keys(m).forEach(k => { m[k] = (m[k] || []).filter(Boolean); });
});

/** 收支类型词表 */
const KIND_WORDS: { kind: LedgerKind; words: string[] }[] = [
  { kind: "transfer", words: ["转账", "转帐", "内部转账", "账户转账", "互转", "划转", "存取", "取现", "存现", "还款", "借入", "借出", "exttransfer", "transfer"] },
  { kind: "income", words: ["收入", "进账", "收益", "工资", "报销入账", "in", "income", "收"] },
  { kind: "expense", words: ["支出", "开支", "消费", "花费", "out", "expense", "支"] },
];

/** 这些词代表「不计收支」，导入时视为无效行 */
const IGNORE_KIND_WORDS = ["--", "不计", "不计入", "无需跟踪", "其他", "无"];

/* ────────────────────────── 文本归一化 ────────────────────────── */

const FULL = "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ";
const HALF = "0123456789ABCDEFGHIJKLMnaabcdefghijklmnopqrstuvwxyz";

/** 表头 / 名称比较用的归一化：全角转半角、去空格与括号标点、繁体的「其它/其他」统一 */
export function normKey(s: string): string {
  let out = "";
  for (const ch of (s || "").trim()) {
    const i = FULL.indexOf(ch);
    out += i >= 0 ? HALF[i] : ch;
  }
  out = out.toLowerCase().replace(/[\s\u3000]/g, "");
  out = out.replace(/[（(【\[].*?[）)】\]]/g, "");
  out = out.replace(/[^\p{Script=Han}\p{Letter}\p{Number}]/gu, "");
  out = out.replace(/^(其它|其他)$/, "其他");
  return out;
}

/** 值匹配用的归一化（保留括号内容，「建设银行(4304)」与「建设银行（4304）」要等价） */
export function normValue(s: string): string {
  let out = "";
  for (const ch of (s || "").trim()) {
    const i = FULL.indexOf(ch);
    out += i >= 0 ? HALF[i] : ch;
  }
  return out.toLowerCase().replace(/[\s\u3000]/g, "").replace(/其它/g, "其他");
}

/* ────────────────────────── 文件读取 ────────────────────────── */

export interface BillSheet {
  name: string;
  headers: string[];      // 原始表头文本
  rows: string[][];       // 表头之下的数据行（已裁掉全空行，列数对齐表头）
  headerRow: number;      // 表头在原表中的行号（0 基），用于给用户展示
}

let xlsxCache: any = null;
function xlsxLib(): any {
  if (!xlsxCache) {
    // 仅在真正要解析 Excel 时才把 SheetJS 读进来（打进 main.js，运行时懒取）
    xlsxCache = require("xlsx/dist/xlsx.core.min.js");
  }
  return xlsxCache;
}

/** UTF-8 优先，出现替换符再退回 GB18030（微信/支付宝导出的 CSV 多为 GB 系编码） */
export function decodeText(bytes: Uint8Array): string {
  const tryDecode = (label: string): string | null => {
    try { return new TextDecoder(label).decode(bytes); } catch (e) { return null; }
  };
  let s = tryDecode("utf-8");
  if (s == null) s = tryDecode("gb18030") ?? "";
  if (s.indexOf("\uFFFD") >= 0) {
    const alt = tryDecode("gb18030") ?? tryDecode("big5");
    if (alt && alt.indexOf("\uFFFD") < 0) s = alt;
  }
  return s.replace(/^\uFEFF/, "");
}

/** 轻量 CSV：自动判定分隔符（, ; \t |），支持双引号转义与换行 */
export function splitCsv(text: string): string[][] {
  const sample = text.slice(0, 4000);
  const counts = [",", ";", "\t", "|"].map(d => ({ d, n: sample.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  const delim = counts[0].n > 0 ? counts[0].d : ",";
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuote = false; }
      else field += c;
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => (c || "").trim() !== ""));
}

/** 摊平后的二维数组 → 表：在前 15 行里挑「像表头」的那行（命中的常见列名最多） */
function aoaToSheet(name: string, aoa: any[][]): BillSheet {
  const str = (v: any): string => (v == null ? "" : String(v)).trim();
  const grid = aoa.map(r => (r || []).map(str));
  const usable = grid.filter(r => r.some(c => c !== ""));
  if (!usable.length) return { name, headers: [], rows: [], headerRow: -1 };
  const aliasPool: string[] = [];
  BILL_SOURCES.forEach(s => Object.keys(s.map).forEach(k => aliasPool.push(...(s.map as any)[k])));
  const aliasNorm = [...new Set(aliasPool.map(normKey).filter(Boolean))];
  const firstIdx = grid.findIndex(r => r.some(c => c !== ""));
  let best = firstIdx, bestScore = -1;
  for (let i = firstIdx; i < Math.min(grid.length, firstIdx + 15); i++) {
    const cells = grid[i];
    if (!cells.some(c => c !== "")) continue;
    let hits = 0, texty = 0;
    cells.forEach(c => {
      if (!c) return;
      texty++;
      const n = normKey(c);
      if (!n) return;
      if (aliasNorm.indexOf(n) >= 0) hits += 2;
      else if (aliasNorm.some(a => a.length >= 2 && (n.includes(a) || a.includes(n)))) hits += 1;
    });
    const score = hits * 10 + texty;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const headers = grid[best] || [];
  const width = headers.reduce((m, c, i) => Math.max(m, c ? i + 1 : 0), 0);
  const rows = grid.slice(best + 1).map(r => {
    const out = r.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  }).filter(r => r.some(c => c !== ""));
  return { name, headers, rows, headerRow: best };
}

/** 入口：按扩展名分流，返回每个工作表一张 BillSheet */
export function readBillFile(bytes: Uint8Array, fileName: string): BillSheet[] {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ext === "csv" || ext === "txt" || ext === "") {
    const text = decodeText(bytes);
    const aoa = splitCsv(text);
    const sheets = [aoaToSheet(fileName, aoa)];
    return sheets.filter(s => s.headers.length);
  }
  const X = xlsxLib();
  const wb = X.read(bytes, { type: "array", codepage: 936, cellDates: false });
  return (wb.SheetNames as string[])
    .map(nm => aoaToSheet(nm, X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, defval: "", blankrows: false })))
    .filter(s => s.headers.length);
}

/** 工作表转成写 CSV 用的字符串（导出用，配合 \uFEFF BOM 让 Excel 认 UTF-8） */
export function toCsv(aoa: (string | number)[][]): string {
  const esc = (v: string | number): string => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return aoa.map(r => r.map(esc).join(",")).join("\r\n");
}

/* ────────────────────────── 模板识别 ────────────────────────── */

export interface DetectResult {
  key: string;
  label: string;
  sheetIndex: number;
  score: number;          // 命中别名数（精确命中权重更高）
  maxScore: number;       // 该表可命中的理论上限，用于展示置信度
  required: BillField[];  // 仍缺的必要字段
  source: BillSource;
}

function scoreSource(src: BillSource, headers: string[]): { exact: number; fuzzy: number; missRequired: BillField[] } {
  const hn = headers.map(normKey);
  const assigned = new Set<number>();
  let exact = 0, fuzzy = 0;
  const used = new Set<string>();
  (Object.keys(src.map) as BillField[]).forEach(f => {
    const aliases = (src.map[f] || []).map(normKey).filter(Boolean);
    let col = -1;
    aliases.forEach(a => { if (col < 0) { const i = hn.findIndex((h, j) => h === a && !assigned.has(j)); if (i >= 0) col = i; } });
    if (col < 0) aliases.forEach(a => { if (col < 0) { const i = hn.findIndex((h, j) => !assigned.has(j) && h.length >= 2 && (h.includes(a) || a.includes(h))); if (i >= 0) col = i; } });
    if (col < 0) return;
    assigned.add(col); used.add(f);
    if (aliases.indexOf(hn[col]) >= 0) exact++; else fuzzy++;
  });
  const required = (["date", "amount", "category", "account"] as BillField[]).filter(f => !used.has(f));
  return { exact, fuzzy, missRequired: required };
}

/** 对每张表分别打分，返回按置信度排序的候选（首位即自动识别结果） */
export function detectSheets(sheets: BillSheet[]): DetectResult[] {
  const out: DetectResult[] = [];
  sheets.forEach((sh, sheetIndex) => {
    BILL_SOURCES.forEach(src => {
      const { exact, fuzzy, missRequired } = scoreSource(src, sh.headers);
      const score = exact * 2 + fuzzy - missRequired.length * 3;
      if (score <= 0) return;
      out.push({ key: src.key, label: src.label, sheetIndex, score, maxScore: Object.keys(src.map).length * 2, required: missRequired, source: src });
    });
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ────────────────────────── 字段映射 ────────────────────────── */

export type ColumnMap = Partial<Record<BillField, number>>;

/** 模板默认映射 + 未命中字段的模糊兜底（跳过已被占用的列） */
export function buildColumnMap(src: BillSource, sh: BillSheet): ColumnMap {
  const hn = sh.headers.map(normKey);
  const map: ColumnMap = {};
  const used = new Set<number>();
  (Object.keys(src.map) as BillField[]).forEach(f => {
    const aliases = (src.map[f] || []).map(normKey).filter(Boolean);
    let col = -1;
    for (const a of aliases) { const i = hn.findIndex((h, j) => h === a && !used.has(j)); if (i >= 0) { col = i; break; } }
    if (col < 0) for (const a of aliases) { const i = hn.findIndex((h, j) => !used.has(j) && a.length >= 2 && (h.includes(a) || a.includes(h))); if (i >= 0) { col = i; break; } }
    if (col < 0) return;
    map[f] = col; used.add(col);
  });
  /* 常见写法的通用兜底：模板没覆盖到的必要字段 */
  (["date", "kind", "amount", "category", "account", "subcategory", "note"] as BillField[]).forEach(f => {
    if (map[f] != null) return;
    const kw = { date: ["日期", "时间", "date"], kind: ["类型", "收/支", "type"], amount: ["金额", "amount"], category: ["类别", "分类"], account: ["账户", "支付方式"], subcategory: ["二级", "子类"], note: ["备注", "说明", "商品"] }[f] || [];
    const i = hn.findIndex((h, j) => !used.has(j) && kw.some(k => h && (h === normKey(k) || h.includes(normKey(k)))));
    if (i >= 0) { map[f] = i; used.add(i); }
  });
  return map;
}

export const unassignedColumns = (sh: BillSheet, map: ColumnMap): number[] => {
  const used: number[] = [];
  (Object.keys(map) as BillField[]).forEach(f => { const v = map[f]; if (v != null) used.push(v); });
  return sh.headers.map((_, i) => i).filter(i => used.indexOf(i) < 0);
};

/* ────────────────────────── 值解析 ────────────────────────── */

export function parseAmount(v: any): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? round2(Math.abs(v)) : null;
  const s = String(v).replace(/[,，\s¥￥$€£]/g, "").replace(/[（(].*?[)）]/g, "");
  const n = parseFloat(s);
  return isFinite(n) ? round2(Math.abs(n)) : null;
}

/** Excel 日期序列号 → {date, clock}（1900 历，含 1900-02-29 bug 的经典处理） */
function fromSerial(n: number): { date: string; clock: string } | null {
  if (!(n > 20000 && n < 80000)) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const pad = (x: number): string => (x < 10 ? "0" : "") + x;
  const dayStart = Math.floor(n);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    clock: n > dayStart ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "",
  };
}

const pad2 = (x: number): string => (x < 10 ? "0" : "") + x;

/** 各种账单日期写法 → YYYY-MM-DD + HH:mm；解析不出来返回 null */
export function parseDateTime(v: any): { date: string; clock: string } | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return fromSerial(v);
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { date: `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`, clock: `${pad2(v.getHours())}:${pad2(v.getMinutes())}` };
  }
  const s = String(v).trim().replace(/\s+/g, " ").replace(/[年月]/g, "-").replace(/日/g, "").replace(/\./g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime()) || d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  const clock = m[4] ? `${pad2(Number(m[4]))}:${pad2(Number(m[5] || 0))}` : "";
  return { date: `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, clock };
}

export function parseKind(text: string, signHint?: number): LedgerKind | "ignore" | null {
  const n = normKey(text);
  if (!n) return signHint == null ? null : signHint < 0 ? "expense" : "income";
  for (const g of KIND_WORDS) if (g.words.some(w => n === normKey(w) || (w.length > 1 && n.includes(normKey(w))))) return g.kind;
  if (IGNORE_KIND_WORDS.indexOf(n) >= 0) return "ignore";
  return signHint == null ? null : signHint < 0 ? "expense" : "income";
}

/* ────────────────────────── 行抽取 ────────────────────────── */

export interface ParsedBillRow {
  line: number;              // 原表行号（1 基，含表头偏移），给用户看
  date: string; clock: string; kind: LedgerKind; rawKind: string; amount: number;
  category: string; subcategory: string; account: string; toAccount: string;
  note: string; tags: string[]; refund: number; discount: number; currency: string; creator: string;
  error?: string;            // 有则默认不勾选
  warn?: string;             // 仅提示（如金额为 0），默认可勾选
  dup?: string;              // 重复原因（与已有记录 / 与本文件第 N 行重复），勾选「跳过重复」时不导入
  signed: number;            // 原文件里的正负（导出回原格式时用）
}

const cell = (row: string[], col?: number): string => (col == null || col < 0 ? "" : (row[col] ?? "").trim());

const isBlankRow = (r: string[]): boolean => !(r || []).some(c => String(c ?? "").trim() !== "");

/** 把一行的原始文本按映射抽成规范记录（含错误原因，便于界面提示） */
export function extractRows(sh: BillSheet, map: ColumnMap, src: BillSource, existing?: Set<string>): ParsedBillRow[] {
  const out: ParsedBillRow[] = [];
  const seen = new Map<string, number>();
  sh.rows.forEach((r, i) => {
    const line = sh.headerRow + i + 2;
    if (isBlankRow(r)) return;
    const dtRaw = cell(r, map.date) || cell(r, map.time);
    const dt = parseDateTime(dtRaw);
    const clockFromCol = cell(r, map.time).match(/(\d{1,2}):(\d{2})/);
    const rawAmt = cell(r, map.amount);
    const rawIncome = cell(r, map.incomeAmount);
    const rawExpense = cell(r, map.expenseAmount);
    let amount: number | null = null;
    let sign = 1;
    let kind: LedgerKind | "ignore" | null = null;
    if (rawIncome || rawExpense) {                 // 收入 / 支出分列（随手记、挖财、支付宝、微信）
      const inc = parseAmount(rawIncome), exp = parseAmount(rawExpense);
      if (inc) { amount = inc; sign = 1; kind = "income"; }
      else if (exp) { amount = exp; sign = -1; kind = "expense"; }
    }
    if (amount == null && rawAmt) {
      amount = parseAmount(rawAmt);
      sign = src.amountMode === "signed" || rawAmt.trim().startsWith("-") ? (rawAmt.trim().startsWith("-") ? -1 : 1) : 1;
    }
    const rawKind = cell(r, map.kind);
    if (!kind) {
      kind = map.kind != null
        ? parseKind(rawKind, amount != null ? sign : undefined)
        : (amount != null ? (sign < 0 ? "expense" : "income") : null);
    }
    let account = cell(r, map.account);
    let toAccount = cell(r, map.toAccount);
    if (kind === "transfer" && !toAccount && src.transferInOneCell) {
      const sp = account.split(/->|→|—>| - /);
      if (sp.length >= 2) { account = sp[0].trim(); toAccount = sp.slice(1).join("").trim(); }
    }
    const note = cell(r, map.note);
    const tags = cell(r, map.tags).split(/[,，、|\/]/).map(t => t.trim()).filter(Boolean).slice(0, 12);
    const row: ParsedBillRow = {
      line, date: dt?.date ?? "", clock: dt?.clock || (clockFromCol ? `${pad2(Number(clockFromCol[1]))}:${clockFromCol[2]}` : ""),
      kind: kind === "ignore" || kind === null ? "expense" : kind,
      rawKind, amount: amount ?? 0,
      category: cell(r, map.category), subcategory: cell(r, map.subcategory),
      account, toAccount, note, tags,
      refund: parseAmount(cell(r, map.refund)) ?? 0, discount: parseAmount(cell(r, map.discount)) ?? 0,
      currency: cell(r, map.currency), creator: cell(r, map.creator), signed: sign,
    };
    if (!dt) row.error = "日期无法识别";
    else if (kind === "ignore") row.error = `状态「${rawKind || "--"}」不计收支`;
    else if (amount == null) row.error = "金额缺失或不是数字";
    else if (amount === 0) row.warn = "金额为 0";
    else if (kind === "transfer" && !toAccount) row.error = "转账缺转入账户（可用「强制方向」按收支导入）";
    else if (kind === null) row.error = "收支类型无法判断（可用「强制方向」指定）";
    if (!row.error) {
      const sig = billSignature(row);
      if (existing && existing.has(sig)) row.dup = "与已有记录相同";
      else if (seen.has(sig)) row.dup = `与本文件第 ${seen.get(sig)} 行重复`;
      else seen.set(sig, line);
    }
    out.push(row);
  });
  return out;
}

/** 疑似重复判定用的指纹：日期 + 时间 + 方向 + 金额 + 账户名 + 备注（带分钟，避免同日同额不同笔被合并） */
export function billSignature(r: { date: string; clock?: string; kind: string; amount: number; account?: string; note?: string; toAccount?: string }): string {
  return `${r.date} ${r.clock ?? ""}|${r.kind}|${r.amount.toFixed(2)}|${normValue(r.account ?? "")}|${normValue(r.toAccount ?? "")}|${normValue(r.note ?? "")}`;
}

/** 已有记录的指纹集合（账户名参与比较，换账户后就不算重复了） */
export function existingSignatures(records: LedgerRecord[], cfg: LedgerConfig): Set<string> {
  const nameOf = (id: string) => cfg.accounts.find(a => a.id === id)?.name ?? "";
  const set = new Set<string>();
  records.forEach(r => set.add(billSignature({
    date: r.date, clock: r.clock || "", kind: r.kind, amount: r.amount,
    account: nameOf(r.accountId), toAccount: r.kind === "transfer" ? nameOf(r.toAccountId ?? "") : "", note: r.note,
  })));
  return set;
}

/* ────────────────────────── 值映射（分类 / 账户 / 币种） ────────────────────────── */

/** 目标编码："" = 忽略；"id:<x>" = 用已有；"new" = 按源名新建；"new:<名称>" = 自定义名新建 */
export type ValueTarget = string;
export interface ValueMaps {
  category: Record<string, ValueTarget>;
  account: Record<string, ValueTarget>;
  toAccount: Record<string, ValueTarget>;
  currency: Record<string, ValueTarget>;
  autoCreate: boolean;
}

export interface ValueCandidate { value: string; count: number; target: ValueTarget }

const idTarget = (id: string): ValueTarget => `id:${id}`;

function findByName<T extends { name: string }>(list: T[], name: string): T | undefined {
  const n = normValue(name);
  return n ? list.find(t => normValue(t.name) === n) : undefined;
}

/** 默认解析：先按名字找已有的，找不到就按源名新建（界面里可逐条改） */
export function autoTarget(kind: "category" | "account" | "currency", value: string, cfg: LedgerConfig, rows: ParsedBillRow[]): ValueTarget {
  const n = normValue(value);
  if (!n) return "";
  if (kind === "currency") {
    const code = /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : "";
    if (code) return idTarget(code);
    const cur = cfg.currencies.find(c => normValue(c.name) === n || normValue(c.code) === n);
    return cur ? idTarget(cur.code) : "";
  }
  if (kind === "account") {
    const a = findByName(cfg.accounts, value);
    return a ? idTarget(a.id) : "new";
  }
  const rowKind = kindOfCategoryForValue(rows, value);
  const c = findByName(cfg.categories.filter(x => x.kind === rowKind), value);
  return c ? idTarget(c.id) : "new";
}

/** 源分类名主要出现在哪种收支里，决定它该建到哪一组类别下 */
function kindOfCategoryForValue(rows: ParsedBillRow[], value: string): LedgerKind {
  const n = normValue(value);
  let inc = 0, exp = 0;
  rows.forEach(r => { if (normValue(r.category) === n) { if (r.kind === "income") inc++; else exp++; } });
  return inc > exp ? "income" : "expense";
}

/** 统计某个源值出现次数（界面展示用） */
export function valueCounts(rows: ParsedBillRow[], get: (r: ParsedBillRow) => string): Map<string, number> {
  const m = new Map<string, number>();
  rows.forEach(r => { const v = (get(r) || "").trim(); if (v) m.set(v, (m.get(v) ?? 0) + 1); });
  return m;
}

/** 为值映射表补齐默认值（新识别 / 换了映射后调用；保留用户已改过的条目） */
export function ensureValueMaps(cfg: LedgerConfig, rows: ParsedBillRow[], maps: ValueMaps): ValueMaps {
  const next: ValueMaps = {
    category: { ...maps.category }, account: { ...maps.account },
    toAccount: { ...maps.toAccount }, currency: { ...maps.currency },
    autoCreate: maps.autoCreate ?? true,
  };
  const fill = (key: "category" | "account" | "toAccount" | "currency", get: (r: ParsedBillRow) => string) => {
    valueCounts(rows, get).forEach((_c, v) => {
      if (!Object.prototype.hasOwnProperty.call(next[key], v)) next[key][v] = autoTarget(key === "currency" ? "currency" : key === "account" || key === "toAccount" ? "account" : "category", v, cfg, rows);
    });
  };
  fill("category", r => r.category);
  fill("account", r => r.account);
  fill("toAccount", r => r.toAccount);
  fill("currency", r => r.currency);
  return next;
}

/* ────────────────────────── 落库：生成记录 ────────────────────────── */

export interface ImportOptions {
  ledgerId: string;
  skipDup: boolean;
  autoCreate: boolean;
  forceKind?: LedgerKind;       // 整批强制方向（来源不区分收支、或转账想按收支入账时用）
}

export interface ImportPlan {
  records: LedgerRecord[];
  createdCategories: string[];  // 展示用的名称
  createdAccounts: string[];
  skippedDup: number;
  skippedError: number;
  batchId: string;
}

const uid = () => `i${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

const targetOf = (table: Record<string, ValueTarget>, kind: "category" | "account" | "currency", value: string, cfg: LedgerConfig, rows: ParsedBillRow[]): ValueTarget =>
  Object.prototype.hasOwnProperty.call(table, value) ? table[value] : autoTarget(kind, value, cfg, rows);

/** 把勾选的行变成 LedgerRecord（会往 cfg 里补新建的账户 / 类别 / 二级），调用方负责 save */
export function planImport(
  cfg: LedgerConfig, rows: ParsedBillRow[], selected: boolean[], maps: ValueMaps, opts: ImportOptions,
): ImportPlan {
  const acctByName: Record<string, string> = {};
  cfg.accounts.forEach(a => { if (!acctByName[a.name]) acctByName[a.name] = a.id; });
  const createdAccountNames: string[] = [];
  const createdCategoryNames: string[] = [];
  /** "" 表示这一行的账户解析失败（后面按未分类处理） */
  const accountFor = (value: string, table: Record<string, ValueTarget>): string => {
    if (!value) return "";
    const target = targetOf(table, "account", value, cfg, rows);
    if (!target) return "";
    if (target.startsWith("id:")) return target.slice(3);
    const name = (target === "new" ? value : target.slice(4)).trim();
    if (!name) return "";
    const hit = cfg.accounts.find(a => a.name === name);
    if (hit) { acctByName[name] = hit.id; return hit.id; }
    if (acctByName[name]) return acctByName[name];
    const id = uid();
    cfg.accounts.push({ id, name, currency: cfg.baseCurrency, opening: 0 });
    acctByName[name] = id;
    createdAccountNames.push(name);
    return id;
  };

  const catCache: Record<string, string> = {};
  const categoryFor = (value: string, sub: string, kind: LedgerKind): { catId: string; subId: string } => {
    if (!value) return { catId: "", subId: "" };
    const key = `${kind}|${value}|${sub}`;
    if (catCache[key]) { const p = catCache[key].split("|"); return { catId: p[0], subId: p[1] === "_" ? "" : p[1] }; }
    const target = targetOf(maps.category, "category", value, cfg, rows);
    let catId = "";
    if (target.startsWith("id:")) catId = target.slice(3);
    else if (target) {
      const name = (target === "new" ? value : target.slice(4)).trim();
      const found = name ? cfg.categories.find(c => c.kind === kind && normValue(c.name) === normValue(name)) : undefined;
      if (found) catId = found.id;
      else if (name) {
        catId = uid();
        cfg.categories.push({ id: catId, name, kind, subs: [] });
        createdCategoryNames.push(`${name}${kind === "income" ? "（收入）" : ""}`);
      }
    }
    let subId = "";
    if (catId && sub) {
      const cat = cfg.categories.find(c => c.id === catId)!;
      const hit = cat.subs.find(s => normValue(s.name) === normValue(sub));
      if (hit) subId = hit.id;
      else if (opts.autoCreate) { subId = uid(); cat.subs.push({ id: subId, name: sub }); }
    }
    catCache[key] = `${catId}|${subId || "_"}`;
    return { catId, subId };
  };

  const batchId = makeBillId();
  const records: LedgerRecord[] = [];
  let skippedDup = 0, skippedError = 0;

  rows.forEach((r, i) => {
    if (!selected[i]) return;
    if (r.error) { skippedError++; return; }
    if (opts.skipDup && r.dup) { skippedDup++; return; }
    const kind: LedgerKind = opts.forceKind ?? r.kind;
    const accountId = accountFor(r.account, maps.account);
    if (kind === "transfer" && accountId && accountFor(r.toAccount, maps.toAccount) === accountId) { skippedError++; return; }
    const toAccountId = kind === "transfer" ? accountFor(r.toAccount, maps.toAccount) : "";
    const { catId, subId } = kind === "transfer" ? { catId: "", subId: "" } : categoryFor(r.category, r.subcategory, kind);
    const curTarget = r.currency ? targetOf(maps.currency, "currency", r.currency, cfg, rows) : "";
    const currency = curTarget.startsWith("id:") ? curTarget.slice(3) : cfg.baseCurrency;
    if (currency !== cfg.baseCurrency && !cfg.currencies.find(c => c.code === currency)) {
      cfg.currencies.push({ code: currency, name: currency, rate: 1 });
    }
    const rec: LedgerRecord = {
      id: uid(), date: r.date, kind, amount: r.amount,
      categoryId: catId, subId: subId || undefined,
      accountId, toAccountId: toAccountId || undefined,
      ledgerId: opts.ledgerId || cfg.ledgers[0]?.id || "",
      refund: r.refund || 0, discount: r.discount || 0,
      note: r.note || "", tags: r.tags || [],
      currency, address: "", creator: r.creator || cfg.username || "", other: "", files: [],
      createdAt: batchCreatedAt(r),
      clock: r.clock || undefined,
      importBatchId: batchId,
    };
    records.push(rec);
  });

  return { records, createdCategories: createdCategoryNames, createdAccounts: createdAccountNames, skippedDup, skippedError, batchId };
}

/** 记录时间戳：文件里带 HH:mm 时用它，方便同一天内按时间排序 */
function batchCreatedAt(r: ParsedBillRow): number {
  if (!r.clock) return Date.now();
  const [h, m] = r.clock.split(":").map(Number);
  const d = new Date(`${r.date}T00:00:00`);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

/* ────────────────────────── 导出 ────────────────────────── */

export interface ExportCol { key: string; label: string; get: (r: LedgerRecord, cfg: LedgerConfig, names: NameMaps) => string | number }
export interface NameMaps {
  cat: Record<string, string>; sub: Record<string, string>; acct: Record<string, string>;
  ledger: Record<string, string>; user: Record<string, string>;
}

export const EXPORT_COLUMNS: ExportCol[] = [
  { key: "date", label: "日期", get: (r) => r.date },
  { key: "clock", label: "时间", get: (r) => r.clock || "" },
  { key: "kind", label: "收支类型", get: (r) => (r.kind === "income" ? "收入" : r.kind === "transfer" ? "转账" : "支出") },
  { key: "amount", label: "金额", get: (r, cfg) => (r.kind === "expense" ? -r.amount : r.amount) },
  { key: "category", label: "类别", get: (r, _c, n) => n.cat[r.categoryId] ?? "" },
  { key: "subcategory", label: "二级分类", get: (r, _c, n) => n.sub[r.subId ?? ""] ?? "" },
  { key: "account", label: "账户", get: (r, _c, n) => n.acct[r.accountId] ?? "" },
  { key: "toAccount", label: "转入账户", get: (r, _c, n) => (r.kind === "transfer" ? n.acct[r.toAccountId ?? ""] ?? "" : "") },
  { key: "ledger", label: "账本", get: (r, _c, n) => n.ledger[r.ledgerId] ?? "" },
  { key: "currency", label: "币种", get: (r) => r.currency || "" },
  { key: "refund", label: "退款", get: (r) => r.refund || "" },
  { key: "discount", label: "优惠", get: (r) => r.discount || "" },
  { key: "note", label: "备注", get: (r) => r.note || "" },
  { key: "tags", label: "标签", get: (r) => (r.tags || []).join(",") },
  { key: "reimbAmount", label: "报销金额", get: (r) => r.reimbAmount || "" },
  { key: "address", label: "地址", get: (r) => r.address || "" },
  { key: "creator", label: "创建用户", get: (r) => r.creator || "" },
  { key: "createdAt", label: "创建时间", get: (r) => new Date(r.createdAt || 0).toLocaleString("zh-CN") },
];

export const EXPORT_PRESETS: Record<string, { label: string; cols: string[] }> = {
  daybook: { label: "Daybook 模板（可原样回灌）", cols: ["date", "clock", "kind", "amount", "category", "subcategory", "account", "toAccount", "ledger", "currency", "refund", "discount", "note", "tags", "address", "creator"] },
  yimu: { label: "一木记账格式", cols: ["date", "kind", "amount", "category", "subcategory", "account", "ledger", "refund", "discount", "note", "tags", "creator"] },
  simple: { label: "精简（日期/类型/金额/类别/账户/备注）", cols: ["date", "kind", "amount", "category", "account", "note"] },
};

export function buildExportCsv(records: LedgerRecord[], cfg: LedgerConfig, cols: ExportCol[]): string {
  const names: NameMaps = { cat: {}, sub: {}, acct: {}, ledger: {}, user: {} };
  cfg.categories.forEach(c => { names.cat[c.id] = c.name; c.subs.forEach(s => { names.sub[s.id] = s.name; }); });
  cfg.accounts.forEach(a => { names.acct[a.id] = a.name; });
  cfg.ledgers.forEach(l => { names.ledger[l.id] = l.name; });
  const aoa: (string | number)[][] = [cols.map(c => c.label)];
  records.forEach(r => aoa.push(cols.map(c => c.get(r, cfg, names))));
  return "\uFEFF" + toCsv(aoa);
}
