import { App, TFile, normalizePath, moment } from "obsidian";
import type { DaybookSettings, SectionConfig, SectionType } from "./settings";
import { getAllSections } from "./settings";
import { getSectionFolders } from "./fileManager";

/** 从文本中提取行内标签 */
function extractInlineTags(text: string): string[] {
  const regex = /(^|[\s\u3000"'`([{<\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001\uFF08\uFF09\u3010\u3011\u300A\u300B\u300C\u300D\u300E\u300F,.;!?])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
  const tags: string[] = [];
  let m;
  while ((m = regex.exec(text)) !== null) { tags.push(m[2]); }
  return [...new Set(tags)];
}

/** 单条记录的类型（章节 id） */
export type EntryType = string;

/** 一条日记内容条目 */
export interface JournalEntry {
  id: string;           // 唯一ID，用于任务同步定位
  type: EntryType;      // 章节 id
  sectionLabel: string; // 章节标签（用于显示）
  sectionEmoji: string; // 章节 emoji（用于显示）
  renderType: SectionType; // 渲染类型（mood/text/plans）
  date: string;         // YYYY-MM-DD
  time?: string;        // HH:mm（从行内容中提取）
  text: string;         // 正文内容
  todos?: TodoItem[];   // 仅 plans 类型有
  tags?: string[];      // 行内标签（#标签）
  filePath: string;     // 来源文件路径
  rawLineIndex?: number; // 在文件中的起始行号（用于任务回写/原文定位）
  endLineIndex?: number; // 在文件中的结束行号（含续行与字段行，用于编辑/归档/删除）
  pinned?: boolean;     // 置顶（任务行 #pinned 标签，或旧格式块尾 [pinned::true] 字段行）
  archived?: string;    // 归档时间（块尾 [archived::时间] 行内字段）
  abandoned?: boolean;  // 已放弃（任务行 #abandoned 标签；区别于完成：灰色淡化+斜体）
}

/** 计划任务项 */
export interface TodoItem {
  text: string;
  done: boolean;
  lineIndex: number;    // 在文件中的行号（用于精确回写）
  dueDate?: string;     // 截止日期 YYYY-MM-DD
  createdAt?: string;   // 创建时间 YYYY-MM-DD 或 YYYY-MM-DD HH:mm
  completedAt?: string; // 完成时间 YYYY-MM-DD HH:mm（勾选完成时自动写入）
  priority?: PriorityLevel; // 优先级 1-4，undefined = 2（重要不紧急，默认）
  indent?: number;      // 层级：0/undefined=顶级任务，1=子任务
  note?: string;        // 备注（计划详情里写，行内字段 [note::…]，单行）
}

/** 优先级：1 重要且紧急 / 2 重要不紧急（默认）/ 3 不重要但紧急 / 4 不重要不紧急 */
export type PriorityLevel = "1" | "2" | "3" | "4";

/** 优先级元数据：颜色 / 罗马数字 / 标签 */
export const PRIORITY_META: Record<PriorityLevel, { numeral: string; color: string; label: string }> = {
  "1": { numeral: "I",   color: "#ef5350", label: "重要且紧急" },
  "2": { numeral: "II",  color: "#ff9800", label: "重要不紧急" },
  "3": { numeral: "III", color: "#2196f3", label: "不重要但紧急" },
  "4": { numeral: "IV",  color: "#4caf50", label: "不重要不紧急" },
};

/** 优先级存储 emoji（写入任务行） */
export const PRIORITY_EMOJI: Record<PriorityLevel, string> = {
  "1": "\u{1F7E5}", // 🟥
  "2": "\u{1F7E7}", // 🟧
  "3": "\u{1F7E6}", // 🟦
  "4": "\u{1F7E9}", // 🟩
};

/** 任务的实际优先级（undefined/null 视为 2） */
export function effectivePriority(p: PriorityLevel | null | undefined): PriorityLevel {
  return p ?? "2";
}

/** 是否显示优先级徽标：2 级默认隐藏，可在设置中开启 */
export function shouldShowPriorityBadge(p: PriorityLevel | undefined, settings: DaybookSettings): boolean {
  return effectivePriority(p) !== "2" || settings.showMediumPriorityBadge;
}

/**
 * 计划进度统计：有子计划的一级任务按子计划数量计数。
 * 子计划全部完成即父计划完成（勾选级联已保证），父行不再重复计 1，
 * 否则一个带 3 个子计划的组会被算成 4 条，进度比例失真。
 */
export function planTodoProgress(todos: TodoItem[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    if (t.indent) continue; // 子计划随父组一起统计，不单独计数
    let childTotal = 0;
    let childDone = 0;
    for (let j = i + 1; j < todos.length && todos[j].indent; j++) {
      childTotal++;
      if (todos[j].done) childDone++;
    }
    if (childTotal > 0) {
      done += childDone;
      total += childTotal;
    } else {
      done += t.done ? 1 : 0;
      total += 1;
    }
  }
  return { done, total };
}

/**
 * 拖拽移动任务（含其子树）到目标位置，原地修改数组。
 * - asChild=true：作为目标任务的子任务插入（追加到目标任务子树末尾，层级置 1）
 * - after=true：插入到目标位置之后（否则之前），拖动项保持自身层级
 * 目标在被拖动子树内部时忽略（避免拖到自己子孙下面形成环）
 */
export function moveTodoSubtree<T extends { indent?: number }>(
  items: T[],
  from: number,
  target: number,
  asChild: boolean,
  after: boolean
): void {
  if (from === target) return;
  let end = from + 1;
  while (end < items.length && items[end].indent) end++;
  if (target >= from && target < end) return;

  const count = end - from;
  const moved = items.splice(from, count);
  let at = target > from ? target - count : target;

  if (asChild) {
    moved.forEach(m => (m.indent = 1));
    let sub = at + 1;
    while (sub < items.length && items[sub].indent) sub++;
    at = sub;
  } else if (after) {
    let sub = at + 1;
    while (sub < items.length && items[sub].indent) sub++;
    at = sub;
  }
  items.splice(at, 0, ...moved);
}

/** 图片扩展名（用于旧链接兼容） */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp"];

/** 按日期分组的条目列表 */
export interface DayGroup {
  date: string;       // YYYY-MM-DD
  dateLabel: string;  // "今天" / "昨天" / "3月25日"
  entries: JournalEntry[];
}

/**
 * 读取 vault 中所有日记文件，解析并返回按日期倒序排列的条目
 */
export async function readAllJournalEntries(
  app: App,
  settings: DaybookSettings,
  filterTypes?: Set<string>
): Promise<DayGroup[]> {
  // 收集所有章节涉及的文件夹（默认 + 自定义路径），去重扫描
  const folders = getSectionFolders(settings);
  const seenPaths = new Set<string>();
  const files = app.vault.getMarkdownFiles()
    .filter(f => {
      if (seenPaths.has(f.path)) return false;
      return folders.some(folder => {
        const norm = normalizePath(folder);
        return f.path.startsWith(norm + "/") || f.path === norm;
      });
    })
    .filter(f => { seenPaths.add(f.path); return true; })
    .sort((a, b) => b.basename.localeCompare(a.basename));

  const groups: DayGroup[] = [];

  // 章节配置签名：章节变化时使解析缓存失效
  const configSig = getAllSections(settings).map(sc => `${sc.id}:${sc.label}:${sc.type}`).join("|");

  for (const file of files) {
    const entries = await parseJournalFile(app, file, settings, filterTypes, configSig);
    if (entries.length === 0) continue;

    const date = file.basename; // YYYY-MM-DD
    groups.push({
      date,
      dateLabel: formatDateLabel(date),
      entries,
    });
  }

  return groups;
}

/**
 * 解析单个日记文件，提取所有条目
 * 结果按 路径|mtime|筛选|章节签名 缓存：搜索输入等高频刷新场景下文件未变时直接复用，
 * 配合 cachedRead 避免反复读盘解析
 */
const parseCache = new Map<string, JournalEntry[]>();

async function parseJournalFile(
  app: App,
  file: TFile,
  settings: DaybookSettings,
  filterTypes?: Set<string>,
  configSig = ""
): Promise<JournalEntry[]> {
  const cacheKey = `${file.path}|${file.stat.mtime}|${filterTypes ? [...filterTypes].sort().join(",") : ""}|${configSig}`;
  const cached = parseCache.get(cacheKey);
  if (cached) return cached;

  const content = await app.vault.cachedRead(file);
  const lines = content.split("\n");
  const entries: JournalEntry[] = [];

  // 建立 section 标题 → SectionConfig 的映射
  const sectionMap = buildSectionMap(getAllSections(settings));

  let currentConfig: SectionConfig | null = null;
  let currentLines: { text: string; lineIndex: number }[] = [];
  let sectionStartLine = -1;

  const flushSection = () => {
    if (!currentConfig || currentLines.length === 0) return;
    if (filterTypes && !filterTypes.has(currentConfig.id)) {
      currentLines = [];
      return;
    }

    if (currentConfig.type === "plans") {
      // 计划（任务中心）：每条任务一个条目；旧格式时间标题仅作兼容边界
      parsePlanSection(currentLines, currentConfig, file.path, file.basename, entries, settings);
    } else {
      // 其他：多行合并解析（v3.1.4）
      // 以 "- HH:mm" 开头的行是新条目，其他行续接到上一条
      let lastEntry: JournalEntry | null = null;
      currentLines.forEach(({ text, lineIndex }) => {
        const trimmed = text.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        // 块尾行内字段行（[pinned::true] / [archived::时间]），不进正文
        const fieldMatch = trimmed.match(/^\[(pinned|archived)::(.+)\]$/);
        if (fieldMatch && lastEntry) {
          if (fieldMatch[1] === "pinned") lastEntry.pinned = fieldMatch[2].trim() === "true";
          else lastEntry.archived = fieldMatch[2].trim();
          lastEntry.endLineIndex = lineIndex;
          return;
        }
        // 去掉行首 "- " 前缀
        const cleaned = trimmed.replace(/^-\s*/, "");
        // 提取时间（兼容 HH:mm / HH:mm:ss）
        const timeMatch = cleaned.match(/^(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$/);
        if (timeMatch) {
          // 新条目
          const entryText = fixImageLinks(timeMatch[2]);
          const entry: JournalEntry = {
            id: `${file.basename}-${lineIndex}`,
            type: currentConfig!.id,
            sectionLabel: currentConfig!.label,
            sectionEmoji: currentConfig!.emoji,
            renderType: currentConfig!.type,
            date: file.basename,
            time: timeMatch[1],
            text: entryText,
            tags: extractInlineTags(entryText),
            filePath: file.path,
            rawLineIndex: lineIndex,
            endLineIndex: lineIndex,
          };
          entries.push(entry);
          lastEntry = entry;
        } else if (lastEntry) {
          // 续行：合并到上一条记录
          const appendText = fixImageLinks(cleaned);
          lastEntry.text += "\n" + appendText;
          lastEntry.endLineIndex = lineIndex;
          // 合并续行的标签
          const newTags = extractInlineTags(appendText);
          if (newTags.length > 0) {
            const existing = lastEntry.tags ?? [];
            lastEntry.tags = [...new Set([...existing, ...newTags])];
          }
        } else {
          // 没有上一条记录兜底创建
          const entryText = fixImageLinks(cleaned);
          const entry: JournalEntry = {
            id: `${file.basename}-${lineIndex}`,
            type: currentConfig!.id,
            sectionLabel: currentConfig!.label,
            sectionEmoji: currentConfig!.emoji,
            renderType: currentConfig!.type,
            date: file.basename,
            text: entryText,
            tags: extractInlineTags(entryText),
            filePath: file.path,
            rawLineIndex: lineIndex,
            endLineIndex: lineIndex,
          };
          entries.push(entry);
          lastEntry = entry;
        }
      });
    }
    currentLines = [];
  };

  lines.forEach((line, idx) => {
    // 检测一级标题（# xxx）
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      flushSection();
      const title = h1Match[1].trim();
      currentConfig = sectionMap[title] ?? null;
      sectionStartLine = idx;
      return;
    }
    if (currentConfig !== null) {
      currentLines.push({ text: line, lineIndex: idx });
    }
  });
  flushSection();

  // 置顶优先，其余按时间倒序排（最新在前）
  entries.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (a.time ?? "00:00").localeCompare(b.time ?? "00:00") * -1;
  });

  parseCache.set(cacheKey, entries);
  if (parseCache.size > 500) {
    const firstKey = parseCache.keys().next().value as string;
    parseCache.delete(firstKey);
  }
  return entries;
}

