/**
 * filters.ts — 章节内容筛选（纯逻辑层，无 Obsidian 运行时依赖，可单测）
 *
 * 设计：一个 SectionFilter 结构承载全部维度，各章节类型只渲染并应用自己相关的维度。
 * 记录流（闪念/计划）走 matchEntry；习惯章节的对象是习惯本身，走 matchHabit。
 */

import { planTodoProgress } from "./fileReader";
import type { JournalEntry, TodoItem } from "./fileReader";

/* ── 取值类型 ── */

/** 有无类筛选：不限 / 有 / 无 */
export type Presence = "any" | "with" | "without";
/** 归档态：未归档（默认）/ 已归档；"all" 仅作历史兼容值（等同未归档展示） */
export type StatusFilter = "all" | "active" | "archived";
/** 完成态 */
export type CompletionFilter = "all" | "done" | "undone";
/** 日期快捷范围 */
export type DatePreset = "" | "today" | "7d" | "30d" | "month" | "lastmonth" | "custom";
/** 习惯某天状态 */
export type CheckinFilter = "all" | "checked" | "skipped" | "rest" | "none";

/** 一条完整的筛选条件（含各类型专属维度） */
export interface SectionFilter {
  q: string;                    // 关键词：空格分隔多关键字，全部命中（模糊、忽略大小写）
  tags: string[];               // 标签：需命中全部（可叠加多个）
  datePreset: DatePreset;       // 日期范围
  dateFrom: string;             // 自定义起止 YYYY-MM-DD
  dateTo: string;
  status: StatusFilter;         // 归档态
  pinnedOnly: boolean;          // 只看置顶
  links: Presence;              // 有无链接（双链 / Markdown 链接 / 外链）
  attachments: Presence;        // 有无附件（图片、音视频等嵌入）
  moods: string[];              // 闪念：心情 emoji
  completion: CompletionFilter; // 计划：完成态
  priorities: string[];         // 计划：优先级 "1".."4"
  overdueOnly: boolean;         // 计划：只看已过期未完成
  dueOnly: boolean;             // 计划：只看设了截止日的
  checkins: CheckinFilter;      // 习惯：今日打卡状态
  shouldToday: boolean;         // 习惯：只看今天该执行的
  quick: string[];              // 快捷筛选（搜索面板 pills）：noneTag / hasAudio / onThisDay，多选 AND
}

/** 习惯的最小结构（避免引入 habitManager 运行时依赖） */
export interface HabitLike {
  id: string;
  name: string;
  icon: string;
  startDate: string;
  archived?: boolean;
  executeDays?: number[];       // 1=周一…7=周日；空 = 每天
}

/** 打卡记录行的最小结构 */
export interface CheckinRowLike {
  habitId: string;
  date: string;
  time?: string;
  note?: string;
  skipped: boolean;
}

/* ── 空值与激活判断 ── */

export function emptyFilter(): SectionFilter {
  return {
    q: "", tags: [], datePreset: "", dateFrom: "", dateTo: "",
    status: "active", pinnedOnly: false, links: "any", attachments: "any",
    moods: [], completion: "all", priorities: [], overdueOnly: false, dueOnly: false,
    checkins: "all", shouldToday: false, quick: [],
  };
}

/** 该维度是否已设置（决定面板里对应行的高亮与徽标计数） */
export function isFilterActive(f: SectionFilter): boolean {
  return activeDimensions(f).length > 0;
}

