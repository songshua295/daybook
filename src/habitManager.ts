/**
 * habitManager.ts — 习惯打卡模块（每习惯一个 md 文件）
 *
 * 数据存储：<diaryFolder>/habits/<文件名>.md
 * - frontmatter 存习惯定义（除日志外全部可选，缺省值见 parseHabitFile）
 * - 正文按 `### YYYY-MM-DD` 分组记录打卡：`- [x] HH:mm - 备注`
 * - `- [-]` = 当日跳过；`- [ ]` = 忽略；尾部 ` +1` 金币后缀读时忽略
 * - 显示名以 frontmatter `name` 为准，文件名只是 sanitize 后的存储句柄
 * - 内部 id = 文件名 stem（改名不丢记录）
 *
 * 格式参考：文档/习惯md文档数据记录格式案例.md
 */

import { App, Notice, TFile, normalizePath, parseYaml, stringifyYaml, moment } from "obsidian";
import type { DaybookSettings } from "./settings";

/* ── 数据模型 ── */

export interface HabitConfig {
  id: string;           // = 文件名 stem，稳定不变
  name: string;         // 显示名（frontmatter name 优先）
  icon: string;         // emoji
  color: string;        // hex
  timesPerDay: number;  // 执行日当天的目标次数（= frequency_value）
  startDate: string;    // YYYY-MM-DD
  archived?: boolean;
  filePath: string;     // habits/<文件名>.md
  executeDays?: number[]; // 1=周一…7=周日；空/缺省 = 每天执行
}

/** 旧 data.json 中的习惯定义（无 filePath），仅供迁移读取 */
export type LegacyHabitDef = Omit<HabitConfig, "filePath"> & { filePath?: string };

/** 一次打卡记录（同一天可有多条） */
export interface CheckinRow {
  habitId: string;
  date: string;       // YYYY-MM-DD
  time?: string;      // HH:mm
  note?: string;
  skipped: boolean;
}

/** 一个习惯文件的完整解析结果 */
export interface HabitData {
  config: HabitConfig;
  rows: CheckinRow[];
  /** frontmatter 原始对象（写回时保留插件不消费的键） */
  rawFrontmatter: Record<string, unknown>;
}

export interface HabitStats {
  todayCount: number;
  currentStreak: number;
  bestStreak: number;
  totalCheckins: number;
}

/* ── 常量与工具 ── */

const HABITS_FILE_LEGACY_NAME = "_habits.md";
const PRESET_COLORS = ["#4caf50", "#ff9800", "#9c27b0", "#2196f3", "#e91e63", "#607d8b", "#f44336", "#3f51b5"];
const LOG_HEADING = "## 📝 打卡日志 (Check-in Log)";

/** 去掉文件系统非法字符，作为存储句柄 */
export function sanitizeHabitName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(0, 60);
}

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PRESET_COLORS[h % PRESET_COLORS.length];
}

