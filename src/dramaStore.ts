/**
 * dramaStore.ts — 追剧（drama）类型的数据层
 *
 * 存储：<追剧目录>/shows.md（单文件；每部剧一个「## 剧名」小节，整读整写）
 *
 * 文件格式（表达约定：中文键、单冒号、值原样不加引号、日期时间人读）：
 *   ## 名侦探柯南
 *   - 编号: dmq2x9k3f          ← 稳定主键，必写；剧名改名不影响身份
 *   - 剧名: 名侦探柯南
 *   - 状态: 追更中             ← 追更中 / 已完结 / 暂停 / 弃剧
 *   - 类型: 动漫
 *   - 标签: 日漫, 推理
 *   - 已看: 190
 *   - 总集数: 0                ← 0 = 未知 / 连载未定
 *   - 豆瓣: https://...
 *   - 下一集: https://...
 *   - 封面:                    ← 封面组用缩进子项，每行一张
 *   	- ![[柯南.jpg]]
 *   - 看完于: 2026-10-01
 *   - 添加于: 2026-10-19 14:30
 *   - 更新于: 2026-11-08 09:12
 *   （小节内其余行为自由笔记，连同未知键行按编号原样保留）
 *
 * 口径说明：
 * - 数据只存在这个侧文件里，不写日记正文；「加一集」只把 已看 加 1。
 * - 进度 = 已看 / 总集数；状态四态；看完时间只在「已完结」时有意义。
 * - 封面只是一份引用文本（见 dramaCover.ts 支持的四种写法），本层不解析。
 * - 豆瓣 URL 只存链接，全部手填，不做抓取。
 */
import { App, Notice, moment, normalizePath } from "obsidian";
import type { DaybookSettings } from "./settings";
import { DEFAULT_DIARY_FOLDER } from "./settings";
import { sanitizeHabitName } from "./habitManager";
import { writeAtomicFile } from "./ledgerStore";

export type DramaStatus = "following" | "done" | "paused" | "dropped";

export const STATUS_ORDER: DramaStatus[] = ["following", "done", "paused", "dropped"];

/** tone 给样式用（列表徽标、进度条配色按状态区分） */
export const STATUS_INFO: Record<DramaStatus, { label: string; tone: string }> = {
  following: { label: "追更中", tone: "live" },
  done: { label: "已完结", tone: "done" },
  paused: { label: "暂停", tone: "pause" },
  dropped: { label: "弃剧", tone: "drop" },
};

export function statusLabel(s: DramaStatus): string {
  return STATUS_INFO[s]?.label ?? "追更中";
}

/** 影视类型快捷候选（仍可手填任意值） */
export const DRAMA_CATEGORIES = ["电视剧", "动漫", "电影", "综艺", "纪录片", "短剧"];

/**
 * 列表卡片可显隐的字段（页内「···」→ 显示字段）。
 * 标题和「加一集」是主信息和主动作，不提供开关；编辑页永远显示全部字段。
 * 开关状态存在 settings.dramaFields，缺省（undefined）＝ 显示。
 */
export type DramaFieldKey =
  | "cover" | "status" | "originalName" | "category" | "tags"
  | "episodes" | "progress" | "dates" | "next" | "douban";

export const DRAMA_FIELDS: { key: DramaFieldKey; label: string; hint: string }[] = [
  { key: "cover", label: "封面", hint: "卡片左侧 2:3 相框" },
  { key: "status", label: "状态徽标", hint: "追更中 / 已完结…" },
  { key: "originalName", label: "原名 / 别名", hint: "如 名探偵コナン" },
  { key: "category", label: "影视类型", hint: "电视剧 / 动漫…" },
  { key: "tags", label: "标签", hint: "条目上的 #标签" },
  { key: "episodes", label: "集数", hint: "已看 / 总集数" },
  { key: "progress", label: "进度条", hint: "百分比与进度条" },
  { key: "dates", label: "时间行", hint: "添加于 / 看完于" },
  { key: "next", label: "下一集按钮", hint: "跳转播放链接" },
  { key: "douban", label: "豆瓣按钮", hint: "打开条目页链接" },
];

/** 读某个字段的显隐（未设置 = 显示） */
export function dramaFieldOn(
  fields: Partial<Record<DramaFieldKey, boolean>> | undefined,
  key: DramaFieldKey,
): boolean {
  return !fields || fields[key] !== false;
}

