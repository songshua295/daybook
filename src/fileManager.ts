import { App, Notice, TFile, TFolder, normalizePath, moment } from "obsidian";
import type { DaybookSettings, SectionType, SectionConfig } from "./settings";
import { DEFAULT_DIARY_FOLDER, getAllSections } from "./settings";

/* ── 路径变量（{日期} / {日期:格式} / {偏移:-1d}；旧 {{moment格式}} 写法兼容） ── */

/** 内置路径变量 → 默认 moment 格式（默认值都不含 Windows 文件名非法字符） */
export const PATH_VARS: Record<string, string> = {
  "日期": "YYYY-MM-DD",
  "时间": "HH-mm",
  "年": "YYYY",
  "月": "MM",
  "日": "DD",
  "时": "HH",
  "分": "mm",
  "秒": "ss",
  "星期": "ddd",
  "时间戳": "x",
};

/** 偏移函数参数：±数字 + d(天)/w(周)/M(月) */
const OFFSET_RE = /^([+-]?\d+)([dDwWM])$/;
const OFFSET_UNIT: Record<string, "days" | "weeks" | "months"> = {
  d: "days", D: "days", w: "weeks", W: "weeks", M: "months",
};

/**
 * 解析路径模式中的变量（写入那一刻按当前时间求值，可任意组合多个）：
 * - 内置变量：{日期} {时间} {年} {月} {日} {时} {分} {秒} {星期} {时间戳}
 * - 格式函数：{日期:格式} / {时间:格式} —— 参数为任意 moment 格式，如 {日期:YYYY/MM/DD}
 * - 偏移函数：{偏移:±Nd|±Nw|±NM[:格式]} —— 相对今天偏移 N 天/周/月，如 {偏移:-1d} = 昨天
 * - 旧写法：{{moment格式}} 等价 {日期:格式}，仍兼容
 * - 未知变量原样保留，不吞用户文本
 * 如 "Work/Notes/{日期}.md" → "Work/Notes/2026-09-15.md"
 * 如 "Logs/{年}/{年}-{月}-{日}.md" → "Logs/2026/2026-09-15.md"
 */
export function resolvePathPattern(pattern: string, now = moment()): string {
  return pattern
    .replace(/\{\{([^{}]+)\}\}/g, (_, fmt) => now.clone().format(fmt.trim()))
    .replace(/\{([^{}]+)\}/g, (raw, body: string) => {
      const cIdx = body.indexOf(":");
      const name = (cIdx < 0 ? body : body.slice(0, cIdx)).trim();
      const arg = cIdx < 0 ? "" : body.slice(cIdx + 1).trim();
      if (name === "偏移") {
        const parts = arg.split(":").map(s => s.trim());
        const m = OFFSET_RE.exec(parts[0] ?? "");
        if (!m) return raw;
        const t = now.clone().add(parseInt(m[1], 10) || 0, OFFSET_UNIT[m[2]]);
        return t.format(parts[1] || "YYYY-MM-DD");
      }
      const fmt = PATH_VARS[name];
      if (!fmt) return raw;
      return now.clone().format(arg || fmt);
    });
}

/**
 * 含变量的路径模式 → 文件匹配正则（每个变量匹配一段非 / 文本）。
 * 用于扫描变量目录下的历史文件（如 Logs/{年}/{日期}.md 要能扫回上个月的月份目录）。
 * 模式不含变量时返回 null。
 */
export function patternToMatcher(pattern: string): RegExp | null {
  const src = pattern.trim().replace(/^\/+/, "");
  const re = /(\{\{[^{}]+\}\}|\{[^{}]+\})/g;
  let hasVar = false;
  let out = "";
  let last = 0;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let m: RegExpExecArray | null; (m = re.exec(src));) {
    hasVar = true;
    out += esc(src.slice(last, m.index)) + "[^/]+";
    last = m.index + m[0].length;
  }
  if (!hasVar) return null;
  out += esc(src.slice(last));
  return new RegExp(`^${out}$`);
}

/**
 * 收集所有含变量章节的路径匹配器。
 * 与 getSectionFolders 配合使用：文件夹前缀扫描覆盖固定目录，
 * 匹配器补上变量目录下的历史文件（变量目录只按"今天"解析会漏掉历史月份）。
 */
