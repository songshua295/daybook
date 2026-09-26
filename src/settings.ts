import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { VIEW_TYPE_JOURNAL } from "./JournalView";
import type { LegacyHabitDef } from "./habitManager";
import { DEFAULT_EXPENSE_CATEGORIES } from "./expenseManager";

/** 视图默认打开位置：left=左侧边栏（默认）/ main=主窗口新标签页 / right=右侧边栏 */
export type OpenLocation = "left" | "main" | "right";

/** 章节渲染类型：memos=闪念（快速记录，支持 Markdown/双链/标签）, plans=待办计划, habits=习惯打卡, expenses=记账 */
export type SectionType = "memos" | "plans" | "habits" | "expenses";

/** 动态章节配置 */
export interface SectionConfig {
  id: string;           // 唯一标识（如 "memos", "plans", "custom-1"）
  emoji: string;        // Tab emoji（如 "⚡"）
  label: string;        // Tab 标签 & 日记中 # 标题
  type: SectionType;    // 渲染类型
  placeholder: string;  // 输入框提示文字
  enabled: boolean;     // 是否在 Tab 栏显示
  showMoodPicker?: boolean; // 仅闪念：心情选择条是否默认展开（undefined = 展开；页面上可随时收起）
  filePath?: string;         // 自定义文件路径（如 Work/Notes/{{YYYY-MM-DD}}.md），留空则用默认
}


/** 版块配置：模式栏的一个入口，包含一个或多个章节 */
export interface PanelConfig {
  id: string;            // 唯一标识
  name: string;          // 版块名（显示在模式栏）
  sections: SectionConfig[]; // 该版块下的章节
}

/** 可编辑的心情选项（emoji + 含义文字） */
export interface MoodOption {
  emoji: string;
  label: string;
}

/** 章节类型开关：整体关闭某类型（闪念/待办计划/习惯打卡/记账），该类型的所有章节不渲染 */
export interface TypeToggles {
  memos: boolean;
  plans: boolean;
  habits: boolean;
  expenses: boolean;
}

/** 类型是否启用（undefined 视为启用） */
export function isTypeEnabled(settings: DaybookSettings, type: SectionType): boolean {
  return settings.typeEnabled?.[type] !== false;
}


/** 扁平化所有版块的章节（供 fileReader 等使用） */
export function getAllSections(settings: DaybookSettings): SectionConfig[] {
  return settings.panels.flatMap(p => p.sections);
}

/** 获取所有启用的章节（enabled + typeEnabled） */
export function getVisibleSections(settings: DaybookSettings): SectionConfig[] {
  return getAllSections(settings).filter(s => s.enabled && isTypeEnabled(settings, s.type));
}

/** 获取有可见章节的版块 */
export function getVisiblePanels(settings: DaybookSettings): PanelConfig[] {
  return settings.panels.filter(p =>
    p.sections.some(s => s.enabled && isTypeEnabled(settings, s.type))
  );
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
  filterCompletion: "all" | "done" | "undone"; // 完成状态筛选
  searchVisible: boolean;                    // 搜索面板是否展开（含搜索/标签/日期筛选）
  searchQuery: string;                       // 搜索关键字
  groupOrder: string[];                      // 分组自定义次序（拖拽产生，按分组 key）
}

export interface DaybookSettings {
  openLocationDesktop: OpenLocation; // 桌面端打开位置（移动端固定主区新标签页）
  panels: PanelConfig[];      // 版块列表（每个版块含若干章节）
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
  typeEnabled: TypeToggles;                 // 章节类型开关（闪念/待办计划/习惯打卡）
  habits?: LegacyHabitDef[];               // 仅作旧数据读取（v4.3 起习惯存 habits/*.md，迁移后清空）
  habitsMigratedV2?: boolean;              // 旧习惯数据已迁移为"每习惯一个 md 文件"
  // v4.4 新增：移动端完成反馈
  completionHaptic: boolean;   // 勾选待办 / 打卡达标时轻微震动
  completionSound: boolean;    // 同一时机播放完成音效
  // v4.6 新增：记账
  expenseCategories: string[];      // 记账分类（在记账页就地管理，不进设置页）
  expensesAddedV1?: boolean;        // 已为老用户追加默认「记账」版块（一次性迁移）
}