/** 返回已生效的维度标签（用于按钮徽标数与结果区摘要） */
export function activeDimensions(f: SectionFilter): string[] {
  const out: string[] = [];
  if (f.q.trim()) out.push("关键词");
  if (f.tags.length) out.push("标签");
  if (f.datePreset) out.push("日期");
  if (f.status === "archived") out.push("归档");   // active 是默认展示，不算生效维度
  if (f.pinnedOnly) out.push("置顶");
  if (f.links !== "any") out.push("链接");
  if (f.attachments !== "any") out.push("附件");
  if (f.moods.length) out.push("心情");
  if (f.completion !== "all") out.push("完成度");
  if (f.priorities.length) out.push("优先级");
  if (f.overdueOnly) out.push("逾期");
  if (f.dueOnly) out.push("截止日");
  if (f.checkins !== "all") out.push("打卡");
  if (f.shouldToday) out.push("今日应打卡");
  if (f.quick.length) out.push("快捷");
  return out;
}

/* ── 日期 ── */

/** YYYY-MM-DD → 本地零点钟点毫秒（避免 new Date("YYYY-MM-DD") 的 UTC 偏移） */
function dayStart(str: string): number {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

function toDateStr(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDays(str: string, days: number): string {
  return toDateStr(dayStart(str) + days * 86400000);
}

/** ISO 星期：1=周一 … 7=周日 */
export function isoWeekday(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const w = new Date(y, (m || 1) - 1, d || 1).getDay();
  return w === 0 ? 7 : w;
}

/** 解析筛选条件的日期闭区间；未设日期范围返回 null */
export function dateBounds(f: SectionFilter, today: string): [string, string] | null {
  if (f.datePreset === "today") return [today, today];
  if (f.datePreset === "7d") return [shiftDays(today, -6), today];
  if (f.datePreset === "30d") return [shiftDays(today, -29), today];
  if (f.datePreset === "month") return [`${today.slice(0, 8)}01`, today];
  if (f.datePreset === "lastmonth") {
    const [y, m] = today.split("-").map(Number);
    const lastPrev = new Date(y, m - 1, 0);          // 上月最后一天
    return [toDateStr(new Date(y, m - 2, 1).getTime()), toDateStr(lastPrev.getTime())];
  }
  if (f.datePreset === "custom") {
    const from = f.dateFrom || "0000-01-01";
    const to = f.dateTo || "9999-12-31";
    return from <= to ? [from, to] : [to, from];
  }
  return null;
}

/* ── 文本 / 链接 / 附件 ── */

/** 空格分隔多关键字，全部命中（子串、忽略大小写） */
export function keywordMatch(text: string, q: string): boolean {
  const hay = text.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(k => hay.includes(k.toLowerCase()));
}

/** 附件扩展名（图片 / 音视频 / 文档） */
const ATTACHMENT_EXTS = [
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "ico",
  "mp3", "m4a", "wav", "ogg", "flac", "webm", "mp4", "mov", "mkv",
  "pdf", "epub", "zip", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
];

interface FoundLinks {
  links: number;        // 指向笔记 / 外链
  embeds: number;       // ![[..]] 嵌入
  attachments: number;  // 指向附件文件的链接或嵌入
}

/** 扫描正文中的链接与附件（双链、Markdown 链接、裸 URL） */
export function scanLinks(text: string): FoundLinks {
  const res: FoundLinks = { links: 0, embeds: 0, attachments: 0 };
  const targets: { target: string; embed: boolean }[] = [];

  const wiki = /(!?)\[\[([^\]|#^]*)(?:#[^\]|^]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wiki.exec(text)) !== null) {
    targets.push({ target: m[2].trim(), embed: m[1] === "!" });
  }
  const md = /(!?)\[[^\]]*\]\(\s*([^)\s]+)/g;
  while ((m = md.exec(text)) !== null) {
    targets.push({ target: m[2].trim(), embed: m[1] === "!" });
  }
  const plain = wikiLinkFree(text);
  const bare = plain.match(/https?:\/\/\S+/gi);
  if (bare) res.links += bare.length;

  for (const t of targets) {
    const ext = (t.target.split(".").pop() || "").toLowerCase();
    const isTargetFile = t.target.includes(".") && ATTACHMENT_EXTS.includes(ext);
    if (isTargetFile) {
      res.attachments += 1;
      if (t.embed) res.embeds += 1;
    } else {
      if (t.embed) res.embeds += 1;   // 嵌入非附件（如笔记段落嵌入）
      else res.links += 1;
    }
  }
  return res;
}

/** 去掉 [[..]] 与 [..](..) 后剩余的文字（用于裸 URL 检测，避免与已计数链接重复） */
function wikiLinkFree(text: string): string {
  return text
    .replace(/(!?)\[\[[^\]]*\]\]/g, " ")
    .replace(/(!?)\[[^\]]*\]\([^)]*\)/g, " ");
}

