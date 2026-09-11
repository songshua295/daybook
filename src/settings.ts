import { App, PluginSettingTab, Setting } from "obsidian";
import type LifeJournalPlugin from "./main";
import { VIEW_TYPE_JOURNAL } from "./JournalView";

export type ThemeName =
  | "forest" | "ocean" | "desert" | "cherry"
  | "dusk" | "midnight" | "lavender" | "matcha"
  | "obsidian";

// v1.1 新增：UI 风格（三套界面设计）
export type UIStyle = "minimal" | "neon" | "soft";

/** 阅读页中计划的展示方式：separate=模式栏独立「计划」入口；inline=融入阅读列表 */
export type PlansDisplay = "separate" | "inline";

/** 视图默认打开位置：left=左侧边栏（默认）/ main=主窗口新标签页 / right=右侧边栏 */
export type OpenLocation = "left" | "main" | "right";

/** 章节渲染类型：memos=闪念（快速记录，支持 Markdown/双链/标签）, plans=待办计划 */
export type SectionType = "memos" | "plans";

/** 动态章节配置 */
export interface SectionConfig {
  id: string;           // 唯一标识（如 "memos", "plans", "custom-1"）
  emoji: string;        // Tab emoji（如 "⚡"）
  label: string;        // Tab 标签 & 日记中 # 标题
  type: SectionType;    // 渲染类型
  placeholder: string;  // 输入框提示文字
  enabled: boolean;     // 是否在 Tab 栏显示
  showMoodPicker?: boolean; // 仅闪念：是否显示心情选择器（undefined = 显示）
}

/** 可编辑的心情选项（emoji + 含义文字） */
export interface MoodOption {
  emoji: string;
  label: string;
}

/** 章节类型开关：整体关闭某类型（闪念/待办计划），该类型的所有章节不渲染 */
export interface TypeToggles {
  memos: boolean;
  plans: boolean;
}

/** 类型是否启用（undefined 视为启用） */
export function isTypeEnabled(settings: LifeJournalSettings, type: SectionType): boolean {
  return settings.typeEnabled?.[type] !== false;
}

/** 阅读视图（含计划视图）的分组/排序/筛选/搜索状态（持久化保存） */
export interface ReviewViewState {
  groupVisible: boolean;                     // 分组面板是否展开（计划）
  sortVisible: boolean;                      // 排序面板是否展开
  planGroupBy: "none" | "priority" | "date"; // 分组方式
  planDateGranularity: "day" | "week" | "month"; // 日期分组粒度
  planSortBy: "time" | "title" | "tag" | "priority"; // 排序方式：时间/标题/标签/优先级
  planSortAsc: boolean;                      // 排序方向
  activeInlineTag: string | null;            // 当前标签筛选
  filterDateFrom: string;                    // 日期范围起
  filterDateTo: string;                      // 日期范围止
  filterPriorities: string[];                // 优先级筛选（"1"/"2"/"3"/"4"）
  searchVisible: boolean;                    // 搜索面板是否展开（含搜索/标签/日期筛选）
  searchQuery: string;                       // 搜索关键字
  groupOrder: string[];                      // 分组自定义次序（拖拽产生，按分组 key）
}

export interface LifeJournalSettings {
  theme: ThemeName;
  uiStyle: UIStyle;          // v1.1 新增
  plansDisplay: PlansDisplay; // 阅读页计划展示方式
  openLocation: OpenLocation; // 视图默认打开位置
  sections: SectionConfig[];  // v3.3 动态章节（替代固定 sectionMapping）
  diaryFolder: string;
  dateFormat: string;
  // v3.2 新增：记录体验升级
  customMoods: MoodOption[];    // 可长按编辑的心情列表（最多 8 个）
  quickTags: string[];          // 快捷标签（如 商业），点击追加 #标签
  // v3.3 新增：计划完成时间
  todoCompletedField: string;               // 勾选完成时写入任务末尾的行内字段名（如 completedAt）
  todoCompletionDisplay: "duration" | "time" | "both"; // 已完成任务显示：耗时/完成时间/两者
  showMediumPriorityBadge: boolean;         // 是否显示普通等级（Ⅱ）徽标，默认隐藏
  reviewState: ReviewViewState;             // 阅读视图状态（分组/排序/筛选/搜索）
  typeEnabled: TypeToggles;                 // 章节类型开关（闪念/待办计划）
}