/**
 * 解析计划章节 —— 任务中心模型（v4 重构）
 *
 * 每条顶格任务行（`- [ ] 文本`）就是一个独立的计划条目，子任务（缩进比上一任务更深）
 * 挂在其父任务下；不再依赖 `- HH:mm 标题` 分块。
 *
 * 兼容读取旧格式：
 * - 时间标题 `- HH:mm [标题]` / `**HH:mm 计划**`：仅作为展示时间来源与旧块边界，
 *   其下任务照常拍平为独立条目
 * - 📅 日期 ≡ [due::YYYY-MM-DD]；🟥🟧🟦🟩 ≡ [priority::1..4]
 * - 块尾 [pinned::true] / [archived::时间] 字段行作用于自上一个时间标题以来的全部任务条目
 * - 状态标签：#pinned = 置顶、#abandoned = 放弃（新格式写入方式）
 */
export function parsePlanSection(
  lines: { text: string; lineIndex: number }[],
  config: SectionConfig,
  filePath: string,
  date: string,
  entries: JournalEntry[],
  settings: DaybookSettings
) {
  let currentTodos: TodoItem[] = [];
  let currentTime: string | undefined;   // 继承自旧格式时间标题（新格式任务无时间）
  let blockEntries: JournalEntry[] = []; // 自上一个时间标题以来的任务条目（旧块字段行的作用域）
  let lastLineIndex = -1;
  let prevWs = -1;                       // 上一任务行的缩进空格数（更深 = 子任务）
  let lastFlushedEntry: JournalEntry | null = null;

  const flush = () => {
    if (currentTodos.length === 0) return;
    const parent = currentTodos[0];
    // 从所有 todo 文本中收集标签
    const allTodoText = currentTodos.map(t => t.text).join(" ");
    const planTags = extractInlineTags(allTodoText);
    const entry: JournalEntry = {
      id: `${date}-task-${parent.lineIndex}`,
      type: config.id,
      sectionLabel: config.label,
      sectionEmoji: config.emoji,
      renderType: config.type,
      date,
      time: currentTime,
      text: parent.text,
      todos: [...currentTodos],
      tags: planTags.length > 0 ? planTags : undefined,
      filePath,
      rawLineIndex: parent.lineIndex,
      endLineIndex: lastLineIndex,
    };
    // 状态标签：#pinned 置顶 / #abandoned 放弃
    if (planTags.includes("pinned")) entry.pinned = true;
    if (planTags.includes("abandoned")) entry.abandoned = true;
    entries.push(entry);
    blockEntries.push(entry);
    lastFlushedEntry = entry;
    currentTodos = [];
  };

  lines.forEach(({ text, lineIndex }) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 块尾行内字段行（[pinned::true] / [archived::时间]）
    const fieldMatch = trimmed.match(/^\[(pinned|archived)::(.+)\]$/);
    if (fieldMatch) {
      // 字段行总是写在所属块尾之后，遇到时该块还没结算——先 flush 再挂字段，
      // 否则会错挂到上一个块（首个块的字段则直接丢失），表现为置顶/归档失效或错位。
      // 旧格式：作用于整块（时间标题以来的全部任务条目）；新格式无标题，块即最后一条任务
      flush();
      const isPin = fieldMatch[1] === "pinned";
      const val = fieldMatch[2].trim();
      const targets = blockEntries.length > 0 ? blockEntries : lastFlushedEntry ? [lastFlushedEntry] : [];
      targets.forEach(e => {
        if (isPin) e.pinned = val === "true";
        else e.archived = val;
        e.endLineIndex = lineIndex;
      });
      lastLineIndex = lineIndex;
      return;
    }

    // 旧格式计划块标题（兼容读取；新格式不再写入）：`- HH:mm[:ss] [标题]` 或 `**HH:mm[:ss] 计划**`
    const isIndented = /^[\t ]/.test(text);
    const planHeaderMatch = trimmed.match(/^\*\*(\d{2}:\d{2}(?::\d{2})?)\s+计划\*\*$/);
    const bulletHeaderMatch = !isIndented
      ? trimmed.match(/^-(?:\s)+(\d{2}:\d{2}(?::\d{2})?)(?:\s+(.+))?$/)
      : null;
    if (planHeaderMatch || bulletHeaderMatch) {
      flush();
      blockEntries = [];
      currentTime = (planHeaderMatch ?? bulletHeaderMatch)![1];
      prevWs = -1;
      return;
    }

    // 任务行（任意缩进）：`- [ ]` / `- [x]`，支持截止日期、优先级、行内字段、标签
    const todoMatch = trimmed.match(/^-\s+\[( |x|X)\]\s+(.+)$/);
    if (todoMatch) {
      let todoText = todoMatch[2];
      const done = todoMatch[1].toLowerCase() === "x";
      let dueDate: string | undefined;
      let priority: PriorityLevel | undefined;
      let completedAt: string | undefined;
      let createdAtVal: string | undefined;

      // 解析截止日期：[due::YYYY-MM-DD]（新）与 📅 YYYY-MM-DD（旧）等效，两者都剥离出标题
      const dueFieldMatch = todoText.match(/\[due::(\d{4}-\d{2}-\d{2})\]/);
      if (dueFieldMatch) {
        dueDate = dueFieldMatch[1];
        todoText = todoText.replace(dueFieldMatch[0], "");
      }
      const dueMatch = todoText.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
      if (dueMatch) {
        dueDate = dueDate ?? dueMatch[1];
        todoText = todoText.replace(/📅\s*\d{4}-\d{2}-\d{2}\s*/, "");
      }

      // 解析优先级：[priority::1..4]（新）与 🟥🟧🟦🟩（旧）等效
      const prioFieldMatch = todoText.match(/\[priority::([1-4])\]/);
      if (prioFieldMatch) {
        priority = prioFieldMatch[1] as PriorityLevel;
        todoText = todoText.replace(prioFieldMatch[0], "");
      }
      (Object.entries(PRIORITY_EMOJI) as [PriorityLevel, string][]).forEach(([lv, emoji]) => {
        if (priority === undefined && todoText.includes(emoji)) {
          priority = lv;
          todoText = todoText.split(emoji).join("");
        }
      });
      // 旧棕色方块（已废弃）仅剥离
      todoText = todoText.replace(/\u{1F7EB}\s*/gu, "");

      // 解析完成时间行内字段（字段名可在设置中自定义，默认 completedAt）
      const compField = getCompletedFieldName(settings);
      const compMatch = todoText.match(new RegExp(`\\[${escapeRegExp(compField)}::([^\\]]*)\\]`, "i"));
      if (compMatch) {
        completedAt = compMatch[1].trim();
        todoText = todoText.replace(compMatch[0], "");
      }

      // 解析创建时间行内字段（[createdAt::YYYY-MM-DD HH:mm]，用于计算耗时）
      const createdMatch = todoText.match(/\[createdAt::([^\]]*)\]/);
      if (createdMatch) {
        createdAtVal = createdMatch[1].trim();
        todoText = todoText.replace(createdMatch[0], "");
      }

      // 解析备注行内字段（[note::…]，计划详情写入）
      let note: string | undefined;
      const noteMatch = todoText.match(/\[note::([^\]]*)\]/);
      if (noteMatch) {
        note = noteMatch[1].trim() || undefined;
        todoText = todoText.replace(noteMatch[0], "");
      }

      // 层级判定：缩进比上一任务行更深 = 子任务（同时兼容旧格式 4/8 空格与新格式 0/4 空格）
      const leadingWs = text.match(/^[ \t]*/)?.[0] ?? "";
      const ws = leadingWs.replace(/\t/g, "    ").length;
      const isChild = currentTodos.length > 0 && ws > prevWs;
      if (!isChild) flush(); // 顶级任务：上一个任务条目到此结束
      prevWs = ws;
      currentTodos.push({
        text: todoText.trim(),
        done,
        lineIndex,
        dueDate,
        priority,
        completedAt,
        createdAt: createdAtVal ?? date,
        indent: isChild ? 1 : undefined,
        note,
      });
      lastLineIndex = lineIndex;
      return;
    }

    // 非任务内容行（旧格式块内的说明文字）：忽略内容，但纳入条目行范围
    lastLineIndex = lineIndex;
  });
  flush();
}