/** 归一化日期为 YYYY-MM-DD（补前导零；Date 对象取本地日期） */
function normalizeDate(raw: unknown): string | null {
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, "0")}-${String(raw.getDate()).padStart(2, "0")}`;
  }
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 宽松解析 execute_days：仅保留 1~7，去重升序；全选 = 每天（空数组） */
function normalizeExecuteDays(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const set = new Set<number>();
  for (const v of raw) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n);
  }
  const list = [...set].sort((a, b) => a - b);
  if (list.length === 0 || list.length === 7) return undefined;
  return list;
}

/** 是否执行日（非执行日 = 休息，不打卡不断连） */
export function isExecuteDay(habit: Pick<HabitConfig, "executeDays">, dateStr: string): boolean {
  const list = habit.executeDays;
  if (!list || list.length === 0) return true;
  return list.includes(moment(dateStr, "YYYY-MM-DD").isoWeekday());
}

/* ── 文件路径 ── */

export function habitsFolderPath(settings: DaybookSettings): string {
  const folder = settings.diaryFolder.trim().replace(/\/$/, "");
  return normalizePath(folder ? `${folder}/habits` : "habits");
}

function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/* ── 解析 / 序列化 ── */

function extractFrontmatter(content: string): { fm: Record<string, unknown>; body: string } {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return { fm: {}, body: content };
  try {
    const parsed = parseYaml(m[1]);
    const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    return { fm, body: content.slice(m[0].length) };
  } catch {
    return { fm: {}, body: content };
  }
}

/** 解析日志正文：`### 日期` 分组 + `- [x] HH:mm - 备注` / `- [-]` 跳过 */
function parseHabitRows(habitId: string, body: string): CheckinRow[] {
  const rows: CheckinRow[] = [];
  let currentDate: string | null = null;
  let dayHasSkip = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const dayMatch = line.match(/^#{2,3}\s+(\d{4}-\d{1,2}-\d{1,2})\b/);
    if (dayMatch) {
      currentDate = normalizeDate(dayMatch[1]);
      dayHasSkip = false;
      continue;
    }
    if (!currentDate) continue;
    const itemMatch = line.match(/^-\s*\[([xX-])\]\s*(.*)$/);
    if (!itemMatch) continue; // 含 `- [ ]` 未勾选行
    let rest = itemMatch[2].trim();
    let time: string | undefined;
    const t = rest.match(/^(\d{1,2}:\d{2})(?::\d{2})?\b/);
    if (t) {
      time = /\d{2}:\d{2}/.test(t[1]) ? t[1] : `0${t[1]}`;
      rest = rest.slice(t[0].length).replace(/^\s*[-–—]\s*/, "").trim();
    }
    // 去掉金币后缀（如 " +1"），写回时不再产生
    rest = rest.replace(/\s*\+\d+\s*$/, "").trim();
    const skipped = itemMatch[1] === "-";
    if (skipped && dayHasSkip) continue; // 跳过每日至多一条，取首条
    if (skipped) dayHasSkip = true;
    rows.push({ habitId, date: currentDate, time, note: rest || undefined, skipped });
  }
  return rows;
}

/** 解析单个习惯文件（无 frontmatter 的纯日志文件也可解析） */
export function parseHabitFile(path: string, content: string): HabitData | null {
  const id = fileStem(path);
  if (!id) return null;
  const { fm, body } = extractFrontmatter(content);
  const rows = parseHabitRows(id, body);

  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : id;
  const icon = typeof fm.icon === "string" && fm.icon.trim() ? fm.icon.trim() : "✅";
  const color = typeof fm.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(fm.color.trim())
    ? fm.color.trim()
    : hashColor(name);
  const fv = typeof fm.frequency_value === "number" ? fm.frequency_value : parseInt(String(fm.frequency_value ?? ""), 10);
  const timesPerDay = Number.isFinite(fv) && fv >= 1 ? Math.min(20, Math.floor(fv)) : 1;
  const validity = fm.validity && typeof fm.validity === "object" ? (fm.validity as Record<string, unknown>) : {};
  const startDate = normalizeDate(validity.start_date)
    ?? (rows.length > 0 ? [...rows.map(r => r.date)].sort()[0] : moment().format("YYYY-MM-DD"));

  const config: HabitConfig = {
    id,
    name,
    icon,
    color,
    timesPerDay,
    startDate,
    archived: fm.is_archived === true,
    filePath: path,
    executeDays: normalizeExecuteDays(fm.execute_days),
  };
  return { config, rows, rawFrontmatter: fm };
}

function timeKey(t?: string): string {
  return t ?? "99:99";
}

/**
 * 序列化为习惯 md 文件。
 * 只写"写入策略"命中的键 + 原样保留 rawFrontmatter 中插件不消费的键；
 * 新建文件时传 full=true 写入全部消费键。
 */
