/**
 * dramaCover.ts — 追剧封面的解析与获取
 *
 * 封面字段只是一段「引用文本」，四种写法都兼容（用户在编辑页手填或点选都行）：
 *   1. Obsidian 嵌入语法   ![[名侦探柯南.jpg]] / ![[Pictures/cover.png|300]]
 *   2. Markdown 图片语法   ![封面](Pictures/cover.png) 或 ![封面](https://…/a.jpg)
 *   3. vault 内相对路径     Pictures/cover.png
 *   4. 普通外链             https://…（直接当 img src）
 * 留空或解析不到文件时，UI 用「首字色块」兜底。
 *
 * 另外提供两个取图入口：从 vault 里挑一张现成图片（模糊搜索），或选本地文件上传进
 * <日记目录>/drama/covers/ 并写成 ![[文件名]] 嵌入语法。
 */
import { App, FuzzySuggestModal, Notice, TFile, normalizePath } from "obsidian";

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "svg"];
const isImageName = (name: string): boolean => {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return IMAGE_EXT.indexOf(ext) >= 0;
};

export type CoverRefType = "none" | "url" | "wiki" | "path";

export interface CoverRef {
  type: CoverRefType;
  /** url = 原链接；wiki = 目标文件名/路径（去掉别名）；path = vault 内相对路径 */
  value: string;
}

const stripSurrounding = (s: string): string => s.replace(/^[\s'"“”]+/, "").replace(/[\s'"“”]+$/, "");

/** 把封面字段解析成「外链 / 嵌入 / 路径 / 空」四类 */
export function parseCoverRef(raw: string): CoverRef {
  const v = stripSurrounding((raw || "").trim());
  if (!v) return { type: "none", value: "" };

  // ![[target|alias]] —— Obsidian 嵌入语法
  const wiki = v.match(/^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]$/);
  if (wiki) return { type: "wiki", value: wiki[1].trim() };
  if (/^\[\[[^\]|#]+(?:#[^\]|]*)?(?:\|[^[\]]+)?\]\]$/.test(v)) {
    const inner = v.slice(2, -2).split("|")[0].split("#")[0].trim();
    if (inner && isImageName(inner)) return { type: "wiki", value: inner };
  }

  // ![alt](target "title") —— Markdown 图片语法
  const md = v.match(/^!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["''][^)]*["''])?\s*\)$/);
  if (md) {
    const target = md[1].trim();
    if (/^(https?:|data:|blob:)/i.test(target)) return { type: "url", value: target };
    return { type: "path", value: decodeURIComponent(target) };
  }

  if (/^(https?:|data:|blob:)/i.test(v)) return { type: "url", value: v };

  return { type: "path", value: v };
}

/** 在 vault 里定位一个图片文件：先按链接解析，再按路径，最后按同名兜底 */
function findImageFile(app: App, target: string): TFile | null {
  const byLink = app.metadataCache.getFirstLinkpathDest(target, "");
  if (byLink instanceof TFile) return byLink;
  const abs = app.vault.getAbstractFileByPath(normalizePath(target));
  if (abs instanceof TFile) return abs;
  // 手填时常见只写了文件名（甚至省了扩展名）：按 basename 兜底找一次
  if (target.indexOf("/") < 0) {
    const lower = target.toLowerCase();
    const base = lower.replace(/\.[a-z0-9]+$/, "");
    const files = app.vault.getFiles();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = f.name.toLowerCase();
      if (isImageName(f.name) && (name === lower || name.replace(/\.[a-z0-9]+$/, "") === base)) return f;
    }
  }
  return null;
}

export interface ResolvedCover {
  /** <img src> 用 */
  src: string;
  /** true = vault 内文件（可做「打开所在文件夹」等本地操作） */
  local: boolean;
}

/**
 * 解析成可直接给 <img> 用的地址；解析不到返回 null（UI 走首字色块兜底）。
 * 注意：vault 文件走 app.vault.getResourcePath，安卓上才是 obsidian://local 之类的可加载地址。
 */
