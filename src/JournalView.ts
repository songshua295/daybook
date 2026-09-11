import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal } from "obsidian";
import type LifeJournalPlugin from "./main";
import { appendToSection } from "./fileManager";
import { appendTodoCompletionInfo, createPriorityBadge, effectivePriority, getCompletedFieldName, moveTodoSubtree, PRIORITY_EMOJI, PRIORITY_META, shouldShowPriorityBadge, type PriorityLevel } from "./fileReader";
import { isTypeEnabled, type SectionConfig, type UIStyle, type MoodOption } from "./settings";
import { ReviewView } from "./ReviewView";
import type { TodoItem } from "./fileReader";
import { attachMemoEditor } from "./memoEditor";

export const VIEW_TYPE_JOURNAL = "life-journal-view";

function isMobile(): boolean { return window.innerWidth < 600; }

function extractInlineTags(text: string): string[] {
  const regex = /(^|[\s\u3000"'`([{<\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001\uFF08\uFF09\u3010\u3011\u300A\u300B\u300C\u300D\u300E\u300F,.;!?])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
  const tags: string[] = [];
  let m;
  while ((m = regex.exec(text)) !== null) { tags.push(m[2]); }
  return [...new Set(tags)];
}

/**
 * 从混合文本中自动提取日期关键词
 * 如"本周五完成计划的制定" → { date: "2026-05-23", text: "完成计划的制定", keyword: "本周五" }
 * 如果文本中有独立的截止日期输入框值，则优先使用 parseSmartDate 解析
 */
function extractDateFromText(input: string): { date: string | undefined; text: string; keyword?: string } {
  const today = moment();
  const trimmed = input.trim();

  // 日期关键词列表（按优先级：越精确的越靠前，长的在前）
  const patterns: { regex: RegExp; calc: (match: RegExpMatchArray) => string | undefined; keyword: string }[] = [
    // 明天/大后天/后天（长的在前，避免"大后天"被匹配成"后天"）
    { regex: /(明天)/, calc: () => today.clone().add(1, "day").format("YYYY-MM-DD"), keyword: "明天" },
    { regex: /(大后天)/, calc: () => today.clone().add(3, "day").format("YYYY-MM-DD"), keyword: "大后天" },
    { regex: /(后天)/, calc: () => today.clone().add(2, "day").format("YYYY-MM-DD"), keyword: "后天" },
    // N天后
    { regex: /(\d+)天后/, calc: (m) => today.clone().add(parseInt(m[1]), "day").format("YYYY-MM-DD"), keyword: "N天后" },
    // 本周X
    { regex: /本周([一二三四五六日天])/, calc: (m) => {
      const wm: Record<string, number> = { "\u4E00": 1, "\u4E8C": 2, "\u4E09": 3, "\u56DB": 4, "\u4E94": 5, "\u516D": 6, "\u65E5": 0, "\u5929": 0 };
      const t = wm[m[1]]; if (t === undefined) return undefined;
      let d = t - today.day(); if (d < 0) d += 7;
      return today.clone().add(d, "day").format("YYYY-MM-DD");
    }, keyword: "本周X" },
    // 下周X
    { regex: /下周([一二三四五六日天])/, calc: (m) => {
      const wm: Record<string, number> = { "\u4E00": 1, "\u4E8C": 2, "\u4E09": 3, "\u56DB": 4, "\u4E94": 5, "\u516D": 6, "\u65E5": 0, "\u5929": 0 };
      const t = wm[m[1]]; if (t === undefined) return undefined;
      return today.clone().add(t - today.day() + 7, "day").format("YYYY-MM-DD");
    }, keyword: "下周X" },
    // 今天（作为截止日期）
    { regex: /(今天)/, calc: () => today.format("YYYY-MM-DD"), keyword: "今天" },
    // YYYY-MM-DD
    { regex: /(\d{4}-\d{2}-\d{2})/, calc: (m) => moment(m[1]).isValid() ? m[1] : undefined, keyword: "ISO日期" },
    // M月D日
    { regex: /(\d{1,2})月(\d{1,2})日/, calc: (m) => today.format("YYYY") + "-" + String(parseInt(m[1])).padStart(2, "0") + "-" + String(parseInt(m[2])).padStart(2, "0"), keyword: "月日" },
  ];

  for (const p of patterns) {
    const match = trimmed.match(p.regex);
    if (match) {
      const date = p.calc(match);
      if (date) {
        // 从文本中移除日期关键词部分
        const cleanText = trimmed.replace(p.regex, "").trim().replace(/^[，。、\s]+/, "").replace(/[，。、\s]+$/, "").trim();
        return { date, text: cleanText || trimmed, keyword: match[0] };
      }
    }
  }

  return { date: undefined, text: trimmed };
}

function formatDueDate(dateStr: string): string {
  const due = moment(dateStr).startOf("day");
  const diff = due.diff(moment().startOf("day"), "day");
  if (diff === 0) return "\u4ECA\u5929";
  if (diff === 1) return "\u660E\u5929";
  if (diff < 0) return `${Math.abs(diff)}\u5929\u524D`;
  if (diff <= 7) return `${diff}\u5929\u540E`;
  return `${due.month() + 1}月${due.date()}日`;
}

/** 心情长按编辑弹窗 */
class MoodEditModal extends Modal {
  private mood: MoodOption;
  private index: number;
  private onSave: (index: number, emoji: string, label: string) => void;
  private onDelete: (index: number) => void;
  private canDelete: boolean;

  constructor(
    app: any,
    mood: MoodOption,
    index: number,
    canDelete: boolean,
    onSave: (index: number, emoji: string, label: string) => void,
    onDelete: (index: number) => void
  ) {
    super(app);
    this.mood = mood;
    this.index = index;
    this.canDelete = canDelete;
    this.onSave = onSave;
    this.onDelete = onDelete;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lj-mood-edit-modal");

    contentEl.createEl("h3", { text: "编辑心情" });

    const form = contentEl.createDiv({ cls: "lj-mood-modal-form" });

    const emojiRow = form.createDiv({ cls: "lj-mood-modal-row" });
    emojiRow.createEl("label", { text: "表情" });
    const emojiInput = emojiRow.createEl("input", {
      cls: "lj-mood-modal-emoji-input",
      attr: { type: "text", maxlength: "4", placeholder: "😄" },
    });
    emojiInput.value = this.mood.emoji;

    const labelRow = form.createDiv({ cls: "lj-mood-modal-row" });
    labelRow.createEl("label", { text: "含义" });
    const labelInput = labelRow.createEl("input", {
      cls: "lj-mood-modal-label-input",
      attr: { type: "text", placeholder: "开心" },
    });
    labelInput.value = this.mood.label;

    const btnRow = contentEl.createDiv({ cls: "lj-mood-modal-btns" });

    if (this.canDelete) {
      const delBtn = btnRow.createEl("button", {
        cls: "lj-mood-modal-del-btn",
        text: "删除",
      });
      delBtn.addEventListener("click", () => {
        this.onDelete(this.index);
        this.close();
      });
    }

    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = btnRow.createEl("button", {
      cls: "mod-cta",
      text: "保存",
    });
    saveBtn.addEventListener("click", () => {
      const emoji = emojiInput.value.trim();
      const label = labelInput.value.trim();
      if (emoji && label) {
        this.onSave(this.index, emoji, label);
        this.close();
      } else {
        new Notice("表情和含义都不能为空");
      }
    });

    // 回车保存
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });
    emojiInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") labelInput.focus();
    });

    setTimeout(() => labelInput.focus(), 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class LifeJournalView extends ItemView {
  plugin: LifeJournalPlugin;
  private selectedMood: string | null = null; // emoji 作为选中标识
  private activeSectionId: string = "memos";
  private todoItems: TodoItem[] = [];
  private viewMode: "record" | "review" | "plans" = "record";
  private _vpResizeHandler: (() => void) | null = null;
  // 录音相关
  private mediaRecorder: any = null;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  // 计划优先级
  private currentPriority: PriorityLevel | null = null;
  // 子任务添加目标（编辑视图，index 指向顶级任务）
  private subtaskTarget: number | null = null;
  // 上一次渲染的编辑上下文（用于离开计划编辑时清空未保存草稿）
  private lastEditCtx = "";

  constructor(leaf: WorkspaceLeaf, plugin: LifeJournalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_JOURNAL; }
  getDisplayText(): string { return "Daybook"; }
  getIcon(): string { return "book-open"; }

  async onOpen() {
    this.buildUI();
    this.setupViewportAdapter();
  }

  async onClose() {
    this.teardownViewportAdapter();
    // 停止录音并释放资源
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop();
      } catch (e) { /* ignore */ }
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
  }

  private setupViewportAdapter() {
    const vp = window.visualViewport;
    if (!vp) return;
    this._vpResizeHandler = () => {
      const root = this.containerEl.children[1] as HTMLElement;
      if (!root) return;
      const h = Math.round(vp.height);
      root.style.height = h + "px";
      root.style.maxHeight = h + "px";
      root.scrollTop = root.scrollHeight;
    };
    vp.addEventListener("resize", this._vpResizeHandler);
  }

  private teardownViewportAdapter() {
    const vp = window.visualViewport;
    if (vp && this._vpResizeHandler) {
      vp.removeEventListener("resize", this._vpResizeHandler);
      this._vpResizeHandler = null;
    }
  }

  buildUI() {
    // 离开计划编辑（计划模式或计划类章节）时清空未保存的草稿
    const ctx = this.viewMode === "plans" ? "@plans" : this.viewMode === "record" ? `#${this.activeSectionId}` : `@${this.viewMode}`;
    if (ctx !== this.lastEditCtx) {
      const leavingPlans = this.lastEditCtx === "@plans"
        || (this.lastEditCtx.startsWith("#") && this.plugin.settings.sections.find(sec => `#${sec.id}` === this.lastEditCtx)?.type === "plans");
      if (leavingPlans) {
        this.todoItems = [];
        this.subtaskTarget = null;
        this.currentPriority = null;
      }
      this.lastEditCtx = ctx;
    }
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.setAttribute("class", "lj-root");
    root.style.height = "";
    root.style.maxHeight = "";
    // 设置切回「融入阅读列表」时，避免停留在已移除的计划模式
    if (this.viewMode === "plans" && (this.plugin.settings.plansDisplay !== "separate" || !isTypeEnabled(this.plugin.settings, "plans"))) {
      this.viewMode = "record";
    }
    const style = this.plugin.settings.uiStyle;
    if (style === "minimal") this.buildMinimalHeader(root);
    else if (style === "neon") this.buildNeonHeader(root);
    else this.buildSoftHeader(root);
    this.buildModeToggleFixed(root);
    if (this.viewMode === "review") {
      root.addClass("lj-root-review-v3");
      const rc = root.createDiv({ cls: "lj-review-container" });
      new ReviewView(rc, this.plugin).render();
      return;
    }
    if (this.viewMode === "plans") {
      // 计划模式：与阅读模式同层级，整页只展示待办计划
      root.addClass("lj-root-review-v3");
      const rc = root.createDiv({ cls: "lj-review-container" });
      new ReviewView(rc, this.plugin, true).render();
      return;
    }
    this.buildTabsAndContent(root, style);
  }

  private buildModeToggleFixed(root: HTMLElement) {
    const bar = root.createDiv({ cls: "lj-mode-toggle-bar lj-mode-toggle-fixed" });
    const toggle = bar.createDiv({ cls: "lj-mode-toggle" });
    const rb = toggle.createDiv({ cls: `lj-mode-btn ${this.viewMode === "record" ? "active" : ""}`, text: "\u270F\uFE0F \u7F16\u8F91" });
    const rv = toggle.createDiv({ cls: `lj-mode-btn ${this.viewMode === "review" ? "active" : ""}`, text: "\u{1F4D6} \u9605\u8BFB" });
    rb.addEventListener("click", () => { if (this.viewMode !== "record") { this.viewMode = "record"; this.buildUI(); } });
    rv.addEventListener("click", () => { if (this.viewMode !== "review") { this.viewMode = "review"; this.buildUI(); } });
    // 计划单独板块时，模式栏新增「📋 计划」入口
    if (this.plugin.settings.plansDisplay === "separate" && isTypeEnabled(this.plugin.settings, "plans")) {
      const rp = toggle.createDiv({ cls: `lj-mode-btn ${this.viewMode === "plans" ? "active" : ""}`, text: "\u{1F4CB} \u8BA1\u5212" });
      rp.addEventListener("click", () => { if (this.viewMode !== "plans") { this.viewMode = "plans"; this.buildUI(); } });
    }
  }

  private buildMinimalHeader(root: HTMLElement) {
    const d = new Date();
    const header = root.createDiv({ cls: "lj-header" });
    const left = header.createDiv({ cls: "lj-header-left" });
    left.createDiv({ cls: "lj-date-tiny", text: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase() + " \xB7 " + ["\u65E5","\u4E00","\u4E8C","\u4E09","\u56DB","\u4E94","\u516D"][d.getDay()] });
    left.createDiv({ cls: "lj-title", text: "Daybook" });
    header.createDiv({ cls: "lj-header-icon", text: "\u2726" });
  }

  private buildNeonHeader(root: HTMLElement) {
    const d = new Date();
    const header = root.createDiv({ cls: "lj-header" });
    const toprow = header.createDiv({ cls: "lj-header-toprow" });
    const logoWrap = toprow.createDiv({ cls: "lj-logo-wrap" });
    logoWrap.createDiv({ cls: "lj-logo-icon", text: "\u2726" });
    logoWrap.createDiv({ cls: "lj-logo-text", text: "Daybook" });
    toprow.createDiv({ cls: "lj-date-badge", text: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase() });
    const greeting = header.createDiv({ cls: "lj-greeting" });
    greeting.createSpan({ text: "\u4ECA\u5929\uFF0C\u597D\u597D" });
    greeting.createSpan({ cls: "lj-greeting-accent", text: "\u8BB0\u5F55\u81EA\u5DF1" });
  }

  private buildSoftHeader(root: HTMLElement) {
    const d = new Date();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const weekDays = ["\u661F\u671F\u65E5","\u661F\u671F\u4E00","\u661F\u671F\u4E8C","\u661F\u671F\u4E09","\u661F\u671F\u56DB","\u661F\u671F\u4E94","\u661F\u671F\u516D"];
    const header = root.createDiv({ cls: "lj-header" });
    const toprow = header.createDiv({ cls: "lj-header-toprow" });
    const brand = toprow.createDiv({ cls: "lj-brand" });
    brand.createDiv({ cls: "lj-brand-dot" });
    brand.createSpan({ text: "Daybook" });
    toprow.createDiv({ cls: "lj-streak-pill", text: "\u2726 \u4ECA\u65E5\u8BB0\u5F55" });
    const dateRow = header.createDiv({ cls: "lj-date-row" });
    dateRow.createSpan({ cls: "lj-date-large", text: `${m}\u6708${day}\u65E5` });
    dateRow.createSpan({ cls: "lj-date-sub", text: weekDays[d.getDay()] });
  }

  private buildTabsAndContent(root: HTMLElement, style: UIStyle) {
    const sections = this.plugin.settings.sections.filter(s => s.enabled && isTypeEnabled(this.plugin.settings, s.type));
    const tabBar = root.createDiv({ cls: "lj-tab-bar" });
    sections.forEach(sec => {
      const btn = tabBar.createDiv({ cls: `lj-tab ${this.activeSectionId === sec.id ? "active" : ""}` });
      btn.createDiv({ cls: "lj-tab-emoji", text: sec.emoji });
      btn.createDiv({ text: sec.label });
      btn.addEventListener("click", () => { if (this.activeSectionId !== sec.id) { this.activeSectionId = sec.id; this.buildUI(); } });
    });
    const content = root.createDiv({ cls: "lj-content lj-content-scroll" });
    const active = sections.find(s => s.id === this.activeSectionId) ?? sections[0];
    if (active) {
      this.activeSectionId = active.id;
      this.renderTabContent(content, active, style);
    } else {
      content.createDiv({ cls: "lj-todo-empty", text: "\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u6DFB\u52A0\u7AE0\u8282" });
    }
  }

  private renderTabContent(container: HTMLElement, section: SectionConfig, style: UIStyle) {
    if (section.type === "plans") this.renderPlansTab(container, section, style);
    else this.renderMemosTab(container, section, style);
  }

  private mountTagPreview(inputEl: HTMLTextAreaElement | HTMLInputElement, previewEl: HTMLElement) {
    const handler = () => {
      const tags = extractInlineTags(inputEl.value);
      previewEl.empty();
      previewEl.toggleClass("has-tags", tags.length > 0);
      if (tags.length === 0) return;
      previewEl.createDiv({ cls: "lj-tag-preview-label", text: "\u5DF2\u8BC6\u522B\u6807\u7B7E" });
      const list = previewEl.createDiv({ cls: "lj-tag-preview-list" });
      tags.forEach(tag => { list.createDiv({ cls: "lj-tag-chip", text: tag }); });
    };
    inputEl.addEventListener("input", handler);
    handler();
  }

  /** 在 textarea 上监听图片粘贴，保存到 vault 并插入 ![[image.png]] 引用 */
  /** 在 textarea 上设置媒体支持：图片粘贴/上传 + 录音 */
  private setupMediaSupport(textarea: HTMLTextAreaElement, wrap: HTMLElement) {
    // 粘贴上传图片
    textarea.addEventListener("paste", async (evt: ClipboardEvent) => {
      const files = evt.clipboardData?.files;
      if (!files || files.length === 0) return;

      let hasImage = false;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("image/")) continue;
        evt.preventDefault();
        hasImage = true;
        await this.saveImageToVault(file, textarea);
      }
    });

    // 图片文件选择
    const fileInput = wrap.createEl("input", {
      cls: "lj-img-file-input",
      attr: { type: "file", accept: "image/*", multiple: "true" },
    });
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const files = fileInput.files;
      if (!files) return;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        await this.saveImageToVault(file, textarea);
      }
      fileInput.value = "";
    });

    // 媒体按钮行（📷 图片 + 🎤 录音）
    const mediaBar = wrap.createDiv({ cls: "lj-media-bar" });
    const imgBtn = mediaBar.createDiv({ cls: "lj-media-btn lj-media-img-btn", text: "\u{1F4F7}", attr: { "aria-label": "添加图片" } });
    const audioBtn = mediaBar.createDiv({ cls: "lj-media-btn lj-media-audio-btn", text: "\u{1F3A4}", attr: { "aria-label": "录音" } });
    const hintText = mediaBar.createDiv({ cls: "lj-media-hint", text: "支持粘贴图片、点击录音" });

    imgBtn.addEventListener("click", () => fileInput.click());

    // 录音按钮
    audioBtn.addEventListener("click", async () => {
      if (this.isRecording) {
        // 停止录音
        this.stopRecording(textarea, audioBtn);
      } else {
        // 开始录音
        this.startRecording(textarea, audioBtn);
      }
    });
  }

  /** 开始录音 */
  private async startRecording(textarea: HTMLTextAreaElement, btn: HTMLElement) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      // 探测支持的 MIME 类型
      let mimeType = "";
      const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      for (const t of types) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
          mimeType = t;
          break;
        }
      }

      if (typeof MediaRecorder === "undefined") {
        new Notice("当前环境不支持录音功能");
        return;
      }

      this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.isRecording = true;
      btn.addClass("recording");

      this.mediaRecorder.ondataavailable = (e: any) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        this.isRecording = false;
        btn.removeClass("recording");

        // 检测 textarea 是否还在 DOM 中（重渲染可能导致失效）
        if (!textarea.isConnected) {
          // 仍然保存文件，但告知用户
          const blob = new Blob(this.audioChunks, { type: mimeType || "audio/webm" });
          const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
          this.saveAudioBlob(blob, ext, null);
          return;
        }

        const blob = new Blob(this.audioChunks, { type: mimeType || "audio/webm" });
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        this.saveAudioBlob(blob, ext, textarea);
      };

      this.mediaRecorder.start();
      new Notice("\u{1F3A4} 开始录音，再次点击停止");
    } catch (e) {
      new Notice("无法启动录音，请检查麦克风权限");
      console.error("Daybook: 录音启动失败", e);
    }
  }

  /** 停止录音 */
  private stopRecording(textarea: HTMLTextAreaElement, btn: HTMLElement) {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
  }

  /** 保存音频 blob 到 vault，可选插入到 textarea */
  private async saveAudioBlob(blob: Blob, ext: string, textarea: HTMLTextAreaElement | null) {
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
      const fileName = `lj-audio-${ts}.${ext}`;

      const diaryFolder = this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
      const audioPath = `${diaryFolder}/${fileName}`;

      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      await this.app.vault.createBinary(audioPath, uint8);

      if (textarea) {
        const insertText = `\n![[${fileName}]]\n`;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = textarea.value.substring(0, start);
        const after = textarea.value.substring(end);
        textarea.value = before + insertText + after;
        textarea.selectionStart = textarea.selectionEnd = start + insertText.length;
        textarea.dispatchEvent(new Event("input"));
      }

      new Notice(`\u{1F3A4} 录音已保存：${fileName}`);
    } catch (e) {
      new Notice("音频保存失败，请检查日记目录设置");
      console.error("Daybook: 音频保存失败", e);
    }
  }

  private async saveImageToVault(file: File, textarea: HTMLTextAreaElement) {
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
      const ext = file.name.split(".").pop() || "png";
      const fileName = `lj-img-${ts}.${ext}`;

      const diaryFolder = this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
      const imagePath = `${diaryFolder}/${fileName}`;

      const arrayBuffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      await this.app.vault.createBinary(imagePath, uint8);

      const insertText = `\n![[${fileName}]]\n`;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      textarea.value = before + insertText + after;
      textarea.selectionStart = textarea.selectionEnd = start + insertText.length;
      textarea.dispatchEvent(new Event("input"));

      new Notice(`\u{1F4F7} 图片已添加：${fileName}`);
    } catch (e) {
      new Notice("图片保存失败，请检查日记目录设置");
      console.error("Daybook: 图片保存失败", e);
    }
  }

  /** 闪念 Tab：快速记录（心情选择器可选，支持 Markdown/双链/标签的增强编辑器） */
  private renderMemosTab(container: HTMLElement, section: SectionConfig, _style: UIStyle) {
    const mobile = isMobile();
    const moods = this.plugin.settings.customMoods;
    const showMood = section.showMoodPicker !== false;

    // 心情选择器（可在章节设置中隐藏）
    if (showMood) {
      const moodGrid = container.createDiv({ cls: "lj-mood-grid lj-mood-grid-4col" });
      moods.forEach((mood, idx) => {
        const pill = moodGrid.createDiv({
          cls: `lj-mood-pill ${this.selectedMood === mood.emoji ? "selected" : ""}`,
          attr: { "aria-label": `${mood.label}（长按编辑）` },
        });
        pill.createDiv({ cls: "lj-mood-emoji", text: mood.emoji });
        pill.createEl("span", { cls: "lj-mood-label", text: mood.label });

        // 长按编辑（600ms）
        let longPressTimer: number | null = null;
        let isLongPress = false;

        const startPress = () => {
          isLongPress = false;
          longPressTimer = activeWindow.setTimeout(() => {
            isLongPress = true;
            const canDelete = moods.length > 1;
            new MoodEditModal(
              this.app,
              mood,
              idx,
              canDelete,
              async (i, emoji, label) => {
                this.plugin.settings.customMoods[i].emoji = emoji;
                this.plugin.settings.customMoods[i].label = label;
                await this.plugin.saveSettings();
                if (this.selectedMood === mood.emoji) {
                  this.selectedMood = emoji;
                }
                this.buildUI();
              },
              async (i) => {
                if (this.selectedMood === this.plugin.settings.customMoods[i].emoji) {
                  this.selectedMood = null;
                }
                this.plugin.settings.customMoods.splice(i, 1);
                await this.plugin.saveSettings();
                this.buildUI();
              }
            ).open();
          }, 600);
        };

        const cancelPress = () => {
          if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        };

        pill.addEventListener("pointerdown", startPress);
        pill.addEventListener("pointerup", cancelPress);
        pill.addEventListener("pointerleave", cancelPress);
        pill.addEventListener("pointermove", cancelPress);
        pill.addEventListener("pointercancel", cancelPress);

        pill.addEventListener("click", () => {
          if (isLongPress) return; // 长按触发后不触发点击
          this.selectedMood = this.selectedMood === mood.emoji ? null : mood.emoji;
          moodGrid.querySelectorAll(".lj-mood-pill").forEach(p => p.removeClass("selected"));
          if (this.selectedMood) pill.addClass("selected");
        });
      });
    }

    const wrap = container.createDiv({ cls: "lj-input-wrap" });
    // 工具栏挂载点（位于输入框上方）
    const toolbarSlot = wrap.createDiv({ cls: "lj-memo-toolbar-slot" });
    const textarea = wrap.createEl("textarea", {
      cls: `lj-textarea lj-mood-textarea ${mobile ? "lj-textarea-mobile" : ""}`,
      attr: { placeholder: section.placeholder, rows: mobile ? "2" : "3" },
    });

    // 快捷标签 chips
    this.renderQuickTags(wrap, textarea);

    const tagPreview = wrap.createDiv({ cls: "lj-tag-preview" });
    this.mountTagPreview(textarea, tagPreview);
    this.setupMediaSupport(textarea, wrap);
    // 增强编辑器：格式化工具栏（B/S/双链/标签/图片）+ 双链/标签自动补全
    const imageInput = wrap.querySelector<HTMLInputElement>(".lj-img-file-input");
    attachMemoEditor(this.app, this.plugin, textarea, wrap, { toolbar: true, toolbarSlot, imageInput });

    const saveBtn = wrap.createDiv({ cls: "lj-save-btn lj-save-btn-sticky" });
    saveBtn.createDiv({ cls: "lj-btn-icon", text: section.emoji });
    saveBtn.createDiv({ cls: "lj-btn-text", text: `\u4FDD\u5B58${section.label}` });
    textarea.addEventListener("focus", () => {
      setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });
    saveBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text && !this.selectedMood) { new Notice("\u8BF7\u5148\u8F93\u5165\u5185\u5BB9\uFF5E"); return; }
      const mood = moods.find(m => m.emoji === this.selectedMood);
      const content = mood
        ? (text ? `${mood.emoji} ${mood.label} \u2014 ${text}` : `${mood.emoji} ${mood.label}`)
        : text;
      saveBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, content);
        new Notice("\u2726 \u95EA\u5FF5\u5DF2\u8BB0\u5F55");
        textarea.value = "";
        textarea.dispatchEvent(new Event("input"));
        this.selectedMood = null;
        this.buildUI();
      } catch (e) { new Notice("\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { saveBtn.removeClass("loading"); }
    });
  }

  /** 渲染快捷标签 chips，点击向 textarea 追加 #标签 */
  private renderQuickTags(container: HTMLElement, textarea: HTMLTextAreaElement) {
    const tags = this.plugin.settings.quickTags;
    if (tags.length === 0) return;

    const chipRow = container.createDiv({ cls: "lj-quick-tags" });
    chipRow.createSpan({ cls: "lj-quick-tags-label", text: "\u5FEB\u6377\u6807\u7B7E\uFF1A" });
    tags.forEach(tag => {
      const chip = chipRow.createDiv({
        cls: "lj-quick-tag-chip",
        text: `#${tag}`,
        attr: { role: "button", "aria-label": `添加标签 ${tag}` },
      });
      chip.addEventListener("click", () => {
        const insertText = `#${tag} `;
        const start = textarea.selectionStart;
        // 光标前已有 '#'（如补全触发中）时替换它，避免出现 ##标签
        let from = start;
        if (from > 0 && textarea.value[from - 1] === "#") from--;
        const before = textarea.value.substring(0, from);
        const after = textarea.value.substring(textarea.selectionEnd);
        textarea.value = before + insertText + after;
        textarea.selectionStart = textarea.selectionEnd = from + insertText.length;
        textarea.dispatchEvent(new Event("input"));
        textarea.focus();
      });
    });
  }

  private renderPlansTab(container: HTMLElement, section: SectionConfig, _style: UIStyle) {
    const mobile = isMobile();
    const wrap = container.createDiv({ cls: "lj-input-wrap lj-plans-input-wrap" });

    // 输入行：左侧 + 按钮，右侧 textarea
    const addRow = wrap.createDiv({ cls: "lj-todo-add-row lj-todo-add-row-textarea" });
    const addBtn = addRow.createDiv({ cls: "lj-todo-add-btn lj-todo-add-btn-left", text: "+", attr: { "aria-label": "添加待办" } });
    const textarea = addRow.createEl("textarea", {
      cls: "lj-todo-textarea",
      attr: {
        placeholder: section.placeholder,
        rows: "1",
        "aria-label": "添加待办",
      },
    });

    // 自动增高
    const autoResize = () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    };
    textarea.addEventListener("input", autoResize);

    // 快捷标签 chips
    this.renderQuickTags(wrap, textarea);

    // 自动识别日期的提示区
    const dateHint = wrap.createDiv({ cls: "lj-date-hint" });
    textarea.addEventListener("input", () => {
      const result = extractDateFromText(textarea.value);
      if (result.date) {
        dateHint.setText(`\u{1F4C5} \u5DF2\u8BC6\u522B\uFF1A${formatDueDate(result.date)}（${result.date}）`);
        dateHint.addClass("visible");
      } else {
        dateHint.setText("");
        dateHint.removeClass("visible");
      }
    });

    // 子任务添加提示区
    const subHint = wrap.createDiv({ cls: "lj-date-hint lj-subtask-hint" });
    const updateSubHint = () => {
      const target = this.subtaskTarget !== null ? this.todoItems[this.subtaskTarget] : null;
      if (target) {
        subHint.setText(`\u21B3 \u6B63\u5728\u4E3A\u300C${target.text}\u300D\u6DFB\u52A0\u5B50\u4EFB\u52A1`);
        subHint.addClass("visible");
      } else {
        subHint.setText("");
        subHint.removeClass("visible");
      }
    };

    const tagPreview = wrap.createDiv({ cls: "lj-tag-preview lj-tag-preview-plans" });
    this.mountTagPreview(textarea, tagPreview);

    // 媒体支持（图片 + 录音）
    this.setupMediaSupport(textarea, wrap);
    // 双链 / 标签自动补全（计划输入框不显示格式化工具栏）
    attachMemoEditor(this.app, this.plugin, textarea, wrap, { toolbar: false });

    // 优先级按钮行
    const priorityRow = wrap.createDiv({ cls: "lj-priority-row" });
    const priorityBtn = priorityRow.createDiv({
      cls: `lj-priority-btn ${this.currentPriority ? `priority-${this.currentPriority}` : ""}`,
      attr: { "aria-label": "设置优先级" },
    });
    priorityBtn.appendChild(createPriorityBadge(this.currentPriority));
    priorityBtn.createSpan({ cls: "lj-priority-label", text: PRIORITY_META[effectivePriority(this.currentPriority)].label });

    // 优先级弹出层（4 级：1重要且紧急 / 2重要不紧急默认 / 3不重要但紧急 / 4不重要不紧急）
    const priorityPopover = wrap.createDiv({ cls: "lj-priority-popover" });
    priorityPopover.style.display = "none";

    (["1", "2", "3", "4"] as PriorityLevel[]).forEach(lv => {
      const opt = priorityPopover.createDiv({ cls: `lj-priority-option level-${lv}` });
      opt.appendChild(createPriorityBadge(lv));
      opt.createSpan({ text: `${lv} ${PRIORITY_META[lv].label}` });
      if (effectivePriority(this.currentPriority) === lv) opt.addClass("active");
      opt.addEventListener("click", () => {
        document.removeEventListener("click", docClickHandler);
        this.currentPriority = lv;
        this.buildUI();
      });
    });

    const clearOpt = priorityPopover.createDiv({ cls: "lj-priority-option clear" });
    clearOpt.createSpan({ text: "\u{274C}" });
    clearOpt.createSpan({ text: "\u6062\u590D\u9ED8\u8BA4\uFF082 \u91CD\u8981\u4E0D\u7D27\u6025\uFF09" });
    if (!this.currentPriority) clearOpt.addClass("active");

    let popoverOpen = false;
    const docClickHandler = () => {
      if (popoverOpen) {
        popoverOpen = false;
        priorityPopover.style.display = "none";
        priorityBtn.removeClass("open");
        document.removeEventListener("click", docClickHandler);
      }
    };
    const togglePopover = () => {
      popoverOpen = !popoverOpen;
      priorityPopover.style.display = popoverOpen ? "block" : "none";
      priorityBtn.toggleClass("open", popoverOpen);
      if (popoverOpen) {
        // 延迟添加，避免当前点击立即触发关闭
        activeWindow.setTimeout(() => {
          document.addEventListener("click", docClickHandler);
        }, 0);
      } else {
        document.removeEventListener("click", docClickHandler);
      }
    };
    priorityBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(); });
    priorityPopover.addEventListener("click", (e) => { e.stopPropagation(); });

    clearOpt.addEventListener("click", () => {
      document.removeEventListener("click", docClickHandler);
      this.currentPriority = null;
      this.buildUI();
    });

    // 保存按钮紧贴输入区，本次编辑的任务列表显示在其下方
    const saveBtn = container.createDiv({ cls: "lj-save-btn lj-save-btn-sticky" });
    saveBtn.createDiv({ cls: "lj-btn-icon", text: section.emoji });
    saveBtn.createDiv({ cls: "lj-btn-text", text: `\u4FDD\u5B58${section.label}` });
    textarea.addEventListener("focus", () => {
      setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });

    const todoList = container.createDiv({ cls: "lj-todo-list" });
    this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
      this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
      updateSubHint();
      textarea.focus();
    } });

    const addItem = () => {
      const rawText = textarea.value.trim();
      if (!rawText) return;
      const { date, text } = extractDateFromText(rawText);
      const item: TodoItem = {
        text: text || rawText,
        done: false,
        lineIndex: -1,
        dueDate: date,
        createdAt: moment().format("YYYY-MM-DD HH:mm"),
        priority: this.currentPriority ?? undefined,
      };
      if (this.subtaskTarget !== null && this.todoItems[this.subtaskTarget]) {
        // 子任务：插入到目标任务的子树末尾
        item.indent = 1;
        let e = this.subtaskTarget + 1;
        while (e < this.todoItems.length && this.todoItems[e].indent) e++;
        this.todoItems.splice(e, 0, item);
      } else {
        // 最后添加的在最上面
        this.todoItems.unshift(item);
      }
      this.subtaskTarget = null;
      textarea.value = "";
      textarea.style.height = "auto";
      dateHint.setText("");
      dateHint.removeClass("visible");
      updateSubHint();
      textarea.dispatchEvent(new Event("input"));
      this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
        this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
        updateSubHint();
        textarea.focus();
      } });
      textarea.focus();
    };

    addBtn.addEventListener("click", addItem);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addItem();
      }
      // Shift+Enter 换行（默认行为）
    });

    const clearRow = container.createDiv({ cls: "lj-todo-clear-row" });
    const clearBtn = clearRow.createDiv({ cls: "lj-todo-clear-btn", text: "\u6E05\u9664\u5DF2\u5B8C\u6210" });
    const rerender = () => this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
      this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
      updateSubHint();
      textarea.focus();
    } });
    clearBtn.addEventListener("click", () => { this.todoItems = this.todoItems.filter(t => !t.done); rerender(); });

    saveBtn.addEventListener("click", async () => {
      if (this.todoItems.length === 0) { new Notice("\u8BF7\u5148\u6DFB\u52A0\u5F85\u529E\u4E8B\u9879\uFF5E"); return; }
      // 保持父子层级排序：先分组（顶级+子任务），组间按优先级/日期排序
      const groups: { head: TodoItem; children: TodoItem[] }[] = [];
      this.todoItems.forEach(t => {
        if (t.indent && groups.length > 0) groups[groups.length - 1].children.push(t);
        else groups.push({ head: t, children: [] });
      });
      groups.sort((a, b) => {
        if (a.head.done !== b.head.done) return a.head.done ? 1 : -1;
        const pa = parseInt(effectivePriority(a.head.priority));
        const pb = parseInt(effectivePriority(b.head.priority));
        if (pa !== pb) return pa - pb;
        if (a.head.dueDate && b.head.dueDate) return a.head.dueDate.localeCompare(b.head.dueDate);
        if (a.head.dueDate) return -1;
        if (b.head.dueDate) return 1;
        return 0;
      });
      const sorted = groups.flatMap(g => [g.head, ...g.children]);
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const completedField = getCompletedFieldName(this.plugin.settings);
      // 与其他章节统一的 "- HH:mm" 列表格式（章节标题已表明是计划，不再重复写"计划"字样）
      const lines = [
        `- ${timeStr}`,
        ...sorted.map(t => {
          const indent = t.indent ? "        " : "    ";
          let line = `${indent}- [${t.done ? "x" : " "}] ${t.text}`;
          // 优先级标记放在文本后面（默认 2 级不写标记）
          const eff = effectivePriority(t.priority);
          if (eff !== "2") line += ` ${PRIORITY_EMOJI[eff]}`;
          if (t.dueDate) line += ` \u{1F4C5} ${t.dueDate}`;
          // 创建时间行内字段（用于计算完成耗时）
          if (t.createdAt) line += ` [createdAt::${t.createdAt}]`;
          // 完成时间行内字段（仅已完成的任务）
          if (t.done && t.completedAt) line += ` [${completedField}::${t.completedAt}]`;
          return line;
        }),
      ];
      saveBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, lines.join("\n"));
        new Notice("\u2726 \u8BA1\u5212\u5DF2\u8BB0\u5F55");
        this.todoItems = [];
        this.currentPriority = null;
        this.subtaskTarget = null;
        updateSubHint();
        rerender();
      } catch (e) { new Notice("\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { saveBtn.removeClass("loading"); }
    });
  }

  private renderTodoItems(
    container: HTMLElement,
    opts?: { onAddSubtask?: (idx: number) => void }
  ) {
    let dragFrom: number | null = null;
    container.empty();
    if (this.todoItems.length === 0) {
      container.createDiv({ cls: "lj-todo-empty", text: "\u6682\u65E0\u5F85\u529E\uFF0C\u5728\u4E0A\u65B9\u8F93\u5165\u540E\u6309\u56DE\u8F66\u6DFB\u52A0\uFF5E" });
      return;
    }
    this.todoItems.forEach((todo, i) => {
      const item = container.createDiv({ cls: `lj-todo-item ${todo.done ? "done" : ""} ${todo.indent ? "sub" : ""}` });
      // 拖拽调整顺序与层级：拖到目标任务上半 = 插到其前；下半 = 顶级任务变为其子任务 / 子任务插到其后
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        dragFrom = i;
        item.addClass("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(i));
        }
      });
      item.addEventListener("dragend", () => {
        dragFrom = null;
        container.querySelectorAll(".lj-todo-item").forEach(el => el.removeClass("drop-before", "drop-after", "dragging"));
      });
      item.addEventListener("dragover", (e) => {
        if (dragFrom === null || dragFrom === i) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        item.toggleClass("drop-before", !lower);
        item.toggleClass("drop-after", lower);
      });
      item.addEventListener("dragleave", () => item.removeClass("drop-before", "drop-after"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = dragFrom;
        dragFrom = null;
        item.removeClass("drop-before", "drop-after");
        if (from === null || from === i) return;
        const rect = item.getBoundingClientRect();
        const lower = e.clientY > rect.top + rect.height / 2;
        const asChild = !this.todoItems[i].indent && lower;
        moveTodoSubtree(this.todoItems, from, i, asChild, lower && !asChild);
        this.renderTodoItems(container, opts);
      });
      const cb = item.createEl("input", { cls: "lj-todo-checkbox", attr: { type: "checkbox" } });
      cb.checked = todo.done;
      cb.addEventListener("change", () => {
        // 父子级联：勾父全勾子，子全勾自动勾父（含完成时间）
        this.setEditTodoCascade(i, cb.checked, moment().format("YYYY-MM-DD HH:mm"));
        this.renderTodoItems(container, opts);
      });
      const textEl = item.createDiv({ cls: `lj-todo-text ${todo.done ? "strikethrough" : ""}` });
      // 优先级徽标（圆形罗马数字 SVG；2 级默认隐藏，可在设置开启）
      if (shouldShowPriorityBadge(todo.priority, this.plugin.settings)) {
        textEl.appendChild(createPriorityBadge(todo.priority));
      }
      textEl.createSpan({ text: todo.text });
      if (todo.dueDate) {
        textEl.createSpan({ cls: `lj-todo-due ${moment(todo.dueDate).isBefore(moment(), "day") ? "overdue" : ""}`, text: `\u{1F4C5} ${formatDueDate(todo.dueDate)}` });
      }
      // 已完成任务的耗时 / 完成时间徽标
      appendTodoCompletionInfo(textEl, todo, this.plugin.settings, false);
      const actionRow = item.createDiv({ cls: "lj-todo-actions" });
      // 添加子任务按钮（仅顶级任务）
      if (!todo.indent && opts?.onAddSubtask) {
        actionRow.createDiv({
          cls: `lj-todo-add-sub ${this.subtaskTarget === i ? "active" : ""}`,
          text: "\u21B3",
          attr: { role: "button", "aria-label": "添加子任务" },
        }).addEventListener("click", () => opts.onAddSubtask!(i));
      }
      actionRow.createDiv({ cls: "lj-todo-del", text: "\xD7" }).addEventListener("click", () => {
        this.todoItems.splice(i, 1);
        if (this.subtaskTarget === i) this.subtaskTarget = null;
        this.renderTodoItems(container, opts);
      });
    });
  }

  /** 编辑视图（内存中）父子任务级联勾选 */
  private setEditTodoCascade(index: number, done: boolean, stamp: string) {
    const items = this.todoItems;
    const t = items[index];
    if (!t) return;
    t.done = done;
    t.completedAt = done ? stamp : undefined;
    if (t.indent) {
      // 子任务 → 同步父任务：全部完成自动完成，任一未完成自动取消
      let p = index - 1;
      while (p >= 0 && items[p].indent) p--;
      if (p >= 0) {
        let e = p + 1;
        let allDone = true;
        while (e < items.length && items[e].indent) {
          if (!items[e].done) allDone = false;
          e++;
        }
        if (e > p + 1) {
          items[p].done = allDone;
          items[p].completedAt = allDone ? (items[p].completedAt ?? stamp) : undefined;
        }
      }
    } else {
      // 父任务 → 同步所有子任务
      let e = index + 1;
      while (e < items.length && items[e].indent) {
        items[e].done = done;
        items[e].completedAt = done ? stamp : undefined;
        e++;
      }
    }
  }
}