export function serializeHabitFile(
  config: HabitConfig,
  rows: CheckinRow[],
  rawFrontmatter: Record<string, unknown> = {},
  full = false
): string {
  const stem = fileStem(config.filePath);
  const fm: Record<string, unknown> = { ...rawFrontmatter };

  if (full || config.name !== stem || fm.name !== undefined) fm.name = config.name;
  else delete fm.name;

  if (full || config.icon !== "✅" || fm.icon !== undefined) fm.icon = config.icon;
  else delete fm.icon;

  if (full || fm.color !== undefined) fm.color = config.color;
  else delete fm.color;

  // frequency_type：只在插件新建时写 "daily"；用户手写的其他值（weekly 等）原样保留
  if (full && fm.frequency_type === undefined) fm.frequency_type = "daily";

  // frequency_value：非 daily 的文件不改写用户的数值语义
  const nonDailyType = typeof fm.frequency_type === "string" && fm.frequency_type.trim().toLowerCase() !== "daily";
  if (config.timesPerDay > 1) fm.frequency_value = config.timesPerDay;
  else if (!nonDailyType) delete fm.frequency_value;

  if (config.archived || fm.is_archived !== undefined) fm.is_archived = !!config.archived;
  else delete fm.is_archived;

  if (config.executeDays && config.executeDays.length > 0) fm.execute_days = [...config.executeDays].sort((a, b) => a - b);
  else delete fm.execute_days;

  const validity = fm.validity && typeof fm.validity === "object" && !Array.isArray(fm.validity)
    ? { ...(fm.validity as Record<string, unknown>) }
    : undefined;
  if (full || validity) {
    fm.validity = { ...(validity ?? {}), start_date: config.startDate };
  } else {
    delete fm.validity;
  }

  const out: string[] = ["---", stringifyYaml(fm).trimEnd(), "---", "", LOG_HEADING, ""];

  const byDate = new Map<string, CheckinRow[]>();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(r);
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  for (const d of dates) {
    out.push(`### ${d}`);
    const group = [...byDate.get(d)!].sort((a, b) => timeKey(a.time).localeCompare(timeKey(b.time)));
    for (const r of group) {
      const note = r.note?.replace(/[\r\n]+/g, " ").trim();
      let line = r.skipped ? "- [-]" : "- [x]";
      if (r.time) line += ` ${r.time}`;
      if (note) line += line.length > 5 ? ` - ${note}` : ` ${note}`;
      out.push(line);
    }
    out.push("");
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

/* ── 加载 ── */

function habitFiles(app: App, settings: DaybookSettings): TFile[] {
  const prefix = habitsFolderPath(settings) + "/";
  return app.vault
    .getMarkdownFiles()
    .filter(f => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"))
    .sort((a, b) => a.basename.localeCompare(b.basename));
}

/** 扫描 habits 目录，解析全部习惯（定义 + 记录） */
export async function loadHabits(app: App, settings: DaybookSettings): Promise<HabitData[]> {
  const out: HabitData[] = [];
  for (const file of habitFiles(app, settings)) {
    try {
      const content = await app.vault.read(file);
      const data = parseHabitFile(file.path, content);
      if (data) out.push(data);
    } catch (e) {
      console.warn("[Daybook] 习惯文件解析失败：", file.path, e);
    }
  }
  return out;
}

/** 重新读取单个习惯文件（读-改-写的"读"） */
export async function readHabitFile(app: App, habit: HabitConfig): Promise<HabitData> {
  const file = app.vault.getAbstractFileByPath(habit.filePath) as TFile | null;
  if (!file) {
    // 文件被外部删除：以内存配置重建空数据
    return { config: { ...habit }, rows: [], rawFrontmatter: {} };
  }
  const content = await app.vault.read(file);
  const data = parseHabitFile(file.path, content);
  if (!data) throw new Error("无法解析习惯文件: " + file.path);
  data.config = { ...data.config, ...{ executeDays: data.config.executeDays ?? habit.executeDays } };
  return data;
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  if (!folderPath) return;
  if (!app.vault.getAbstractFileByPath(folderPath)) {
    await app.vault.createFolder(folderPath);
  }
}

/** 写回单个习惯文件（写时重读磁盘内容，保留手动编辑与扩展键） */
async function writeHabitFile(app: App, habit: HabitConfig, rows: CheckinRow[]): Promise<void> {
  let rawFm: Record<string, unknown> = {};
  const file = app.vault.getAbstractFileByPath(habit.filePath) as TFile | null;
  if (file) {
    try {
      rawFm = extractFrontmatter(await app.vault.read(file)).fm;
    } catch {
      // ignore, 用内存值兜底
    }
  }
  const content = serializeHabitFile(habit, rows, rawFm);
  if (file) {
    await app.vault.modify(file, content);
  } else {
    const folder = habit.filePath.slice(0, habit.filePath.lastIndexOf("/"));
    await ensureFolder(app, folder);
    await app.vault.create(habit.filePath, content);
  }
}

/* ── 打卡操作（单文件读-改-写） ── */

function nowHHmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 打卡一次（新增记录，带当前时间），返回记录的时间 */
export async function checkinHabit(app: App, habit: HabitConfig, date: string): Promise<string> {
  const data = await readHabitFile(app, habit);
  const time = nowHHmm();
  data.rows.push({ habitId: habit.id, date, time, skipped: false });
  await writeHabitFile(app, habit, data.rows);
  return time;
}

/** 删除指定时间的一次打卡（返回是否删掉） */
export async function deleteCheckinAt(
  app: App,
  habit: HabitConfig,
  date: string,
  time?: string
): Promise<boolean> {
  const data = await readHabitFile(app, habit);
  const idx = data.rows.findIndex(r =>
    !r.skipped && r.date === date && r.time === time
  );
  if (idx < 0) return false;
  data.rows.splice(idx, 1);
  await writeHabitFile(app, habit, data.rows);
  return true;
}

/** 撤销最近一次打卡（时间最晚的一条） */
export async function uncheckLast(app: App, habit: HabitConfig, date: string): Promise<boolean> {
  const data = await readHabitFile(app, habit);
  let idx = -1, best = "";
  data.rows.forEach((r, i) => {
    if (r.skipped || r.date !== date) return;
    const t = r.time ?? "";
    if (idx < 0 || t >= best) { idx = i; best = t; }
  });
  if (idx < 0) return false;
  data.rows.splice(idx, 1);
  await writeHabitFile(app, habit, data.rows);
  return true;
}

/** 清空某天的全部打卡（含跳过标记） */
export async function clearDayCheckins(app: App, habit: HabitConfig, date: string): Promise<void> {
  const data = await readHabitFile(app, habit);
  const next = data.rows.filter(r => !(r.date === date));
  await writeHabitFile(app, habit, next);
}

/** 标记某天为跳过（不算未完成、不中断连续） */
export async function skipDay(app: App, habit: HabitConfig, date: string, note?: string): Promise<void> {
  const data = await readHabitFile(app, habit);
  const idx = data.rows.findIndex(r => r.date === date && r.skipped);
  if (idx >= 0) {
    data.rows[idx].note = note;
  } else {
    data.rows.push({ habitId: habit.id, date, skipped: true, note });
  }
  await writeHabitFile(app, habit, data.rows);
}

/** 取消某天的跳过标记 */
export async function removeSkip(app: App, habit: HabitConfig, date: string): Promise<void> {
  const data = await readHabitFile(app, habit);
  const next = data.rows.filter(r => !(r.date === date && r.skipped));
  await writeHabitFile(app, habit, next);
}

/** 更新某天备注（写在最近一次打卡上；无打卡则挂在跳过记录上；都没有则新建一次带备注的打卡） */
export async function setCheckinNote(
  app: App,
  habit: HabitConfig,
  date: string,
  note: string
): Promise<void> {
  const data = await readHabitFile(app, habit);
  const dayRows = data.rows.filter(r => r.date === date);
  const nonSkip = dayRows.filter(r => !r.skipped);
  const target = nonSkip.length > 0
    ? nonSkip[nonSkip.length - 1]
    : dayRows.length > 0
      ? dayRows[0]
      : null;
  const trimmed = note.trim() || undefined;
  if (target) target.note = trimmed;
  else data.rows.push({ habitId: habit.id, date, time: nowHHmm(), note: trimmed, skipped: false });
  await writeHabitFile(app, habit, data.rows);
}

/* ── 习惯文件增删 ── */

export interface HabitDraft {
  name: string;
  icon: string;
  color: string;
  timesPerDay: number;
  executeDays?: number[];
  archived?: boolean;
}

function uniqueHabitPath(app: App, dir: string, stem: string): string {
  let candidate = stem;
  let n = 2;
  while (app.vault.getAbstractFileByPath(normalizePath(`${dir}/${candidate}.md`))) {
    candidate = `${stem}-${n++}`;
  }
  return normalizePath(`${dir}/${candidate}.md`);
}

/** 新建习惯文件（文件名 = sanitize(name)，冲突自动加后缀），返回新配置 */
export async function createHabitFile(
  app: App,
  settings: DaybookSettings,
  draft: HabitDraft,
  startDate?: string
): Promise<HabitConfig> {
  const dir = habitsFolderPath(settings);
  await ensureFolder(app, dir);
  const id = `h-${Date.now().toString(36)}`;
  const stem = sanitizeHabitName(draft.name) || id;
  const filePath = uniqueHabitPath(app, dir, stem);
  const habit: HabitConfig = {
    id: fileStem(filePath),
    name: draft.name.trim() || fileStem(filePath),
    icon: draft.icon.trim() || "🎉",
    color: draft.color,
    timesPerDay: Math.min(20, Math.max(1, draft.timesPerDay || 1)),
    startDate: startDate ?? moment().format("YYYY-MM-DD"),
    filePath,
    executeDays: draft.executeDays && draft.executeDays.length > 0 && draft.executeDays.length < 7
      ? [...draft.executeDays].sort((a, b) => a - b)
      : undefined,
  };
  await app.vault.create(filePath, serializeHabitFile(habit, [], {}, true));
  return habit;
}

/** 更新习惯定义（只改 frontmatter，不动文件名；未知扩展键原样保留） */
export async function updateHabitConfig(
  app: App,
  habit: HabitConfig,
  draft: Partial<HabitDraft>
): Promise<HabitConfig> {
  const data = await readHabitFile(app, habit);
  const next: HabitConfig = {
    ...data.config,
    name: draft.name?.trim() || data.config.name,
    icon: draft.icon?.trim() || data.config.icon,
    color: draft.color ?? data.config.color,
    timesPerDay: draft.timesPerDay !== undefined
      ? Math.min(20, Math.max(1, draft.timesPerDay || 1))
      : data.config.timesPerDay,
    archived: draft.archived !== undefined ? draft.archived : data.config.archived,
    executeDays: draft.executeDays !== undefined
      ? (draft.executeDays.length > 0 && draft.executeDays.length < 7 ? [...draft.executeDays].sort((a, b) => a - b) : undefined)
      : data.config.executeDays,
  };
  await writeHabitFile(app, next, data.rows);
  return next;
}

/** 删除习惯文件（移入回收站） */
export async function deleteHabitFile(app: App, habit: HabitConfig): Promise<void> {
  const file = app.vault.getAbstractFileByPath(habit.filePath) as TFile | null;
  if (file) await app.fileManager.trashFile(file);
}

/* ── 聚合读取（Dashboard/TodayPanel 兼容入口） ── */

/** 汇总全部习惯的打卡记录（同旧签名语义，habitId = 文件 stem） */
export async function readCheckins(app: App, settings: DaybookSettings): Promise<CheckinRow[]> {
  const habits = await loadHabits(app, settings);
  return habits.flatMap(h => h.rows);
}

/* ── 旧数据迁移（一次性） ── */

/** 旧 `_habits.md` 的行格式：`- [habitId] [time:: HH:mm] [note:: x] [skipped:: true]` */
function parseLegacyCheckins(content: string): CheckinRow[] {
  const rows: CheckinRow[] = [];
  let currentDate: string | null = null;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const dayMatch = line.match(/^##\s+(\d{4}-\d{1,2}-\d{1,2})/);
    if (dayMatch) {
      currentDate = normalizeDate(dayMatch[1]);
      continue;
    }
    const rowMatch = line.match(/^-\s+\[([^\]]+)\](.*)$/);
    if (!rowMatch || !currentDate) continue;
    const habitId = rowMatch[1].trim();
    const rest = rowMatch[2];
    const timeMatch = rest.match(/\[time::\s*(\d{1,2}:\d{2})\]/i);
    const noteMatch = rest.match(/\[note::([^\]]*)\]/i);
    const skipMatch = rest.match(/\[skipped::\s*(true|false)\]/i);
    rows.push({
      habitId,
      date: currentDate,
      time: timeMatch?.[1],
      note: noteMatch?.[1]?.trim() || undefined,
      skipped: skipMatch?.[1]?.toLowerCase() === "true",
    });
  }
  return rows;
}

/**
 * 把 settings.habits + 旧 _habits.md 迁移为"每习惯一个文件"。
 * 返回 true 表示有变更（调用方需 saveSettings）。失败抛错由调用方兜底。
 */
export async function migrateLegacyHabits(app: App, settings: DaybookSettings): Promise<boolean> {
  if (settings.habitsMigratedV2) return false;
  const legacyDefs: LegacyHabitDef[] = Array.isArray(settings.habits) ? settings.habits : [];
  const folder = settings.diaryFolder.trim().replace(/\/$/, "");
  const legacyPath = normalizePath(folder ? `${folder}/${HABITS_FILE_LEGACY_NAME}` : HABITS_FILE_LEGACY_NAME);
  const legacyFile = app.vault.getAbstractFileByPath(legacyPath) as TFile | null;

  if (legacyDefs.length === 0 && !legacyFile) {
    settings.habitsMigratedV2 = true;
    return true;
  }

  const legacyRows = legacyFile ? parseLegacyCheckins(await app.vault.read(legacyFile)) : [];
  const defIds = new Set(legacyDefs.map(d => d.id));
  const hasOrphans = legacyRows.some(r => !defIds.has(r.habitId));

  for (const def of legacyDefs) {
    const draft: HabitDraft = {
      name: def.name,
      icon: def.icon,
      color: def.color,
      timesPerDay: def.timesPerDay,
    };
    const rowsForHabit = legacyRows.filter(r => r.habitId === def.id);
    const habit = await createHabitFile(app, settings, draft, normalizeDate(def.startDate) ?? undefined);
    const merged = rowsForHabit.map(r => ({ ...r, habitId: habit.id }));
    await writeHabitFile(app, habit, merged);
  }

  if (legacyFile) {
    if (hasOrphans) {
      // 有无主记录：整个旧文件改名保留（其中已迁移的行在新文件里另有一份）
      const backupPath = normalizePath(folder ? `${folder}/_habits-旧数据备份.md` : "_habits-旧数据备份.md");
      const uniqueBackup = uniqueHabitPath(app, backupPath.slice(0, backupPath.lastIndexOf("/")), "_habits-旧数据备份");
      await app.vault.rename(legacyFile, uniqueBackup);
      new Notice("旧习惯文件中存在未迁移的打卡记录，已备份为 _habits-旧数据备份.md");
    } else {
      await app.fileManager.trashFile(legacyFile);
    }
  }

  settings.habits = [];
  settings.habitsMigratedV2 = true;
  return true;
}

/* ── 查询辅助（纯函数） ── */

/** 某天某习惯的打卡记录（按时间升序） */
export function dayCheckins(rows: CheckinRow[], habitId: string, date: string): CheckinRow[] {
  return rows
    .filter(r => r.habitId === habitId && r.date === date && !r.skipped)
    .sort((a, b) => timeKey(a.time).localeCompare(timeKey(b.time)));
}

/** 某天打卡次数 */
export function dayCount(rows: CheckinRow[], habitId: string, date: string): number {
  return dayCheckins(rows, habitId, date).length;
}

/** 某天是否存在跳过标记 */
export function daySkipped(rows: CheckinRow[], habitId: string, date: string): boolean {
  return rows.some(r => r.habitId === habitId && r.date === date && r.skipped);
}

/** 查询某天状态：checked / skipped / rest / none（有任意一次打卡即 checked） */
export function checkinState(
  rows: CheckinRow[],
  habitId: string,
  date: string,
  executeDays?: number[]
): "checked" | "skipped" | "rest" | "none" {
  if (dayCount(rows, habitId, date) > 0) return "checked";
  if (daySkipped(rows, habitId, date)) return "skipped";
  if (executeDays && executeDays.length > 0 && !isExecuteDay({ executeDays }, date)) return "rest";
  return "none";
}

/** 热力图单元格 */
export interface HeatCell {
  date: string;
  count: number;
  skipped: boolean;
  rest: boolean;    // 非执行日
  target: number;
}

/** 聚合 [startDate, endDate] 闭区间内每天的打卡数据，用于热力图 */
export function heatRangeData(
  rows: CheckinRow[],
  habitId: string,
  startDate: string,
  endDate: string,
  opts?: { executeDays?: number[]; timesPerDay?: number }
): HeatCell[] {
  const target = Math.max(1, opts?.timesPerDay ?? 1);
  const counts = new Map<string, number>();
  const skippedSet = new Set<string>();
  for (const r of rows) {
    if (r.habitId !== habitId || r.date < startDate || r.date > endDate) continue;
    if (r.skipped) { skippedSet.add(r.date); continue; }
    counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  }
  const out: HeatCell[] = [];
  const end = moment(endDate, "YYYY-MM-DD");
  for (let d = moment(startDate, "YYYY-MM-DD"); d.valueOf() <= end.valueOf(); d.add(1, "day")) {
    const ds = d.format("YYYY-MM-DD");
    out.push({
      date: ds,
      count: counts.get(ds) ?? 0,
      skipped: skippedSet.has(ds),
      rest: !isExecuteDay({ executeDays: opts?.executeDays }, ds),
      target,
    });
  }
  return out;
}

/** 最近 weeks 周的热力图窗口：列对齐周一，末列为 endDate 所在周（周末几天为未来格） */
export function weeksHeatData(
  rows: CheckinRow[],
  habitId: string,
  weeks: number,
  endDate: string,
  opts?: { executeDays?: number[]; timesPerDay?: number }
): HeatCell[] {
  const end = moment(endDate, "YYYY-MM-DD");
  const lastColStart = end.clone().subtract((end.isoWeekday() + 6) % 7, "days");
  const start = lastColStart.clone().subtract(Math.max(1, weeks) - 1, "weeks");
  return heatRangeData(rows, habitId, start.format("YYYY-MM-DD"), lastColStart.clone().add(6, "days").format("YYYY-MM-DD"), opts);
}

/* ── 趋势图聚合（纯函数） ── */

export type TrendDimension = "week" | "month" | "year";

export interface TrendBucket {
  label: string;      // 轴标签（日：14…20；月：1…31；年：1~12）
  fullLabel: string;  // tooltip 用（YYYY-MM-DD 或 2026-09）
  count: number;      // 打卡次数
  target: number;     // 目标次数（休息日/年维度可为 0）
  rate: number;       // 完成度 0~1
  met: boolean;
  rest?: boolean;     // 非执行日
}

export interface TrendResult {
  rangeLabel: string; // 如 "9月14日 - 9月20日" / "2026 年 9 月" / "2026 年"
  buckets: TrendBucket[];
}

const WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"];

/** 按维度切桶生成趋势图数据；anchorStr 为区间内任一日期（周/月）或年内任一日（年） */
export function trendBuckets(
  rows: CheckinRow[],
  habit: HabitConfig,
  dimension: TrendDimension,
  anchorStr: string
): TrendResult {
  const target = Math.max(1, habit.timesPerDay || 1);
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.skipped) continue;
    counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  }
  const dayBucket = (ds: string, label: string, fullLabel: string): TrendBucket => {
    const count = counts.get(ds) ?? 0;
    const rest = !isExecuteDay(habit, ds);
    return {
      label,
      fullLabel,
      count,
      target: rest ? 0 : target,
      rate: rest ? 0 : Math.min(count / target, 1),
      met: !rest && count >= target,
      rest,
    };
  };

  if (dimension === "week") {
    const start = moment(anchorStr, "YYYY-MM-DD").startOf("isoWeek");
    const buckets: TrendBucket[] = [];
    for (let i = 0; i < 7; i++) {
      const d = start.clone().add(i, "days");
      buckets.push(dayBucket(d.format("YYYY-MM-DD"), WEEKDAY_CN[i], d.format("M月D日")));
    }
    const end = start.clone().add(6, "days");
    return {
      rangeLabel: `${start.format("M月D日")} - ${end.format("M月D日")}`,
      buckets,
    };
  }

  if (dimension === "month") {
    const m = moment(anchorStr, "YYYY-MM-DD").startOf("month");
    const days = m.daysInMonth();
    const buckets: TrendBucket[] = [];
    for (let d = 1; d <= days; d++) {
      const day = m.clone().date(d);
      buckets.push(dayBucket(day.format("YYYY-MM-DD"), String(d), day.format("M月D日")));
    }
    return { rangeLabel: m.format("YYYY 年 M 月"), buckets };
  }

  // year：12 个月桶，rate = 达标天数 / 应打卡天数
  const y = moment(anchorStr, "YYYY-MM-DD").startOf("year");
  const buckets: TrendBucket[] = [];
  for (let month = 0; month < 12; month++) {
    const m = y.clone().month(month);
    const ym = m.format("YYYY-MM");
    const daysIn = m.daysInMonth();
    let count = 0, metDays = 0, expected = 0;
    for (let d = 1; d <= daysIn; d++) {
      const ds = `${ym}-${String(d).padStart(2, "0")}`;
      const c = counts.get(ds) ?? 0;
      count += c;
      if (isExecuteDay(habit, ds)) {
        expected++;
        if (c >= target) metDays++;
      }
    }
    buckets.push({
      label: String(month + 1),
      fullLabel: ym,
      count,
      target: expected,
      rate: expected > 0 ? Math.min(metDays / expected, 1) : 0,
      met: expected > 0 && metDays >= expected,
    });
  }
  return { rangeLabel: y.format("YYYY 年"), buckets };
}