/**
 * 判断链接是否为图片（按扩展名）
 */
function isImageLink(link: string): boolean {
  const ext = link.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

/**
 * 修复旧式图片链接：[[xxx.png]] → ![[xxx.png]]
 * 仅修复内存数据，不修改原文件
 */
export function fixImageLinks(text: string): string {
  // 捕获可选的 '!' 前缀（不使用 lookbehind，兼容 iOS < 16.4 的 Safari）
  return text.replace(/(!?)\[\[([^\[\]]+\.([a-zA-Z]{2,4}))\]\]/g, (match, bang, linkContent, ext) => {
    if (!bang && IMAGE_EXTS.includes(ext.toLowerCase())) {
      return `![[${linkContent}]]`;
    }
    return match;
  });
}

/**
 * 将 sections 数组 → 标题文字 → SectionConfig 的反查表
 */
function buildSectionMap(sections: SectionConfig[]): Record<string, SectionConfig> {
  const map: Record<string, SectionConfig> = {};
  for (const sec of sections) {
    map[sec.label] = sec;
  }
  return map;
}

/**
 * 格式化日期标签（今天/昨天/N月N日）
 */
export function formatDateLabel(dateStr: string): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (dateStr === fmt(today)) return "今天";
  if (dateStr === fmt(yesterday)) return "昨天";

  const match = dateStr.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (match) return `${parseInt(match[1])}月${parseInt(match[2])}日`;
  return dateStr;
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 单个任务行的状态更新（done + 完成时间） */
export interface TodoStateUpdate {
  lineIndex: number;
  done: boolean;
  completedAt?: string;
}

/** 批量回写任务状态（勾选/取消勾选 + 完成时间字段），一次读改写 */
export async function setTodoStatesInFile(
  app: App,
  filePath: string,
  updates: TodoStateUpdate[],
  settings: DaybookSettings
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!file) throw new Error(`文件不存在：${filePath}`);

  const content = await app.vault.read(file);
  const lines = content.split("\n");
  const fieldName = getCompletedFieldName(settings);
  const fieldRegex = new RegExp(`\\s*\\[${escapeRegExp(fieldName)}::[^\\]]*\\]`, "i");

  for (const u of updates) {
    if (u.lineIndex < 0 || u.lineIndex >= lines.length) continue;
    const line = lines[u.lineIndex];
    let newLine = u.done
      ? line.replace(/^(\s*-\s+)\[ \]/, "$1[x]")
      : line.replace(/^(\s*-\s+)\[x\]/i, "$1[ ]");
    if (u.done) {
      const fieldText = `[${fieldName}::${u.completedAt ?? moment().format("YYYY-MM-DD HH:mm")}]`;
      if (fieldRegex.test(newLine)) {
        newLine = newLine.replace(new RegExp(`\\[${escapeRegExp(fieldName)}::[^\\]]*\\]`, "i"), fieldText);
      } else {
        newLine = newLine.replace(/\s+$/, "") + ` ${fieldText}`;
      }
    } else {
      newLine = newLine.replace(fieldRegex, "").replace(/\s+$/, "");
    }
    lines[u.lineIndex] = newLine;
  }

  await app.vault.modify(file, lines.join("\n"));
}

