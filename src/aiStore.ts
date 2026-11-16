/**
 * aiStore.ts — AI 助手的会话与写入历史
 *
 * 存储：<日记目录>/ai/history.json（与 data.json 隔离，删掉文件即清空对话）
 * - messages：最近 60 条对话（user / assistant），只存文本，不存待确认动作
 * - writes：最近 40 条写入记录，每条保存被改文件的前后全文，撤销时按 before 还原
 *
 * 为什么存全文快照而不是反向指令：日记/习惯/journal 都是纯文本，文件很小；
 * 快照还原对所有类型通用，不会因为「加一集」这类增量操作写错撤销逻辑。
 */
import { App, normalizePath } from "obsidian";
import type { DaybookSettings } from "./settings";
import { DEFAULT_DIARY_FOLDER } from "./settings";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface AiWriteFile {
  path: string;
  /** 写入前全文；null = 文件原本不存在 */
  before: string | null;
  /** 写入后全文；null = 写入后不存在（当前不会出现，留作兼容） */
  after: string | null;
}

export interface AiWriteRecord {
  id: string;
  at: number;
  title: string;
  files: AiWriteFile[];
  undone?: boolean;
  undoneAt?: number;
}

const MAX_MESSAGES = 60;
const MAX_WRITES = 40;

function makeWriteId(): string {
  return `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export class AiStore {
  messages: AiMessage[] = [];
  writes: AiWriteRecord[] = [];
  private loaded = false;

  constructor(private app: App, private settings: DaybookSettings) {}

  get dir(): string {
    const folder = (this.settings.diaryFolder ?? "").trim().replace(/\/+$/, "") || DEFAULT_DIARY_FOLDER;
    return normalizePath(`${folder}/ai`);
  }

  get path(): string {
    return normalizePath(`${this.dir}/history.json`);
  }

  async load(): Promise<void> {
    this.messages = [];
    this.writes = [];
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        const raw = JSON.parse(await adapter.read(this.path));
        const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
        msgs.forEach((m: unknown) => {
          const item = m as Partial<AiMessage> | null;
          if (!item || (item.role !== "user" && item.role !== "assistant")) return;
          const content = String(item.content ?? "");
          if (!content) return;
          this.messages.push({ role: item.role, content, at: Number(item.at) || Date.now() });
        });
        const writes = Array.isArray(raw?.writes) ? raw.writes : [];
        writes.forEach((w: unknown) => {
          const item = w as Partial<AiWriteRecord> | null;
          if (!item || !Array.isArray(item.files)) return;
          const files = item.files
            .map(f => {
              const file = f as Partial<AiWriteFile> | null;
              if (!file || typeof file.path !== "string" || !file.path) return null;
              return {
                path: normalizePath(file.path),
                before: typeof file.before === "string" ? file.before : null,
                after: typeof file.after === "string" ? file.after : null,
              } as AiWriteFile;
            })
            .filter((f): f is AiWriteFile => f !== null);
          if (!files.length) return;
          this.writes.push({
            id: String(item.id ?? makeWriteId()),
            at: Number(item.at) || Date.now(),
            title: String(item.title ?? "AI 写入"),
            files,
            undone: item.undone === true,
            undoneAt: Number(item.undoneAt) || undefined,
          });
        });
      }
    } catch (e) {
      console.error("Daybook AI: 读取 history.json 失败", e);
    }
    this.messages = this.messages.slice(-MAX_MESSAGES);
    this.writes = this.writes.slice(0, MAX_WRITES);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
      await adapter.write(this.path, JSON.stringify({
        version: 1,
        messages: this.messages.slice(-MAX_MESSAGES),
        writes: this.writes.slice(0, MAX_WRITES),
      }, null, 2));
    } catch (e) {
      console.error("Daybook AI: 写入 history.json 失败", e);
    }
  }

  async pushMessage(role: AiMessage["role"], content: string): Promise<void> {
    const text = content.trim();
    if (!text) return;
    this.messages.push({ role, content: text, at: Date.now() });
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES);
    await this.persist();
  }

  async clearMessages(): Promise<void> {
    this.messages = [];
    await this.persist();
  }

  async addWrite(title: string, files: AiWriteFile[]): Promise<AiWriteRecord> {
    const rec: AiWriteRecord = {
      id: makeWriteId(),
      at: Date.now(),
      title,
      files,
    };
    this.writes.unshift(rec);
    if (this.writes.length > MAX_WRITES) this.writes = this.writes.slice(0, MAX_WRITES);
    await this.persist();
    return rec;
  }

  /** 最近一条尚未撤销的写入（「···」→ 撤销最近写入） */
  recentWrite(): AiWriteRecord | null {
    return this.writes.find(w => !w.undone) ?? null;
  }

  /** 按 before 还原文件；返回是否全部成功 */
  async undo(rec: AiWriteRecord): Promise<boolean> {
    if (rec.undone) return false;
    const adapter = this.app.vault.adapter;
    let ok = true;
    for (const f of rec.files) {
      try {
        if (f.before === null) {
          if (await adapter.exists(f.path)) await adapter.remove(f.path);
        } else {
          await adapter.write(f.path, f.before);
        }
      } catch (e) {
        ok = false;
        console.error("Daybook AI: 撤销写入失败", f.path, e);
      }
    }
    rec.undone = true;
    rec.undoneAt = Date.now();
    await this.persist();
    return ok;
  }

  get isLoaded(): boolean { return this.loaded; }
}