/** 去掉行内字段（[amt::1] / [createdAt::…] 等），避免关键词命中元数据 */
export function stripInlineFields(text: string): string {
  return text.replace(/\[[a-zA-Z][\w-]*::[^\]]*\]/g, " ");
}

/** 参与关键词搜索的正文（计划含各任务行） */
function searchableText(entry: JournalEntry): string {
  const parts = [stripInlineFields(entry.text), entry.sectionLabel];
  (entry.todos ?? []).forEach(t => parts.push(stripInlineFields(t.text)));
  return parts.join("\n");
}

/* ── 计划维度 ── */

/** 任务实际优先级（与 fileReader.effectivePriority 一致，此处内联以免引入运行时依赖） */
function prioOf(t: TodoItem | { priority?: string | null }): string {
  return t.priority ?? "2";
}

/**
 * 计划块是否已完成：口径与进度条/Dashboard 的 planTodoProgress 统一——
 * 有任务且进度满格（done === total，带子任务的组按子任务计）。
 * 空计划块（没有任何任务）视为已完成：没承诺即没欠账。
 */
export function planDone(todos: TodoItem[] | undefined): boolean {
  const { done, total } = planTodoProgress(todos ?? []);
  return total === 0 || done === total;
}

/** 计划块是否存在未完成 / 过期 / 设了截止日的任务 */
export function planFlags(todos: TodoItem[] | undefined, today: string) {
  const list = todos ?? [];
  return {
    hasTodo: list.length > 0,
    undone: list.some(t => !t.done),
    due: list.some(t => !!t.dueDate),
    overdue: list.some(t => !t.done && !!t.dueDate && t.dueDate < today),
  };
}

/* ── 记录流筛选（闪念 / 计划） ── */