export interface DramaShow {
  id: string;
  title: string;             // 标题
  originalName: string;      // 原名 / 别名（如 名探偵コナン）
  category: string;          // 影视类型（电视剧 / 动漫 / 电影…）
  tags: string[];            // 标签
  cover: string;             // 封面引用（旧字段，恒等于 covers[0]，保留兼容旧数据/旧版本）
  covers?: string[];         // 封面组：文件类型，可放多张（![[ ]]、md 语法、vault 路径或 URL）
  status: DramaStatus;       // 状态
  totalEpisodes: number;     // 总计数（总集数，0 = 未知）
  episodes: number;          // 计数（已看集数）
  nextEpisodeUrl: string;    // 下一集直达（链接，可空）
  doubanUrl: string;         // 豆瓣条目页链接（只存链接，全部手填）
  finishedAt: string;        // 看完时间 YYYY-MM-DD（可空）
  createdAt: number;         // 创建时间
  updatedAt: number;         // 最后改动时间（含「加一集」）
}

export function makeDramaId(): string {
  return `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** 空条目（新建表单初始值） */
export function newDramaShow(): DramaShow {
  const now = Date.now();
  return {
    id: makeDramaId(),
    title: "",
    originalName: "",
    category: "",
    tags: [],
    cover: "",
    covers: [],
    status: "following",
    totalEpisodes: 0,
    episodes: 0,
    nextEpisodeUrl: "",
    doubanUrl: "",
    finishedAt: "",
    createdAt: now,
    updatedAt: now,
  };
}

/** 封面组：covers 优先，旧数据只有 cover 时回落成单元素数组 */
export function coverList(s: Pick<DramaShow, "cover" | "covers">): string[] {
  const arr = Array.isArray(s.covers) ? s.covers : (s.cover ? [s.cover] : []);
  return arr.filter((c): c is string => typeof c === "string" && !!c.trim());
}

/** 读取任意来源的条目并补齐字段（旧文件 / 手改 JSON 都可能缺键） */
function normalizeShow(raw: Partial<DramaShow> | null): DramaShow | null {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim();
  if (!title) return null;
  const now = Date.now();
  const status: DramaStatus = STATUS_ORDER.indexOf(raw.status as DramaStatus) >= 0
    ? (raw.status as DramaStatus)
    : "following";
  const asNum = (v: unknown): number => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const covers = Array.isArray(raw.covers)
    ? raw.covers.map(c => String(c ?? "").trim()).filter(Boolean)
    : (String(raw.cover ?? "").trim() ? [String(raw.cover).trim()] : []);
  return {
    id: String(raw.id ?? makeDramaId()),
    title,
    originalName: String(raw.originalName ?? ""),
    category: String(raw.category ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim()).filter(Boolean) : [],
    cover: covers[0] ?? "",
    covers,
    status,
    totalEpisodes: asNum(raw.totalEpisodes),
    episodes: asNum(raw.episodes),
    nextEpisodeUrl: String(raw.nextEpisodeUrl ?? ""),
    doubanUrl: String(raw.doubanUrl ?? ""),
    finishedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.finishedAt ?? "")) ? String(raw.finishedAt) : "",
    createdAt: asNum(raw.createdAt) || now,
    updatedAt: asNum(raw.updatedAt) || now,
  };
}

/** 进度（0..1）；总集数未知时返回 0，由 UI 决定只显示集数 */
export function progressOf(s: DramaShow): number {
  if (s.totalEpisodes > 0) return Math.min(1, s.episodes / s.totalEpisodes);
  return 0;
}

/** 进度文字：有总数写「1250 / 1250」，没总数写「已看 190 集」 */
export function progressText(s: DramaShow): string {
  if (s.totalEpisodes > 0) return `${s.episodes} / ${s.totalEpisodes}`;
  return s.episodes > 0 ? `已看 ${s.episodes} 集` : "未开始";
}

/* ── 存储路径与 shows.md 序列化 ── */

/** 追剧数据目录：自定义 dramaFolder 优先，否则 <日记目录>/drama */
export function dramaDir(settings: DaybookSettings): string {
  const custom = (settings.dramaFolder ?? "").trim().replace(/\/+$/, "");
  if (custom) return normalizePath(custom);
  const folder = settings.diaryFolder.trim().replace(/\/$/, "") || DEFAULT_DIARY_FOLDER;
  return normalizePath(`${folder}/drama`);
}

/** 状态中文标签 → 枚举（STATUS_INFO 反查），兼收英文枚举值 */
const STATUS_BY_LABEL: Record<string, DramaStatus> = Object.fromEntries(
  STATUS_ORDER.map(k => [STATUS_INFO[k].label, k]),
);

function parseStatusValue(val: string): DramaStatus | undefined {
  if (STATUS_BY_LABEL[val]) return STATUS_BY_LABEL[val];
  return STATUS_ORDER.indexOf(val as DramaStatus) >= 0 ? (val as DramaStatus) : undefined;
}

/** 毫秒 → 人读 `YYYY-MM-DD HH:mm`（文件里不出现时间戳） */
function fmtDateTime(ms: number): string {
  return moment(ms).format("YYYY-MM-DD HH:mm");
}

/** 人读时间 → 毫秒；解析失败返回 0（由 normalizeShow 兜底为当前时间） */
function parseDateTime(val: string): number {
  const m = moment(val.trim(), "YYYY-MM-DD HH:mm", true);
  return m.isValid() ? m.valueOf() : 0;
}

/** 分钟对齐（人读时间只有分钟精度，迁移比对前先把两侧都对齐） */
function floorMinute(ms: number): number {
  return Math.floor(ms / 60000) * 60000;
}

/** 单部剧 → 小节行（未知键行与笔记 extras 追加在已知字段之后） */
function serializeShowSection(s: DramaShow, extras: string[]): string[] {
  const lines: string[] = [`## ${sanitizeHabitName(s.title) || s.title}`];
  const put = (key: string, val: string) => lines.push(`- ${key}: ${val}`);
  put("编号", s.id);
  put("剧名", s.title);
  put("状态", STATUS_INFO[s.status]?.label ?? "追更中");
  if (s.originalName) put("原名", s.originalName);
  if (s.category) put("类型", s.category);
  if (s.tags.length) put("标签", s.tags.join(", "));
  put("已看", String(s.episodes));
  put("总集数", String(s.totalEpisodes));
  if (s.doubanUrl) put("豆瓣", s.doubanUrl);
  if (s.nextEpisodeUrl) put("下一集", s.nextEpisodeUrl);
  const covers = coverList(s);
  if (covers.length) {
    lines.push("- 封面:");
    covers.forEach(c => lines.push(`\t- ${c}`));
  }
  if (s.finishedAt) put("看完于", s.finishedAt);
  put("添加于", fmtDateTime(s.createdAt));
  put("更新于", fmtDateTime(s.updatedAt));
  lines.push(...extras);
  return lines;
}

