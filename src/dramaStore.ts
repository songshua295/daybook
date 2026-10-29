/**
 * dramaStore.ts — 追剧（drama）类型的数据层
 *
 * 存储：<日记目录>/drama/shows.json（整个数组一份，条目不多，整读整写最简单）
 *
 * 口径说明：
 * - 数据只存在这个侧文件里，不写日记正文；「加一集」只把 计数(episodes) 加 1。
 * - 计数 = 已看集数，总计数 = 总集数（0 = 未知 / 连载未定），进度按两者相除。
 * - 状态四态：追更中 / 已完结 / 暂停 / 弃剧；看完时间只在「已完结」时有意义。
 * - 封面只是一份引用文本（见 dramaCover.ts 支持的四种写法），本层不解析。
 * - 豆瓣 URL 只存链接，全部手填，不做抓取。
 */
import { App, normalizePath } from "obsidian";
import type { DaybookSettings } from "./settings";

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
  { key: "episodes", label: "集数计数", hint: "已看 / 总集数" },
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
  cover: string;             // 封面引用（![[ ]]、md 图片语法、vault 路径或普通 URL）
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
  return {
    id: String(raw.id ?? makeDramaId()),
    title,
    originalName: String(raw.originalName ?? ""),
    category: String(raw.category ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim()).filter(Boolean) : [],
    cover: String(raw.cover ?? ""),
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

export class DramaStore {
  shows: DramaShow[] = [];
  private loaded = false;

  constructor(private app: App, private settings: DaybookSettings) {}

  get dir(): string {
    const folder = this.settings.diaryFolder.trim().replace(/\/$/, "");
    return normalizePath(`${folder}/drama`);
  }

  get path(): string {
    return normalizePath(`${this.dir}/shows.json`);
  }

  async load(): Promise<void> {
    this.shows = [];
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        const raw = JSON.parse(await adapter.read(this.path));
        const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.shows) ? raw.shows : [];
        arr.forEach(item => {
          const s = normalizeShow(item);
          if (s) this.shows.push(s);
        });
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

  private async persist(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
      await adapter.write(this.path, JSON.stringify(this.shows, null, 2));
    } catch (e) {
      console.error("Daybook drama: 保存失败", e);
      throw e;
    }
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
