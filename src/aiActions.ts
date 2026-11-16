/**
 * aiActions.ts — AI 把一句话变成「待写入动作」，人确认后才落盘
 *
 * 流程：系统提示词（各类型源文件的真实格式 + 现有数据清单）
 *   → 模型返回 { reply, ops }
 *   → prepareOps 逐条校验并生成预览（目标文件 + 将写入的内容）
 *   → 用户点「确认写入」→ executeOps 事务化执行：取基线快照 → 各 op 暂存新内容（同一文件
 *     多条 op 在内存里合并）→ 落盘前检测外部改动 → 每个文件恰好写一次 → 失败整体回滚，
 *     前后全文快照进撤销历史（可一键撤销）
 *
 * 只开放这几类动作：闪念、待办、习惯打卡、记一笔、追剧新增/加一集/更新。
 * 不开放任意文件改写——所有写入都走插件自己的存储 API，格式与手动录入完全一致。
 */
import { App, moment, normalizePath, TFile } from "obsidian";
import type { DaybookSettings, SectionConfig, SectionType } from "./settings";
import { DEFAULT_LEDGER_FOLDER, getVisibleSections } from "./settings";
import { appendToSectionContent, resolveSectionPath } from "./fileManager";
import { readJournalEntriesForDates, type JournalEntry } from "./fileReader";
import {
  isValidHHmm, loadHabits, parseHabitFile, serializeHabitFile,
  type HabitData, type CheckinRow,
} from "./habitManager";
import {
  LedgerStore, defaultLedgerConfig, makeRecordId, baseAmount, fmtMoney, writeAtomicFile,
  type LedgerCategory, type LedgerConfig, type LedgerRecord,
} from "./ledgerStore";
import { parseYearJournal, serializeYearJournal, makeNameResolver } from "./ledgerJournal";
import {
  DramaStore, STATUS_INFO, STATUS_ORDER, newDramaShow,
  type DramaShow, type DramaStatus,
} from "./dramaStore";
import type { AiWriteFile } from "./aiStore";

/* ══ 模型返回的动作 ══ */

/** 只读查询：结果会回传给模型，再由它组织成中文回答 */
export type AiQueryOp =
  | { op: "query-diary"; from?: string; to?: string; days?: number; keyword?: string }
  | {
    op: "query-ledger"; from?: string; to?: string; days?: number;
    kind?: "expense" | "income"; category?: string; account?: string;
    keyword?: string; limit?: number;
  }
  | { op: "query-habits"; from?: string; to?: string; days?: number; habit?: string };

export type AiOp =
  | AiQueryOp
  | { op: "memo"; text: string; section?: string }
  | { op: "plan"; text: string; priority?: string; due?: string; section?: string }
  | { op: "checkin"; habit: string; date?: string; time?: string }
  | {
    op: "ledger";
    kind: "expense" | "income";
    amount: number;
    category: string;
    sub?: string;
    account: string;
    note?: string;
    date?: string;
    tags?: string[];
  }
  | {
    op: "drama-add";
    title: string;
    category?: string;
    totalEpisodes?: number;
    status?: DramaStatus;
    tags?: string[];
    originalName?: string;
  }
  | { op: "drama-bump"; title: string; count?: number }
  | {
    op: "drama-update";
    title: string;
    episodes?: number;
    totalEpisodes?: number;
    status?: DramaStatus;
    finishedAt?: string;
  };

export interface ParsedAiReply {
  reply: string;
  ops: AiOp[];
}

/* ══ 页面打开 / 每次发送时读取的上下文 ══ */

