/**
 * planOverview.ts — 计划任务总览的分组逻辑（纯函数，可单测）
 *
 * 把所有计划块里的任务汇聚成一张清单，按优先级或截止日期分组；
 * 总览只列未完成的任务（勾选完成即从总览消失），写回原文件由视图层处理。
 * 日期分组用纯 Date 运算，不依赖 moment，便于单测。
 */

import type { DayGroup, JournalEntry, TodoItem } from "./fileReader";
import type { PlanSortKey } from "./settings";

/** 一条总览任务：任务本身 + 所属计划块条目（勾选级联与详情编辑需要） */
export interface PlanOverviewTask {
  entry: JournalEntry;
  todo: TodoItem;
}

/**
 * 从计划条目里收集任务：collectAllPlanTasks 收全部（含已完成），
 * collectPlanTasks 只收未完成的（已放弃的任务两者都不收）。
 * 只收顶级任务：子任务折叠在父任务下，由视图层点击父任务展开渲染，
 * 否则分组排序会把父子拆散到不同组（各自的截止日/优先级不同）。
 */
export function collectAllPlanTasks(entries: JournalEntry[]): PlanOverviewTask[] {
  const out: PlanOverviewTask[] = [];
  for (const e of entries) {
    if (e.renderType !== "plans" || e.abandoned) continue;
    for (const t of e.todos ?? []) {
      if (t.indent) continue;
      out.push({ entry: e, todo: t });
    }
  }
  return out;
}

/** 某父任务的子任务区间：todos 数组里紧跟其后、indent 为真的若干条 */
export function childTodosOfParent(entry: JournalEntry, parent: TodoItem): TodoItem[] {
  const todos = entry.todos ?? [];
  const i = todos.indexOf(parent);
  if (i === -1) return [];
  const out: TodoItem[] = [];
  for (let j = i + 1; j < todos.length && todos[j].indent; j++) out.push(todos[j]);
  return out;
}

/**
 * 单条顶级任务是否算「已完成」：有子任务看子任务有没有全勾完，
 * 没子任务看自身勾选。与 planTodoProgress 同口径（父行不重复计数），
 * 「隐藏已完成」按这个粒度剔除任务，整块完成的任务卡片才消失。
 */
export function planTaskDone(entry: JournalEntry, todo: TodoItem): boolean {
  const kids = childTodosOfParent(entry, todo);
  return kids.length > 0 ? kids.every(k => k.done) : todo.done;
}

/** 从计划条目里收集未完成的任务（分组视图「隐藏已完成」口径） */
export function collectPlanTasks(entries: JournalEntry[]): PlanOverviewTask[] {
  return collectAllPlanTasks(entries).filter(t => !planTaskDone(t.entry, t.todo));
}

export type PlanGroupMode = "priority" | "date" | "tag";

export interface PlanTaskGroup {
  key: string;
  label: string;
  tasks: PlanOverviewTask[];
}