/** 全部剧集 → shows.md 全文（头部一行标题，小节间空行分隔） */
export function serializeShows(shows: DramaShow[], extrasById: Map<string, string[]>): string {
  const lines: string[] = ["# 追剧", ""];
  shows.forEach((s, i) => {
    if (i > 0) lines.push("");
    lines.push(...serializeShowSection(s, extrasById.get(s.id) ?? []));
  });
  return `${lines.join("\n")}\n`;
}

/**
 * 解析 shows.md：按 `^## ` 切条目；字段行 `- 已知键: 值`（首个冒号后整段为值，
 * URL 含冒号不受影响）；封面缩进子项每行一张；其余行（含未知键行）原样保留。
 */
export function parseShowsMd(text: string): { shows: DramaShow[]; extras: Map<string, string[]> } {
  const shows: DramaShow[] = [];
  const extras = new Map<string, string[]>();
  type Draft = { raw: Record<string, unknown>; covers: string[]; other: string[]; inCovers: boolean };
  let cur: Draft | null = null;

  const flush = () => {
    if (!cur) return;
    const raw = { ...cur.raw } as Partial<DramaShow>;
    if (cur.covers.length) raw.covers = cur.covers;
    const clean = normalizeShow(raw);
    if (clean) {
      shows.push(clean);
      // 去掉尾随空行后，仍有内容才保留（未知键行 + 笔记）
      const other = [...cur.other];
      while (other.length && !other[other.length - 1].trim()) other.pop();
      if (other.length) extras.set(clean.id, other);
    }
    cur = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^## /.test(rawLine)) {
      flush();
      cur = { raw: { title: rawLine.slice(3).trim() }, covers: [], other: [], inCovers: false };
      continue;
    }
    if (!cur) continue; // 文件头（# 追剧 等）忽略
    if (/^[ \t]+- /.test(rawLine)) {
      // 缩进子项：仅在「封面」语境下收作封面，其余原样保留
      const val = rawLine.replace(/^[ \t]+- */, "").trim();
      if (cur.inCovers && val) cur.covers.push(val);
      else cur.other.push(rawLine);
      continue;
    }
    const m = rawLine.match(/^- ([^:：]+): ?(.*)$/);
    if (m) {
      const key = m[1].trim();
      const val = m[2].trim();
      cur.inCovers = false;
      switch (key) {
        case "编号": cur.raw.id = val; break;
        case "剧名": if (val) cur.raw.title = val; break;
        case "原名": cur.raw.originalName = val; break;
        case "状态": { const st = parseStatusValue(val); if (st) cur.raw.status = st; break; }
        case "类型": cur.raw.category = val; break;
        case "标签": cur.raw.tags = val ? val.split(/[,，]/).map(t => t.trim()).filter(Boolean) : []; break;
        case "已看": cur.raw.episodes = val; break;
        case "总集数": cur.raw.totalEpisodes = val; break;
        case "豆瓣": cur.raw.doubanUrl = val; break;
        case "下一集": cur.raw.nextEpisodeUrl = val; break;
        case "封面":
          cur.inCovers = true;
          if (val) cur.covers.push(val); // 行内单封面写法也收
          break;
        case "看完于": cur.raw.finishedAt = val; break;
        case "添加于": cur.raw.createdAt = parseDateTime(val); break;
        case "更新于": cur.raw.updatedAt = parseDateTime(val); break;
        default: cur.other.push(rawLine); // 未知键行原样保留
      }
      continue;
    }
    // 普通笔记行（含空行）
    if (!rawLine.trim()) cur.inCovers = false;
    cur.other.push(rawLine);
  }
  flush();
  return { shows, extras };
}