export const DEFAULT_SETTINGS: LifeJournalSettings = {
  theme: "forest",
  uiStyle: "soft",           // 默认柔光卡片
  plansDisplay: "separate",  // 计划单独成板块（模式栏新增入口）
  openLocation: "left",      // 默认在左侧边栏打开
  sections: [
    { id: "memos", emoji: "\u26A1", label: "\u95EA\u5FF5", type: "memos", placeholder: "\u6B64\u523B\u7684\u60F3\u6CD5\u2026\u652F\u6301 **\u52A0\u7C97**\u3001[[\u53CC\u94FE]]\u3001#\u6807\u7B7E", enabled: true, showMoodPicker: true },
    { id: "plans",    emoji: "\u{1F4C5}", label: "\u8BA1\u5212", type: "plans", placeholder: "\u6DFB\u52A0\u5F85\u529E\uFF0C\u5982\uFF1A\u672C\u5468\u4E94\u5B8C\u6210\u62A5\u544A", enabled: true },
  ],
  diaryFolder: "Daily",
  dateFormat: "YYYY-MM-DD",
  customMoods: [
    { emoji: "\u{1F604}", label: "\u5F00\u5FC3" },
    { emoji: "\u{1F610}", label: "\u5E73\u9759" },
    { emoji: "\u{1F62B}", label: "\u75B2\u60EB" },
    { emoji: "\u{1F630}", label: "\u7126\u8651" },
    { emoji: "\u{1F61E}", label: "\u96BE\u8FC7" },
    { emoji: "\u{1F62E}", label: "\u5403\u60CA" },
    { emoji: "\u{1F929}", label: "\u5174\u594B" },
    { emoji: "\u{1F970}", label: "\u611F\u6069" },
  ],
  quickTags: ["\u5546\u4E1A"],
  todoCompletedField: "completedAt",
  todoCompletionDisplay: "both",
  showMediumPriorityBadge: false,
  reviewState: {
    groupVisible: false,
    sortVisible: false,
    planGroupBy: "none",
    planDateGranularity: "day",
    planSortBy: "time",
    planSortAsc: false,
    activeInlineTag: null,
    filterDateFrom: "",
    filterDateTo: "",
    filterPriorities: [],
    searchVisible: false,
    searchQuery: "",
    groupOrder: [],
  },
  typeEnabled: {
    memos: true,
    plans: true,
  },
};

/** 心情数量上限（一行 4 个，最多两行） */
export const MAX_CUSTOM_MOODS = 8;

/** 章节数量上限 */
export const MAX_SECTIONS = 8;

/** 章节类型信息 */
export const SECTION_TYPE_INFO: Record<SectionType, { label: string; emoji: string; desc: string }> = {
  memos: { label: "闪念", emoji: "⚡", desc: "快速记录，支持加粗/删除线/双链/图片/标签" },
  plans: { label: "待办计划", emoji: "📅", desc: "待办输入 + 日期提取 + 优先级 + 子任务" },
};