/**
 * 计算父子任务级联更新：
 * - 勾选/取消子任务 → 子任务全完成时父任务自动完成（记录完成时间）；任一未完成则父任务自动取消
 * - 勾选/取消父任务 → 所有子任务同步完成/取消（完成时间同步写入/清除）
 */
export function buildTodoCascade(
  todos: TodoItem[],
  clicked: TodoItem,
  done: boolean,
  stamp: string
): TodoStateUpdate[] {
  const idx = todos.indexOf(clicked);
  const updates: TodoStateUpdate[] = [
    { lineIndex: clicked.lineIndex, done, completedAt: done ? stamp : undefined },
  ];
  if (idx === -1) return updates;

  if (clicked.indent) {
    // 子任务 → 同步父任务状态
    let p = idx - 1;
    while (p >= 0 && todos[p].indent) p--;
    if (p >= 0) {
      const kidIdx: number[] = [];
      for (let i = p + 1; i < todos.length && todos[i].indent; i++) kidIdx.push(i);
      if (kidIdx.length > 0) {
        const allDone = kidIdx.every(i => (todos[i] === clicked ? done : todos[i].done));
        const parent = todos[p];
        if (allDone && !parent.done) {
          updates.push({ lineIndex: parent.lineIndex, done: true, completedAt: stamp });
        } else if (!allDone && parent.done) {
          updates.push({ lineIndex: parent.lineIndex, done: false });
        }
      }
    }
  } else {
    // 父任务 → 同步所有子任务
    for (let i = idx + 1; i < todos.length && todos[i].indent; i++) {
      if (todos[i].done !== done) {
        updates.push({ lineIndex: todos[i].lineIndex, done, completedAt: done ? stamp : undefined });
      }
    }
  }
  return updates;
}