export function getSectionFileMatchers(settings: DaybookSettings): RegExp[] {
  const matchers: RegExp[] = [];
  for (const sec of getAllSections(settings)) {
    if (!sec.filePath || !sec.filePath.trim()) continue;
    const p = sec.filePath.trim().replace(/^\/+/, "");
    const matcher = patternToMatcher(p.endsWith(".md") ? p : `${p}.md`);
    if (matcher) matchers.push(matcher);
  }
  return matchers;
}

/**
 * 获取今日日记文件路径（默认文件夹 + 默认日期格式）
 */
export function getDiaryPath(settings: DaybookSettings): string {
  const date = moment().format(settings.dateFormat);
  const folder = settings.diaryFolder.trim().replace(/\/$/, "");
  return normalizePath(`${folder}/${date}.md`);
}

/**
 * 解析章节对应的今日文件路径
 * - 有自定义 filePath：替换 {{}} 变量，确保 .md 后缀
 * - 无自定义：回退到默认 diaryFolder/dateFormat.md
 */
export function resolveSectionPath(settings: DaybookSettings, section?: SectionConfig): string {
  if (section?.filePath && section.filePath.trim()) {
    let p = section.filePath.trim().replace(/^\/+/, "");
    p = resolvePathPattern(p);
    if (!p.endsWith(".md")) p += ".md";
    return normalizePath(p);
  }
  return getDiaryPath(settings);
}

/**
 * 获取章节文件所在的文件夹路径（用于扫描文件）
 */
function getSectionFolder(settings: DaybookSettings, section?: SectionConfig): string {
  const fullPath = resolveSectionPath(settings, section);
  const idx = fullPath.lastIndexOf("/");
  return idx > 0 ? fullPath.slice(0, idx) : "";
}

/**
 * 收集所有章节涉及的文件夹列表（去重），用于 fileReader 扫描
 */
export function getSectionFolders(settings: DaybookSettings): string[] {
  const folders = new Set<string>();
  const defaultFolder = settings.diaryFolder.trim().replace(/\/$/, "");
  folders.add(defaultFolder);
  for (const sec of getAllSections(settings)) {
    if (sec.filePath && sec.filePath.trim()) {
      const folder = getSectionFolder(settings, sec);
      if (folder) folders.add(folder);
    }
  }
  return [...folders];
}

/**
 * 确保目录存在
 */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (normalized === "." || normalized === "") return;
  const exists = app.vault.getAbstractFileByPath(normalized);
  if (!exists) {
    await app.vault.createFolder(normalized);
  }
}

/**
 * 格式化时间戳
 */
function getTimestamp(): string {
  return moment().format("HH:mm");
}

/**
 * 纯函数：向日记内容追加 section 行（content 为 null = 新建文件），返回新全文，不落盘。
 * 供 AI 批量事务使用：同一文件多次追加只在内存里串行叠加，最后落盘一次。
 */
