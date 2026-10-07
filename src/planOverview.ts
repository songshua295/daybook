/**
 * planOverview.ts — 计划任务总览的分组逻辑（纯函数，可单测）
 *
 * 把所有计划块里的任务汇聚成一张清单，按优先级或截止日期分组；
 * 总览只列未完成的任务（勾选完成即从总览消失），写回原文件由视图层处理。
 * 日期分组用纯 Date 运算，不依赖 moment，便于单测。
 */

import type { DayGroup, JournalEntry, TodoItem } from "./fileReader";

/** 一条总览任务：任务本身 + 所属计划块条目（勾选级联与详情编辑需要） */
export interface PlanOverviewTask {
  entry: JournalEntry;
  todo: TodoItem;
}

/**
 * 从计划条目里收集任务：collectAllPlanTasks 收全部（含已完成），
 * collectPlanTasks 只收未完成的（已放弃的任务两者都不收）。
 */
export function collectAllPlanTasks(entries: JournalEntry[]): PlanOverviewTask[] {
  const out: PlanOverviewTask[] = [];
  for (const e of entries) {
    if (e.renderType !== "plans" || e.abandoned) continue;
    for (const t of e.todos ?? []) {
      out.push({ entry: e, todo: t });
    }
  }
  return out;
}

/** 从计划条目里收集未完成的任务（总览分组默认口径） */
export function collectPlanTasks(entries: JournalEntry[]): PlanOverviewTask[] {
  return collectAllPlanTasks(entries).filter(t => !t.todo.done);
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

/** 组内排序：有截止日在前（升序），无截止日在后；同级按优先级、再按加入顺序 */
function byDue(a: PlanOverviewTask, b: PlanOverviewTask): number {
  const da = a.todo.dueDate ?? "9999-12-31";
  const db = b.todo.dueDate ?? "9999-12-31";
  if (da !== db) return da.localeCompare(db);
  return (a.todo.priority ?? "2").localeCompare(b.todo.priority ?? "2");
}

/**
 * 分组：
 * - priority：I 重要且紧急 → IV 不重要不紧急
 * - date：逾期 → 今天 → 明天 → 7 天内 → 以后 → 无截止日
 * - tag：按任务的第一个有效标签（排除 #pinned/#abandoned），无标签归入"未分类"
 */
export function groupPlanTasks(
  tasks: PlanOverviewTask[],
  mode: PlanGroupMode,
  today: string
): PlanTaskGroup[] {
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
      tasks: tasks.filter(t => (t.todo.priority ?? "2") === key).sort(byDue),
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
        groups.push({ key, label: `#${key}`, tasks: list.sort(byDue) });
      }
    }
    groups.sort((a, b) => a.key.localeCompare(b.key, "zh"));
    const none = buckets.get("__none__");
    if (none && none.length > 0) {
      groups.push({ key: "__none__", label: "未分类", tasks: none.sort(byDue) });
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
  return meta.map(([key, label]) => ({ key, label, tasks: buckets[key].sort(byDue) }));
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