export function resolveCover(app: App, raw: string): ResolvedCover | null {
  const ref = parseCoverRef(raw);
  if (ref.type === "none") return null;
  if (ref.type === "url") return { src: ref.value, local: false };
  const file = findImageFile(app, ref.value);
  if (!file) return null;
  try {
    return { src: app.vault.getResourcePath(file), local: true };
  } catch (e) {
    return null;
  }
}

/** 用户输入校验：外链看着像链接就补 https://，其余原样返回 */
export function tidyCoverInput(raw: string): string {
  const v = stripSurrounding((raw || "").trim());
  if (/^[\w.-]+\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)$/i.test(v)) return `![[${v}]]`;
  if (/^(www\.)|^[a-z0-9-]+\.[a-z]{2,}\//i.test(v) && !/^[a-z]+:\/\//i.test(v)) return `https://${v}`;
  return v;
}

/* ── 首字色块兜底 ── */

const COVER_COLORS = [
  "#C2707A", "#C98F5B", "#B8A24F", "#7FA36B", "#5FA88F",
  "#5F97B8", "#6C7FB8", "#8A72B8", "#B0689E", "#B26A6A",
];

const COVER_NOISE = /^[\s《》〈〉「」『』【】（）()“”"'’.,、!！?？::;；\-—_·]+/;

/** 取标题首字（跳过书名号等标点）；拉丁字母转大写 */
export function coverInitial(title: string): string {
  const clean = (title || "").replace(COVER_NOISE, "");
  const ch = Array.from(clean)[0];
  if (!ch) return "?";
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

/** 标题 → 固定色（同一个剧每次渲染都是同一个颜色） */
export function coverColor(title: string): string {
  const s = title || "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return COVER_COLORS[h % COVER_COLORS.length];
}

/* ── 取图：从 vault 选 / 本地上传 ── */

/** vault 图片模糊搜索选择器 */
class CoverFileSuggest extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("搜索 vault 里的图片…");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => isImageName(f.name));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

/** 从 vault 现有图片里选一张，回调收到嵌入文本 ![[文件名]] */
export function pickVaultCover(app: App, onPick: (embed: string, file: TFile) => void): void {
  if (app.vault.getFiles().length === 0) { new Notice("这个库里没有图片文件"); return; }
  new CoverFileSuggest(app, file => {
    onPick(`![[${file.name}]]`, file);
  }).open();
}

/**
 * 选一个本地图片文件（浏览器/WebView 原生文件选择，移动端会走系统相册或文件）。
 * 用一次性隐藏 input，取消或不选时返回 null。
 */
export function pickLocalImageFile(host: HTMLElement): Promise<File | null> {
  return new Promise(resolve => {
    const input = host.createEl("input", {
      cls: "db-drama-file-input",
      attr: { type: "file", accept: IMAGE_EXT.map(e => `image/${e}`).join(",") + ",image/*" },
    });
    input.style.display = "none";
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => {
      const f = input.files && input.files.length ? input.files[0] : null;
      done(f);
    });
    input.addEventListener("cancel", () => done(null));
    host.appendChild(input);
    input.click();
  });
}

const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

/**
 * 把本地图片写进 vault（<日记目录>/drama/covers/），返回嵌入文本 ![[文件名]]。
 * 重名时追加序号，避免 createBinary 直接抛错。
 */
export async function uploadCoverImage(app: App, dir: string, file: File): Promise<string | null> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const safe = (file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)) || "cover";
  try {
    if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
    let fileName = `db-cover-${stamp}-${safe}.${ext}`;
    let seq = 1;
    while (await app.vault.adapter.exists(normalizePath(`${dir}/${fileName}`))) {
      fileName = `db-cover-${stamp}-${safe}-${seq++}.${ext}`;
    }
    const buffer = await file.arrayBuffer();
    await app.vault.createBinary(normalizePath(`${dir}/${fileName}`), new Uint8Array(buffer));
    return `![[${fileName}]]`;
  } catch (e) {
    console.error("Daybook drama: 封面保存失败", e);
    new Notice("封面保存失败，请检查日记目录设置");
    return null;
  }
}