export interface AiDataContext {
  today: string;
  weekday: string;
  habits: HabitData[];
  ledgerConfig: LedgerConfig;
  dramas: DramaShow[];
  /** 可见章节清单：注入提示词，供 memo / plan 的 section 字段选择 */
  sections: { id: string; type: SectionType; label: string; emoji: string; path?: string }[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asDateOpt(v: unknown): string | undefined {
  const s = asText(v);
  return DATE_RE.test(s) ? s : undefined;
}

/** days 只接受 1~366；用于「最近 N 天」这类问法 */
function asDays(v: unknown): number | undefined {
  const n = Math.round(asNum(v));
  return n > 0 ? Math.min(n, 366) : undefined;
}

async function readLedgerConfig(app: App, settings: DaybookSettings): Promise<LedgerConfig> {
  const folder = (settings.ledgerFolder ?? "").trim().replace(/\/+$/, "") || DEFAULT_LEDGER_FOLDER;
  const path = normalizePath(`${folder}/config.json`);
  try {
    const adapter = app.vault.adapter;
    if (await adapter.exists(path)) {
      const raw = JSON.parse(await adapter.read(path));
      return {
        ...defaultLedgerConfig(),
        ...raw,
        ledgers: Array.isArray(raw?.ledgers) && raw.ledgers.length ? raw.ledgers : defaultLedgerConfig().ledgers,
        accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
        categories: Array.isArray(raw?.categories) ? raw.categories : [],
        currencies: Array.isArray(raw?.currencies) && raw.currencies.length ? raw.currencies : defaultLedgerConfig().currencies,
      };
    }
  } catch (e) {
    console.error("Daybook AI: 读取记账配置失败", e);
  }
  return defaultLedgerConfig();
}

export async function loadAiDataContext(app: App, settings: DaybookSettings): Promise<AiDataContext> {
  const habits = await loadHabits(app, settings);
  const drama = new DramaStore(app, settings);
  await drama.load();
  return {
    today: moment().format("YYYY-MM-DD"),
    weekday: "周" + "日一二三四五六".charAt(moment().day()),
    habits,
    ledgerConfig: await readLedgerConfig(app, settings),
    dramas: drama.shows,
    sections: getVisibleSections(settings).map(s => ({
      id: s.id, type: s.type, label: s.label, emoji: s.emoji,
      path: s.filePath?.trim() || undefined,
    })),
  };
}

/* ══ 系统提示词 ══ */

function describeHabits(ctx: AiDataContext): string {
  if (!ctx.habits.length) return "（还没有习惯）";
  return ctx.habits
    .map(h => {
      const c = h.config;
      const days = c.executeDays?.length ? `每周${c.executeDays.map(d => "一二三四五六日".charAt(d - 1)).join("/")}` : "每天";
      return `- ${c.name}（${days}，目标 ${c.timesPerDay} 次/天）`;
    })
    .join("\n");
}

function describeLedger(ctx: AiDataContext): string {
  const cats = ctx.ledgerConfig.categories
    .map(c => {
      const subs = c.subs?.length ? `（${c.subs.map(s => s.name).join("、")}）` : "";
      return `${c.name}${subs}[${c.kind === "income" ? "收入" : "支出"}]`;
    })
    .join("；");
  const accounts = ctx.ledgerConfig.accounts.filter(a => !a.archived).map(a => a.name).join("、");
  return `类别：${cats || "（空）"}\n账户：${accounts || "（空）"}`;
}

function describeDramas(ctx: AiDataContext): string {
  if (!ctx.dramas.length) return "（空）";
  return ctx.dramas
    .slice(0, 40)
    .map(s => `- ${s.title}（${STATUS_INFO[s.status]?.label ?? "追更中"} ${s.episodes}/${s.totalEpisodes || "?"}）`)
    .join("\n");
}

/** 闪念/待办章节清单：同名类型可能有多个章节（不同 label / 自定义路径） */
function describeSections(ctx: AiDataContext): string {
  const secs = ctx.sections.filter(s => s.type === "memos" || s.type === "plans");
  if (!secs.length) return "（闪念/待办章节都已关闭，不能写闪念和待办）";
  return secs
    .map(s => {
      const typeLabel = s.type === "memos" ? "闪念" : "待办";
      return `- ${s.label}（${typeLabel}）${s.path ? `→ ${s.path}` : ""}`;
    })
    .join("\n");
}

export function buildSystemPrompt(ctx: AiDataContext): string {
  return `你是 Daybook 的写作助手。Daybook 是一个 Obsidian 插件，用户用一句话描述想记录的内容，你把它整理成待写入的文件内容。

今天是 ${ctx.today}（${ctx.weekday}）。

【输出格式】必须是一个严格的 JSON 对象，不要输出 JSON 之外的任何文字，不要用代码块围栏：
{"reply":"给用户看的中文说明（简短）","ops":[]}

【可用动作】ops 数组元素，按顺序执行：
1. 闪念：{"op":"memo","text":"内容","section":"章节名可选"} —— 追加到今天的闪念。text 支持 **加粗**、[[双链]]、#标签。section 从【章节清单】里选；只有一个闪念章节时省略。
2. 待办：{"op":"plan","text":"任务标题","priority":2,"due":"YYYY-MM-DD","section":"章节名可选"} —— 追加到今天的待办。priority：1=紧急 2=普通 3=重要 4=低，缺省 2；due 可省略；text 里不要再重复日期。section 同闪念。
3. 习惯打卡：{"op":"checkin","habit":"习惯名","date":"YYYY-MM-DD","time":"HH:mm"} —— 给已有习惯补打卡。date 缺省今天，time 缺省当前时间。
4. 记一笔：{"op":"ledger","kind":"expense","amount":32.5,"category":"餐饮","sub":"午餐","account":"微信","note":"备注","date":"YYYY-MM-DD","tags":["工作"]} —— kind 只能是 expense 或 income；category / sub / account 必须从下面清单里选；sub 尽量选类别括号里最贴切的一个，没把握就省略；date 缺省今天。
5. 新增追剧：{"op":"drama-add","title":"剧名","category":"电视剧","totalEpisodes":24,"status":"following","tags":[]} —— status：following=追更中 done=已完结 paused=暂停 dropped=弃剧。
6. 加一集：{"op":"drama-bump","title":"剧名","count":1}
7. 更新追剧：{"op":"drama-update","title":"剧名","episodes":5,"totalEpisodes":24,"status":"done"}
8. 查闪念/待办：{"op":"query-diary","days":7,"keyword":"可选"} —— days 或 from/to（YYYY-MM-DD）二选一，缺省今天；最多回溯 366 天。
9. 查记账：{"op":"query-ledger","days":30,"kind":"expense","category":"餐饮","account":"微信","keyword":"可选","limit":20} —— 返回合计、类别小计与最近明细（折算基准币）。
10. 查习惯：{"op":"query-habits","days":7,"habit":"阅读"} —— 返回打卡次数、打卡天数与今日进度。

【章节清单】memo / plan 可用 "section":"章节名" 指定写入哪个章节（填下面括号前的名字）；同一类型有多个章节时按内容选最合适的，只有一个时不用传：
${describeSections(ctx)}

【规则】
- 用户只是询问、闲聊、查询时，禁止编造数据：需要真实记录（历史闪念/待办、金额、习惯打卡、追剧进度）才能回答时，第一轮只返回查询动作，reply 留空或一句「我先查一下」，系统会把查询结果发给你，你再基于结果用中文回答。
- 查询是只读的、不花用户一次确认；能合并成一个查询就别拆成多个。
- 查询没给时间范围时：闪念/待办/习惯默认今天，记账默认本月。
- 用户既要查询又要记录时，可以在同一次 ops 里同时给查询和写入动作；写入仍需用户确认。
- 不要编造习惯名、记账类别、账户、剧名、章节名；清单里没有就在 reply 里说明，不要猜。
- 信息不足或无法理解时 ops 为空，并在 reply 里问清楚。
- amount 只写数字；日期用 YYYY-MM-DD；时间用 HH:mm。
- reply 用中文，不要提到 JSON、ops、动作这些实现细节。

【现有习惯】
${describeHabits(ctx)}

【记账配置】
${describeLedger(ctx)}

【追剧清单】
${describeDramas(ctx)}`;
}

/* ══ 解析模型回复 ══ */

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 去掉模型偶尔带上的列表符号 / 复选框，写入时由插件自己加 */
function asEntryText(v: unknown): string {
  return asText(v).replace(/^-\s*(\[[ xX]\]\s*)?/, "").trim();
}

function asNum(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(n) ? n : 0;
}

function asStatus(v: unknown): DramaStatus | undefined {
  const s = asText(v).toLowerCase();
  if (STATUS_ORDER.indexOf(s as DramaStatus) >= 0) return s as DramaStatus;
  const map: Record<string, DramaStatus> = {
    "追更中": "following", "连载中": "following",
    "已完结": "done", "完结": "done", "看完": "done",
    "暂停": "paused",
    "弃剧": "dropped", "弃坑": "dropped",
  };
  return map[s];
}

function asKind(v: unknown): "expense" | "income" | null {
  const s = asText(v).toLowerCase();
  if (s === "expense" || s === "支出" || s === "消费" || s === "花销") return "expense";
  if (s === "income" || s === "收入" || s === "进账") return "income";
  return null;
}

function parseOp(raw: unknown): AiOp | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const op = asText(o.op);
  if (op === "query-diary") {
    return {
      op, from: asDateOpt(o.from), to: asDateOpt(o.to), days: asDays(o.days),
      keyword: asText(o.keyword) || undefined,
    };
  }
  if (op === "query-ledger") {
    const kindRaw = o.kind;
    const kind = kindRaw === undefined || kindRaw === null || asText(kindRaw) === ""
      ? undefined
      : asKind(kindRaw);
    if (kind === null) return null;
    return {
      op, from: asDateOpt(o.from), to: asDateOpt(o.to), days: asDays(o.days),
      kind,
      category: asText(o.category) || undefined,
      account: asText(o.account) || undefined,
      keyword: asText(o.keyword) || undefined,
      limit: Math.min(Math.max(Math.round(asNum(o.limit)) || 20, 1), 50),
    };
  }
  if (op === "query-habits") {
    return {
      op, from: asDateOpt(o.from), to: asDateOpt(o.to), days: asDays(o.days),
      habit: asText(o.habit) || undefined,
    };
  }
  if (op === "memo") {
    const text = asEntryText(o.text);
    return text ? { op: "memo", text, section: asText(o.section) || undefined } : null;
  }
  if (op === "plan") {
    const text = asEntryText(o.text);
    if (!text) return null;
    const p = asText(o.priority);
    const due = asText(o.due);
    return {
      op: "plan", text,
      priority: /^[1-4]$/.test(p) ? p : undefined,
      due: DATE_RE.test(due) ? due : undefined,
      section: asText(o.section) || undefined,
    };
  }
  if (op === "checkin") {
    const habit = asText(o.habit);
    if (!habit) return null;
    const date = asText(o.date);
    const time = asText(o.time);
    return {
      op: "checkin", habit,
      date: DATE_RE.test(date) ? date : undefined,
      time: isValidHHmm(time) ? time : undefined,
    };
  }
  if (op === "ledger") {
    const kind = asKind(o.kind);
    if (!kind) return null;
    const amount = asNum(o.amount);
    const category = asText(o.category);
    const account = asText(o.account);
    if (!(amount > 0) || !category || !account) return null;
    const date = asText(o.date);
    return {
      op: "ledger", kind, amount,
      category, account,
      sub: asText(o.sub) || undefined,
      note: asText(o.note) || undefined,
      date: DATE_RE.test(date) ? date : undefined,
      tags: Array.isArray(o.tags) ? o.tags.map(t => asText(t)).filter(Boolean) : undefined,
    };
  }
  if (op === "drama-add") {
    const title = asText(o.title);
    if (!title) return null;
    return {
      op: "drama-add", title,
      category: asText(o.category) || undefined,
      totalEpisodes: Math.max(0, Math.round(asNum(o.totalEpisodes))),
      status: asStatus(o.status),
      tags: Array.isArray(o.tags) ? o.tags.map(t => asText(t)).filter(Boolean) : undefined,
      originalName: asText(o.originalName) || undefined,
    };
  }
  if (op === "drama-bump") {
    const title = asText(o.title);
    if (!title) return null;
    const count = Math.round(asNum(o.count));
    return { op: "drama-bump", title, count: count > 0 ? Math.min(count, 100) : 1 };
  }
  if (op === "drama-update") {
    const title = asText(o.title);
    if (!title) return null;
    const episodes = asNum(o.episodes);
    const total = asNum(o.totalEpisodes);
    const finishedAt = asText(o.finishedAt);
    return {
      op: "drama-update", title,
      episodes: episodes >= 0 ? Math.round(episodes) : undefined,
      totalEpisodes: total >= 0 ? Math.round(total) : undefined,
      status: asStatus(o.status),
      finishedAt: DATE_RE.test(finishedAt) ? finishedAt : undefined,
    };
  }
  return null;
}

export function parseAiResponse(raw: string): ParsedAiReply {
  const text = (raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      const reply = asText(obj?.reply) || asText(obj?.message);
      const ops = Array.isArray(obj?.ops)
        ? obj.ops.map(parseOp).filter((o: AiOp | null): o is AiOp => o !== null)
        : [];
      if (reply || ops.length) return { reply: reply || "好的。", ops };
    } catch (e) {
      // 非 JSON：整段当普通回复
    }
  }
  return { reply: text || "（AI 没有返回内容）", ops: [] };
}

