/**
 * aiPage.ts — AI 助手页（页内，不新开标签页）
 *
 * 交互：一句话 → 模型返回「回复 + 待写入动作」→ 页面展示每项动作的目标文件与
 * 将写入的内容 → 用户点「确认写入」才落盘 → 记录前后快照，可一键撤销。
 *
 * 结构：顶栏（返回 / 标题 / ···）+ 对话列表（flex 撑满、内部滚动）+ 底部输入条。
 * 安卓返回键由 JournalView 的 popstate 哨兵揭开本页（与 Dashboard 同一套）。
 */
import { App, EventRef, Menu, Modal, Notice, moment, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { AiStore, type AiWriteRecord } from "./aiStore";
import { aiConfigProblem, chatComplete, resolveAiConfig, type AiChatMessage } from "./aiClient";
import {
  buildSystemPrompt, executeOps, executeQueries, loadAiDataContext, parseAiResponse, prepareOps, splitAiOps,
  type AiOp, type PreparedOp,
} from "./aiActions";

/** 写入记录：最近 40 次，任选一条按写入前全文还原 */
class AiWriteHistoryModal extends Modal {
  constructor(
    app: App,
    private records: AiWriteRecord[],
    private onUndo: (rec: AiWriteRecord) => Promise<boolean>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("db-ai-hist");
    contentEl.createEl("h3", { text: "AI 写入记录" });
    contentEl.createDiv({
      cls: "db-ai-hist-hint",
      text: "保留最近 40 次写入；撤销会按写入前的全文还原文件。",
    });
    if (!this.records.length) {
      contentEl.createDiv({ cls: "db-ai-hist-empty", text: "还没有写入记录" });
      return;
    }
    const list = contentEl.createDiv({ cls: "db-ai-hist-list" });
    this.records.forEach(rec => {
      const row = list.createDiv({ cls: "db-ai-hist-row" + (rec.undone ? " is-undone" : "") });
      const meta = row.createDiv({ cls: "db-ai-hist-meta" });
      meta.createDiv({ cls: "db-ai-hist-time", text: moment(rec.at).format("YYYY-MM-DD HH:mm") });
      meta.createDiv({ cls: "db-ai-hist-title", text: rec.title });
      meta.createDiv({ cls: "db-ai-hist-files", text: rec.files.map(f => f.path).join("  ") });
      const btn = row.createEl("button", {
        cls: "db-ai-hist-btn",
        text: rec.undone ? "已撤销" : "撤销",
        attr: { type: "button" },
      });
      if (rec.undone) { btn.disabled = true; return; }
      btn.addEventListener("click", () => {
        void (async () => {
          btn.disabled = true;
          const ok = await this.onUndo(rec);
          if (ok) {
            btn.setText("已撤销");
            row.addClass("is-undone");
          } else {
            btn.disabled = false;
          }
        })();
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const EXAMPLES: { label: string; text: string }[] = [
  { label: "记一笔午饭 32 元", text: "记一笔午饭 32 元，微信支付" },
  { label: "这个月吃饭花了多少", text: "这个月吃饭一共花了多少？" },
  { label: "给「阅读」打卡", text: "帮我给「阅读」打今天的卡" },
  { label: "加一个明天的待办", text: "加一个待办：明天下午三点前交报告" },
];

/** 两轮里的写入动作合并去重（查询轮可能同时给出记录动作） */
function mergeWriteOps(a: AiOp[], b: AiOp[]): AiOp[] {
  const out = [...a];
  const seen = new Set(out.map(o => JSON.stringify(o)));
  b.forEach(o => {
    const key = JSON.stringify(o);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(o);
  });
  return out;
}

export class AiChatPage {
  private store: AiStore;
  private headEl!: HTMLElement;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private pendingEl: HTMLElement | null = null;
  private pending: PreparedOp[] = [];
  private busy = false;
  private destroyed = false;
  private resizeRef: EventRef | null = null;
  private focusHandler: (() => void) | null = null;
  private kbHandler: (() => void) | null = null;

  constructor(
    private app: App,
    private plugin: DaybookPlugin,
    private hostEl: HTMLElement,
    private scopeEl: HTMLElement,
    private onBack: () => void,
    private onWritten: () => void,
  ) {
    this.store = new AiStore(app, plugin.settings);
  }

  async open(): Promise<void> {
    await this.store.load();
    if (this.destroyed) return;
    this.render();
    // 原生标题栏显隐/尺寸变化会改变与内容的重叠量
    this.resizeRef = this.app.workspace.on("resize", () => this.applyHeaderInset());
    // 从设置页回来时刷新「未配置」横幅与标题里的模型名
    this.focusHandler = () => this.syncConfigState();
    activeWindow.addEventListener("focus", this.focusHandler);
    // 键盘弹起后列表会变矮：把最新一条保持在可见区
    this.kbHandler = () => activeWindow.setTimeout(() => this.scrollToBottom(), 120);
    activeWindow.addEventListener("keyboardWillShow", this.kbHandler as EventListener);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.resizeRef) {
      this.app.workspace.offref(this.resizeRef);
      this.resizeRef = null;
    }
    if (this.focusHandler) {
      activeWindow.removeEventListener("focus", this.focusHandler);
      this.focusHandler = null;
    }
    if (this.kbHandler) {
      activeWindow.removeEventListener("keyboardWillShow", this.kbHandler as EventListener);
      this.kbHandler = null;
    }
  }

  /** 设置页可能刚改过厂商 / Key：只同步状态条与横幅，不重建待写入卡片 */
  private syncConfigState(): void {
    if (this.destroyed || !this.headEl || !this.listEl) return;
    const cfg = resolveAiConfig(this.plugin.settings);
    const sub = this.headEl.querySelector(".db-ai-title-sub");
    if (sub instanceof HTMLElement) {
      sub.setText(cfg.model ? `${cfg.vendorName} · ${cfg.model}` : cfg.vendorName);
    }
    const problem = aiConfigProblem(this.plugin.settings);
    const setup = this.listEl.querySelector(".db-ai-setup");
    // 有待写入卡片时不重建列表，避免把待确认内容清掉
    if (problem && !setup && !this.pendingEl) this.renderMessages();
    else if (!problem && setup) setup.remove();
  }

  /* ══ 骨架 ══ */

  private render(): void {
    const host = this.hostEl;
    host.empty();
    host.setAttribute("class", "db-root db-page-ai");

    this.headEl = host.createDiv({ cls: "db-ai-head" });
    const back = this.headEl.createEl("button", {
      cls: "db-ai-icon",
      attr: { type: "button", "aria-label": "返回", title: "返回" },
    });
    setIcon(back, "arrow-left");
    back.addEventListener("click", () => this.onBack());

    const title = this.headEl.createDiv({ cls: "db-ai-title" });
    title.createDiv({ cls: "db-ai-title-main", text: "AI 助手" });
    const cfg = resolveAiConfig(this.plugin.settings);
    title.createDiv({
      cls: "db-ai-title-sub",
      text: cfg.model ? `${cfg.vendorName} · ${cfg.model}` : cfg.vendorName,
    });

    const more = this.headEl.createEl("button", {
      cls: "db-ai-icon",
      attr: { type: "button", "aria-label": "更多操作", "aria-haspopup": "menu", title: "更多操作" },
    });
    setIcon(more, "more-horizontal");
    this.bindMenu(more);

    this.listEl = host.createDiv({ cls: "db-ai-list" });
    this.renderMessages();

    const bar = host.createDiv({ cls: "db-ai-composer" });
    this.inputEl = bar.createEl("textarea", {
      cls: "db-ai-input",
      attr: {
        rows: "1",
        placeholder: "记录或提问：记一笔午饭 32 元 / 这个月花了多少",
        "aria-label": "AI 输入框",
        enterkeyhint: "send",
      },
    });
    this.inputEl.addEventListener("input", () => this.autosize());
    let composing = false;
    this.inputEl.addEventListener("compositionstart", () => { composing = true; });
    this.inputEl.addEventListener("compositionend", () => { composing = false; });
    this.inputEl.addEventListener("keydown", e => {
      const ime = composing || (e as KeyboardEvent & { isComposing?: boolean }).isComposing;
      if (e.key === "Enter" && !e.shiftKey && !ime) {
        e.preventDefault();
        void this.send();
      }
    });

    this.sendBtn = bar.createEl("button", {
      cls: "db-ai-send",
      attr: { type: "button", "aria-label": "发送" },
    });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => void this.send());

    this.applyHeaderInset();
    activeWindow.requestAnimationFrame(() => {
      this.applyHeaderInset();
      this.scrollToBottom();
    });
  }

  /** 安卓端原生 .view-header 悬浮在内容之上：量出重叠高度后让 sticky 顶栏下移避让 */
  private applyHeaderInset(): void {
    if (!this.headEl || !this.hostEl || this.destroyed) return;
    const native = this.scopeEl.querySelector(".view-header") as HTMLElement | null;
    let inset = 0;
    if (native && native.offsetHeight > 0) {
      const nBottom = native.getBoundingClientRect().bottom;
      const rTop = this.hostEl.getBoundingClientRect().top;
      inset = Math.max(0, Math.ceil(nBottom - rTop));
    }
    const on = inset > 0;
    this.headEl.toggleClass("is-inset", on);
    this.headEl.style.top = on ? `${inset}px` : "";
    this.headEl.style.marginTop = on ? `${inset}px` : "";
  }

  private bindMenu(trigger: HTMLElement): void {
    trigger.addEventListener("click", e => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem(item => {
        item.setTitle("撤销最近一次写入").setIcon("undo-2");
        item.onClick(() => {
          const rec = this.store.recentWrite();
          if (!rec) { new Notice("没有可撤销的写入"); return; }
          void this.undoWrite(rec);
        });
      });
      menu.addItem(item => {
        item.setTitle("写入记录").setIcon("history");
        item.onClick(() => {
          new AiWriteHistoryModal(this.app, this.store.writes, rec => this.undoWrite(rec)).open();
        });
      });
      menu.addItem(item => {
        item.setTitle("清空对话").setIcon("trash-2");
        item.onClick(() => {
          void (async () => {
            await this.store.clearMessages();
            this.pending = [];
            this.pendingEl = null;
            this.renderMessages();
            this.scrollToBottom();
          })();
        });
      });
      menu.addSeparator();
      menu.addItem(item => {
        item.setTitle("AI 设置").setIcon("settings");
        item.onClick(() => this.openSettings());
      });
      menu.addItem(item => {
        item.setTitle("返回").setIcon("arrow-left");
        item.onClick(() => this.onBack());
      });
      const rect = trigger.getBoundingClientRect();
      menu.showAtPosition({ x: Math.max(8, rect.right - 180), y: rect.bottom + 4 });
    });
  }

  private openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    if (setting) { setting.open(); setting.openTabById(this.plugin.manifest.id); }
    else new Notice("请到「设置 → 第三方插件 → Daybook」里配置 AI");
  }

  /* ══ 对话列表 ══ */

  private renderMessages(): void {
    this.listEl.empty();
    this.pendingEl = null;
    const problem = aiConfigProblem(this.plugin.settings);
    if (problem) this.renderSetupCard(problem);
    if (!this.store.messages.length) {
      this.renderEmpty();
      return;
    }
    this.store.messages.forEach(m => this.renderBubble(m.role, m.content));
  }

  private renderSetupCard(problem: string): void {
    const card = this.listEl.createDiv({ cls: "db-ai-setup" });
    card.createDiv({ cls: "db-ai-setup-title", text: "先配置模型" });
    card.createDiv({ cls: "db-ai-setup-text", text: `${problem}。到插件设置 →「AI 助手」里选择厂商并填入 API Key 即可。` });
    const btn = card.createEl("button", {
      cls: "db-ai-setup-btn",
      text: "去设置",
      attr: { type: "button" },
    });
    btn.addEventListener("click", () => this.openSettings());
  }

  private renderEmpty(): void {
    const empty = this.listEl.createDiv({ cls: "db-ai-empty" });
    empty.createDiv({ cls: "db-ai-empty-title", text: "让 AI 帮你写进 Daybook" });
    empty.createDiv({
      cls: "db-ai-empty-text",
      text: "可以说一句想记录的话，也可以直接问已经记过的内容。写入前先给你看要写的东西，点确认才落盘；查询只读，不会改文件。",
    });
    const chips = empty.createDiv({ cls: "db-ai-chips" });
    EXAMPLES.forEach(ex => {
      const chip = chips.createEl("button", {
        cls: "db-ai-chip",
        text: ex.label,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => {
        this.inputEl.value = ex.text;
        this.autosize();
        this.inputEl.focus();
      });
    });
  }

  private renderBubble(role: "user" | "assistant", content: string): HTMLElement {
    const msg = this.listEl.createDiv({ cls: `db-ai-msg is-${role}` });
    msg.createDiv({ cls: "db-ai-text", text: content });
    return msg;
  }

  private appendTransient(content: string, kind: "loading" | "error" | "system"): HTMLElement {
    const el = this.listEl.createDiv({ cls: `db-ai-msg is-assistant is-${kind}` });
    el.createDiv({ cls: "db-ai-text", text: content });
    this.scrollToBottom();
    return el;
  }

  /* ══ 待写入预览 ══ */

  private renderPending(prepared: PreparedOp[], invalid: string[]): void {
    if (!prepared.length && !invalid.length) return;
    this.pendingEl?.remove();
    const card = this.listEl.createDiv({ cls: "db-ai-pending" });
    this.pendingEl = card;
    card.createDiv({
      cls: "db-ai-pending-title",
      text: `待写入 ${prepared.length} 项${invalid.length ? ` · ${invalid.length} 项无法执行` : ""}`,
    });

    prepared.forEach(p => {
      const row = card.createDiv({ cls: "db-ai-op" });
      const head = row.createDiv({ cls: "db-ai-op-head" });
      head.createSpan({ cls: "db-ai-op-kind", text: p.kind });
      head.createSpan({ cls: "db-ai-op-summary", text: p.summary });
      row.createDiv({ cls: "db-ai-op-path", text: p.paths[0] });
      row.createDiv({ cls: "db-ai-op-preview", text: p.preview });
    });

    invalid.forEach(text => {
      card.createDiv({ cls: "db-ai-op-invalid", text: `⚠ ${text}` });
    });

    const actions = card.createDiv({ cls: "db-ai-pending-actions" });
    const cancel = actions.createEl("button", {
      cls: "db-ai-btn is-secondary", text: "取消", attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.pending = [];
      card.remove();
      this.pendingEl = null;
    });
    const confirm = actions.createEl("button", {
      cls: "db-ai-btn is-primary",
      text: prepared.length ? "确认写入" : "无法执行",
      attr: { type: "button" },
    });
    if (!prepared.length) confirm.disabled = true;
    confirm.addEventListener("click", () => {
      if (!prepared.length) return;
      void this.confirmWrite(prepared, confirm, cancel);
    });
    this.scrollToBottom();
  }

  private async confirmWrite(
    prepared: PreparedOp[],
    confirm: HTMLButtonElement,
    cancel: HTMLButtonElement,
  ): Promise<void> {
    if (this.busy) return;
    confirm.disabled = true;
    cancel.disabled = true;
    this.setBusy(true);
    try {
      const result = await executeOps(this.app, prepared);
      if (!result.files.length) {
        new Notice("内容没有变化，未写入");
      } else {
        const rec = await this.store.addWrite(result.title, result.files);
        this.pending = [];
        this.pendingEl?.remove();
        this.pendingEl = null;
        this.appendWriteResult(rec);
        this.onWritten();
      }
    } catch (e) {
      new Notice("写入失败：" + (e instanceof Error ? e.message : String(e)));
      confirm.disabled = false;
      cancel.disabled = false;
    } finally {
      this.setBusy(false);
      this.scrollToBottom();
    }
  }

  private appendWriteResult(rec: AiWriteRecord): void {
    const el = this.listEl.createDiv({ cls: "db-ai-msg is-assistant is-written" });
    el.createDiv({ cls: "db-ai-text", text: `✅ 已写入 ${rec.files.length} 个文件：\n${rec.title}` });
    const undo = el.createEl("button", {
      cls: "db-ai-undo", text: "撤销", attr: { type: "button", "aria-label": "撤销这次写入" },
    });
    undo.addEventListener("click", () => {
      undo.disabled = true;
      void this.undoWrite(rec);
    });
  }

  private async undoWrite(rec: AiWriteRecord): Promise<boolean> {
    const ok = await this.store.undo(rec);
    if (ok) {
      this.onWritten();
      new Notice("已撤销这次写入");
      this.appendTransient(`已撤销：${rec.title}`, "system");
    } else {
      new Notice("撤销失败，可能有文件已被移动或删除");
    }
    this.scrollToBottom();
    return ok;
  }

  /* ══ 发送 ══ */

  private async send(): Promise<void> {
    if (this.busy || this.destroyed) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    const problem = aiConfigProblem(this.plugin.settings);
    if (problem) { new Notice(`${problem}（设置 → AI 助手）`); return; }

    this.inputEl.value = "";
    this.autosize();
    this.pending = [];
    this.pendingEl = null;

    await this.store.pushMessage("user", text);
    this.renderMessages();
    this.scrollToBottom();

    const loading = this.appendTransient("正在思考…", "loading");
    const setLoadingText = (t: string) => {
      const el = loading.querySelector(".db-ai-text");
      if (el instanceof HTMLElement) el.setText(t);
    };
    this.setBusy(true);
    try {
      const ctx = await loadAiDataContext(this.app, this.plugin.settings);
      const history: AiChatMessage[] = this.store.messages
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content }));
      // Anthropic 要求对话以 user 开头：截断后若首条是 assistant 就丢掉
      while (history.length && history[0].role === "assistant") history.shift();
      const raw = await chatComplete(this.plugin.settings, [
        { role: "system", content: buildSystemPrompt(ctx) },
        ...history,
      ]);
      if (this.destroyed) return;
      const parsed = parseAiResponse(raw);
      let reply = parsed.reply;
      let ops = parsed.ops;
      const first = splitAiOps(ops);
      if (first.queries.length) {
        // 只读查询立即执行，把结果回传给模型组织答案；写入仍走确认
        setLoadingText("正在查询数据…");
        const queryText = await executeQueries(this.app, this.plugin.settings, ctx, first.queries);
        if (this.destroyed) return;
        const raw2 = await chatComplete(this.plugin.settings, [
          { role: "system", content: buildSystemPrompt(ctx) },
          ...history,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: `以下是只读查询结果，请据此回答用户；如果需要记录，照常返回待写入动作。\n\n${queryText}`,
          },
        ]);
        if (this.destroyed) return;
        const parsed2 = parseAiResponse(raw2);
        reply = parsed2.reply || reply;
        ops = mergeWriteOps(first.writes, splitAiOps(parsed2.ops).writes);
      }
      await this.store.pushMessage("assistant", reply);
      this.renderMessages();
      this.scrollToBottom();
      if (ops.length) {
        const { prepared, invalid } = await prepareOps(
          this.app, this.plugin.settings, ctx, ops,
        );
        this.pending = prepared;
        this.renderPending(prepared, invalid);
      }
    } catch (e) {
      loading.remove();
      this.appendTransient(`请求失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      this.setBusy(false);
      this.scrollToBottom();
    }
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.sendBtn?.toggleClass("is-busy", on);
    if (this.sendBtn) this.sendBtn.disabled = on;
  }

  private autosize(): void {
    const el = this.inputEl;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  private scrollToBottom(): void {
    const el = this.listEl;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }
}
