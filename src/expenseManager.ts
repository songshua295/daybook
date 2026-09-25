/**
 * expenseManager.ts — 记账模块（数据层）
 *
 * 存储：与其他章节一致，写入当日日记文件的 `# 记账` 小节，
 * 每条一行（appendToFile 自动加 "- HH:mm " 前缀）：
 *   - 09:30 [amt::-18.00] [cat::餐饮] 午餐
 * 行内字段约定：
 * - amt：带符号金额，负数=支出、正数=收入（必填，无字段则按普通文本渲染）
 * - cat：分类名（可省略）
 * - 剩余文字为备注
 */

/** 默认支出分类（首次运行时写入 settings.expenseCategories，之后在记账页就地管理） */
export const DEFAULT_EXPENSE_CATEGORIES = ["餐饮", "交通", "购物", "居住", "娱乐", "医疗", "其他"];

export type ExpenseKind = "expense" | "income";

/** 解析后的记账条目 */
export interface ExpenseParsed {
  amount: number;       // 带符号：负=支出
  category?: string;
  note: string;
}

/** 生成写入日记的行内内容（不含 "- HH:mm " 前缀） */
export function buildExpenseContent(opts: {
  kind: ExpenseKind;
  amount: number;
  category?: string;
  note?: string;
}): string {
  const signed = opts.kind === "expense" ? -Math.abs(opts.amount) : Math.abs(opts.amount);
  let line = `[amt::${signed.toFixed(2)}]`;
  const cat = opts.category?.trim();
  if (cat) line += ` [cat::${cat}]`;
  const note = opts.note?.trim();
  if (note) line += ` ${note}`;
  return line;
}

/** 解析记账条目正文（entry.text）；无 amt 字段返回 null（视为普通文本兜底渲染） */
export function parseExpenseText(text: string): ExpenseParsed | null {
  const amtMatch = text.match(/\[amt::(-?)\d+(?:\.\d+)?\]/i);
  if (!amtMatch) return null;
  const amount = parseFloat(text.match(/\[amt::(-?\d+(?:\.\d+)?)\]/i)![1]);
  const catMatch = text.match(/\[cat::([^\]]*)\]/i);
  const category = catMatch?.[1].trim() || undefined;
  const note = text
    .replace(/\[amt::-?\d+(?:\.\d+)?\]/i, "")
    .replace(/\[cat::[^\]]*\]/i, "")
    .trim();
  return { amount, category, note };
}

/** 金额展示：1234.5 → "1,234.50"（整数不带小数） */
export function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const fixed = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  const [int, dec] = fixed.split(".");
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec ? `${withSep}.${dec}` : withSep;
}

/** 解析用户输入的金额文本；非法返回 null */
export function parseAmountInput(raw: string): number | null {
  const v = parseFloat(raw.replace(/[¥￥,\s]/g, ""));
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100) / 100;
}