/* ══ 校验 + 生成预览 ══ */

export interface PreparedOp {
  op: AiOp;
  kind: string;
  summary: string;
  /** 会被改动的文件（第一个是主目标） */
  paths: string[];
  preview: string;
  /** 快照前的准备（如记账先完成旧数据迁移，避免撤销时把迁移结果当成 AI 写入删掉） */
  prepare?: () => Promise<void>;
  /** 事务化写入：基于基线内容计算新全文并暂存，不直接落盘。
   *  base.get(path) 为 null = 文件当前不存在；同批 op 依次执行，
   *  后执行的能看到先执行的暂存结果（同一文件多条 op 自动合并为一次落盘）。 */
  stage: (base: Map<string, string | null>) => Promise<void>;
}

export interface PrepareResult {
  prepared: PreparedOp[];
  invalid: string[];
}

/** 该类型的所有可见章节，按设置顺序 */
function sectionsOfType(settings: DaybookSettings, type: SectionType): SectionConfig[] {
  return getVisibleSections(settings).filter(s => s.type === type);
}

/** 按 AI 给的章节名/ID 定位章节；没给或找不到返回 null（调用方回退第一个） */
function pickSection(secs: SectionConfig[], name: string | undefined): SectionConfig | null {
  const q = (name ?? "").trim();
  if (!q) return null;
  return secs.find(s => s.label === q)
    ?? secs.find(s => s.id === q)
    ?? secs.find(s => s.label.includes(q) || q.includes(s.label))
    ?? null;
}