/** 一条记录是否命中全部筛选条件 */
export function matchEntry(entry: JournalEntry, f: SectionFilter, today: string): boolean {
  const bounds = dateBounds(f, today);
  if (bounds && (entry.date < bounds[0] || entry.date > bounds[1])) return false;

  if (f.status === "archived" && !entry.archived) return false;
  if (f.status === "active" && entry.archived) return false;
  if (f.pinnedOnly && !entry.pinned) return false;

  const q = f.q.trim();
  if (q && !keywordMatch(searchableText(entry), q)) return false;

  if (f.tags.length) {
    const own = entry.tags ?? [];
    // 多标签 = 必须全部包含（点击标签叠加筛选时按 AND 组合）
    if (!f.tags.every(t => own.includes(t))) return false;
  }

  if (f.quick.length) {
    const own = entry.tags ?? [];
    const scan = scanLinks(entry.text);
    const hasLink = scan.links + scan.embeds > 0;
    const hasImage = scan.embeds + scan.attachments > 0 || /!\[[^\]]*\]\(|![^[]*\[[^\]]*\]\([^)]*\)/.test(entry.text);
    const hasAudio = /\.(mp3|m4a|wav|ogg|flac|webm)\b/i.test(entry.text);
    const isToday = entry.date === today;
    const isOnThisDay = entry.date.slice(5) === today.slice(5) && entry.date.slice(0, 4) !== today.slice(0, 4);
    for (const qf of f.quick) {
      if (qf === "noneTag" && own.length > 0) return false;
      if (qf === "hasLink" && !hasLink) return false;
      if (qf === "hasImage" && !hasImage) return false;
      if (qf === "hasAudio" && !hasAudio) return false;
      if (qf === "onThisDay" && !isOnThisDay) return false;
      if (qf === "today" && !isToday) return false;
    }
  }

  if (f.links !== "any" || f.attachments !== "any") {
    const scan = scanLinks(entry.text + "\n" + (entry.todos ?? []).map(t => t.text).join("\n"));
    const linkHit = scan.links + scan.embeds + scan.attachments > 0;
    const attachHit = scan.attachments + scan.embeds > 0;
    if (f.links === "with" && !linkHit) return false;
    if (f.links === "without" && linkHit) return false;
    if (f.attachments === "with" && !attachHit) return false;
    if (f.attachments === "without" && attachHit) return false;
  }

  switch (entry.renderType) {
    case "plans": {
      if (f.completion === "done" && !planDone(entry.todos)) return false;
      if (f.completion === "undone" && planDone(entry.todos)) return false;
      const flags = planFlags(entry.todos, today);
      if (f.dueOnly && !flags.due) return false;
      if (f.overdueOnly && !flags.overdue) return false;
      if (f.priorities.length) {
        const list = entry.todos ?? [];
        if (!list.some(t => f.priorities.includes(prioOf(t)))) return false;
      }
      break;
    }
    case "memos": {
      if (f.moods.length) {
        const head = entry.text.trim();
        // 心情以 “emoji 含义 — 正文” 开头写入
        const hit = f.moods.some(m => head === m || head.startsWith(`${m} `) || head.includes(`[mood::${m}]`));
        if (!hit) return false;
      }
      break;
    }
    default:
      break;
  }
  return true;
}

/* ── 习惯筛选 ── */

/** 某天该习惯的状态（与 habitManager.checkinState 同语义） */
export function habitDayState(
  rows: CheckinRowLike[],
  habit: HabitLike,
  date: string
): "checked" | "skipped" | "rest" | "none" {
  const mine = rows.filter(r => r.habitId === habit.id && r.date === date);
  if (mine.some(r => !r.skipped)) return "checked";
  if (mine.some(r => r.skipped)) return "skipped";
  const days = habit.executeDays;
  if (days && days.length > 0 && !days.includes(isoWeekday(date))) return "rest";
  return "none";
}

/** 习惯是否命中筛选（作用对象是习惯列表，而非记录流） */
export function matchHabit(
  habit: HabitLike,
  rows: CheckinRowLike[],
  f: SectionFilter,
  today: string
): boolean {
  if (f.status === "archived" && !habit.archived) return false;
  if (f.status === "active" && habit.archived) return false;

  const q = f.q.trim();
  if (q) {
    const notes = rows.filter(r => r.habitId === habit.id && r.note).map(r => `${r.date} ${r.note}`).join("\n");
    if (!keywordMatch(`${habit.icon} ${habit.name}\n${notes}`, q)) return false;
  }

  if (f.checkins !== "all" && habitDayState(rows, habit, today) !== f.checkins) return false;
  if (f.shouldToday && habitDayState(rows, habit, today) === "rest") return false;

  const bounds = dateBounds(f, today);
  if (bounds) {
    // 日期范围对习惯的含义：该期间内有打卡记录
    const inRange = rows.some(r =>
      r.habitId === habit.id && !r.skipped && r.date >= bounds[0] && r.date <= bounds[1]);
    if (!inRange) return false;
  }
  return true;
}

/* ── 候选值收集（供面板渲染 chips） ── */

/** 从已加载记录里收集出现过的标签，按使用次数倒序 */
export function collectTags(entries: JournalEntry[]): { tag: string; count: number }[] {
  const map = new Map<string, number>();
  entries.forEach(e => (e.tags ?? []).forEach(t => map.set(t, (map.get(t) ?? 0) + 1)));
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"));
}