export function appendToSectionContent(
  content: string | null,
  sectionTitle: string,
  sectionType: SectionType,
  entry: string,
  timestamp = getTimestamp()
): string {
  // 计划/待办内容已经是格式化的 Markdown（- [ ] / - [x]），直接写入，不加外层 bullet
  // 其他 section 用 "- HH:mm 内容" 格式
  const isRawContent = sectionType === "plans";
  const entryLine = isRawContent
    ? entry.trim()
    : `- ${timestamp} ${entry}`;

  if (content === null) {
    // 新建日记文件（不再写入日期一级标题，日期由文件名承载）
    return `# ${sectionTitle}\n\n${entryLine}\n`;
  }

  // 查找 section
  const sectionRegex = new RegExp(`(^# ${escapeRegex(sectionTitle)}\\s*$)`, "m");
  const match = sectionRegex.exec(content);

  // 多行内容（plans）前后需要空行确保 Markdown 正确解析
  const separator = isRawContent ? "\n\n" : "\n";

  if (match) {
    // Section 存在：找到下一个 # 标题或文件末尾，在其前插入
    const sectionStart = match.index + match[0].length;
    const afterSection = content.slice(sectionStart);
    // 查找下一个一级标题
    const nextH1 = afterSection.search(/\n^# /m);

    if (nextH1 === -1) {
      // 追加到文件末尾
      return content.trimEnd() + separator + entryLine + "\n";
    }
    const insertPos = sectionStart + nextH1;
    return content.slice(0, insertPos) + separator + entryLine + content.slice(insertPos);
  }
  // Section 不存在：追加新 section
  return content.trimEnd() + `\n\n# ${sectionTitle}\n\n${entryLine}\n`;
}

/**
 * 向日记的指定 section（# 标题）追加内容
 * 如果 section 不存在则在末尾新建
 */
export async function appendToSection(
  app: App,
  settings: DaybookSettings,
  sectionLabel: string,
  sectionType: SectionType,
  content: string,
  section?: SectionConfig
): Promise<void> {
  const diaryPath = resolveSectionPath(settings, section);
  const folderPath = diaryPath.includes("/") ? diaryPath.slice(0, diaryPath.lastIndexOf("/")) : "";

  // 确保文件夹存在
  await ensureFolder(app, folderPath);

  const file = app.vault.getAbstractFileByPath(diaryPath) as TFile | null;
  const existing = file ? await app.vault.read(file) : null;
  const next = appendToSectionContent(existing, sectionLabel, sectionType, content);

  if (!file) {
    await app.vault.create(diaryPath, next);
    return;
  }
  await app.vault.modify(file, next);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ══════════════════════════════════════════════════════
   回顾页记录操作：按行范围读写（置顶/编辑/归档/删除共用）
   ══════════════════════════════════════════════════════ */

/** 解析文件为行数组；文件不存在时抛错 */
async function readFileLines(app: App, filePath: string): Promise<{ file: TFile; lines: string[] }> {
  const file = app.vault.getAbstractFileByPath(filePath) as TFile | null;
  if (!file) throw new Error(`文件不存在：${filePath}`);
  const content = await app.vault.read(file);
  return { file, lines: content.split("\n") };
}

/** 校验行范围合法性 */
function clampRange(lines: string[], startLine: number, endLine: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(startLine, lines.length - 1));
  const end = Math.max(start, Math.min(endLine, lines.length - 1));
  return { start, end };
}

/** 读取文件指定行范围（闭区间，0-based） */
export async function readLineRange(
  app: App,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<string[]> {
  const { lines } = await readFileLines(app, filePath);
  const { start, end } = clampRange(lines, startLine, endLine);
  return lines.slice(start, end + 1);
}

/** 在指定行之后插入一行（用于追加 [pinned]/[archived] 字段行） */
export async function insertLineAfter(
  app: App,
  filePath: string,
  lineIndex: number,
  newLine: string
): Promise<void> {
  const { file, lines } = await readFileLines(app, filePath);
  const at = Math.max(0, Math.min(lineIndex, lines.length - 1));
  lines.splice(at + 1, 0, newLine);
  await app.vault.modify(file, lines.join("\n"));
}

/** 用新内容替换指定行范围（闭区间，0-based） */
export async function replaceLineRange(
  app: App,
  filePath: string,
  startLine: number,
  endLine: number,
  newLines: string[]
): Promise<void> {
  const { file, lines } = await readFileLines(app, filePath);
  const { start, end } = clampRange(lines, startLine, endLine);
  lines.splice(start, end - start + 1, ...newLines);
  await app.vault.modify(file, lines.join("\n"));
}

/** 删除指定行范围（闭区间，0-based） */
export async function removeLineRange(
  app: App,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<void> {
  const { file, lines } = await readFileLines(app, filePath);
  const { start, end } = clampRange(lines, startLine, endLine);
  lines.splice(start, end - start + 1);
  await app.vault.modify(file, lines.join("\n"));
}

/* ── 数据根迁移：旧目录整体迁入 Daybook/（一次性） ── */

/** 旧版记账默认目录（.obsidian 下，用户库可能仍留存） */
const LEGACY_LEDGER_FOLDER = ".obsidian/记账";

function stripTrailingSlash(p: string): string {
  return p.trim().replace(/\/+$/, "");
}

/**
 * 一次性把旧数据根迁到 Daybook/：
 * 1. 旧日记目录（如 Daily/）整体 rename 为 Daybook/（日记/习惯/记账/追剧/ai 一次到位，链接自动更新）
 * 2. 旧默认记账目录 .obsidian/记账 若存在则迁入 Daybook/记账
 * 3. 改写 settings 里指向旧日记目录前缀的各路径
 * 返回 true 表示设置有变化（含旗标置位），调用方需 saveSettings。
 */
export async function migrateStorageRoot(app: App, settings: DaybookSettings): Promise<boolean> {
  if (settings.rootFolderMigratedV1) return false;
  const adapter = app.vault.adapter;
  const newRoot = DEFAULT_DIARY_FOLDER;
  const oldDiary = stripTrailingSlash(settings.diaryFolder || "");
  const moved: string[] = [];

  try {
    // 1. 旧日记目录整体搬迁（新旧并存时跳过，避免覆盖，提示手动处理）
    if (oldDiary && oldDiary !== newRoot) {
      const oldFolder = app.vault.getAbstractFileByPath(oldDiary);
      const oldExists = oldFolder instanceof TFolder || (await adapter.exists(oldDiary));
      const newExists = await adapter.exists(newRoot);
      if (oldExists && !newExists) {
        if (oldFolder instanceof TFolder) {
          await app.fileManager.renameFile(oldFolder, newRoot);
        } else {
          await adapter.rename(oldDiary, newRoot);
        }
        moved.push(`${oldDiary}/ → ${newRoot}/`);
      } else if (oldExists && newExists) {
        new Notice(`⚠️ 检测到 ${oldDiary}/ 与 ${newRoot}/ 并存，未自动合并；旧数据仍指向原目录，请手动整理`);
      }
    }

    // 2. 旧默认记账目录 → Daybook/记账
    const legacyLedgerExists = await adapter.exists(LEGACY_LEDGER_FOLDER);
    const newLedgerExists = await adapter.exists(`${newRoot}/记账`);
    if (legacyLedgerExists && !newLedgerExists) {
      const legacyFolder = app.vault.getAbstractFileByPath(LEGACY_LEDGER_FOLDER);
      if (legacyFolder instanceof TFolder) {
        await app.fileManager.renameFile(legacyFolder, `${newRoot}/记账`);
        moved.push(`${LEGACY_LEDGER_FOLDER} → ${newRoot}/记账`);
      }
    }

    // 3. 改写 settings 路径（仅当旧目录已搬走或本就不存在时，避免指到空目录）
    const oldGone = oldDiary === newRoot || !(await adapter.exists(oldDiary));
    const rewrite = (p: string | undefined): string | undefined => {
      const t = stripTrailingSlash(p ?? "");
      if (!t) return p;
      if (t === LEGACY_LEDGER_FOLDER) return `${newRoot}/记账`;
      if (oldGone && oldDiary && t.startsWith(`${oldDiary}/`)) return `${newRoot}/${t.slice(oldDiary.length + 1)}`;
      if (oldGone && oldDiary && t === oldDiary) return newRoot;
      return p;
    };
    const before = {
      diaryFolder: settings.diaryFolder,
      habitsFolder: settings.habitsFolder,
      ledgerFolder: settings.ledgerFolder,
      dramaFolder: settings.dramaFolder,
    };
    settings.diaryFolder = rewrite(settings.diaryFolder) ?? DEFAULT_DIARY_FOLDER;
    settings.habitsFolder = rewrite(settings.habitsFolder);
    settings.ledgerFolder = rewrite(settings.ledgerFolder);
    settings.dramaFolder = rewrite(settings.dramaFolder);
    const changed =
      settings.diaryFolder !== before.diaryFolder ||
      settings.habitsFolder !== before.habitsFolder ||
      settings.ledgerFolder !== before.ledgerFolder ||
      settings.dramaFolder !== before.dramaFolder;

    settings.rootFolderMigratedV1 = true;
    if (moved.length) {
      new Notice(`✅ 数据已迁入 ${newRoot}/：${moved.join("；")}`);
    }
    return changed || moved.length > 0;
  } catch (e) {
    console.error("Daybook: 数据根迁移失败", e);
    new Notice("数据根迁移失败，不影响其他功能，下次启动自动重试");
    settings.rootFolderMigratedV1 = true;
    return true;
  }
}