function matchHabit(habits: HabitData[], name: string): HabitData | null {
  const q = name.trim();
  if (!q) return null;
  return habits.find(h => h.config.name === q)
    ?? habits.find(h => h.config.name.includes(q) || q.includes(h.config.name))
    ?? null;
}

function matchDrama(shows: DramaShow[], title: string): DramaShow | null {
  const q = title.trim();
  if (!q) return null;
  return shows.find(s => s.title === q)
    ?? shows.find(s => s.title.includes(q) || q.includes(s.title))
    ?? null;
}

function planLine(op: Extract<AiOp, { op: "plan" }>): string {
  let line = `- [ ] ${op.text}`;
  const p = op.priority ?? "2";
  if (p !== "2") line += ` [优先级: ${p}]`;
  if (op.due) line += ` [截止: ${op.due}]`;
  line += ` [创建于: ${moment().format("YYYY-MM-DD HH:mm")}]`;
  return line;
}

function money(n: number): string {
  return n.toFixed(2);
}

async function readText(app: App, path: string): Promise<string | null> {
  const adapter = app.vault.adapter;
  return (await adapter.exists(path)) ? adapter.read(path) : null;
}

export async function prepareOps(
  app: App,
  settings: DaybookSettings,
  ctx: AiDataContext,
  ops: AiOp[],
): Promise<PrepareResult> {
  const prepared: PreparedOp[] = [];
  const invalid: string[] = [];

  for (const op of ops) {
    if (op.op === "memo") {
      const secs = sectionsOfType(settings, "memos");
      if (!secs.length) { invalid.push("闪念章节已关闭，无法写入闪念"); continue; }
      const sec = pickSection(secs, op.section) ?? secs[0];
      const multi = secs.length > 1;
      const path = resolveSectionPath(settings, sec);
      prepared.push({
        op, kind: "闪念",
        summary: `闪念${multi ? `（${sec.label}）` : ""}：${op.text}`,
        paths: [path],
        preview: `# ${sec.label}\n\n- ${moment().format("HH:mm")} ${op.text}`,
        stage: async (base) => {
          const cur = base.get(path) ?? null;
          base.set(path, appendToSectionContent(cur, sec.label, "memos", op.text));
        },
      });
      continue;
    }

    if (op.op === "plan") {
      const secs = sectionsOfType(settings, "plans");
      if (!secs.length) { invalid.push("待办章节已关闭，无法写入待办"); continue; }
      const sec = pickSection(secs, op.section) ?? secs[0];
      const multi = secs.length > 1;
      const path = resolveSectionPath(settings, sec);
      const line = planLine(op);
      prepared.push({
        op, kind: "待办",
        summary: `待办${multi ? `（${sec.label}）` : ""}：${op.text}${op.due ? `（截止 ${op.due}）` : ""}`,
        paths: [path],
        preview: `# ${sec.label}\n\n${line}`,
        stage: async (base) => {
          const cur = base.get(path) ?? null;
          base.set(path, appendToSectionContent(cur, sec.label, "plans", line));
        },
      });
      continue;
    }

    if (op.op === "checkin") {
      const habit = matchHabit(ctx.habits, op.habit);
      if (!habit) { invalid.push(`没有找到习惯「${op.habit}」`); continue; }
      const date = op.date ?? ctx.today;
      const time = op.time ?? moment().format("HH:mm");
      prepared.push({
        op, kind: "打卡",
        summary: `给「${habit.config.name}」打卡 ${date} ${time}`,
        paths: [habit.config.filePath],
        preview: `### ${date}\n\n- [x] ${time}`,
        stage: async (base) => {
          const path = habit.config.filePath;
          const cur = base.get(path) ?? null;
          let rows: CheckinRow[] = [];
          let rawFm: Record<string, unknown> = {};
          if (cur !== null) {
            const parsed = parseHabitFile(path, cur);
            if (parsed) { rows = parsed.rows; rawFm = parsed.rawFrontmatter; }
          }
          rows.push({ habitId: habit.config.id, date, time, skipped: false });
          base.set(path, serializeHabitFile(habit.config, rows, rawFm));
        },
      });
      continue;
    }

    if (op.op === "ledger") {
      const cfg = ctx.ledgerConfig;
      const kindLabel = op.kind === "income" ? "收入" : "支出";
      const kindCats = cfg.categories.filter(c => c.kind === op.kind);
      const subUnder = (cat: LedgerCategory, name: string): { id: string; name: string } | null =>
        cat.subs?.find(s => s.name === name)
        ?? cat.subs?.find(s => s.name.includes(name) || name.includes(s.name))
        ?? null;
      // 全局找最合适的子类别（先精确后模糊）：把「类别/子类别」组合纠正到真实存在的位置
      const findSubGlobal = (name: string): { cat: LedgerCategory; sub: { id: string; name: string } } | null => {
        for (const c of kindCats) {
          const s = c.subs?.find(x => x.name === name);
          if (s) return { cat: c, sub: s };
        }
        for (const c of kindCats) {
          const s = c.subs?.find(x => x.name.includes(name) || name.includes(x.name));
          if (s) return { cat: c, sub: s };
        }
        return null;
      };
      let cat = kindCats.find(c => c.name === op.category)
        ?? kindCats.find(c => c.name.includes(op.category) || op.category.includes(c.name))
        ?? null;
      let sub = cat && op.sub ? subUnder(cat, op.sub) : null;
      let rerouted = false;
      if (cat && op.sub && !sub) {
        // 子类别不在该类别下：全局找更合适的类别/子类别组合（如「餐饮/打车」→「交通/打车」）
        const hit = findSubGlobal(op.sub);
        if (hit) { cat = hit.cat; sub = hit.sub; rerouted = true; }
      } else if (!cat && op.sub) {
        // 类别没匹配上：用子类别定位（如「吃饭/午餐」→「餐饮/午餐」）
        const hit = findSubGlobal(op.sub);
        if (hit) { cat = hit.cat; sub = hit.sub; rerouted = true; }
      }
      if (!cat) { invalid.push(`记账类别「${op.category}」不存在或与收支类型不符`); continue; }
      if (op.sub && !sub) { invalid.push(`类别「${cat.name}」下没有「${op.sub}」`); continue; }
      const acc = cfg.accounts.find(a => !a.archived && a.name === op.account)
        ?? cfg.accounts.find(a => !a.archived && (a.name.includes(op.account) || op.account.includes(a.name)));
      if (!acc) { invalid.push(`记账账户「${op.account}」不存在`); continue; }
      // 固定解析结果：cat/sub 是 let，闭包里拿不到非空收窄
      const finalCat = cat;
      const finalSub = sub;
      const date = op.date ?? ctx.today;
      const year = date.slice(0, 4);
      const store = new LedgerStore(app, settings);
      const buildRecord = (config: LedgerConfig, cat: LedgerCategory, sub: { id: string; name: string } | null): LedgerRecord | null => {
        const c = config.categories.find(x => x.id === cat.id)
          ?? config.categories.find(x => x.name === cat.name && x.kind === op.kind);
        if (!c) return null;
        const s = sub ? (c.subs?.find(x => x.id === sub.id) ?? c.subs?.find(x => x.name === sub.name)) : undefined;
        const a = config.accounts.find(x => x.id === acc.id) ?? config.accounts.find(x => x.name === acc.name);
        if (!a) return null;
        return {
          id: makeRecordId(),
          date,
          kind: op.kind,
          amount: Math.round(op.amount * 100) / 100,
          categoryId: c.id,
          subId: s?.id,
          accountId: a.id,
          ledgerId: config.ledgers[0]?.id ?? "",
          refund: 0,
          discount: 0,
          note: op.note ?? "",
          tags: op.tags ?? [],
          currency: config.baseCurrency || "CNY",
          address: "",
          creator: config.username || "",
          other: "",
          files: [],
          createdAt: Date.now(),
          clock: moment().format("HH:mm"),
        };
      };
      let ledgerStore: LedgerStore | null = null;
      const getStore = async (): Promise<LedgerStore> => {
        if (!ledgerStore) {
          ledgerStore = new LedgerStore(app, settings);
          await ledgerStore.load();
        }
        return ledgerStore;
      };
      const targetPath = store.recordsFilePath(year);
      prepared.push({
        op, kind: "记账",
        summary: `记一笔：${kindLabel} ¥${money(op.amount)} · ${cat.name}${sub ? ` / ${sub.name}` : ""} · ${acc.name}`,
        paths: [targetPath],
        prepare: async () => { await getStore(); },
        preview: `${date}  ${kindLabel}  ${op.amount.toFixed(2)} ${cfg.baseCurrency || "CNY"}\n类别：${cat.name}${sub ? ` / ${sub.name}` : ""}\n账户：${acc.name}${op.note ? `\n备注：${op.note}` : ""}${op.tags?.length ? `\n标签：${op.tags.map(t => "#" + t).join(" ")}` : ""}${rerouted ? `\n（已将「${op.category}${op.sub ? ` / ${op.sub}` : ""}」匹配到 ${cat.name}${sub ? ` / ${sub.name}` : ""}）` : ""}`,
        stage: async (base) => {
          const s = await getStore();
          const rec = buildRecord(s.config, finalCat, finalSub);
          if (!rec) throw new Error("记账配置已变化，请重新发送");
          // 基于基线内容追加（同一年多条记账在同一次 stage 链里叠加，最后只落盘一次）
          const cur = base.get(targetPath) ?? null;
          const yearRecords: LedgerRecord[] = [];
          if (cur !== null) {
            yearRecords.push(...parseYearJournal(cur, s.config, makeNameResolver(s.config)).records);
          }
          yearRecords.unshift(rec);
          yearRecords.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
          base.set(targetPath, serializeYearJournal(yearRecords, s.config));
        },
      });
      continue;
    }

    if (op.op === "drama-add") {
      const store = new DramaStore(app, settings);
      if (matchDrama(ctx.dramas, op.title)) { invalid.push(`追剧「${op.title}」已经存在，可以改用「加一集」`); continue; }
      prepared.push({
        op, kind: "追剧",
        summary: `新增追剧：${op.title}${op.totalEpisodes ? `（共 ${op.totalEpisodes} 集）` : ""}`,
        paths: [store.path],
        preview: [
          op.title,
          `状态：${STATUS_INFO[op.status ?? "following"].label}`,
          `已看：0 / ${op.totalEpisodes || "?"}`,
          op.category ? `类型：${op.category}` : "",
          op.tags?.length ? `标签：${op.tags.map(t => "#" + t).join(" ")}` : "",
        ].filter(Boolean).join("\n"),
        stage: async (base) => {
          const s = new DramaStore(app, settings);
          s.beginStaged();
          s.seedFromText(base.get(store.path) ?? null);
          if (matchDrama(s.shows, op.title)) throw new Error("追剧条目已存在，请重新发送");
          const show = newDramaShow();
          show.title = op.title;
          show.category = op.category ?? "";
          show.totalEpisodes = op.totalEpisodes ?? 0;
          show.status = op.status ?? "following";
          show.tags = op.tags ?? [];
          show.originalName = op.originalName ?? "";
          await s.addShow(show);
          base.set(store.path, s.serialize());
        },
      });
      continue;
    }

    if (op.op === "drama-bump") {
      const show = matchDrama(ctx.dramas, op.title);
      if (!show) { invalid.push(`没有找到追剧「${op.title}」`); continue; }
      const count = op.count ?? 1;
      const next = show.totalEpisodes > 0
        ? Math.min(show.totalEpisodes, show.episodes + count)
        : show.episodes + count;
      const actual = Math.max(0, next - show.episodes);
      const dramaPath = new DramaStore(app, settings).path;
      prepared.push({
        op, kind: "追剧",
        summary: `「${show.title}」加 ${actual} 集：${show.episodes} → ${next}`,
        paths: [dramaPath],
        preview: `${show.title}\n已看：${show.episodes} → ${next}${show.totalEpisodes > 0 ? ` / ${show.totalEpisodes}` : ""}`,
        stage: async (base) => {
          const s = new DramaStore(app, settings);
          s.beginStaged();
          s.seedFromText(base.get(dramaPath) ?? null);
          const cur = matchDrama(s.shows, op.title);
          if (!cur) throw new Error("追剧条目已变化，请重新发送");
          for (let i = 0; i < actual; i++) await s.bumpEpisode(cur.id, moment().format("YYYY-MM-DD"));
          base.set(dramaPath, s.serialize());
        },
      });
      continue;
    }

    if (op.op === "drama-update") {
      const show = matchDrama(ctx.dramas, op.title);
      if (!show) { invalid.push(`没有找到追剧「${op.title}」`); continue; }
      const nextEpisodes = op.episodes ?? show.episodes;
      const nextTotal = op.totalEpisodes ?? show.totalEpisodes;
      const nextStatus = op.status ?? show.status;
      const dramaPath = new DramaStore(app, settings).path;
      prepared.push({
        op, kind: "追剧",
        summary: `更新「${show.title}」：${nextEpisodes}/${nextTotal || "?"} · ${STATUS_INFO[nextStatus].label}`,
        paths: [dramaPath],
        preview: [
          show.title,
          `已看：${show.episodes} → ${nextEpisodes}`,
          nextTotal !== show.totalEpisodes ? `总集数：${show.totalEpisodes || "?"} → ${nextTotal || "?"}` : "",
          nextStatus !== show.status ? `状态：${STATUS_INFO[show.status].label} → ${STATUS_INFO[nextStatus].label}` : "",
          op.finishedAt ? `看完于：${op.finishedAt}` : "",
        ].filter(Boolean).join("\n"),
        stage: async (base) => {
          const s = new DramaStore(app, settings);
          s.beginStaged();
          s.seedFromText(base.get(dramaPath) ?? null);
          const cur = matchDrama(s.shows, op.title);
          if (!cur) throw new Error("追剧条目已变化，请重新发送");
          await s.updateShow({
            ...cur,
            episodes: nextEpisodes,
            totalEpisodes: nextTotal,
            status: nextStatus,
            finishedAt: op.finishedAt ?? cur.finishedAt,
          });
          base.set(dramaPath, s.serialize());
        },
      });
      continue;
    }
  }

  return { prepared, invalid };
}