/** 今天 + n 天（本地时区，YYYY-MM-DD） */
function addDays(today: string, n: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** 无截止日排在最后：用哨兵日期代替 undefined 参与字符串比较 */
const NO_DUE = "9999-12-31";

/** 创建时间键：任务的 [createdAt::] 优先，缺失时退回所属日记块的日期时间 */
function createdKey(t: PlanOverviewTask): string {
  return t.todo.createdAt ?? `${t.entry.date} ${t.entry.time ?? "00:00"}`;
}

/** 优先级 Ⅰ→Ⅳ（未标注按 Ⅱ 处理，与 effectivePriority 一致） */
function priorityKey(t: PlanOverviewTask): string {
  return t.todo.priority ?? "2";
}

/**
 * 组内排序比较器（方向固定，不单独提供升降序开关）：
 * - created：新→旧
 * - due：截止日升序，无截止日垫底
 * - priority：Ⅰ 重要且紧急 → Ⅳ 不重要不紧急
 * - title：任务文本中文升序
 * 平手时交给 Array.sort 的稳定性保留文件原序（拖拽结果）。
 */
const SORTERS: Record<PlanSortKey, (a: PlanOverviewTask, b: PlanOverviewTask) => number> = {
  created: (a, b) => createdKey(b).localeCompare(createdKey(a)),
  due: (a, b) => (a.todo.dueDate ?? NO_DUE).localeCompare(b.todo.dueDate ?? NO_DUE)
    || priorityKey(a).localeCompare(priorityKey(b)),
  priority: (a, b) => priorityKey(a).localeCompare(priorityKey(b))
    || (a.todo.dueDate ?? NO_DUE).localeCompare(b.todo.dueDate ?? NO_DUE),
  title: (a, b) => a.todo.text.localeCompare(b.todo.text, "zh"),
};

/** 按指定键排好序返回新数组（不改入参） */
export function sortPlanTasks(
  tasks: PlanOverviewTask[],
  key: PlanSortKey
): PlanOverviewTask[] {
  return tasks.slice().sort(SORTERS[key]);
}

/** 组内排序比较器（默认按截止日） */
type Cmp = (a: PlanOverviewTask, b: PlanOverviewTask) => number;

/**
 * 分组：
 * - priority：I 重要且紧急 → IV 不重要不紧急
 * - date：逾期 → 今天 → 明天 → 7 天内 → 以后 → 无截止日
 * - tag：按任务的第一个有效标签（排除 #pinned/#abandoned），无标签归入"未分类"
 * @param sortKey 组内排序键，默认按截止日（保持旧调用行为）
 */
export function groupPlanTasks(
  tasks: PlanOverviewTask[],
  mode: PlanGroupMode,
  today: string,
  sortKey: PlanSortKey = "due"
): PlanTaskGroup[] {
  const by: Cmp = SORTERS[sortKey];
  if (mode === "priority") {
    const defs: [string, string][] = [
      ["1", "I 重要且紧急"],
      ["2", "II 重要不紧急"],
      ["3", "III 不重要但紧急"],
      ["4", "IV 不重要不紧急"],
    ];
    return defs.map(([key, label]) => ({
      key,
      label,
      tasks: tasks.filter(t => (t.todo.priority ?? "2") === key).sort(by),
    }));
  }

  if (mode === "tag") {
    // 第一个非状态标签作为分组键，按标签名排序，"未分类"固定垫底
    const buckets = new Map<string, PlanOverviewTask[]>();
    for (const t of tasks) {
      const tag = (t.entry.tags ?? []).filter(x => x !== "pinned" && x !== "abandoned")[0];
      const key = tag ?? "__none__";
      const list = buckets.get(key) ?? [];
      list.push(t);
      buckets.set(key, list);
    }
    const groups: PlanTaskGroup[] = [];
    for (const [key, list] of buckets) {
      if (key !== "__none__") {
        groups.push({ key, label: `#${key}`, tasks: list.sort(by) });
      }
    }
    groups.sort((a, b) => a.key.localeCompare(b.key, "zh"));
    const none = buckets.get("__none__");
    if (none && none.length > 0) {
      groups.push({ key: "__none__", label: "未分类", tasks: none.sort(by) });
    }
    return groups;
  }

  const buckets: Record<string, PlanOverviewTask[]> = {
    overdue: [], today: [], tomorrow: [], week: [], later: [], none: [],
  };
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);
  for (const t of tasks) {
    const d = t.todo.dueDate;
    if (!d) buckets.none.push(t);
    else if (d < today) buckets.overdue.push(t);
    else if (d === today) buckets.today.push(t);
    else if (d === tomorrow) buckets.tomorrow.push(t);
    else if (d <= weekEnd) buckets.week.push(t);
    else buckets.later.push(t);
  }
  const meta: [string, string][] = [
    ["overdue", "⚠ 逾期"],
    ["today", "今天"],
    ["tomorrow", "明天"],
    ["week", "7 天内"],
    ["later", "以后"],
    ["none", "无截止日"],
  ];
  return meta.map(([key, label]) => ({ key, label, tasks: buckets[key].sort(by) }));
}

/** 截止日的友好显示（逾期返回 null，由调用方用"逾期"徽标表达） */
export function planDueLabel(dueDate: string, today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const base = new Date(y, m - 1, d).getTime();
  const [yy, mm, dd] = dueDate.split("-").map(Number);
  const diff = Math.round((new Date(yy, mm - 1, dd).getTime() - base) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff < 0) return `${Math.abs(diff)}天前`;
  if (diff <= 7) return `${diff}天后`;
  return `${mm}月${dd}日`;
}

/** 截止日是否已逾期（不含今天） */
export function planDueOverdue(dueDate: string, today: string): boolean {
  return dueDate < today;
}