export const DEFAULT_SETTINGS: DaybookSettings = {
  openLocationDesktop: "left",  // 桌面端默认左侧边栏
  panels: [
    {
      id: "record",
      name: "记录",
      sections: [
        { id: "memos", emoji: "\u26A1", label: "\u95EA\u5FF5", type: "memos", placeholder: "\u6B64\u523B\u7684\u60F3\u6CD5\u2026\u652F\u6301 **\u52A0\u7C97**\u3001[[\u53CC\u94FE]]\u3001#\u6807\u7B7E", enabled: true, showMoodPicker: true },
      ],
    },
    {
      id: "plans",
      name: "计划",
      sections: [
        { id: "plans", emoji: "\u{1F4C5}", label: "计划", type: "plans", placeholder: "添加待办，如：本周五完成报告", enabled: true },
      ],
    },
    {
      id: "habits",
      name: "习惯",
      sections: [
        { id: "habits", emoji: "\u{1F4A7}", label: "习惯打卡", type: "habits", placeholder: "", enabled: true },
      ],
    },
    {
      id: "expenses",
      name: "记账",
      sections: [
        { id: "expenses", emoji: "\u{1F4B0}", label: "记账", type: "expenses", placeholder: "", enabled: true },
      ],
    },
  ],
  diaryFolder: "Daily",
  dateFormat: "YYYY-MM-DD",
  customMoods: [
    { emoji: "💭", label: "思考" },
    { emoji: "😊", label: "开心" },
    { emoji: "😢", label: "伤心" },
    { emoji: "😰", label: "焦虑" },
    { emoji: "😤", label: "生气" },
    { emoji: "😌", label: "平静" },
    { emoji: "✨", label: "期待" },
    { emoji: "😫", label: "疲惫" },
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
    filterCompletion: "all",
    searchVisible: false,
    searchQuery: "",
    groupOrder: [],
  },
  typeEnabled: {
    memos: true,
    plans: true,
    habits: true,
    expenses: true,
  },
  completionHaptic: true,
  completionSound: true,
  expenseCategories: DEFAULT_EXPENSE_CATEGORIES,
};

/** 心情数量上限（一行 4 个，最多两行） */
export const MAX_CUSTOM_MOODS = 8;

/** 章节数量上限 */
export const MAX_SECTIONS = 8;

/** 章节类型信息 */
export const SECTION_TYPE_INFO: Record<SectionType, { label: string; emoji: string; desc: string }> = {
  memos: { label: "闪念", emoji: "⚡", desc: "快速记录，支持加粗/删除线/双链/图片/标签" },
  plans: { label: "待办计划", emoji: "\u{1F4C5}", desc: "待办输入 + 日期提取 + 优先级 + 子任务" },
  habits: { label: "习惯打卡", emoji: "\u{1F4A7}", desc: "每习惯一个 md（<日记目录>/habits/，可手动编辑）· 详情页含活跃度热力图 + 周/月/年趋势图" },
  expenses: { label: "记账", emoji: "\u{1F4B0}", desc: "金额 + 分类 + 备注，写入当日日记的「记账」小节；今日记录含收支合计" },
};



export class DaybookSettingTab extends PluginSettingTab {
  plugin: DaybookPlugin;