/* ══ 只读查询（结果回传给模型，再由模型回答） ══ */

export function isQueryOp(op: AiOp): op is AiQueryOp {
  return op.op === "query-diary" || op.op === "query-ledger" || op.op === "query-habits";
}

/** 写入动作与查询动作分开：查询立即执行，写入仍要用户确认 */
export function splitAiOps(ops: AiOp[]): { queries: AiQueryOp[]; writes: AiOp[] } {
  const queries: AiQueryOp[] = [];
  const writes: AiOp[] = [];
  ops.forEach(o => (isQueryOp(o) ? queries.push(o) : writes.push(o)));
  return { queries, writes };
}

const MAX_QUERY_DAYS = 366;
const MAX_DIARY_DAYS = 92;
const MAX_DIARY_LINES = 150;
const MAX_LEDGER_ROWS = 50;
const MAX_QUERY_CHARS = 7000;

function normalizeRange(
  from: string | undefined,
  to: string | undefined,
  days: number | undefined,
  today: string,
): { from: string; to: string } {
  let f = from ?? "";
  let t = to ?? "";
  if (!f && !t) {
    if (days) {
      t = today;
      f = moment(today).subtract(days - 1, "day").format("YYYY-MM-DD");
    } else {
      f = today;
      t = today;
    }
  } else if (!f) {
    f = t;
  } else if (!t) {
    t = f;
  }
  if (f > t) [f, t] = [t, f];
  // 跨度上限：避免把十年数据一次性塞进提示词
  if (moment(t).diff(moment(f), "days") > MAX_QUERY_DAYS - 1) {
    f = moment(t).subtract(MAX_QUERY_DAYS - 1, "day").format("YYYY-MM-DD");
  }
  return { from: f, to: t };
}