/** 周维度锚点日期平移（dimension 步长翻页） */
export function shiftAnchor(anchorStr: string, dimension: TrendDimension, delta: number): string {
  const unit = dimension === "week" ? "weeks" : dimension === "month" ? "months" : "years";
  return moment(anchorStr, "YYYY-MM-DD").add(delta, unit as "weeks" | "months" | "years").format("YYYY-MM-DD");
}

/* ── 统计计算 ── */

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 计算单个习惯的统计（连续/最佳/累计），达标 = 当日次数 >= timesPerDay；非执行日豁免 */
export function computeHabitStats(
  rows: CheckinRow[],
  habit: HabitConfig,
  todayStr: string
): HabitStats {
  const target = Math.max(1, habit.timesPerDay || 1);
  const counts = new Map<string, number>();
  let totalCheckins = 0;
  for (const r of rows) {
    if (r.habitId !== habit.id || r.skipped) continue;
    totalCheckins++;
    counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  }
  const doneSet = new Set([...counts.entries()].filter(([, c]) => c >= target).map(([d]) => d));
  const skippedSet = new Set(rows.filter(r => r.habitId === habit.id && r.skipped).map(r => r.date));
  // 豁免日 = 手动跳过 ∪ 非执行日
  const exempt = (ds: string): boolean =>
    skippedSet.has(ds) || !isExecuteDay(habit, ds);

  let currentStreak = 0;
  {
    const cursor = new Date(todayStr + "T00:00:00");
    if (!doneSet.has(dateStr(cursor)) && !exempt(dateStr(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (true) {
      const ds = dateStr(cursor);
      if (doneSet.has(ds)) {
        currentStreak++;
        cursor.setDate(cursor.getDate() - 1);
      } else if (exempt(ds)) {
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }
  }

  const sorted = [...doneSet].sort();
  let bestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const ds of sorted) {
    if (prev) {
      const p = new Date(prev + "T00:00:00");
      const cur = new Date(ds + "T00:00:00");
      const gapDays = Math.round((cur.getTime() - p.getTime()) / 86400000);
      const gapAllExempt = gapDays > 1 && [...Array(gapDays - 1)].every((_, i) => {
        const gapDate = new Date(p);
        gapDate.setDate(p.getDate() + i + 1);
        return exempt(dateStr(gapDate));
      });
      if (gapDays === 1 || gapAllExempt) run = run + 1;
      else run = 1;
    } else {
      run = 1;
    }
    if (run > bestStreak) bestStreak = run;
    prev = ds;
  }
  if (currentStreak > bestStreak) bestStreak = currentStreak;

  return {
    todayCount: counts.get(todayStr) ?? 0,
    currentStreak,
    bestStreak,
    totalCheckins,
  };
}
