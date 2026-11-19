import { App, Menu, Modal, Notice, PluginSettingTab, Setting, TextComponent, setIcon } from "obsidian";
import type DaybookPlugin from "./main";
import { VIEW_TYPE_JOURNAL } from "./JournalView";
import type { LegacyHabitDef } from "./habitManager";
import type { DramaFieldKey } from "./dramaStore";
import { testAiConnection } from "./aiClient";

/** 视图默认打开位置：left=左侧边栏（默认）/ main=主窗口新标签页 / right=右侧边栏 */
export type OpenLocation = "left" | "main" | "right";

/** 章节渲染类型：memos=闪念（快速记录，支持 Markdown/双链/标签）, plans=待办计划, habits=习惯打卡, ledger=记账, drama=追剧 */
export type SectionType = "memos" | "plans" | "habits" | "ledger" | "drama";

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

/** 章节类型开关：整体关闭某类型（闪念/待办计划/习惯打卡/记账/追剧），该类型的所有章节不渲染 */
export interface TypeToggles {
  memos: boolean;
  plans: boolean;
  habits: boolean;
  ledger: boolean;
  drama: boolean;
}

/** 类型是否启用（undefined 视为启用） */
export function isTypeEnabled(settings: DaybookSettings, type: SectionType): boolean {
  return settings.typeEnabled?.[type] !== false;
}

/* ── AI 助手：第三方厂商预设 ──
   协议只有三种：OpenAI 兼容（多数国产厂商/Ollama）、Anthropic Messages、Gemini。
   厂商只提供默认地址与模型，用户可在设置里覆盖；留空 = 用预设。 */
export type AiProtocol = "openai" | "anthropic" | "gemini";
export type AiProviderId =
  | "deepseek" | "openai" | "qwen" | "moonshot" | "zhipu" | "openrouter"
  | "ollama" | "anthropic" | "gemini" | "custom";

export interface AiVendor {
  id: AiProviderId;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  keyHint: string;
}