/**
 * 一次性迁移：旧 shows.json → shows.md（ledger 式三态：无旧数据/成功/失败不置旗标）。
 * 返回 true 表示设置有变化（旗标置位），调用方需 saveSettings。
 */
export async function migrateDramaJsonToMd(app: App, settings: DaybookSettings): Promise<boolean> {
  if (settings.dramaMigratedV2) return false;
  const dir = dramaDir(settings);
  const jsonPath = normalizePath(`${dir}/shows.json`);
  const adapter = app.vault.adapter;
  try {
    if (!(await adapter.exists(jsonPath))) {
      settings.dramaMigratedV2 = true;
      return true;
    }
    const raw = JSON.parse(await adapter.read(jsonPath));
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.shows) ? raw.shows : [];
    const shows: DramaShow[] = [];
    arr.forEach(item => {
      const s = normalizeShow(item);
      if (s) shows.push(s);
    });
    shows.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    // 人读时间只有分钟精度：先对齐再校验，避免秒级差导致误判
    shows.forEach(s => {
      s.createdAt = floorMinute(s.createdAt);
      s.updatedAt = floorMinute(s.updatedAt);
    });
    // round-trip 校验：序列化 → 解析回 → 逐条深比对，任一不符即中止
    const text = serializeShows(shows, new Map());
    const back = parseShowsMd(text);
    const mismatch = back.shows.length !== shows.length
      || back.shows.some((s, i) => JSON.stringify(s) !== JSON.stringify(shows[i]));
    if (mismatch) {
      new Notice("⚠️ 追剧数据迁移校验不一致，已中止（shows.json 保持原样，下次启动自动重试）");
      return false;
    }
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await writeAtomicFile(adapter, normalizePath(`${dir}/shows.md`), text);
    settings.dramaMigratedV2 = true;
    new Notice(`✅ 追剧数据已迁移为 shows.md（${shows.length} 条）；旧 shows.json 保留，确认无误后可手动删除`);
    return true;
  } catch (e) {
    console.error("Daybook drama: 旧数据迁移失败", e);
    new Notice("追剧数据迁移失败，下次启动自动重试");
    return false;
  }
}

export class DramaStore {
  shows: DramaShow[] = [];
  private loaded = false;
  /** 未知键行 + 自由笔记（按编号；写回时原样保留） */
  private extrasById = new Map<string, string[]>();
  /** 事务模式（AI 批量写入用）：变更只在内存叠加，由调用方取 serialize() 统一落盘 */
  private staged = false;

  constructor(private app: App, private settings: DaybookSettings) {}

  get dir(): string {
    return dramaDir(this.settings);
  }

  get path(): string {
    return normalizePath(`${this.dir}/shows.md`);
  }

  private get bakPath(): string {
    return `${this.path}.bak`;
  }