/** 构造圆形罗马数字优先级 SVG 徽标并挂到父元素（undefined = 2 级默认） */
export function createPriorityBadge(parent: HTMLElement, priority: PriorityLevel | null | undefined): HTMLElement {
  const meta = PRIORITY_META[effectivePriority(priority)];
  const span = parent.createSpan({
    cls: "db-priority-badge-svg",
    attr: { "aria-label": `${meta.numeral} ${meta.label}`, role: "img" },
  });
  span.innerHTML =
    `<svg width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="8" fill="${meta.color}"/>` +
    `<text x="8" y="8.6" text-anchor="middle" dominant-baseline="central" ` +
    `font-size="${meta.numeral.length > 1 ? 7.5 : 9}" font-weight="700" fill="#ffffff" ` +
    `font-family="Georgia, 'Times New Roman', serif">${meta.numeral}</text>` +
    `</svg>`;
  return span;
}

/** 获取完成时间行内字段名（设置中的字段名，默认 completedAt） */
export function getCompletedFieldName(settings: DaybookSettings): string {
  return (settings.todoCompletedField ?? "").trim() || "completedAt";
}

/** 格式化创建时间 → 完成时间的耗时（如 2小时35分钟）；无法计算时返回 null */
function formatTodoDuration(createdAt: string | undefined, completedAt: string | undefined): string | null {
  if (!createdAt || !completedAt) return null;
  const start = moment(createdAt);
  const end = moment(completedAt);
  if (!start.isValid() || !end.isValid()) return null;
  const mins = end.diff(start, "minutes");
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rm = mins % 60;
    return rm > 0 ? `${hours}小时${rm}分钟` : `${hours}小时`;
  }
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh > 0 ? `${days}天${rh}小时` : `${days}天`;
}

