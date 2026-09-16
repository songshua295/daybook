import { App, TFile, normalizePath, moment } from "obsidian";
import type { DaybookSettings, SectionType, SectionConfig } from "./settings";
import { getAllSections } from "./settings";

/**
 * 解析路径模式中的 {{moment格式}} 变量
 * 如 "Work/Notes/{{YYYY-MM-DD}}.md" → "Work/Notes/2026-09-15.md"
 * 如 "Logs/{{YYYY/MM}}/{{YYYY-MM-DD}}.md" → "Logs/2026/09/2026-09-15.md"
 */
function resolvePathPattern(pattern: string): string {
  return pattern.replace(/\{\{([^}]+)\}\}/g, (_, fmt) => moment().format(fmt.trim()));
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
  const sectionTitle = sectionLabel;
  const diaryPath = resolveSectionPath(settings, section);
  const folderPath = diaryPath.includes("/") ? diaryPath.slice(0, diaryPath.lastIndexOf("/")) : "";

  // 确保文件夹存在
  await ensureFolder(app, folderPath);

  let file = app.vault.getAbstractFileByPath(diaryPath) as TFile | null;
  const timestamp = getTimestamp();

  // 计划/待办内容已经是格式化的 Markdown（- [ ] / - [x]），直接写入，不加外层 bullet
  // 其他 section 用 "- HH:mm 内容" 格式
  const isRawContent = sectionType === "plans";
  const entryLine = isRawContent
    ? content.trim()
    : `- ${timestamp} ${content}`;

  if (!file) {
    // 新建日记文件（不再写入日期一级标题，日期由文件名承载）
    const initial = `# ${sectionTitle}\n\n${entryLine}\n`;
    file = await app.vault.create(diaryPath, initial);
    return;
  }

  // 读取现有内容
  let rawContent = await app.vault.read(file);

  // 查找 section
  const sectionRegex = new RegExp(`(^# ${escapeRegex(sectionTitle)}\\s*$)`, "m");
  const match = sectionRegex.exec(rawContent);

  // 多行内容（plans）前后需要空行确保 Markdown 正确解析
  const separator = isRawContent ? "\n\n" : "\n";

  if (match) {
    // Section 存在：找到下一个 # 标题或文件末尾，在其前插入
    const sectionStart = match.index + match[0].length;
    const afterSection = rawContent.slice(sectionStart);
    // 查找下一个一级标题
    const nextH1 = afterSection.search(/\n^# /m);

    if (nextH1 === -1) {
      // 追加到文件末尾
      rawContent = rawContent.trimEnd() + separator + entryLine + "\n";
    } else {
      const insertPos = sectionStart + nextH1;
      rawContent = rawContent.slice(0, insertPos) + separator + entryLine + rawContent.slice(insertPos);
    }
  } else {
    // Section 不存在：追加新 section
    rawContent = rawContent.trimEnd() + `\n\n# ${sectionTitle}\n\n${entryLine}\n`;
  }

  await app.vault.modify(file, rawContent);
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