export const AI_VENDORS: AiVendor[] = [
  { id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyHint: "sk-..." },
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyHint: "sk-..." },
  { id: "qwen", name: "通义千问（阿里云）", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", keyHint: "sk-..." },
  { id: "moonshot", name: "Kimi（月之暗面）", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", keyHint: "sk-..." },
  { id: "zhipu", name: "智谱 GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", keyHint: "API Key" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyHint: "sk-or-..." },
  { id: "ollama", name: "Ollama（本地）", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", keyHint: "本地可留空" },
  { id: "anthropic", name: "Anthropic Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-20241022", keyHint: "sk-ant-..." },
  { id: "gemini", name: "Google Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash", keyHint: "AIza..." },
  { id: "custom", name: "自定义（OpenAI 兼容）", protocol: "openai", baseUrl: "", model: "", keyHint: "API Key" },
];

export const DEFAULT_AI_PROVIDER: AiProviderId = "deepseek";

export function aiVendor(id: string | undefined): AiVendor {
  return AI_VENDORS.find(v => v.id === id) ?? AI_VENDORS[0];
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

/**
 * 计划视图的分组方式：
 * - created：按创建日期分天（新→旧），同一天的任务合进一张卡片
 * - due：按截止日期分桶（逾期 / 今天 / 明天 / 7 天内 / 以后 / 无截止日）
 * - priority：按优先级分四象限
 * - tag：按第一个有效标签分组
 */
export type PlanGroupBy = "created" | "due" | "priority" | "tag";

/** 计划视图的组内排序键（方向固定，不单独给开关） */
export type PlanSortKey = "created" | "due" | "priority" | "title";

/**
 * 阅读视图（计划章节）的视图偏好，持久化保存。
 * 只放真正接线的字段：筛选条件由 JournalView 按章节各自持有（视图内状态，不落盘）。
 */
export interface ReviewViewState {
  planGroupBy: PlanGroupBy;
  planSortBy: PlanSortKey;
  /** false（默认）= 隐藏整块已完成的任务，由顶栏「···」里的显示/隐藏已完成切换 */
  planShowDone: boolean;
  /** true（默认）= 显示任务的描述徽标与 #标签，由顶栏「···」里的显示/隐藏详细切换 */
  planShowDetail: boolean;
}

export interface DaybookSettings {
  openLocationDesktop: OpenLocation; // 桌面端打开位置（移动端固定主区新标签页）
  panels: PanelConfig[];      // 版块列表（每个版块含若干章节）
  diaryFolder: string;
  dateFormat: string;
  // v3.2 新增：记录体验升级
  customMoods: MoodOption[];    // 可长按编辑的心情列表（最多 8 个）
  quickTags: string[];          // 快捷标签（如 商业），点击追加 #标签
  memoSortOrder?: "newest" | "oldest"; // 闪念记录流排序（新→旧 / 旧→新）
  /** 追剧列表卡片字段显隐（缺省 = 全显示；入口在追剧页「···」→ 显示字段） */
  dramaFields?: Partial<Record<DramaFieldKey, boolean>>;
  // v3.3 新增：计划完成时间
  todoCompletedField: string;               // 勾选完成时写入任务末尾的行内字段名（如 完成于）
  todoCompletionDisplay: "duration" | "time" | "both"; // 已完成任务显示：耗时/完成时间/两者
  showMediumPriorityBadge: boolean;         // 是否显示普通等级（Ⅱ）徽标，默认隐藏
  reviewState: ReviewViewState;             // 计划视图偏好（分组 / 排序 / 已完成与详细的显隐）
  typeEnabled: TypeToggles;                 // 章节类型开关（闪念/待办计划/习惯打卡）
  habits?: LegacyHabitDef[];               // 仅作旧数据读取（v4.3 起习惯存 habits/*.md，迁移后清空）
  habitsMigratedV2?: boolean;              // 旧习惯数据已迁移为"每习惯一个 md 文件"
  // v4.4 新增：移动端完成反馈
  completionHaptic: boolean;   // 勾选待办 / 打卡达标时轻微震动
  completionSound: boolean;    // 同一时机播放完成音效
  // v4.7 界面状态
  lastSectionId?: string;           // 最近使用的章节（打开视图时恢复；章节失效时回退首个）
  // v5.0 数据存储位置（统一在设置页「数据存储」分组管理；空字符串 = 用默认值）
  habitsFolder?: string;            // 习惯文件夹；空 = <日记目录>/habits/<习惯名>.md
  ledgerFolder?: string;            // 记账数据文件夹（hledger journal）；默认 Daybook/记账
  ledgerFileExt?: string;           // 记账记录文件后缀（不带点）：journal / md / text；默认 md
  dramaFolder?: string;             // 追剧数据文件夹；空 = <日记目录>/drama
  ledgerMigratedV2?: boolean;       // 旧 records-YYYY.json 已迁移为 hledger journal（一次性）
  // v6.1 数据根统一 Daybook/ + 各类型属性中文化（均为一次性迁移旗标）
  rootFolderMigratedV1?: boolean;   // 旧数据目录（Daily/ 等）已整体迁入 Daybook/
  dramaMigratedV2?: boolean;        // 追剧 shows.json 已迁移为 shows.md（一次性）
  habitKeysMigratedV1?: boolean;    // 习惯 frontmatter 英文键已改写为中文键（一次性）
  // v6 AI 助手（页内聊天，帮助写入各类型源文件）
  aiProvider?: AiProviderId;        // 厂商预设；缺省 DeepSeek
  aiBaseUrl?: string;               // 覆盖厂商默认地址；空 = 用预设
  aiModel?: string;                 // 覆盖厂商默认模型；空 = 用预设
  aiApiKey?: string;                // 第三方 API Key（存在 data.json 内，仅本机）
}

/** 数据根与记账默认（所有类型默认目录统一在 Daybook/ 下） */
export const DEFAULT_DIARY_FOLDER = "Daybook";
export const DEFAULT_LEDGER_FOLDER = "Daybook/记账";
export const DEFAULT_LEDGER_EXT = "md";

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
  ],
  diaryFolder: DEFAULT_DIARY_FOLDER,
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
  todoCompletedField: "完成于",
  todoCompletionDisplay: "both",
  showMediumPriorityBadge: false,
  reviewState: {
    planGroupBy: "created",
    planSortBy: "priority",
    planShowDone: false,
    planShowDetail: true,
  },
  typeEnabled: {
    memos: true,
    plans: true,
    habits: true,
    ledger: true,
    drama: true,
  },
  completionHaptic: true,
  completionSound: true,
  habitsFolder: "",
  ledgerFolder: DEFAULT_LEDGER_FOLDER,
  ledgerFileExt: DEFAULT_LEDGER_EXT,
  dramaFolder: "",
  aiProvider: DEFAULT_AI_PROVIDER,
  aiBaseUrl: "",
  aiModel: "",
  aiApiKey: "",
};

/** 心情数量上限（一行 4 个，最多两行） */
export const MAX_CUSTOM_MOODS = 8;

/** 章节数量上限 */
export const MAX_SECTIONS = 8;

/** 章节类型信息 */
export const SECTION_TYPE_INFO: Record<SectionType, { label: string; emoji: string; desc: string }> = {
  memos: { label: "闪念", emoji: "⚡", desc: "快速记录，支持加粗/删除线/双链/图片/标签" },
  plans: { label: "待办计划", emoji: "\u{1F4C5}", desc: "待办输入 + 日期提取 + 优先级 + 子任务" },
  habits: { label: "习惯打卡", emoji: "\u{1F4A7}", desc: "每习惯一个 md（默认 Daybook/habits/习惯名.md，可手动编辑）· 详情页含打卡月历 + 周/月/年趋势图" },
  ledger: { label: "记账", emoji: "\u{1F4B0}", desc: "记一笔/视图/资产/预算/统计/报表/设置 七页 · 数据存 hledger journal（默认 Daybook/记账/，后缀可在设置中改）" },
  drama: { label: "追剧", emoji: "\u{1F4FA}", desc: "剧集卡片列表 + 页内编辑 · 数据存 Daybook/drama/shows.md（中文键值 + 笔记区，不写日记正文）" },
};

/** 删除确认弹窗（设置页自带轻量版，避免与 TodayPanel 形成循环导入） */
class SettingsConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmText: string,
    private onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("db-set-confirm");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message });
    const btns = contentEl.createDiv({ cls: "db-set-confirm-btns" });
    btns.createEl("button", { text: "取消", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    btns.createEl("button", { text: this.confirmText, cls: "mod-warning", attr: { type: "button" } })
      .addEventListener("click", () => { this.close(); this.onConfirm(); });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 单行输入弹窗（重命名版块等） */
class TextInputModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private value: string,
    private placeholder: string,
    private onConfirm: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("db-set-confirm");
    contentEl.createEl("h3", { text: this.title });
    const input = contentEl.createEl("input", {
      cls: "db-set-input",
      attr: { type: "text", placeholder: this.placeholder, "aria-label": this.title },
    });
    input.value = this.value;
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.onConfirm(v);
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    const btns = contentEl.createDiv({ cls: "db-set-confirm-btns" });
    btns.createEl("button", { text: "取消", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    btns.createEl("button", { text: "确定", cls: "mod-cta", attr: { type: "button" } })
      .addEventListener("click", submit);
    activeWindow.setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 设置页 v2：iOS 分组式（Settings.app 的语言）。
 * 4 个常显分组，不再「藏进可折叠卡片」；版块/章节用两级手风琴就地编辑；
 * 窄屏（手机）下所有 Setting 行自动竖排、控件全宽（CSS @media ≤620px）。
 */
export class DaybookSettingTab extends PluginSettingTab {
  plugin: DaybookPlugin;

  constructor(app: App, plugin: DaybookPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /* ── 通用构件 ── */

  /** 分组：图标 + 标题 + 圆角容器；返回内容区 */
  private group(parent: HTMLElement, title: string, icon: string): HTMLElement {
    const g = parent.createDiv({ cls: "db-set-group" });
    const head = g.createDiv({ cls: "db-set-group-head" });
    const ic = head.createDiv({ cls: "db-set-group-icon" });
    setIcon(ic, icon);
    head.createSpan({ cls: "db-set-group-title", text: title });
    return g.createDiv({ cls: "db-set-group-body" });
  }

  /** 胶囊开关按钮（可见/隐藏、展开/收起）；点击不触发所在行 */
  private pill(parent: HTMLElement, text: string, on: boolean, onClick: () => void): HTMLElement {
    const p = parent.createEl("button", {
      cls: `db-set-pill ${on ? "on" : "off"}`,
      text, attr: { type: "button" },
    });
    p.addEventListener("click", e => { e.stopPropagation(); onClick(); });
    return p;
  }

  /** 竖排字段：小标签 + 全宽控件（+ 可选提示）；返回控件容器 */
  private field(parent: HTMLElement, label: string, hint?: string): HTMLElement {
    const f = parent.createDiv({ cls: "db-set-field" });
    f.createEl("label", { cls: "db-set-field-label", text: label });
    const ctl = f.createDiv({ cls: "db-set-field-ctl" });
    if (hint) f.createDiv({ cls: "db-set-field-hint", text: hint });
    return ctl;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("db-settings-v2");
    const root = containerEl.createDiv({ cls: "db-set-root" });

    const save = () => this.plugin.saveSettings();
    const refreshView = () => {
      const view = this.plugin.getJournalView();
      if (view) view.buildUI();
    };
    const reopenView = async () => {
      await save();
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
      if (existing) { existing.detach(); await this.plugin.activateView(); }
    };

    /* ══ 分组 1：通用 ══ */
    const gGeneral = this.group(root, "通用", "settings");

    new Setting(gGeneral)
      .setName("桌面端打开位置")
      .setDesc("仅桌面端；手机端固定为主窗口")
      .addDropdown(dropdown => dropdown
        .addOption("left", "左侧边栏")
        .addOption("main", "主窗口（新标签页）")
        .addOption("right", "右侧边栏")
        .setValue(this.plugin.settings.openLocationDesktop)
        .onChange(async value => {
          this.plugin.settings.openLocationDesktop = value as OpenLocation;
          await reopenView();
        }));

    /* ══ 分组 1.5：数据存储（各模块文件夹统一在此管理） ══ */
    const gStorage = this.group(root, "数据存储", "folder");
    gStorage.createDiv({
      cls: "db-settings-hint",
      text: "各类型默认目录统一在 Daybook/ 下；存储格式、路径变量与迁移说明见 README。",
    });

    new Setting(gStorage)
      .setName("日记文件夹（闪念 / 计划默认位置）")
      .setDesc("闪念/计划存放的文件夹")
      .addText(text => text
        .setPlaceholder("Daybook（默认）")
        .setValue(this.plugin.settings.diaryFolder)
        .onChange(async (value) => {
          this.plugin.settings.diaryFolder = value.trim();
          await save();
        }));

    new Setting(gStorage)
      .setName("日期格式（日记文件名）")
      .setDesc("日记文件名的日期格式")
      .addText(text => text
        .setPlaceholder("YYYY-MM-DD（默认）")
        .setValue(this.plugin.settings.dateFormat)
        .onChange(async (value) => {
          this.plugin.settings.dateFormat = value.trim() || "YYYY-MM-DD";
          await save();
        }));

    new Setting(gStorage)
      .setName("习惯文件夹")
      .setDesc("每习惯一个 md，可手动编辑")
      .addText(text => text
        .setPlaceholder("Daybook/habits（默认）")
        .setValue(this.plugin.settings.habitsFolder ?? "")
        .onChange(async (value) => {
          this.plugin.settings.habitsFolder = value.trim();
          await save();
        }));

    new Setting(gStorage)
      .setName("记账文件夹（hledger）")
      .setDesc("记账记录（hledger journal）")
      .addText(text => text
        .setPlaceholder("Daybook/记账（默认）")
        .setValue(this.plugin.settings.ledgerFolder ?? "")
        .onChange(async (value) => {
          this.plugin.settings.ledgerFolder = value.trim();
          await save();
        }));

    new Setting(gStorage)
      .setName("记账记录文件后缀")
      .setDesc("按年分文件，如 2026.md")
      .addDropdown(dropdown => dropdown
        .addOption("md", "md（Obsidian 笔记）")
        .addOption("journal", "journal（hledger 标准）")
        .addOption("text", "text（纯文本）")
        .setValue(this.plugin.settings.ledgerFileExt ?? DEFAULT_LEDGER_EXT)
        .onChange(async value => {
          this.plugin.settings.ledgerFileExt = value;
          await save();
        }));

    new Setting(gStorage)
      .setName("追剧文件夹")
      .setDesc("追剧数据与封面")
      .addText(text => text
        .setPlaceholder("Daybook/drama（默认）")
        .setValue(this.plugin.settings.dramaFolder ?? "")
        .onChange(async (value) => {
          this.plugin.settings.dramaFolder = value.trim();
          await save();
        }));

    /* ══ 分组 1.8：AI 助手 ══ */
    const gAi = this.group(root, "AI 助手", "sparkles");
    gAi.createDiv({
      cls: "db-settings-hint",
      text: "入口在章节顶栏「···」→ AI 助手：写入先确认后落盘，查询只读。详见 README。",
    });

    let aiBaseText: TextComponent | null = null;
    let aiModelText: TextComponent | null = null;
    let aiKeyText: TextComponent | null = null;
    const aiHint = gAi.createDiv({ cls: "db-settings-hint" });
    const refreshAiHint = () => {
      const vendor = aiVendor(this.plugin.settings.aiProvider);
      const proto = vendor.protocol === "openai"
        ? "OpenAI 兼容"
        : vendor.protocol === "anthropic" ? "Anthropic Messages" : "Gemini";
      aiHint.setText(`协议：${proto}。地址 / 模型留空时使用 ${vendor.name} 的默认值${vendor.baseUrl ? `（${vendor.baseUrl}）` : ""}。`);
      aiBaseText?.setPlaceholder(vendor.baseUrl || "https://...");
      aiModelText?.setPlaceholder(vendor.model || "模型名");
      aiKeyText?.setPlaceholder(vendor.keyHint);
    };

    new Setting(gAi)
      .setName("厂商")
      .setDesc("选「自定义」时需填地址与模型")
      .addDropdown(dropdown => {
        AI_VENDORS.forEach(v => dropdown.addOption(v.id, v.name));
        dropdown
          .setValue(this.plugin.settings.aiProvider ?? DEFAULT_AI_PROVIDER)
          .onChange(async value => {
            this.plugin.settings.aiProvider = value as AiProviderId;
            await save();
            refreshAiHint();
          });
      });

    new Setting(gAi)
      .setName("API 地址")
      .setDesc("留空 = 用厂商默认地址")
      .addText(text => {
        aiBaseText = text;
        text
          .setValue(this.plugin.settings.aiBaseUrl ?? "")
          .onChange(async value => {
            this.plugin.settings.aiBaseUrl = value.trim();
            await save();
          });
      });

    new Setting(gAi)
      .setName("模型")
      .setDesc("留空 = 用厂商默认模型")
      .addText(text => {
        aiModelText = text;
        text
          .setValue(this.plugin.settings.aiModel ?? "")
          .onChange(async value => {
            this.plugin.settings.aiModel = value.trim();
            await save();
          });
      });

    new Setting(gAi)
      .setName("API Key")
      .setDesc("保存在本仓库 data.json")
      .addText(text => {
        aiKeyText = text;
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.aiApiKey ?? "")
          .onChange(async value => {
            this.plugin.settings.aiApiKey = value.trim();
            await save();
          });
      });

    new Setting(gAi)
      .setName("连接测试")
      .setDesc("用当前配置发一次最小请求")
      .addButton(btn => btn
        .setButtonText("测试")
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("测试中…");
          try {
            const reply = await testAiConnection(this.plugin.settings);
            new Notice(`✅ 连接成功：${reply.slice(0, 40)}`);
          } catch (e) {
            new Notice(`❌ ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText("测试");
          }
        }));

    refreshAiHint();

    /* ══ 分组 2：版块与章节 ══ */
    const gPanels = this.group(root, "版块与章节", "layers");
    gPanels.createDiv({
      cls: "db-settings-hint",
      text: "版块＝主界面左上角的入口分组；章节＝进入后可切换的记录页。",
    });

    const TYPE_TOGGLES: { key: SectionType; label: string; desc: string }[] = [
      { key: "memos", label: "⚡ 闪念类型", desc: "关闭后隐藏所有闪念章节及其记录" },
      { key: "plans", label: "📅 待办计划类型", desc: "关闭后隐藏所有计划章节及其任务" },
      { key: "habits", label: "💧 习惯打卡类型", desc: "关闭后隐藏所有习惯章节" },
      { key: "ledger", label: "💰 记账类型", desc: "关闭后隐藏所有记账章节" },
      { key: "drama", label: "\u{1F4FA} 追剧类型", desc: "关闭后隐藏所有追剧章节" },
    ];
    TYPE_TOGGLES.forEach(({ key, label, desc }) => {
      new Setting(gPanels)
        .setName(label)
        .setDesc(desc)
        .addToggle(toggle => toggle
          .setValue(isTypeEnabled(this.plugin.settings, key))
          .onChange(async value => {
            this.plugin.settings.typeEnabled[key] = value;
            await save();
            refreshView();
          }));
    });

    const panelList = gPanels.createDiv({ cls: "db-set-list" });
    const totalSections = () => this.plugin.settings.panels.reduce((n, p) => n + p.sections.length, 0);

    /* 章节编辑弹层：字段竖排、即时保存；类型切换时重建表单（决定文件路径 / 心情条是否显示） */
    const openSectionSheet = (panel: PanelConfig, sec: SectionConfig) => {
      const sheet = new Modal(this.app);
      sheet.modalEl.addClass("db-sheet");

      const renderSheet = () => {
        const { contentEl } = sheet;
        contentEl.empty();
        const head = contentEl.createDiv({ cls: "db-sheet-head" });
        head.createSpan({ cls: "db-set-emoji", text: sec.emoji });
        const titleEl = head.createSpan({ cls: "db-sheet-title", text: `编辑章节 · ${sec.label}` });
        const closeBtn = head.createDiv({
          cls: "db-sheet-close",
          attr: { role: "button", tabindex: "0", "aria-label": "关闭" },
        });
        setIcon(closeBtn, "x");
        const closeSheet = () => sheet.close();
        closeBtn.addEventListener("click", closeSheet);
        closeBtn.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); closeSheet(); }
        });

        const body = contentEl.createDiv({ cls: "db-sheet-scroll" });

        // 名称 + 图标
        const row1 = body.createDiv({ cls: "db-set-field-row" });
        const labelCtl = this.field(row1, "名称");
        const labelInput = labelCtl.createEl("input", {
          cls: "db-set-input", attr: { type: "text", "aria-label": "章节名称" },
        });
        labelInput.value = sec.label;
        labelInput.addEventListener("change", async () => {
          const v = labelInput.value.trim();
          if (!v) { labelInput.value = sec.label; return; }
          sec.label = v;
          titleEl.setText(`编辑章节 · ${sec.label}`);
          await save(); renderPanels(); refreshView();
        });
        const emojiCtl = this.field(row1, "图标");
        const emojiInput = emojiCtl.createEl("input", {
          cls: "db-set-input", attr: { type: "text", maxlength: "4", "aria-label": "章节图标" },
        });
        emojiInput.value = sec.emoji;
        emojiInput.addEventListener("change", async () => {
          const v = emojiInput.value.trim();
          if (!v) { emojiInput.value = sec.emoji; return; }
          sec.emoji = v;
          await save(); renderPanels(); refreshView();
        });

        // 类型
        const typeCtl = this.field(body, "章节类型");
        const typeSelect = typeCtl.createEl("select", {
          cls: "db-set-input", attr: { "aria-label": "章节类型" },
        });
        (Object.entries(SECTION_TYPE_INFO) as [SectionType, typeof SECTION_TYPE_INFO[SectionType]][]).forEach(([key, info]) => {
          const opt = typeSelect.createEl("option", { value: key, text: `${info.emoji} ${info.label}` });
          if (sec.type === key) opt.setAttribute("selected", "selected");
        });
        typeSelect.addEventListener("change", async () => {
          sec.type = typeSelect.value as SectionType;
          await save(); renderPanels(); refreshView();
          renderSheet();
        });

        // 提示文字
        const phCtl = this.field(body, "输入框提示文字");
        const phInput = phCtl.createEl("input", {
          cls: "db-set-input", attr: { type: "text", "aria-label": "章节提示文字" },
        });
        phInput.value = sec.placeholder;
        phInput.addEventListener("change", async () => {
          sec.placeholder = phInput.value.trim() || "输入内容…";
          await save(); renderPanels(); refreshView();
        });

        // 文件路径（记账 / 追剧的数据在 记账/ 目录与 drama/shows.md，不走日记 md 文件路径）
        if (sec.type !== "ledger" && sec.type !== "drama") {
          const fpCtl = this.field(body, "文件路径",
            "支持 {日期} {年} 等变量与 {偏移:-1d}，完整写法见 README");
          const fpInput = fpCtl.createEl("input", {
            cls: "db-set-input db-set-input-mono",
            attr: { type: "text", placeholder: "Work/Notes/{日期}.md", "aria-label": "章节文件路径" },
          });
          fpInput.value = sec.filePath ?? "";
          fpInput.addEventListener("change", async () => {
            sec.filePath = fpInput.value.trim() || undefined;
            await save(); renderPanels(); refreshView();
          });
        }

        // 心情条默认状态（仅闪念）
        if (sec.type === "memos") {
          const moodCtl = this.field(body, "心情选择条");
          const moodPill = this.pill(moodCtl, sec.showMoodPicker !== false ? "默认展开" : "默认收起",
            sec.showMoodPicker !== false, async () => {
              sec.showMoodPicker = sec.showMoodPicker === false;
              const on = sec.showMoodPicker !== false;
              moodPill.setText(on ? "默认展开" : "默认收起");
              moodPill.toggleClass("on", on);
              moodPill.toggleClass("off", !on);
              await save(); refreshView();
            });
        }

        // 底部：删除（危险，二次确认）+ 完成
        const foot = contentEl.createDiv({ cls: "db-sheet-foot" });
        const del = foot.createEl("button", {
          cls: "db-sheet-del", text: "删除章节", attr: { type: "button", "aria-label": "删除章节" },
        });
        del.addEventListener("click", () => {
          new SettingsConfirmModal(this.app, "删除章节",
            `确定删除章节「${sec.emoji} ${sec.label}」吗？日记文件里已有的记录不受影响。`,
            "删除", () => {
              void (async () => {
                const idx = panel.sections.indexOf(sec);
                if (idx >= 0) panel.sections.splice(idx, 1);
                await save(); renderPanels(); refreshView();
                sheet.close();
              })();
            }).open();
        });
        const done = foot.createEl("button", {
          cls: "db-sheet-done", text: "完成", attr: { type: "button" },
        });
        done.addEventListener("click", closeSheet);
      };

      renderSheet();
      sheet.open();
    };

    /* ⋮ 版块菜单：重命名 / 上移 / 下移 / 删除（危险操作二次确认） */
    const showPanelMenu = (e: MouseEvent | KeyboardEvent, panel: PanelConfig, pi: number) => {
      const panels = this.plugin.settings.panels;
      const menu = new Menu();
      menu.addItem(item => item
        .setTitle("重命名版块")
        .setIcon("pencil")
        .onClick(() => {
          new TextInputModal(this.app, "重命名版块", panel.name, "版块名称", async v => {
            panel.name = v;
            await save(); renderPanels(); refreshView();
          }).open();
        }));
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle("上移")
        .setIcon("arrow-up")
        .setDisabled(pi === 0)
        .onClick(async () => {
          [panels[pi - 1], panels[pi]] = [panels[pi], panels[pi - 1]];
          await save(); renderPanels(); refreshView();
        }));
      menu.addItem(item => item
        .setTitle("下移")
        .setIcon("arrow-down")
        .setDisabled(pi === panels.length - 1)
        .onClick(async () => {
          [panels[pi + 1], panels[pi]] = [panels[pi], panels[pi + 1]];
          await save(); renderPanels(); refreshView();
        }));
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle("删除版块")
        .setIcon("trash-2")
        .onClick(() => {
          new SettingsConfirmModal(this.app, "删除版块",
            `确定删除版块「${panel.name}」吗？其中的 ${panel.sections.length} 个章节会一并移除（日记文件里的记录不受影响）。`,
            "删除", () => {
              void (async () => {
                panels.splice(pi, 1);
                await save(); renderPanels(); refreshView();
              })();
            }).open();
        }));
      if (e instanceof MouseEvent) menu.showAtMouseEvent(e);
      else {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
      }
    };

    /* ☰ 拖拽排序：pointer 拖动实时换位，松手后按 DOM 顺序重建数据（章节可跨版块拖动） */
    const makeDraggable = (row: HTMLElement, onDrop: () => void) => {
      const handle = row.createDiv({
        cls: "db-set-row-drag",
        attr: { "aria-label": "拖拽排序", title: "拖拽排序" },
      });
      setIcon(handle, "grip-vertical");
      handle.addEventListener("pointerdown", e => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        row.addClass("is-dragging");
        const rows = (): HTMLElement[] =>
          Array.from(panelList.querySelectorAll<HTMLElement>(":scope > .db-set-row"));
        const onMove = (ev: PointerEvent) => {
          const target = rows().find(r => {
            if (r === row) return false;
            const rect = r.getBoundingClientRect();
            return ev.clientY >= rect.top && ev.clientY < rect.bottom;
          });
          if (!target) return;
          const rect = target.getBoundingClientRect();
          let ref = ev.clientY >= rect.top + rect.height / 2 ? target.nextSibling : target;
          // 章节行不能拖到第一个版块行之前，否则无法确定归属
          if (row.classList.contains("db-set-row-sec")) {
            const firstPanel = panelList.querySelector<HTMLElement>(":scope > .db-set-row-panel");
            if (firstPanel && (ref === firstPanel ||
              (ref instanceof Element && firstPanel.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_PRECEDING))) {
              ref = firstPanel.nextSibling;
            }
          }
          panelList.insertBefore(row, ref);
        };
        const onUp = () => {
          row.removeClass("is-dragging");
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          onDrop();
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      });
    };

    /* 松手后按 DOM 顺序重建 panels / sections；遗漏的按原顺序补回，保证数据不丢 */
    const reorderFromDom = async () => {
      const panels = this.plugin.settings.panels;
      const panelOrder: PanelConfig[] = [];
      const buckets = new Map<PanelConfig, SectionConfig[]>();
      let cur: PanelConfig | null = null;
      for (const el of Array.from(panelList.children) as HTMLElement[]) {
        if (el.classList.contains("db-set-row-panel")) {
          const p = panels[Number(el.dataset.pi)];
          if (p && !buckets.has(p)) {
            cur = p;
            panelOrder.push(p);
            buckets.set(p, []);
          }
        } else if (el.classList.contains("db-set-row-sec") && cur) {
          const sec = panels[Number(el.dataset.pi)]?.sections[Number(el.dataset.si)];
          const bucket = buckets.get(cur)!;
          if (sec && !bucket.includes(sec)) bucket.push(sec);
        }
      }
      panels.forEach(p => {
        if (!buckets.has(p)) { panelOrder.push(p); buckets.set(p, [...p.sections]); }
        const bucket = buckets.get(p)!;
        p.sections.forEach(s => { if (!bucket.includes(s)) bucket.push(s); });
      });
      this.plugin.settings.panels = panelOrder;
      panelOrder.forEach(p => { p.sections = buckets.get(p) ?? []; });
      await save(); renderPanels(); refreshView();
    };

    const renderPanels = () => {
      panelList.empty();
      this.plugin.settings.panels.forEach((panel, pi) => {
        /* 版块行：整行点击弹 ⋮ 菜单，☰ 拖拽排序 */
        const prow = panelList.createDiv({ cls: "db-set-row db-set-row-panel" });
        prow.dataset.pi = String(pi);
        const pmain = prow.createDiv({
          cls: "db-set-row-main",
          attr: { role: "button", tabindex: "0", "aria-label": `版块 ${panel.name}，点击打开菜单` },
        });
        pmain.createSpan({ cls: "db-set-num", text: String(pi + 1) });
        pmain.createSpan({ cls: "db-set-item-title", text: panel.name });
        pmain.createSpan({
          cls: "db-set-item-sub",
          text: panel.sections.length === 1 ? "1 个章节" : `${panel.sections.length} 个章节`,
        });
        const pchev = pmain.createDiv({ cls: "db-set-item-chev" });
        setIcon(pchev, "more-horizontal");
        pmain.addEventListener("click", e => showPanelMenu(e, panel, pi));
        pmain.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showPanelMenu(e, panel, pi); }
        });
        makeDraggable(prow, () => void reorderFromDom());

        /* 章节行：点行打开编辑弹层，可见性胶囊就地切换 */
        panel.sections.forEach((sec, si) => {
          const srow = panelList.createDiv({ cls: "db-set-row db-set-row-sec" });
          srow.dataset.pi = String(pi);
          srow.dataset.si = String(si);
          const smain = srow.createDiv({
            cls: "db-set-row-main",
            attr: { role: "button", tabindex: "0", "aria-label": `编辑章节 ${sec.label}` },
          });
          smain.createSpan({ cls: "db-set-emoji", text: sec.emoji });
          smain.createSpan({ cls: "db-set-item-title", text: sec.label });
          smain.createSpan({ cls: "db-set-item-sub", text: SECTION_TYPE_INFO[sec.type].label });
          this.pill(smain, sec.enabled ? "可见" : "隐藏", sec.enabled, async () => {
            sec.enabled = !sec.enabled;
            await save(); renderPanels(); refreshView();
          });
          const schev = smain.createDiv({ cls: "db-set-item-chev" });
          setIcon(schev, "chevron-right");
          smain.addEventListener("click", () => openSectionSheet(panel, sec));
          smain.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSectionSheet(panel, sec); }
          });
          makeDraggable(srow, () => void reorderFromDom());
        });

        /* 添加章节行：点击创建并直接打开编辑弹层 */
        const full = totalSections() >= MAX_SECTIONS;
        const addRow = panelList.createDiv({ cls: `db-set-row db-set-row-add${full ? " is-disabled" : ""}` });
        addRow.setAttribute("aria-label", full ? `章节已达上限（${MAX_SECTIONS} 个）` : `在版块 ${panel.name} 中添加章节`);
        addRow.createSpan({ text: full ? `章节已达上限（${MAX_SECTIONS} 个）` : "+ 添加章节" });
        addRow.addEventListener("click", async () => {
          if (totalSections() >= MAX_SECTIONS) { new Notice(`最多 ${MAX_SECTIONS} 个章节`); return; }
          const sec: SectionConfig = {
            id: `custom-${Date.now()}`, emoji: "⚡", label: `新章节${panel.sections.length + 1}`,
            type: "memos", placeholder: "输入内容…", enabled: true, showMoodPicker: false,
          };
          panel.sections.push(sec);
          await save(); renderPanels(); refreshView();
          openSectionSheet(panel, sec);
        });
      });
    };

    renderPanels();

    // 添加版块
    const addPanelBtn = gPanels.createEl("button", {
      cls: "db-set-add db-set-add-outer",
      text: "+ 添加版块", attr: { type: "button", "aria-label": "添加版块" },
    });
    addPanelBtn.addEventListener("click", async () => {
      this.plugin.settings.panels.push({
        id: `panel-${Date.now()}`,
        name: `新版块${this.plugin.settings.panels.length + 1}`,
        sections: [{ id: `custom-${Date.now()}`, emoji: "⚡", label: "新章节1", type: "memos", placeholder: "输入内容…", enabled: true, showMoodPicker: false }],
      });
      await save(); renderPanels(); refreshView();
    });

    /* ══ 分组 3：记录体验 ══ */
    const gRecord = this.group(root, "记录体验", "sparkles");
    gRecord.createDiv({
      cls: "db-settings-hint",
      text: `自定义心情表情与含义，最多 ${MAX_CUSTOM_MOODS} 个；记录页长按心情也能直接编辑。`,
    });

    const moodList = gRecord.createDiv({ cls: "db-mood-editor" });
    const addMoodBtn = gRecord.createEl("button", {
      cls: "db-mood-add-btn", attr: { type: "button", "aria-label": "添加心情" },
    });

    const renderMoodEditor = () => {
      moodList.empty();
      this.plugin.settings.customMoods.forEach((mood, idx) => {
        const row = moodList.createDiv({ cls: "db-mood-edit-row" });
        const emojiInput = row.createEl("input", { cls: "db-mood-edit-emoji", attr: { type: "text", maxlength: "4", placeholder: "🙂", "aria-label": `心情 ${idx + 1} 表情` } });
        emojiInput.value = mood.emoji;
        const labelInput = row.createEl("input", { cls: "db-mood-edit-label", attr: { type: "text", placeholder: "含义，如：思考", "aria-label": `心情 ${idx + 1} 含义` } });
        labelInput.value = mood.label;
        emojiInput.addEventListener("change", async () => {
          const v = emojiInput.value.trim();
          if (v) { mood.emoji = v; await save(); refreshView(); }
        });
        labelInput.addEventListener("change", async () => {
          const v = labelInput.value.trim();
          if (v) { mood.label = v; await save(); refreshView(); }
        });
        const del = row.createDiv({ cls: "db-mood-edit-del", text: "×", attr: { role: "button", "aria-label": `删除心情 ${mood.label}`, tabindex: "0" } });
        const remove = async () => {
          this.plugin.settings.customMoods.splice(idx, 1);
          await save(); renderMoodEditor(); refreshView();
        };
        del.addEventListener("click", () => void remove());
        del.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void remove(); } });
      });
      const full = this.plugin.settings.customMoods.length >= MAX_CUSTOM_MOODS;
      addMoodBtn.toggleClass("is-disabled", full);
      addMoodBtn.setText(full ? `已达上限（${MAX_CUSTOM_MOODS} 个）` : "+ 添加心情");
    };
    addMoodBtn.addEventListener("click", async () => {
      if (this.plugin.settings.customMoods.length >= MAX_CUSTOM_MOODS) {
        new Notice(`最多 ${MAX_CUSTOM_MOODS} 个心情`);
        return;
      }
      this.plugin.settings.customMoods.push({ emoji: "🙂", label: "心情" });
      await save(); renderMoodEditor(); refreshView();
    });
    renderMoodEditor();

    new Setting(gRecord)
      .setName("快捷标签")
      .setDesc("记录页一键追加的 #标签")
      .addText(text => text
        .setPlaceholder("工作, 灵感, 读书")
        .setValue(this.plugin.settings.quickTags.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.quickTags = value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
          await save();
        }));

    /* ══ 分组 4：计划与反馈 ══ */
    const gPlan = this.group(root, "计划与反馈", "check-circle");

    new Setting(gPlan)
      .setName("完成时间字段名")
      .setDesc("勾选完成时写入的行内字段")
      .addText(text => text
        .setPlaceholder("完成于（默认）")
        .setValue(this.plugin.settings.todoCompletedField)
        .onChange(async (value) => {
          this.plugin.settings.todoCompletedField = value.trim() || DEFAULT_SETTINGS.todoCompletedField;
          await save();
        }));

    new Setting(gPlan)
      .setName("已完成任务显示")
      .setDesc("已完成的计划后面显示的完成信息")
      .addDropdown(dropdown => dropdown
        .addOption("duration", "完成耗时")
        .addOption("time", "完成时间")
        .addOption("both", "两者都显示")
        .setValue(this.plugin.settings.todoCompletionDisplay)
        .onChange(async value => {
          this.plugin.settings.todoCompletionDisplay = value as typeof this.plugin.settings.todoCompletionDisplay;
          await save();
          refreshView();
        }));

    new Setting(gPlan)
      .setName("显示 2 级优先级徽标")
      .setDesc("开启后 2 级计划也显示橙色 Ⅱ 徽标")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showMediumPriorityBadge)
        .onChange(async value => {
          this.plugin.settings.showMediumPriorityBadge = value;
          await save();
          refreshView();
        }));

    gPlan.createDiv({
      cls: "db-settings-hint",
      text: "以下完成反馈仅手机端生效。",
    });

    new Setting(gPlan)
      .setName("完成时震动")
      .setDesc("点击完成的瞬间轻微震动")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.completionHaptic)
        .onChange(async value => {
          this.plugin.settings.completionHaptic = value;
          await save();
        }));

    new Setting(gPlan)
      .setName("完成时播放音效")
      .setDesc("与震动同时播放「完成音效」")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.completionSound)
        .onChange(async value => {
          this.plugin.settings.completionSound = value;
          await save();
        }));
  }
}