export const THEME_INFO: Record<ThemeName, { label: string; emoji: string; desc: string }> = {
  forest:   { label: "晨林",   emoji: "🌿", desc: "清晨森林，清新静谧" },
  ocean:    { label: "海浪",   emoji: "🌊", desc: "深海蓝调，平静辽远" },
  desert:   { label: "暮沙",   emoji: "🏜️", desc: "沙漠黄昏，温暖沉静" },
  cherry:   { label: "樱落",   emoji: "🌸", desc: "樱花粉调，柔美浪漫" },
  dusk:     { label: "暮霞",   emoji: "🌅", desc: "傍晚霞光，温柔余晖" },
  midnight: { label: "极夜",   emoji: "🌙", desc: "深邃夜色，沉稳神秘" },
  lavender: { label: "薰衣草", emoji: "💜", desc: "紫调梦幻，温柔治愈" },
  matcha:   { label: "抹茶",   emoji: "🍵", desc: "和风抹茶，清雅禅意" },
  obsidian: { label: "跟随Obsidian", emoji: "🎨", desc: "自动适配 Obsidian 明暗主题" },
};

export const UI_STYLE_INFO: Record<UIStyle, { label: string; emoji: string; desc: string }> = {
  minimal: { label: "极简墨白", emoji: "◻️", desc: "纸质质感，克制留白，高级感纯黑白" },
  neon:    { label: "霓光深夜", emoji: "🌙", desc: "暗色沉浸，紫粉渐变，科技仪式感" },
  soft:    { label: "柔光卡片", emoji: "🌸", desc: "磨砂玻璃，暖橙紫渐变，温柔治愈" },
};

export class LifeJournalSettingTab extends PluginSettingTab {
  plugin: LifeJournalPlugin;