  async load(): Promise<void> {
    this.shows = [];
    this.extrasById.clear();
    try {
      const adapter = this.app.vault.adapter;
      const readParsed = async (p: string) => parseShowsMd(await adapter.read(p));
      let parsed: { shows: DramaShow[]; extras: Map<string, string[]> } | null = null;
      if (await adapter.exists(this.path)) {
        try {
          parsed = await readParsed(this.path);
        } catch (e) {
          console.error("Daybook drama: shows.md 读取失败，尝试 .bak", e);
        }
      }
      if (!parsed && await adapter.exists(this.bakPath)) {
        try {
          parsed = await readParsed(this.bakPath);
          new Notice(`⚠️ 追剧文件损坏，已从备份恢复：${this.path}`);
        } catch (e) {
          console.error("Daybook drama: 备份文件也损坏", this.bakPath, e);
        }
      }
      if (parsed) {
        this.shows = parsed.shows;
        this.extrasById = parsed.extras;
      }
    } catch (e) {
      console.error("Daybook drama: 读取失败", e);
    }
    this.sortShows();
    this.loaded = true;
  }

  /** 默认按最后改动排序（追更中 + 加过一集的 naturally 排在前面） */
  private sortShows(): void {
    this.shows.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  private async ensureDir(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
    } catch (e) { /* 已存在时忽略 */ }
  }

  private async persist(): Promise<void> {
    if (this.staged) return; // 事务模式：不直接写盘
    await this.ensureDir();
    await writeAtomicFile(this.app.vault.adapter, this.path, serializeShows(this.shows, this.extrasById));
  }

  /* ── AI 批量事务支持 ── */

  /** 进入事务模式：后续 addShow/updateShow/bumpEpisode 只改内存，不写盘 */
  beginStaged(): void {
    this.staged = true;
  }

  /** 用 shows.md 文本（null = 文件不存在）初始化内存数据，替代 load() */
  seedFromText(text: string | null): void {
    this.shows = [];
    this.extrasById = new Map();
    if (text) {
      const parsed = parseShowsMd(text);
      this.shows = parsed.shows;
      this.extrasById = parsed.extras;
    }
    this.sortShows();
    this.loaded = true;
  }

  /** 当前内存数据序列化为 shows.md 全文 */
  serialize(): string {
    return serializeShows(this.shows, this.extrasById);
  }

  byId(id: string): DramaShow | null {
    return this.shows.find(s => s.id === id) ?? null;
  }

  async addShow(show: DramaShow): Promise<void> {
    const clean = normalizeShow(show);
    if (!clean) return;
    this.shows.unshift(clean);
    this.sortShows();
    await this.persist();
  }

  async updateShow(show: DramaShow): Promise<void> {
    const clean = normalizeShow(show);
    if (!clean) return;
    const idx = this.shows.findIndex(s => s.id === clean.id);
    if (idx < 0) return this.addShow(clean);
    this.shows[idx] = { ...clean, createdAt: this.shows[idx].createdAt, updatedAt: Date.now() };
    this.sortShows();
    await this.persist();
  }

  async removeShow(id: string): Promise<void> {
    this.shows = this.shows.filter(s => s.id !== id);
    this.extrasById.delete(id);
    await this.persist();
  }

  /**
   * 「加一集」：已看集数 +1（不超过总集数）。
   * 达到总集数时自动转为「已完结」并补当天日期，省一次手动切换。
   */
  async bumpEpisode(id: string, today: string): Promise<DramaShow | null> {
    const s = this.byId(id);
    if (!s) return null;
    const next = Math.max(0, s.episodes + 1);
    const episodes = s.totalEpisodes > 0 ? Math.min(next, s.totalEpisodes) : next;
    const done = s.totalEpisodes > 0 && episodes >= s.totalEpisodes;
    await this.updateShow({
      ...s,
      episodes,
      status: done && s.status === "following" ? "done" : s.status,
      finishedAt: done && !s.finishedAt ? today : s.finishedAt,
    });
    return this.byId(id);
  }

  /** 状态计数（列表页顶部标签用） */
  statusCounts(): Record<DramaStatus, number> {
    const out = { following: 0, done: 0, paused: 0, dropped: 0 } as Record<DramaStatus, number>;
    this.shows.forEach(s => { out[s.status] = (out[s.status] || 0) + 1; });
    return out;
  }

  allTags(): string[] {
    const set = new Set<string>();
    this.shows.forEach(s => (s.tags || []).forEach(t => t && set.add(t)));
    return [...set];
  }

  /** 已登记条目里出现过的影视类型（编辑页快捷选择） */
  allCategories(): string[] {
    const set = new Set<string>();
    DRAMA_CATEGORIES.forEach(c => set.add(c));
    this.shows.forEach(s => s.category && set.add(s.category));
    return [...set];
  }

  get isLoaded(): boolean { return this.loaded; }
}