/** 生成范围内的日期列表；超过 cap 天时只取最近的 cap 天 */
function datesOfRange(from: string, to: string, cap: number): string[] {
  const out: string[] = [];
  const end = moment(to).startOf("day");
  const start = moment(from).startOf("day");
  const total = end.diff(start, "days") + 1;
  const begin = total > cap ? end.clone().subtract(cap - 1, "day") : start;
  for (let d = begin.clone(); !d.isAfter(end); d.add(1, "day")) {
    out.push(d.format("YYYY-MM-DD"));
  }
  return out;
}

function clipLines(lines: string[], maxLines: number, maxChars = MAX_QUERY_CHARS): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (out.length >= maxLines || used + line.length > maxChars) {
      out.push(`……（结果过多，已截断，共 ${lines.length} 行）`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

function compactText(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function matchesQuery(haystack: string, keyword: string | undefined): boolean {
  return !keyword || haystack.toLowerCase().includes(keyword.trim().toLowerCase());
}

async function queryDiary(
  app: App,
  settings: DaybookSettings,
  today: string,
  q: Extract<AiQueryOp, { op: "query-diary" }>,
): Promise<string> {
  const { from, to } = normalizeRange(q.from, q.to, q.days, today);
  const dates = datesOfRange(from, to, MAX_DIARY_DAYS);
  const entries = await readJournalEntriesForDates(app, settings, dates);
  entries.sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? "").localeCompare(a.time ?? ""));
  const lines: string[] = [];
  entries.forEach(e => {
    if (e.archived) return;
    if (e.todos?.length) {
      const head = e.todos[0];
      const hit = matchesQuery(`${head.text} ${head.note ?? ""} ${head.desc ?? ""} ${(e.tags ?? []).join(" ")}`, q.keyword);
      if (!hit) return;
      e.todos.forEach(t => {
        const mark = t.done ? "[x]" : "[ ]";
        const indent = t.indent ? " ↳ " : " ";
        const due = t.dueDate ? `（截止 ${t.dueDate}）` : "";
        const done = t.completedAt ? `（完成 ${t.completedAt}）` : "";
        const abandoned = e.abandoned ? "（已放弃）" : "";
        lines.push(`${e.date} ${e.sectionLabel}${indent}${mark} ${compactText(t.text)}${abandoned}${due}${done}`);
      });
    } else {
      const hit = matchesQuery(`${e.text} ${e.sectionLabel} ${(e.tags ?? []).join(" ")}`, q.keyword);
      if (!hit) return;
      const time = e.time ? ` ${e.time}` : "";
      lines.push(`${e.date} ${e.sectionLabel}${time} ${compactText(e.text)}`);
    }
  });
  const spanDays = moment(to).diff(moment(from), "days") + 1;
  const scope = `${from} ~ ${to}`;
  const keyword = q.keyword ? `，关键词「${q.keyword}」` : "";
  const head = `【闪念/待办查询】范围 ${scope}${keyword}${dates.length < spanDays ? `，仅取最近 ${dates.length} 天` : ""}，命中 ${lines.length} 条：`;
  return lines.length ? `${head}\n${clipLines(lines, MAX_DIARY_LINES)}` : `${head}\n（没有记录）`;
}

async function queryHabits(
  ctx: AiDataContext,
  today: string,
  q: Extract<AiQueryOp, { op: "query-habits" }>,
): Promise<string> {
  const { from, to } = normalizeRange(q.from, q.to, q.days, today);
  const picked = q.habit ? ctx.habits.filter(h => matchHabit([h], q.habit!)) : ctx.habits;
  const head = `【习惯打卡查询】范围 ${from} ~ ${to}${q.habit ? `，习惯「${q.habit}」` : ""}：`;
  if (!picked.length) return `${head}\n（没有匹配的习惯）`;
  const blocks: string[] = [];
  picked.forEach(h => {
    const rows = h.rows
      .filter(r => !r.skipped && r.date >= from && r.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? "").localeCompare(a.time ?? ""));
    const days = new Map<string, number>();
    rows.forEach(r => days.set(r.date, (days.get(r.date) ?? 0) + 1));
    const recent = rows.slice(0, 8).map(r => `${r.date.slice(5)}${r.time ? " " + r.time : ""}`).join("、");
    blocks.push([
      `习惯「${h.config.name}」：${rows.length} 次，打卡 ${days.size} 天${rows.length ? `；最近：${recent}` : ""}`,
      `  今日 ${days.get(today) ?? 0}/${h.config.timesPerDay} 次（目标）`,
    ].join("\n"));
  });
  return `${head}\n${blocks.join("\n")}`;
}