  constructor(app: App, plugin: LifeJournalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 顶部标题
    const header = containerEl.createDiv({ cls: "lj-settings-header" });
    header.createEl("h2", { text: "Daybook" });
    header.createEl("p", { text: "v3.1.6 · 记录即意义", cls: "lj-settings-version" });

    // ── 界面风格 ──────────────────────────────────────
    containerEl.createEl("h3", { text: "✦ 界面风格" });
    containerEl.createEl("p", {
      text: "选择你喜欢的整体界面风格",
      cls: "lj-settings-hint"
    });

    const styleGrid = containerEl.createDiv({ cls: "lj-style-grid" });
    (Object.entries(UI_STYLE_INFO) as [UIStyle, typeof UI_STYLE_INFO[UIStyle]][]).forEach(([key, info]) => {
      const card = styleGrid.createDiv({
        cls: `lj-style-card lj-style-${key} ${this.plugin.settings.uiStyle === key ? "active" : ""}`
      });
      const preview = card.createDiv({ cls: "lj-style-preview" });
      preview.createDiv({ cls: "lj-style-emoji", text: info.emoji });
      card.createDiv({ cls: "lj-style-name", text: info.label });
      card.createDiv({ cls: "lj-style-desc", text: info.desc });
      card.addEventListener("click", async () => {
        styleGrid.querySelectorAll(".lj-style-card").forEach(c => c.removeClass("active"));
        card.addClass("active");
        this.plugin.settings.uiStyle = key;
        await this.plugin.saveSettings();
        this.plugin.applyUIStyle();
        // 重新渲染视图
        const view = this.plugin.getJournalView();
        if (view) view.buildUI();
      });
    });

    // ── 皮肤选择 ──────────────────────────────────────
    containerEl.createEl("h3", { text: "🎨 配色皮肤" });
    containerEl.createEl("p", {
      text: "在当前界面风格下应用配色（极简墨白风格下皮肤效果较弱）",
      cls: "lj-settings-hint"
    });

    const themeGrid = containerEl.createDiv({ cls: "lj-theme-grid" });
    (Object.entries(THEME_INFO) as [ThemeName, typeof THEME_INFO[ThemeName]][]).forEach(([key, info]) => {
      const card = themeGrid.createDiv({
        cls: `lj-theme-card lj-theme-${key} ${this.plugin.settings.theme === key ? "active" : ""}`
      });
      card.createDiv({ cls: "lj-theme-emoji", text: info.emoji });
      card.createDiv({ cls: "lj-theme-name", text: info.label });
      card.createDiv({ cls: "lj-theme-desc", text: info.desc });
      card.addEventListener("click", async () => {
        themeGrid.querySelectorAll(".lj-theme-card").forEach(c => c.removeClass("active"));
        card.addClass("active");
        this.plugin.settings.theme = key;
        await this.plugin.saveSettings();
        this.plugin.applyTheme();
      });
    });

    // ── 阅读页计划展示 ────────────────────────────────
    new Setting(containerEl)
      .setName("计划展示方式")
      .setDesc("「单独板块」：模式栏新增 📋 计划 入口，计划不再混入阅读列表；「融入阅读列表」：计划按日期混排显示")
      .addDropdown(dropdown => dropdown
        .addOption("separate", "单独板块（模式栏入口）")
        .addOption("inline", "融入阅读列表")
        .setValue(this.plugin.settings.plansDisplay)
        .onChange(async value => {
          this.plugin.settings.plansDisplay = value as typeof this.plugin.settings.plansDisplay;
          await this.plugin.saveSettings();
          // 结构变化，重建已打开的阅读视图
          const view = this.plugin.getJournalView();
          if (view) view.buildUI();
        }));

    // ── 视图打开位置 ──────────────────────────────────
    new Setting(containerEl)
      .setName("默认打开位置")
      .setDesc("打开 Life Journal 视图的位置：左侧边栏 / 主窗口（新标签页）/ 右侧边栏；切换后已打开的视图会自动迁移到新位置")
      .addDropdown(dropdown => dropdown
        .addOption("left", "左侧边栏")
        .addOption("main", "主窗口（新标签页）")
        .addOption("right", "右侧边栏")
        .setValue(this.plugin.settings.openLocation)
        .onChange(async value => {
          this.plugin.settings.openLocation = value as typeof this.plugin.settings.openLocation;
          await this.plugin.saveSettings();
          // 已打开的视图迁移到新位置
          const { workspace } = this.plugin.app;
          const existing = workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
          if (existing) {
            existing.detach();
            await this.plugin.activateView();
          }
        }));

    // ── 日记设置 ──────────────────────────────────────
    containerEl.createEl("h3", { text: "📁 日记目录" });

    new Setting(containerEl)
      .setName("日记文件夹")
      .setDesc("存放日记文件的文件夹路径（相对于vault根目录）")
      .addText(text => text
        .setPlaceholder("例如: Daily 或 Journal/Daily")
        .setValue(this.plugin.settings.diaryFolder)
        .onChange(async (value) => {
          this.plugin.settings.diaryFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("日期格式")
      .setDesc("日记文件名的日期格式（使用 YYYY MM DD）")
      .addText(text => text
        .setPlaceholder("YYYY-MM-DD")
        .setValue(this.plugin.settings.dateFormat)
        .onChange(async (value) => {
          this.plugin.settings.dateFormat = value.trim() || "YYYY-MM-DD";
          await this.plugin.saveSettings();
        }));

    // ── 章节管理 ──────────────────────────────────────
    containerEl.createEl("h3", { text: "\u{1F4D1} \u7AE0\u8282\u7BA1\u7406" });
    containerEl.createEl("p", {
      text: "\u81EA\u5B9A\u4E49\u8BB0\u5F55\u9875\u7684 Tab \u7AE0\u8282\u3002\u53EF\u4EE5\u6DFB\u52A0\u3001\u5220\u9664\u3001\u7F16\u8F91\u540D\u79F0/\u56FE\u6807/\u7C7B\u578B/\u63D0\u793A\u6587\u5B57\uFF0C\u8C03\u6574\u987A\u5E8F\uFF0C\u6700\u591A " + MAX_SECTIONS + " \u4E2A\u3002\u6BCF\u4E2A\u7AE0\u8282\u5BF9\u5E94\u65E5\u8BB0\u4E2D\u7684\u4E00\u4E2A # \u6807\u9898\u533A\u5757\u3002",
      cls: "lj-settings-hint"
    });

    // 类型开关：整体关闭闪念/待办计划类型
    const TYPE_TOGGLES: { key: SectionType; label: string; desc: string }[] = [
      { key: "memos", label: "⚡ 闪念类型", desc: "关闭后所有闪念类型的章节（含 Tab 与阅读视图）都不显示" },
      { key: "plans", label: "📅 待办计划类型", desc: "关闭后所有计划章节不显示，模式栏的「计划」入口也会隐藏" },
    ];
    TYPE_TOGGLES.forEach(({ key, label, desc }) => {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addToggle(toggle => toggle
          .setValue(isTypeEnabled(this.plugin.settings, key))
          .onChange(async value => {
            this.plugin.settings.typeEnabled[key] = value;
            await this.plugin.saveSettings();
            refreshView();
          }));
    });

    const sectionList = containerEl.createDiv({ cls: "lj-section-editor" });

    const refreshView = () => {
      const view = this.plugin.getJournalView();
      if (view) view.buildUI();
    };

    const renderSectionEditor = () => {
      sectionList.empty();
      this.plugin.settings.sections.forEach((sec, idx) => {
        // 每个章节是一张卡片
        const card = sectionList.createDiv({ cls: "lj-section-card" });

        // 卡片头：序号 + 排序 + 删除
        const cardHead = card.createDiv({ cls: "lj-section-card-head" });
        cardHead.createDiv({ cls: "lj-section-card-num", text: `${idx + 1}` });

        const moveGroup = cardHead.createDiv({ cls: "lj-section-move-group" });
        const upBtn = moveGroup.createDiv({ cls: "lj-section-move-btn", text: "\u2191", attr: { "aria-label": "\u4E0A\u79FB", role: "button", tabindex: "0" } });
        upBtn.toggleClass("disabled", idx === 0);
        upBtn.addEventListener("click", async () => {
          if (idx === 0) return;
          const arr = this.plugin.settings.sections;
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          await this.plugin.saveSettings();
          renderSectionEditor();
          refreshView();
        });

        const downBtn = moveGroup.createDiv({ cls: "lj-section-move-btn", text: "\u2193", attr: { "aria-label": "\u4E0B\u79FB", role: "button", tabindex: "0" } });
        downBtn.toggleClass("disabled", idx === this.plugin.settings.sections.length - 1);
        downBtn.addEventListener("click", async () => {
          if (idx === this.plugin.settings.sections.length - 1) return;
          const arr = this.plugin.settings.sections;
          [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
          await this.plugin.saveSettings();
          renderSectionEditor();
          refreshView();
        });

        // 显示/隐藏
        const toggleBtn = cardHead.createDiv({
          cls: `lj-section-toggle ${sec.enabled ? "enabled" : ""}`,
          text: sec.enabled ? "\u{1F441}\uFE0F \u53EF\u89C1" : "\u{1F6AB} \u9690\u85CF",
          attr: { role: "button", tabindex: "0", "aria-label": sec.enabled ? "\u70B9\u51FB\u9690\u85CF" : "\u70B9\u51FB\u663E\u793A" },
        });
        toggleBtn.addEventListener("click", async () => {
          this.plugin.settings.sections[idx].enabled = !sec.enabled;
          await this.plugin.saveSettings();
          renderSectionEditor();
          refreshView();
        });

        // 删除按钮（醒目）
        const delBtn = cardHead.createDiv({
          cls: "lj-section-del-btn",
          text: "\u{1F5D1}\uFE0F \u5220\u9664",
          attr: { role: "button", tabindex: "0", "aria-label": `\u5220\u9664\u7AE0\u8282 ${sec.label}` },
        });
        delBtn.addEventListener("click", async () => {
          this.plugin.settings.sections.splice(idx, 1);
          await this.plugin.saveSettings();
          renderSectionEditor();
          refreshView();
        });

        // 卡片内容：emoji + 名称 + 类型 + 占位符
        const cardBody = card.createDiv({ cls: "lj-section-card-body" });

        const fieldRow1 = cardBody.createDiv({ cls: "lj-section-field-row" });

        // emoji
        const emojiCell = fieldRow1.createDiv({ cls: "lj-section-field" });
        emojiCell.createEl("label", { text: "\u56FE\u6807", cls: "lj-section-field-label" });
        const emojiInput = emojiCell.createEl("input", {
          cls: "lj-section-edit-emoji",
          attr: { type: "text", maxlength: "4", "aria-label": `\u7AE0\u8282 ${idx + 1} \u56FE\u6807` },
        });
        emojiInput.value = sec.emoji;
        emojiInput.addEventListener("change", async () => {
          const v = emojiInput.value.trim();
          if (v) { this.plugin.settings.sections[idx].emoji = v; await this.plugin.saveSettings(); refreshView(); }
        });

        // 名称
        const labelCell = fieldRow1.createDiv({ cls: "lj-section-field" });
        labelCell.createEl("label", { text: "\u540D\u79F0", cls: "lj-section-field-label" });
        const labelInput = labelCell.createEl("input", {
          cls: "lj-section-edit-label",
          attr: { type: "text", "aria-label": `\u7AE0\u8282 ${idx + 1} \u540D\u79F0` },
        });
        labelInput.value = sec.label;
        labelInput.addEventListener("change", async () => {
          const v = labelInput.value.trim();
          if (v) { this.plugin.settings.sections[idx].label = v; await this.plugin.saveSettings(); refreshView(); }
        });

        // 类型
        const typeCell = fieldRow1.createDiv({ cls: "lj-section-field" });
        typeCell.createEl("label", { text: "\u7C7B\u578B", cls: "lj-section-field-label" });
        const typeSelect = typeCell.createEl("select", {
          cls: "lj-section-edit-type",
          attr: { "aria-label": `\u7AE0\u8282 ${idx + 1} \u7C7B\u578B` },
        });
        (Object.entries(SECTION_TYPE_INFO) as [SectionType, typeof SECTION_TYPE_INFO[SectionType]][]).forEach(([key, info]) => {
          const opt = typeSelect.createEl("option", { value: key, text: `${info.emoji} ${info.label}` });
          if (sec.type === key) opt.setAttribute("selected", "selected");
        });
        typeSelect.addEventListener("change", async () => {
          this.plugin.settings.sections[idx].type = typeSelect.value as SectionType;
          await this.plugin.saveSettings();
          refreshView();
        });

        // 占位符
        const fieldRow2 = cardBody.createDiv({ cls: "lj-section-field-row" });
        const placeholderCell = fieldRow2.createDiv({ cls: "lj-section-field lj-section-field-wide" });
        placeholderCell.createEl("label", { text: "\u8F93\u5165\u6846\u63D0\u793A\u6587\u5B57", cls: "lj-section-field-label" });
        const placeholderInput = placeholderCell.createEl("input", {
          cls: "lj-section-edit-placeholder",
          attr: { type: "text", "aria-label": `\u7AE0\u8282 ${idx + 1} \u63D0\u793A\u6587\u5B57` },
        });
        placeholderInput.value = sec.placeholder;
        placeholderInput.addEventListener("change", async () => {
          this.plugin.settings.sections[idx].placeholder = placeholderInput.value.trim() || "\u8F93\u5165\u5185\u5BB9\u2026";
          await this.plugin.saveSettings();
          refreshView();
        });

        // 闪念：心情选择器开关（是否在输入区上方显示心情 emoji 网格）
        if (sec.type === "memos") {
          const fieldRow3 = cardBody.createDiv({ cls: "lj-section-field-row" });
          const moodCell = fieldRow3.createDiv({ cls: "lj-section-field" });
          moodCell.createEl("label", { text: "\u5FC3\u60C5\u9009\u62E9\u5668", cls: "lj-section-field-label" });
          const moodToggle = moodCell.createDiv({
            cls: `lj-section-toggle ${sec.showMoodPicker !== false ? "enabled" : ""}`,
            text: sec.showMoodPicker !== false ? "\u{1F60A} \u663E\u793A" : "\u{1F6AB} \u9690\u85CF",
            attr: { role: "button", tabindex: "0", "aria-label": "\u5207\u6362\u5FC3\u60C5\u9009\u62E9\u5668" },
          });
          moodToggle.addEventListener("click", async () => {
            this.plugin.settings.sections[idx].showMoodPicker = sec.showMoodPicker === false;
            await this.plugin.saveSettings();
            renderSectionEditor();
            refreshView();
          });
        }
      });

      // 添加按钮（在列表底部，醒目）
      const full = this.plugin.settings.sections.length >= MAX_SECTIONS;
      if (full) {
        sectionList.createDiv({ cls: "lj-section-full-hint", text: `\u5DF2\u8FBE\u4E0A\u9650\uFF08${MAX_SECTIONS} \u4E2A\uFF09` });
      }
    };

    renderSectionEditor();

    // 添加章节按钮（独立放在列表下方）
    const addSectionBtn = containerEl.createEl("button", {
      cls: "lj-section-add-btn",
      text: "+ \u6DFB\u52A0\u7AE0\u8282",
      attr: { "aria-label": "\u6DFB\u52A0\u7AE0\u8282" },
    });
    addSectionBtn.toggleClass("is-disabled", this.plugin.settings.sections.length >= MAX_SECTIONS);
    addSectionBtn.addEventListener("click", async () => {
      if (this.plugin.settings.sections.length >= MAX_SECTIONS) return;
      const count = this.plugin.settings.sections.length + 1;
      this.plugin.settings.sections.push({
        id: `custom-${Date.now()}`,
        emoji: "\u26A1",
        label: `\u65B0\u7AE0\u8282${count}`,
        type: "memos",
        placeholder: "\u8F93\u5165\u5185\u5BB9\u2026",
        enabled: true,
        showMoodPicker: false,
      });
      await this.plugin.saveSettings();
      renderSectionEditor();
      addSectionBtn.toggleClass("is-disabled", this.plugin.settings.sections.length >= MAX_SECTIONS);
      refreshView();
    });

    // ── 心情管理 ──────────────────────────────────────
    containerEl.createEl("h3", { text: "🌟 心情管理" });
    containerEl.createEl("p", {
      text: `自定义心情的表情与含义文字，最多 ${MAX_CUSTOM_MOODS} 个（一行 4 个）；在记录页长按心情也可直接编辑`,
      cls: "lj-settings-hint"
    });

    const moodList = containerEl.createDiv({ cls: "lj-mood-editor" });
    const addMoodBtn = containerEl.createEl("button", {
      cls: "lj-mood-add-btn",
      attr: { "aria-label": "添加心情" },
    });

    const refreshJournalView = () => {
      const view = this.plugin.getJournalView();
      if (view) view.buildUI();
    };

    const renderMoodEditor = () => {
      moodList.empty();
      this.plugin.settings.customMoods.forEach((mood, idx) => {
        const row = moodList.createDiv({ cls: "lj-mood-edit-row" });
        const emojiInput = row.createEl("input", {
          cls: "lj-mood-edit-emoji",
          attr: { type: "text", maxlength: "4", "aria-label": `心情 ${idx + 1} 表情` },
        });
        emojiInput.value = mood.emoji;
        const labelInput = row.createEl("input", {
          cls: "lj-mood-edit-label",
          attr: { type: "text", "aria-label": `心情 ${idx + 1} 含义` },
        });
        labelInput.value = mood.label;

        emojiInput.addEventListener("change", async () => {
          const v = emojiInput.value.trim();
          if (v) { this.plugin.settings.customMoods[idx].emoji = v; await this.plugin.saveSettings(); refreshJournalView(); }
        });
        labelInput.addEventListener("change", async () => {
          const v = labelInput.value.trim();
          if (v) { this.plugin.settings.customMoods[idx].label = v; await this.plugin.saveSettings(); refreshJournalView(); }
        });

        const del = row.createDiv({ cls: "lj-mood-edit-del", text: "×", attr: { role: "button", "aria-label": `删除心情 ${mood.label}`, tabindex: "0" } });
        const remove = async () => {
          this.plugin.settings.customMoods.splice(idx, 1);
          await this.plugin.saveSettings();
          renderMoodEditor();
          refreshJournalView();
        };
        del.addEventListener("click", remove);
        del.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void remove(); } });
      });

      const full = this.plugin.settings.customMoods.length >= MAX_CUSTOM_MOODS;
      addMoodBtn.toggleClass("is-disabled", full);
      addMoodBtn.setText(full ? `已达上限（${MAX_CUSTOM_MOODS} 个）` : "+ 添加心情");
    };
    addMoodBtn.addEventListener("click", async () => {
      if (this.plugin.settings.customMoods.length >= MAX_CUSTOM_MOODS) return;
      this.plugin.settings.customMoods.push({ emoji: "🙂", label: "心情" });
      await this.plugin.saveSettings();
      renderMoodEditor();
      refreshJournalView();
    });
    renderMoodEditor();

    // ── 快捷标签 ──────────────────────────────────────
    containerEl.createEl("h3", { text: "🏷 快捷标签" });
    containerEl.createEl("p", {
      text: "记录页显示的快捷标签，点击即可向正文追加 #标签（回顾页可按标签筛选）；多个标签用逗号分隔",
      cls: "lj-settings-hint"
    });
    new Setting(containerEl)
      .setName("快捷标签列表")
      .addText(text => text
        .setPlaceholder("商业, 灵感, 读书")
        .setValue(this.plugin.settings.quickTags.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.quickTags = value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    // ── 优先级显示 ────────────────────────────────────
    new Setting(containerEl)
      .setName("显示 2 级优先级徽标")
      .setDesc("开启后，2 级（重要不紧急，默认等级）的计划也显示橙色 Ⅱ 徽标；默认只显示 1红 / 3蓝 / 4绿")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showMediumPriorityBadge)
        .onChange(async value => {
          this.plugin.settings.showMediumPriorityBadge = value;
          await this.plugin.saveSettings();
          const view = this.plugin.getJournalView();
          if (view) view.buildUI();
        }));

    // ── 计划完成时间 ──────────────────────────────────
    containerEl.createEl("h3", { text: "✅ 计划完成时间" });
    containerEl.createEl("p", {
      text: "勾选完成计划时，自动在任务末尾写入完成时间行内字段（如 [completedAt::2026-09-11 14:30]）；取消完成时自动移除。可在已完成的计划后面显示完成耗时或完成时间。",
      cls: "lj-settings-hint"
    });
    new Setting(containerEl)
      .setName("完成时间字段名")
      .setDesc("写入任务末尾的行内字段名，如 completedAt")
      .addText(text => text
        .setPlaceholder("completedAt")
        .setValue(this.plugin.settings.todoCompletedField)
        .onChange(async (value) => {
          this.plugin.settings.todoCompletedField = value.trim() || "completedAt";
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("已完成任务显示")
      .setDesc("在已完成的计划后面显示的完成信息")
      .addDropdown(dropdown => dropdown
        .addOption("duration", "完成耗时")
        .addOption("time", "完成时间")
        .addOption("both", "两者都显示")
        .setValue(this.plugin.settings.todoCompletionDisplay)
        .onChange(async value => {
          this.plugin.settings.todoCompletionDisplay = value as typeof this.plugin.settings.todoCompletionDisplay;
          await this.plugin.saveSettings();
          const view = this.plugin.getJournalView();
          if (view) view.buildUI();
        }));

    // 底部版本信息
    const footer = containerEl.createDiv({ cls: "lj-settings-footer" });
    footer.createEl("span", { text: "Daybook v3.2.0 · 记录即意义 ✦" });
  }
}