/** 按设置计算已完成任务的展示信息：耗时 / 完成时间 */
export function formatTodoCompletion(
  todo: TodoItem,
  settings: DaybookSettings
): { duration: string | null; time: string | null } {
  const display = settings.todoCompletionDisplay ?? "both";
  const duration = display === "time" ? null : formatTodoDuration(todo.createdAt, todo.completedAt);
  let time: string | null = null;
  if (display !== "duration" && todo.completedAt) {
    const comp = moment(todo.completedAt);
    const created = todo.createdAt ? moment(todo.createdAt) : null;
    // 与创建同天时只显示时间部分，否则显示 日期 + 时间
    time = created && created.isValid() && comp.isSame(created, "day")
      ? comp.format("HH:mm")
      : comp.format("MM-DD HH:mm");
  }
  return { duration, time };
}

/** 在已完成任务的文本元素后追加耗时/完成时间徽标（按设置显示；未完成时清除） */
export function appendTodoCompletionInfo(
  textEl: HTMLElement,
  todo: TodoItem,
  settings: DaybookSettings,
  review: boolean
): void {
  const cls = review ? "db-review-todo-completed" : "db-todo-completed";
  textEl.querySelectorAll("." + cls).forEach(el => el.remove());
  if (!todo.done) return;
  const info = formatTodoCompletion(todo, settings);
  if (!info.duration && !info.time) return;
  const row = textEl.createDiv({ cls });
  if (info.duration) row.createSpan({ cls: `${cls}-item duration`, text: `⏱ ${info.duration}` });
  if (info.time) row.createSpan({ cls: `${cls}-item time`, text: `✅ ${info.time}` });
}