async function queryLedger(
  app: App,
  settings: DaybookSettings,
  today: string,
  q: Extract<AiQueryOp, { op: "query-ledger" }>,
): Promise<string> {
  const { from, to } = normalizeRange(q.from, q.to, q.days, today);
  const head = `【记账查询】范围 ${from} ~ ${to}${q.kind ? `，${q.kind === "income" ? "收入" : "支出"}` : ""}${q.category ? `，类别「${q.category}」` : ""}${q.account ? `，账户「${q.account}」` : ""}${q.keyword ? `，关键词「${q.keyword}」` : ""}：`;
  let store: LedgerStore;
  try {
    store = new LedgerStore(app, settings);
    await store.load();
  } catch (e) {
    console.error("Daybook AI: 读取记账数据失败", e);
    return `${head}\n（记账数据读取失败）`;
  }
  const cfg = store.config;
  const catOf = (r: LedgerRecord) => cfg.categories.find(c => c.id === r.categoryId);
  const subOf = (r: LedgerRecord) => catOf(r)?.subs.find(s => s.id === r.subId);
  const accOf = (r: LedgerRecord) => cfg.accounts.find(a => a.id === r.accountId);
  let records = store.records.filter(r => r.date >= from && r.date <= to);
  if (q.kind) records = records.filter(r => r.kind === q.kind);
  if (q.category) {
    const k = q.category.trim();
    records = records.filter(r => {
      const cat = catOf(r);
      const sub = subOf(r);
      return [cat?.name ?? "", sub?.name ?? ""].some(n => n && (n.includes(k) || k.includes(n)));
    });
  }
  if (q.account) {
    const k = q.account.trim();
    records = records.filter(r => {
      const acc = accOf(r);
      return !!acc && (acc.name.includes(k) || k.includes(acc.name));
    });
  }
  if (q.keyword) {
    records = records.filter(r => matchesQuery(
      `${r.note} ${(r.tags ?? []).join(" ")} ${r.address} ${r.other}`,
      q.keyword,
    ));
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  let expense = 0, income = 0, transfers = 0;
  const byCat = new Map<string, number>();
  records.forEach(r => {
    if (r.kind === "transfer") { transfers++; return; }
    const amount = baseAmount(r, cfg);
    if (r.kind === "expense") {
      expense += amount;
      const name = catOf(r)?.name ?? "未分类";
      byCat.set(name, (byCat.get(name) ?? 0) + amount);
    } else {
      income += amount;
    }
  });
  const base = cfg.baseCurrency || "CNY";
  const summary = `共 ${records.length} 笔：支出 ${fmtMoney(expense)} ${base}，收入 ${fmtMoney(income)} ${base}，结余 ${fmtMoney(income - expense)} ${base}${transfers ? `（另有 ${transfers} 笔转账，不计收支）` : ""}`;
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, n]) => `${name} ${fmtMoney(n)}`).join("、");
  const limit = Math.min(q.limit ?? 20, MAX_LEDGER_ROWS);
  const rows = records.slice(0, limit).map(r => {
    const cat = catOf(r);
    const sub = subOf(r);
    const acc = accOf(r);
    const label = r.kind === "income" ? "收入" : r.kind === "transfer" ? "转账" : "支出";
    const catText = cat ? `${cat.name}${sub ? `/${sub.name}` : ""}` : "未分类";
    const note = r.note ? ` · ${compactText(r.note, 40)}` : "";
    return `${r.date} ${r.clock ? r.clock + " " : ""}${label} ${fmtMoney(baseAmount(r, cfg))} ${base} · ${catText} · ${acc?.name ?? "未知账户"}${note}`;
  });
  const lines = [summary];
  if (cats) lines.push(`支出类别：${cats}`);
  if (rows.length) lines.push("明细（按时间倒序）：", ...rows);
  if (records.length > rows.length) lines.push(`……仅列出最近 ${rows.length} 笔`);
  return `${head}\n${clipLines(lines, MAX_LEDGER_ROWS + 4)}`;
}