  constructor(app: App, plugin: DaybookPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** 创建 iOS 风格分组卡片（可折叠） */
  private createSettingsCard(parent: HTMLElement, title: string, icon: string): HTMLElement {
    const card = parent.createDiv({ cls: "db-settings-card" });
    const header = card.createDiv({ cls: "db-settings-card-header" });
    const iconEl = header.createDiv({ cls: "db-settings-card-icon" });
    setIcon(iconEl, icon);
    header.createEl("span", { text: title, cls: "db-settings-card-title" });
    const chevron = header.createDiv({ cls: "db-settings-card-chevron" });
    setIcon(chevron, "chevron-down");
    const body = card.createDiv({ cls: "db-settings-card-body" });
    header.addEventListener("click", (e) => {
      // 不拦截卡片内部交互（输入、按钮等）
      if ((e.target as HTMLElement).closest("input, button, select, textarea, .db-section-toggle, .db-section-move-btn, .db-section-del-btn")) return;
      card.toggleClass("db-card-collapsed", !card.hasClass("db-card-collapsed"));
      setIcon(chevron, card.hasClass("db-card-collapsed") ? "chevron-right" : "chevron-down");
    });
    return body;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("db-settings-grouped");

    // ══ 卡片 1: 通用 ════════════════════════════════
    const card1 = this.createSettingsCard(containerEl, "通用", "settings");

    const reopenView = async () => {
      await this.plugin.saveSettings();
      const { workspace } = this.plugin.app;
      const existing = workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
      if (existing) { existing.detach(); await this.plugin.activateView(); }
    };
    new Setting(card1)
      .setName("桌面端打开位置")
      .setDesc("桌面端默认打开位置")
      .addDropdown(dropdown => dropdown
        .addOption("left", "左侧边栏")
        .addOption("main", "主窗口（新标签页）")
        .addOption("right", "右侧边栏")
        .setValue(this.plugin.settings.openLocationDesktop)
        .onChange(async value => {
          this.plugin.settings.openLocationDesktop = value as OpenLocation;
          await reopenView();
        }));

    new Setting(card1)
      .setName("日记文件夹")
      .setDesc("存放日记文件的文件夹路径（相对于 vault 根目录）")
      .addText(text => text
        .setPlaceholder("例如: Daily 或 Journal/Daily")
        .setValue(this.plugin.settings.diaryFolder)
        .onChange(async (value) => {
          this.plugin.settings.diaryFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(card1)
      .setName("日期格式")
      .setDesc("日记文件名的日期格式（使用 YYYY MM DD）")
      .addText(text => text
        .setPlaceholder("YYYY-MM-DD")
        .setValue(this.plugin.settings.dateFormat)
        .onChange(async (value) => {
          this.plugin.settings.dateFormat = value.trim() || "YYYY-MM-DD";
          await this.plugin.saveSettings();
        }));

    // ══ 卡片 2: 版块管理 ════════════════════════════
    const card2 = this.createSettingsCard(containerEl, "版块管理", "layers");
    card2.createEl("p", {
      text: "每个章节对应主页面左上角下拉列表中的一个记录入口；关闭类型或停用章节后，对应入口与其今日记录一并隐藏。",
      cls: "db-settings-hint"
    });

    // 类型开关
    const TYPE_TOGGLES: { key: SectionType; label: string; desc: string }[] = [
      { key: "memos", label: "⚡ 闪念类型", desc: "关闭后所有闪念章节不显示" },
      { key: "plans", label: "📅 待办计划类型", desc: "关闭后所有计划章节不显示" },
      { key: "habits", label: "💧 习惯打卡类型", desc: "关闭后所有习惯打卡章节不显示" },
      { key: "expenses", label: "\u{1F4B0} 记账类型", desc: "关闭后所有记账章节不显示" },
    ];
    TYPE_TOGGLES.forEach(({ key, label, desc }) => {
      new Setting(card2)
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

    const panelList = card2.createDiv({ cls: "db-panel-editor" });

    const refreshView = () => {
      const view = this.plugin.getJournalView();
      if (view) view.buildUI();
    };

    const totalSections = () => this.plugin.settings.panels.reduce((n, p) => n + p.sections.length, 0);

    const renderPanelEditor = () => {
      panelList.empty();
      this.plugin.settings.panels.forEach((panel, pi) => {
        // ── 版块卡片 ──
        const panelCard = panelList.createDiv({ cls: "db-panel-card" });
        const panelHead = panelCard.createDiv({ cls: "db-panel-card-head" });

        // 序号
        panelHead.createDiv({ cls: "db-section-card-num", text: `${pi + 1}` });

        // 版块名（可编辑）
        const nameInput = panelHead.createEl("input", {
          cls: "db-panel-name-input",
          attr: { type: "text", "aria-label": `版块 ${pi + 1} 名称` },
        });
        nameInput.value = panel.name;
        nameInput.addEventListener("change", async () => {
          const v = nameInput.value.trim();
          if (v) { this.plugin.settings.panels[pi].name = v; await this.plugin.saveSettings(); refreshView(); }
        });

        // 单/多章节提示
        const secCount = panel.sections.length;
        const hintEl = panelHead.createDiv({
          cls: "db-panel-section-hint",
          text: secCount <= 1 ? "单章节" : `${secCount} 个章节`,
        });

        // 折叠按钮
        const panelChevron = panelHead.createDiv({ cls: "db-panel-chevron" });
        setIcon(panelChevron, "chevron-down");

        // 排序按钮
        const moveGroup = panelHead.createDiv({ cls: "db-section-move-group" });
        const upBtn = moveGroup.createDiv({ cls: "db-section-move-btn", text: "↑", attr: { "aria-label": "上移版块", role: "button", tabindex: "0" } });
        upBtn.toggleClass("disabled", pi === 0);
        upBtn.addEventListener("click", async () => {
          if (pi === 0) return;
          const arr = this.plugin.settings.panels;
          [arr[pi - 1], arr[pi]] = [arr[pi], arr[pi - 1]];
          await this.plugin.saveSettings();
          renderPanelEditor();
          refreshView();
        });
        const downBtn = moveGroup.createDiv({ cls: "db-section-move-btn", text: "↓", attr: { "aria-label": "下移版块", role: "button", tabindex: "0" } });
        downBtn.toggleClass("disabled", pi === this.plugin.settings.panels.length - 1);
        downBtn.addEventListener("click", async () => {
          if (pi === this.plugin.settings.panels.length - 1) return;
          const arr = this.plugin.settings.panels;
          [arr[pi + 1], arr[pi]] = [arr[pi], arr[pi + 1]];
          await this.plugin.saveSettings();
          renderPanelEditor();
          refreshView();
        });

        // 删除版块
        const delPanelBtn = panelHead.createDiv({
          cls: "db-section-del-btn",
          text: "🗑️ 删除",
          attr: { role: "button", tabindex: "0", "aria-label": `删除版块 ${panel.name}` },
        });
        delPanelBtn.addEventListener("click", async () => {
          this.plugin.settings.panels.splice(pi, 1);
          await this.plugin.saveSettings();
          renderPanelEditor();
          refreshView();
        });

        // ── 版块内：章节列表 ──
        const secList = panelCard.createDiv({ cls: "db-panel-sections" });

        // 点击版块头折叠/展开章节列表
        panelHead.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("input, button, select, textarea, .db-section-toggle, .db-section-move-btn, .db-section-del-btn")) return;
          panelCard.toggleClass("db-panel-collapsed", !panelCard.hasClass("db-panel-collapsed"));
          setIcon(panelChevron, panelCard.hasClass("db-panel-collapsed") ? "chevron-right" : "chevron-down");
        });
        panel.sections.forEach((sec, si) => {
          const secCard = secList.createDiv({ cls: "db-section-card db-section-card-nested" });
          const secHead = secCard.createDiv({ cls: "db-section-card-head" });

          // 章节序号
          secHead.createDiv({ cls: "db-section-card-num", text: `${si + 1}` });

          // 显示/隐藏
          const toggleBtn = secHead.createDiv({
            cls: `db-section-toggle ${sec.enabled ? "enabled" : ""}`,
            text: sec.enabled ? "👁️ 可见" : "🚫 隐藏",
            attr: { role: "button", tabindex: "0", "aria-label": sec.enabled ? "点击隐藏" : "点击显示" },
          });
          toggleBtn.addEventListener("click", async () => {
            this.plugin.settings.panels[pi].sections[si].enabled = !sec.enabled;
            await this.plugin.saveSettings();
            renderPanelEditor();
            refreshView();
          });

          // 排序
          const secMove = secHead.createDiv({ cls: "db-section-move-group" });
          const sUp = secMove.createDiv({ cls: "db-section-move-btn", text: "↑", attr: { "aria-label": "上移章节", role: "button", tabindex: "0" } });
          sUp.toggleClass("disabled", si === 0);
          sUp.addEventListener("click", async () => {
            if (si === 0) return;
            const arr = this.plugin.settings.panels[pi].sections;
            [arr[si - 1], arr[si]] = [arr[si], arr[si - 1]];
            await this.plugin.saveSettings();
            renderPanelEditor();
            refreshView();
          });
          const sDown = secMove.createDiv({ cls: "db-section-move-btn", text: "↓", attr: { "aria-label": "下移章节", role: "button", tabindex: "0" } });
          sDown.toggleClass("disabled", si === panel.sections.length - 1);
          sDown.addEventListener("click", async () => {
            if (si === panel.sections.length - 1) return;
            const arr = this.plugin.settings.panels[pi].sections;
            [arr[si + 1], arr[si]] = [arr[si], arr[si + 1]];
            await this.plugin.saveSettings();
            renderPanelEditor();
            refreshView();
          });

          // 删除章节
          const delSecBtn = secHead.createDiv({
            cls: "db-section-del-btn",
            text: "🗑️ 删除",
            attr: { role: "button", tabindex: "0", "aria-label": `删除章节 ${sec.label}` },
          });
          delSecBtn.addEventListener("click", async () => {
            this.plugin.settings.panels[pi].sections.splice(si, 1);
            await this.plugin.saveSettings();
            renderPanelEditor();
            refreshView();
          });

          // 章节内容
          const secBody = secCard.createDiv({ cls: "db-section-card-body" });
          const row1 = secBody.createDiv({ cls: "db-section-field-row" });

          // emoji
          const emojiCell = row1.createDiv({ cls: "db-section-field" });
          emojiCell.createEl("label", { text: "图标", cls: "db-section-field-label" });
          const emojiInput = emojiCell.createEl("input", { cls: "db-section-edit-emoji", attr: { type: "text", maxlength: "4", "aria-label": `章节 ${si + 1} 图标` } });
          emojiInput.value = sec.emoji;
          emojiInput.addEventListener("change", async () => {
            const v = emojiInput.value.trim();
            if (v) { this.plugin.settings.panels[pi].sections[si].emoji = v; await this.plugin.saveSettings(); refreshView(); }
          });

          // 名称
          const labelCell = row1.createDiv({ cls: "db-section-field" });
          labelCell.createEl("label", { text: "名称", cls: "db-section-field-label" });
          const labelInput = labelCell.createEl("input", { cls: "db-section-edit-label", attr: { type: "text", "aria-label": `章节 ${si + 1} 名称` } });
          labelInput.value = sec.label;
          labelInput.addEventListener("change", async () => {
            const v = labelInput.value.trim();
            if (v) { this.plugin.settings.panels[pi].sections[si].label = v; await this.plugin.saveSettings(); refreshView(); }
          });

          // 类型
          const typeCell = row1.createDiv({ cls: "db-section-field" });
          typeCell.createEl("label", { text: "类型", cls: "db-section-field-label" });
          const typeSelect = typeCell.createEl("select", { cls: "db-section-edit-type", attr: { "aria-label": `章节 ${si + 1} 类型` } });
          (Object.entries(SECTION_TYPE_INFO) as [SectionType, typeof SECTION_TYPE_INFO[SectionType]][]).forEach(([key, info]) => {
            const opt = typeSelect.createEl("option", { value: key, text: `${info.emoji} ${info.label}` });
            if (sec.type === key) opt.setAttribute("selected", "selected");
          });
          typeSelect.addEventListener("change", async () => {
            this.plugin.settings.panels[pi].sections[si].type = typeSelect.value as SectionType;
            await this.plugin.saveSettings();
            refreshView();
          });

          // 占位符
          const row2 = secBody.createDiv({ cls: "db-section-field-row" });
          const phCell = row2.createDiv({ cls: "db-section-field db-section-field-wide" });
          phCell.createEl("label", { text: "输入框提示文字", cls: "db-section-field-label" });
          const phInput = phCell.createEl("input", { cls: "db-section-edit-placeholder", attr: { type: "text", "aria-label": `章节 ${si + 1} 提示文字` } });
          phInput.value = sec.placeholder;
          phInput.addEventListener("change", async () => {
            this.plugin.settings.panels[pi].sections[si].placeholder = phInput.value.trim() || "输入内容…";
            await this.plugin.saveSettings();
            refreshView();
          });

          // 文件路径（自定义）
          const rowFp = secBody.createDiv({ cls: "db-section-field-row" });
          const fpCell = rowFp.createDiv({ cls: "db-section-field db-section-field-wide" });
          fpCell.createEl("label", { text: "文件路径", cls: "db-section-field-label" });
          const fpInput = fpCell.createEl("input", {
            cls: "db-section-edit-filepath",
            attr: { type: "text", placeholder: "如 Work/Notes/{{YYYY-MM-DD}}.md，留空则用默认", "aria-label": `章节 ${si + 1} 文件路径` },
          });
          fpInput.value = sec.filePath ?? "";
          fpInput.addEventListener("change", async () => {
            this.plugin.settings.panels[pi].sections[si].filePath = fpInput.value.trim() || undefined;
            await this.plugin.saveSettings();
            refreshView();
          });
          fpCell.createEl("div", {
            cls: "db-section-field-hint",
            text: "{{YYYY-MM-DD}} 为日期变量，支持 moment 格式如 {{YYYY/MM}}、{{HH:mm}} 等",
          });

          // 心情选择条默认展开状态（仅闪念）
          if (sec.type === "memos") {
            const row3 = secBody.createDiv({ cls: "db-section-field-row" });
            const moodCell = row3.createDiv({ cls: "db-section-field" });
            moodCell.createEl("label", { text: "是否展开", cls: "db-section-field-label" });
            const moodToggle = moodCell.createDiv({
              cls: `db-section-toggle ${sec.showMoodPicker !== false ? "enabled" : ""}`,
              text: sec.showMoodPicker !== false ? "😊 展开" : "🙈 收起",
              attr: { role: "button", tabindex: "0", "aria-label": "切换心情选择条默认展开状态" },
            });
            moodToggle.addEventListener("click", async () => {
              this.plugin.settings.panels[pi].sections[si].showMoodPicker = sec.showMoodPicker === false;
              await this.plugin.saveSettings();
              renderPanelEditor();
              refreshView();
            });
          }
        });

        // 添加章节按钮（版块内）
        const addSecBtn = secList.createEl("button", { cls: "db-section-add-btn db-section-add-btn-sm", text: "+ 添加章节", attr: { "aria-label": `在版块 ${panel.name} 中添加章节` } });
        addSecBtn.toggleClass("is-disabled", totalSections() >= MAX_SECTIONS);
        addSecBtn.addEventListener("click", async () => {
          if (totalSections() >= MAX_SECTIONS) return;
          const count = panel.sections.length + 1;
          this.plugin.settings.panels[pi].sections.push({ id: `custom-${Date.now()}`, emoji: "⚡", label: `新章节${count}`, type: "memos", placeholder: "输入内容…", enabled: true, showMoodPicker: false });
          await this.plugin.saveSettings();
          renderPanelEditor();
          refreshView();
        });
      });
    };

    renderPanelEditor();

    // 添加版块按钮
    const addPanelBtn = card2.createEl("button", { cls: "db-section-add-btn", text: "+ 添加版块", attr: { "aria-label": "添加版块" } });
    addPanelBtn.addEventListener("click", async () => {
      this.plugin.settings.panels.push({
        id: `panel-${Date.now()}`,
        name: `新版块${this.plugin.settings.panels.length + 1}`,
        sections: [{ id: `custom-${Date.now()}`, emoji: "⚡", label: "新章节1", type: "memos", placeholder: "输入内容…", enabled: true, showMoodPicker: false }],
      });
      await this.plugin.saveSettings();
      renderPanelEditor();
      refreshView();
    });

        // ══ 卡片 3: 记录偏好 ════════════════════════════
    const card3 = this.createSettingsCard(containerEl, "记录偏好", "sparkles");

    // — 心情管理 —
    card3.createEl("p", { text: `自定义心情表情与含义，最多 ${MAX_CUSTOM_MOODS} 个；长按心情可直接编辑`, cls: "db-settings-hint" });
    const moodList = card3.createDiv({ cls: "db-mood-editor" });
    const addMoodBtn = card3.createEl("button", { cls: "db-mood-add-btn", attr: { "aria-label": "添加心情" } });

    const refreshJournalView = () => { const view = this.plugin.getJournalView(); if (view) view.buildUI(); };

    const renderMoodEditor = () => {
      moodList.empty();
      this.plugin.settings.customMoods.forEach((mood, idx) => {
        const row = moodList.createDiv({ cls: "db-mood-edit-row" });
        const emojiInput = row.createEl("input", { cls: "db-mood-edit-emoji", attr: { type: "text", maxlength: "4", "aria-label": `心情 ${idx + 1} 表情` } });
        emojiInput.value = mood.emoji;
        const labelInput = row.createEl("input", { cls: "db-mood-edit-label", attr: { type: "text", "aria-label": `心情 ${idx + 1} 含义` } });
        labelInput.value = mood.label;
        emojiInput.addEventListener("change", async () => { const v = emojiInput.value.trim(); if (v) { this.plugin.settings.customMoods[idx].emoji = v; await this.plugin.saveSettings(); refreshJournalView(); } });
        labelInput.addEventListener("change", async () => { const v = labelInput.value.trim(); if (v) { this.plugin.settings.customMoods[idx].label = v; await this.plugin.saveSettings(); refreshJournalView(); } });
        const del = row.createDiv({ cls: "db-mood-edit-del", text: "×", attr: { role: "button", "aria-label": `删除心情 ${mood.label}`, tabindex: "0" } });
        const remove = async () => { this.plugin.settings.customMoods.splice(idx, 1); await this.plugin.saveSettings(); renderMoodEditor(); refreshJournalView(); };
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

    // — 快捷标签 —
    new Setting(card3)
      .setName("快捷标签")
      .setDesc("记录页显示的快捷标签，点击追加 #标签；多个用逗号分隔")
      .addText(text => text
        .setPlaceholder("商业, 灵感, 读书")
        .setValue(this.plugin.settings.quickTags.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.quickTags = value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    // — 优先级徽标 —
    new Setting(card3)
      .setName("显示 2 级优先级徽标")
      .setDesc("开启后 2 级（重要不紧急）计划也显示橙色 Ⅱ 徽标；默认只显示 1红 / 3蓝 / 4绿")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showMediumPriorityBadge)
        .onChange(async value => {
          this.plugin.settings.showMediumPriorityBadge = value;
          await this.plugin.saveSettings();
          const view = this.plugin.getJournalView();
          if (view) view.buildUI();
        }));

    // ══ 卡片 4: 计划完成时间 ════════════════════════
    const card4 = this.createSettingsCard(containerEl, "计划完成时间", "check-circle");
    card4.createEl("p", {
      text: "勾选完成计划时自动写入完成时间行内字段；取消完成时自动移除。",
      cls: "db-settings-hint"
    });

    new Setting(card4)
      .setName("完成时间字段名")
      .setDesc("写入任务末尾的行内字段名，如 completedAt")
      .addText(text => text
        .setPlaceholder("completedAt")
        .setValue(this.plugin.settings.todoCompletedField)
        .onChange(async (value) => {
          this.plugin.settings.todoCompletedField = value.trim() || "completedAt";
          await this.plugin.saveSettings();
        }));

    new Setting(card4)
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

    // ══ 卡片 5: 完成反馈（手机端） ══════════════════
    const card5 = this.createSettingsCard(containerEl, "完成反馈", "bell-ring");
    card5.createEl("p", {
      text: "仅手机端生效：勾选待办完成、或习惯打卡达到当日目标次数时给出反馈（每日 1 次的习惯每次打卡都反馈）。",
      cls: "db-settings-hint"
    });

    new Setting(card5)
      .setName("完成时震动")
      .setDesc("点击完成的瞬间轻微震动")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.completionHaptic)
        .onChange(async value => {
          this.plugin.settings.completionHaptic = value;
          await this.plugin.saveSettings();
        }));

    new Setting(card5)
      .setName("完成时播放音效")
      .setDesc("与震动同时播放「完成音效」，音量固定为 60%")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.completionSound)
        .onChange(async value => {
          this.plugin.settings.completionSound = value;
          await this.plugin.saveSettings();
        }));
  }
}
