import { ItemView, WorkspaceLeaf, Notice, moment, TFile, Modal, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { appendToSection, resolveSectionPath } from "./fileManager";
import { appendTodoCompletionInfo, createPriorityBadge, effectivePriority, getCompletedFieldName, moveTodoSubtree, PRIORITY_EMOJI, PRIORITY_META, shouldShowPriorityBadge, type PriorityLevel } from "./fileReader";
import { getVisiblePanels, getVisibleSections, getAllSections, type SectionConfig, type MoodOption } from "./settings";
import { ReviewView } from "./ReviewView";
import type { TodoItem } from "./fileReader";
import { attachMemoEditor } from "./memoEditor";
import { createLiveEditor, type LiveEditor, type LiveEditorOptions } from "./liveEditor";

export const VIEW_TYPE_JOURNAL = "daybook-view";

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

export class DaybookView extends ItemView {
  plugin: DaybookPlugin;
  private selectedMood: string | null = null; // emoji 作为选中标识
  private activeSectionId: string = "memos";
  private todoItems: TodoItem[] = [];
  private viewMode: string = ""; // "edit" or "review"
  private activePanelId: string = "";
  private _vpResizeHandler: (() => void) | null = null;
  // 录音相关
  private mediaRecorder: any = null;
  private audioChunks: Blob[] = [];
  private _currentSection?: SectionConfig;
  private isRecording = false;
  // 计划优先级
  private currentPriority: PriorityLevel | null = null;
  // 子任务添加目标（编辑视图，index 指向顶级任务）
  private subtaskTarget: number | null = null;
  // 上一次渲染的编辑上下文（用于离开计划编辑时清空未保存草稿）
  private lastEditCtx = "";
  // 当前页面上的内嵌实时渲染编辑器（buildUI 重建/onClose 时统一销毁）
  private liveEditors = new Set<LiveEditor>();

  constructor(leaf: WorkspaceLeaf, plugin: DaybookPlugin) {
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
    this.destroyLiveEditors();
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

  /** 销毁所有内嵌编辑器（buildUI 全量重建/视图关闭前调用） */
  private destroyLiveEditors() {
    this.liveEditors.forEach(ed => {
      try { ed.destroy(); } catch (e) { /* ignore */ }
    });
    this.liveEditors.clear();
  }

  /**
   * 创建内嵌 Live Preview 编辑器并登记生命周期。
   * 文件上下文取当前章节对应的日记文件（双链/附件路径解析用）。
   */
  private makeEditor(parent: HTMLElement, opts: LiveEditorOptions, extraCls = ""): LiveEditor {
    let sourceFile: TFile | null = null;
    try {
      const sectionPath = resolveSectionPath(this.plugin.settings, this._currentSection);
      const af = this.app.vault.getAbstractFileByPath(sectionPath);
      if (af instanceof TFile) sourceFile = af;
    } catch (e) { /* ignore */ }
    const editor = createLiveEditor(this.app, parent, opts, extraCls, sourceFile);
    this.liveEditors.add(editor);
    return editor;
  }

  buildUI() {
    // 离开计划编辑时清空未保存的草稿
    const allSecs = getAllSections(this.plugin.settings);
    const ctx = this.viewMode === "review" ? "@review" : `#${this.activeSectionId}`;
    if (ctx !== this.lastEditCtx) {
      const leavingPlans = this.lastEditCtx.startsWith("#")
        && allSecs.find(sec => `#${sec.id}` === this.lastEditCtx)?.type === "plans";
      if (leavingPlans) {
        this.todoItems = [];
        this.subtaskTarget = null;
        this.currentPriority = null;
      }
      this.lastEditCtx = ctx;
    }
    const root = this.containerEl.children[1] as HTMLElement;
    this.destroyLiveEditors();
    root.empty();
    root.setAttribute("class", "lj-root");
    root.style.height = "";
    root.style.maxHeight = "";
    // 确保当前模式有效：非 review 即 edit
    const visiblePanels = getVisiblePanels(this.plugin.settings);
    if (this.viewMode !== "review" && this.viewMode !== "edit") {
      this.viewMode = visiblePanels.length > 0 ? "edit" : "review";
    }
    this.buildModeToggleFixed(root);
    if (this.viewMode === "review") {
      root.addClass("lj-root-review-v3");
      const rc = root.createDiv({ cls: "lj-review-container" });
      new ReviewView(rc, this.plugin).render();
      return;
    }
    this.buildEditContent(root);
  }

  private buildModeToggleFixed(root: HTMLElement) {
    const bar = root.createDiv({ cls: "lj-mode-toggle-bar lj-mode-toggle-fixed" });
    const toggle = bar.createDiv({ cls: "lj-mode-toggle" });
    // 编辑按钮（统一入口，所有章节在此切换编辑）
    const visiblePanels = getVisiblePanels(this.plugin.settings);
    const eb = toggle.createDiv({
      cls: `lj-mode-btn ${this.viewMode === "edit" ? "active" : ""}`,
      text: "\u270F\uFE0F \u7F16\u8F91",
    });
    eb.toggleClass("disabled", visiblePanels.length === 0);
    eb.addEventListener("click", () => {
      if (this.viewMode !== "edit" && visiblePanels.length > 0) { this.viewMode = "edit"; this.buildUI(); }
    });
    // 阅读按钮
    const rv = toggle.createDiv({ cls: `lj-mode-btn ${this.viewMode === "review" ? "active" : ""}`, text: "\u{1F4D6} \u9605\u8BFB" });
    rv.addEventListener("click", () => { if (this.viewMode !== "review") { this.viewMode = "review"; this.buildUI(); } });
  }

  private buildEditContent(root: HTMLElement) {
    // 编辑模式：统一展示所有版块下的所有可见章节，方便跨章节编辑/合并
    const sections = getVisibleSections(this.plugin.settings);
    // ⚠️ tab 栏必须先于内容区创建（lj-root 是 flex column + 整体滚动，
    // 若内容区 flex:1 在前，tab 栏会被推到所有内容的最底部，不可见）
    if (sections.length === 0) {
      const content = root.createDiv({ cls: "lj-content lj-content-scroll" });
      content.createDiv({ cls: "lj-todo-empty", text: "没有可见章节" });
      return;
    }
    // 单章节：直接显示
    if (sections.length === 1) {
      const content = root.createDiv({ cls: "lj-content lj-content-scroll" });
      this.activeSectionId = sections[0].id;
      this.renderTabContent(content, sections[0]);
      return;
    }
    // 多章节：先建 tab 栏（在内容区上方），再建内容区
    const tabBar = root.createDiv({ cls: "lj-tab-bar" });
    sections.forEach(sec => {
      const btn = tabBar.createDiv({ cls: `lj-tab ${this.activeSectionId === sec.id ? "active" : ""}` });
      btn.createDiv({ cls: "lj-tab-emoji", text: sec.emoji });
      btn.createDiv({ text: sec.label });
      btn.addEventListener("click", () => { if (this.activeSectionId !== sec.id) { this.activeSectionId = sec.id; this.buildUI(); } });
    });
    const content = root.createDiv({ cls: "lj-content lj-content-scroll" });
    const active = sections.find(s => s.id === this.activeSectionId) ?? sections[0];
    this.activeSectionId = active.id;
    this.renderTabContent(content, active);
  }

  private renderTabContent(container: HTMLElement, section: SectionConfig) {
    if (section.type === "plans") this.renderPlansTab(container, section);
    else this.renderMemosTab(container, section);
  }

  /** 根据当前文本刷新"已识别标签"预览 */
  private refreshTagPreview(value: string, previewEl: HTMLElement) {
    const tags = extractInlineTags(value);
    previewEl.empty();
    previewEl.toggleClass("has-tags", tags.length > 0);
    if (tags.length === 0) return;
    previewEl.createDiv({ cls: "lj-tag-preview-label", text: "\u5DF2\u8BC6\u522B\u6807\u7B7E" });
    const list = previewEl.createDiv({ cls: "lj-tag-preview-list" });
    tags.forEach(tag => { list.createDiv({ cls: "lj-tag-chip", text: tag }); });
  }

  /**
   * 媒体支持：图片文件选择 + 图片粘贴（粘贴由编辑器 onPasteFiles 传入）+ 录音。
   * toolbarSlot 存在时渲染精简工具栏（拍照 + 录音）；实时渲染模式下不再需要
   * B/S/双链 等格式化按钮——标记语法在输入时即被原生渲染。
   */
  private setupMediaSupport(editor: LiveEditor, wrap: HTMLElement, section?: SectionConfig, toolbarSlot?: HTMLElement) {
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
        await this.saveImageToVault(files[i], editor);
      }
      fileInput.value = "";
    });

    if (!toolbarSlot) return;

    // 精简工具栏：照片 + 录音
    toolbarSlot.empty();
    toolbarSlot.addClass("lj-memo-toolbar");

    const photoBtn = toolbarSlot.createDiv({
      cls: "lj-memo-tb-btn lj-memo-tb-icon",
      attr: { role: "button", "aria-label": "上传照片", title: "上传照片" },
    });
    setIcon(photoBtn, "image");
    photoBtn.addEventListener("mousedown", e => e.preventDefault());
    photoBtn.addEventListener("click", () => fileInput.click());

    const micBtn = toolbarSlot.createDiv({
      cls: "lj-memo-tb-btn lj-memo-tb-icon lj-memo-tb-audio",
      attr: { role: "button", "aria-label": "录音", title: "录音" },
    });
    setIcon(micBtn, "mic");
    micBtn.addEventListener("mousedown", e => e.preventDefault());
    micBtn.addEventListener("click", () => {
      if (this.isRecording) this.stopRecording(editor, micBtn);
      else this.startRecording(editor, micBtn);
    });
  }

  /** 开始录音 */
  private async startRecording(editor: LiveEditor, btn: HTMLElement) {
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

        // 编辑器可能已因重渲染被销毁（脱离 DOM），此时只保存文件
        const blob = new Blob(this.audioChunks, { type: mimeType || "audio/webm" });
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        this.saveAudioBlob(blob, ext, editor.el.isConnected ? editor : null);
      };

      this.mediaRecorder.start();
      new Notice("\u{1F3A4} 开始录音，再次点击停止");
    } catch (e) {
      new Notice("无法启动录音，请检查麦克风权限");
      console.error("Daybook: 录音启动失败", e);
    }
  }

  /** 停止录音 */
  private stopRecording(_editor: LiveEditor, _btn: HTMLElement) {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
  }

  /** 保存音频 blob 到 vault，可选插入到编辑器 */
  private async saveAudioBlob(blob: Blob, ext: string, editor: LiveEditor | null) {
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
      const fileName = `lj-audio-${ts}.${ext}`;

      const fullPath = resolveSectionPath(this.plugin.settings, this._currentSection);
      const diaryFolder = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
      const audioPath = `${diaryFolder}/${fileName}`;

      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      await this.app.vault.createBinary(audioPath, uint8);

      if (editor) {
        editor.insertAtCursor(`\n![[${fileName}]]\n`);
      }

      new Notice(`\u{1F3A4} 录音已保存：${fileName}`);
    } catch (e) {
      new Notice("音频保存失败，请检查日记目录设置");
      console.error("Daybook: 音频保存失败", e);
    }
  }

  private async saveImageToVault(file: File, editor: LiveEditor) {
    try {
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}${String(now.getSeconds()).padStart(2,"0")}`;
      const ext = file.name.split(".").pop() || "png";
      const fileName = `lj-img-${ts}.${ext}`;

      const fullPath = resolveSectionPath(this.plugin.settings, this._currentSection);
      const diaryFolder = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : this.plugin.settings.diaryFolder.trim().replace(/\/$/, "");
      const imagePath = `${diaryFolder}/${fileName}`;

      const arrayBuffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      await this.app.vault.createBinary(imagePath, uint8);

      editor.insertAtCursor(`\n![[${fileName}]]\n`);

      new Notice(`\u{1F4F7} 图片已添加：${fileName}`);
    } catch (e) {
      new Notice("图片保存失败，请检查日记目录设置");
      console.error("Daybook: 图片保存失败", e);
    }
  }

  /** 闪念 Tab：快速记录（心情选择器可选，支持 Markdown/双链/标签的增强编辑器） */
  private renderMemosTab(container: HTMLElement, section: SectionConfig) {
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
    // 工具栏挂载点（位于输入框上方）：照片 + 录音
    const toolbarSlot = wrap.createDiv({ cls: "lj-memo-toolbar-slot" });
    this._currentSection = section;

    // 内嵌 Live Preview 编辑器：输入即渲染（Obsidian 原生 Markdown 效果）
    // tagPreview 在下方声明，onChange 回调触发时它必然已存在
    const tagPreviewRef: { el: HTMLElement | null } = { el: null };
    const editor = this.makeEditor(wrap, {
      placeholder: section.placeholder,
      onChange: (value) => { if (tagPreviewRef.el) this.refreshTagPreview(value, tagPreviewRef.el); },
      onPasteFiles: (files) => {
        files.forEach(f => this.saveImageToVault(f, editor));
      },
    }, mobile ? "lj-live-editor-mobile" : "");

    // 快捷标签 chips（紧跟输入框）
    this.renderQuickTags(wrap, editor);
    // 标签识别预览
    const tagPreview = wrap.createDiv({ cls: "lj-tag-preview" });
    tagPreviewRef.el = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

    // 媒体：图片选择/粘贴 + 录音（精简工具栏渲染到 toolbarSlot）
    this.setupMediaSupport(editor, wrap, section, toolbarSlot);
    // textarea 降级模式：保留旧的双链/标签自动补全（实时渲染模式使用原生补全）
    if (!editor.isLive && editor.nativeInput) {
      attachMemoEditor(this.app, this.plugin, editor.nativeInput, wrap, { toolbar: false });
    }

    const saveBtn = wrap.createDiv({ cls: "lj-save-btn lj-save-btn-sticky" });
    saveBtn.createDiv({ cls: "lj-btn-icon", text: section.emoji });
    saveBtn.createDiv({ cls: "lj-btn-text", text: `\u4FDD\u5B58${section.label}` });
    // focusin 对 textarea 与 CM contentDOM 均可冒泡捕获
    editor.el.addEventListener("focusin", () => {
      setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });
    saveBtn.addEventListener("click", async () => {
      const text = editor.getValue().trim();
      if (!text && !this.selectedMood) { new Notice("\u8BF7\u5148\u8F93\u5165\u5185\u5BB9\uFF5E"); return; }
      const mood = moods.find(m => m.emoji === this.selectedMood);
      const content = mood
        ? (text ? `${mood.emoji} ${mood.label} \u2014 ${text}` : `${mood.emoji} ${mood.label}`)
        : text;
      saveBtn.addClass("loading");
      try {
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, content, section);
        new Notice("\u2726 \u95EA\u5FF5\u5DF2\u8BB0\u5F55");
        editor.setValue("");
        this.selectedMood = null;
        this.buildUI();
      } catch (e) { new Notice("\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u65E5\u8BB0\u76EE\u5F55\u8BBE\u7F6E"); }
      finally { saveBtn.removeClass("loading"); }
    });
  }

  /** 渲染快捷标签 chips，点击向编辑器插入 #标签 */
  private renderQuickTags(container: HTMLElement, editor: LiveEditor) {
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
        const sel = editor.getSelection();
        // 光标前已有 '#'（如补全触发中）时替换它，避免出现 ##标签
        let from = sel.from;
        if (from > 0 && editor.getValue()[from - 1] === "#") from--;
        editor.replaceRange(from, sel.to, insertText);
      });
    });
  }

  private renderPlansTab(container: HTMLElement, section: SectionConfig) {
    const mobile = isMobile();
    const wrap = container.createDiv({ cls: "lj-input-wrap lj-plans-input-wrap" });

    // 输入行：左侧 + 按钮，右侧内嵌 Live Preview 编辑器
    const addRow = wrap.createDiv({ cls: "lj-todo-add-row lj-todo-add-row-textarea" });
    const addBtn = addRow.createDiv({ cls: "lj-todo-add-btn lj-todo-add-btn-left", text: "+", attr: { "aria-label": "添加待办" } });

    this._currentSection = section;

    // 提示区元素在编辑器后创建，onChange 触发时通过 ref 访问
    const hintRefs: { date: HTMLElement | null; tags: HTMLElement | null } = { date: null, tags: null };

    // 单行增长型实时编辑器：Enter 添加、Shift+Enter 换行（高度由 CSS 自适应，最高 120px）
    const editor = this.makeEditor(addRow, {
      placeholder: section.placeholder,
      onChange: (value) => {
        // 降级 textarea 才需要 JS 自动增高；CM 由 CSS 自适应
        if (!editor.isLive && editor.nativeInput) {
          const ta = editor.nativeInput;
          ta.style.height = "auto";
          ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
        }
        const dateHint = hintRefs.date;
        if (dateHint) {
          const result = extractDateFromText(value);
          if (result.date) {
            dateHint.setText(`\u{1F4C5} \u5DF2\u8BC6\u522B\uFF1A${formatDueDate(result.date)}（${result.date}）`);
            dateHint.addClass("visible");
          } else {
            dateHint.setText("");
            dateHint.removeClass("visible");
          }
        }
        if (hintRefs.tags) this.refreshTagPreview(value, hintRefs.tags);
      },
      onEnter: (_mod, shift) => {
        if (!shift) {
          addItem();
          return true; // 吞掉 Enter，不插入换行
        }
        return false; // Shift+Enter 换行
      },
      onPasteFiles: (files) => {
        files.forEach(f => this.saveImageToVault(f, editor));
      },
    }, "lj-live-editor-plan");

    // 降级 textarea 初始为单行（CM 模式高度完全由 CSS 控制）
    if (!editor.isLive && editor.nativeInput) editor.nativeInput.rows = 1;

    // 快捷标签 chips（紧跟输入行）
    this.renderQuickTags(wrap, editor);
    // 自动识别日期的提示区
    const dateHint = wrap.createDiv({ cls: "lj-date-hint" });
    hintRefs.date = dateHint;
    // 子任务添加提示区
    const subHint = wrap.createDiv({ cls: "lj-date-hint lj-subtask-hint" });
    // 标签识别预览
    const tagPreview = wrap.createDiv({ cls: "lj-tag-preview lj-tag-preview-plans" });
    hintRefs.tags = tagPreview;
    this.refreshTagPreview(editor.getValue(), tagPreview);

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

    // 媒体支持（图片粘贴/选择；计划页不放录音工具栏）
    this.setupMediaSupport(editor, wrap, section);
    // textarea 降级模式：保留旧的双链/标签自动补全
    if (!editor.isLive && editor.nativeInput) {
      attachMemoEditor(this.app, this.plugin, editor.nativeInput, wrap, { toolbar: false });
    }

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
    editor.el.addEventListener("focusin", () => {
      setTimeout(() => saveBtn.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
    });

    const todoList = container.createDiv({ cls: "lj-todo-list" });
    this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
      this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
      updateSubHint();
      editor.focus();
    } });

    const addItem = () => {
      const rawText = editor.getValue().trim();
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
      editor.setValue("");
      dateHint.setText("");
      dateHint.removeClass("visible");
      updateSubHint();
      this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
        this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
        updateSubHint();
        editor.focus();
      } });
      editor.focus();
    };

    addBtn.addEventListener("click", addItem);
    // Enter 添加 / Shift+Enter 换行已由编辑器 onEnter 统一处理

    const clearRow = container.createDiv({ cls: "lj-todo-clear-row" });
    const clearBtn = clearRow.createDiv({ cls: "lj-todo-clear-btn", text: "\u6E05\u9664\u5DF2\u5B8C\u6210" });
    const rerender = () => this.renderTodoItems(todoList, { onAddSubtask: (idx) => {
      this.subtaskTarget = this.subtaskTarget === idx ? null : idx;
      updateSubHint();
      editor.focus();
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
        await appendToSection(this.app, this.plugin.settings, section.label, section.type, lines.join("\n"), section);
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