/** 执行一批只读查询，返回拼接好的中文结果（给模型第二轮使用） */
export async function executeQueries(
  app: App,
  settings: DaybookSettings,
  ctx: AiDataContext,
  queries: AiQueryOp[],
): Promise<string> {
  const blocks: string[] = [];
  for (const q of queries) {
    if (q.op === "query-diary") blocks.push(await queryDiary(app, settings, ctx.today, q));
    else if (q.op === "query-ledger") blocks.push(await queryLedger(app, settings, ctx.today, q));
    else if (q.op === "query-habits") blocks.push(await queryHabits(ctx, ctx.today, q));
  }
  return clipLines(blocks.join("\n\n").split("\n"), Number.MAX_SAFE_INTEGER, MAX_QUERY_CHARS);
}

/* ══ 执行 + 快照 ══ */

export interface ExecuteResult {
  title: string;
  files: AiWriteFile[];
}

export async function executeOps(
  app: App,
  ops: PreparedOp[],
): Promise<ExecuteResult> {
  // 先做准备（如记账旧数据迁移、创建目录），再取基线：撤销只回滚 AI 真正写入的内容
  for (const p of ops) {
    if (p.prepare) await p.prepare();
  }

  // 1) 基线：每个涉及文件只读一次全文（null = 文件不存在）
  const allPaths = [...new Set(ops.flatMap(p => p.paths))];
  const baseline = new Map<string, string | null>();
  for (const path of allPaths) baseline.set(path, await readText(app, path));

  // 2) 暂存：依次计算各 op 的新内容（同一文件的多个 op 在内存里叠加，最后只落盘一次）
  const staged = new Map(baseline);
  for (const p of ops) await p.stage(staged);

  // 3) 冲突检测：落盘前重读比对基线，期间被外部改动就取消整批（此时还没有写任何东西）
  for (const path of allPaths) {
    const now = await readText(app, path);
    if (now !== (baseline.get(path) ?? null)) {
      throw new Error(`文件在准备期间被外部修改，已取消本次写入：${path}`);
    }
  }

  // 4) 提交：只写内容有变化的文件，每个文件恰好一次
  const written: string[] = [];
  try {
    for (const path of allPaths) {
      const before = baseline.get(path) ?? null;
      const after = staged.get(path) ?? null;
      if (after === before) continue;
      await writeCommit(app, path, after ?? "", before === null);
      written.push(path);
    }
  } catch (e) {
    // 中途失败：把已改的文件还原，避免「写了一半又没记录可撤销」
    for (const path of written) {
      const b = baseline.get(path);
      try {
        if (b === null || b === undefined) {
          if (await app.vault.adapter.exists(path)) await app.vault.adapter.remove(path);
        } else {
          await app.vault.adapter.write(path, b);
        }
      } catch (restoreError) {
        console.error("Daybook AI: 回滚失败", path, restoreError);
      }
    }
    throw e;
  }

  // 5) 记录快照：直接用暂存结果与基线对比，不再重读磁盘
  const files: AiWriteFile[] = [];
  for (const path of allPaths) {
    const b = baseline.get(path) ?? null;
    const a = staged.get(path) ?? null;
    if (a === b) continue;
    files.push({ path, before: b, after: a });
  }
  return {
    title: ops.map(p => p.summary).join("；"),
    files,
  };
}

/** 提交单个文件：md 走 vault API（保证元数据缓存刷新），其余（记账 journal 等）走原子写 */
async function writeCommit(app: App, path: string, text: string, isNew: boolean): Promise<void> {
  if (isNew) {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    if (path.endsWith(".md")) {
      await app.vault.create(path, text);
      return;
    }
    await writeAtomicFile(app.vault.adapter, path, text);
    return;
  }
  const file = app.vault.getAbstractFileByPath(path) as TFile | null;
  if (file) {
    await app.vault.modify(file, text);
    return;
  }
  await writeAtomicFile(app.vault.adapter, path, text);
}
