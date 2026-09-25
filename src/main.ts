import { Notice, Plugin, Platform } from "obsidian";
import { DaybookView, VIEW_TYPE_JOURNAL } from "./JournalView";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";
import {
  DaybookSettings,
  DaybookSettingTab,
  DEFAULT_SETTINGS,
  type PanelConfig,
} from "./settings";
import { migrateLegacyHabits } from "./habitManager";
import { CompletionFeedback } from "./feedback";

export default class DaybookPlugin extends Plugin {
  settings: DaybookSettings = DEFAULT_SETTINGS;
  /** 移动端勾选待办 / 打卡达标时的震动 + 音效反馈 */
  readonly feedback = new CompletionFeedback(() => this.settings);

  async onload() {
    await this.loadSettings();

    // 旧习惯数据（data.json 定义 + _habits.md 记录）→ 每习惯一个 md 文件（一次性）
    try {
      const changed = await migrateLegacyHabits(this.app, this.settings);
      if (changed) await this.saveSettings();
    } catch (e) {
      console.error("Daybook: 习惯数据迁移失败", e);
      new Notice("习惯数据迁移失败，不影响其他功能");
    }

    this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new DaybookView(leaf, this));
    this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this));

    this.addRibbonIcon("book-open", "Daybook", () => {
      this.activateView();
    });

    this.addSettingTab(new DaybookSettingTab(this.app, this));

    this.addCommand({
      id: "open-daybook",
      name: "打开 Daybook",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-dashboard",
      name: "打开 Dashboard",
      callback: () => this.activateDashboard(),
    });
  }

  async loadSettings() {
    const loaded = await this.loadData();
    // 迁移：旧 openLocation → openLocationDesktop
    //（需在合并进 settings 前处理：首次安装时 loaded 为 null）
    if (loaded?.openLocation && !loaded.openLocationDesktop) {
      loaded.openLocationDesktop = loaded.openLocation;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.settings.typeEnabled = Object.assign({}, DEFAULT_SETTINGS.typeEnabled, loaded?.typeEnabled ?? {});
    // 旧 habits（data.json 定义）仅作迁移读取；形状异常直接丢弃
    if (this.settings.habits && !Array.isArray(this.settings.habits)) {
      this.settings.habits = [];
    }
    if (this.settings.typeEnabled.habits === undefined) {
      this.settings.typeEnabled.habits = true;
    }
    // 迁移：旧 sections + plansDisplay → 新 panels
    if ((loaded as any)?.sections && !this.settings.panels) {
      const oldSections = (loaded as any).sections as any[];
      const oldPlansDisplay = (loaded as any).plansDisplay ?? "separate";
      if (oldPlansDisplay === "separate") {
        // 计划独立成版块，其余放「记录」版块
        const memos = oldSections.filter(s => s.type !== "plans");
        const plans = oldSections.filter(s => s.type === "plans");
        this.settings.panels = [];
        if (memos.length > 0) {
          this.settings.panels.push({ id: "record", name: "记录", sections: memos });
        }
        if (plans.length > 0) {
          this.settings.panels.push({ id: "plans", name: "计划", sections: plans });
        }
      } else {
        // 全部放一个版块
        this.settings.panels = [{ id: "record", name: "记录", sections: oldSections }];
      }
      await this.saveSettings();
    }
    // 确保 panels 存在且形状合法（旧/损坏的 data.json 可能缺 sections，会让视图渲染崩溃）
    const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS.panels)) as PanelConfig[];
    if (!Array.isArray(this.settings.panels) || this.settings.panels.length === 0) {
      this.settings.panels = cloneDefaults();
    } else {
      this.settings.panels.forEach(p => { if (!Array.isArray(p.sections)) p.sections = []; });
      this.settings.panels = this.settings.panels.filter(p => p.sections.length > 0);
      if (this.settings.panels.length === 0) this.settings.panels = cloneDefaults();
    }
    if (!Array.isArray(this.settings.expenseCategories)) {
      this.settings.expenseCategories = [...DEFAULT_SETTINGS.expenseCategories];
    }
    // 迁移：老用户一次性追加默认「记账」版块（之后用户删掉不会再出现）
    if (!loaded?.expensesAddedV1) {
      const hasExpenses = this.settings.panels.some(p => p.sections.some(s => s.type === "expenses"));
      if (!hasExpenses) {
        const defaults = cloneDefaults();
        const expensePanel = defaults.find(p => p.id === "expenses");
        if (expensePanel) this.settings.panels.push(expensePanel);
      }
      this.settings.expensesAddedV1 = true;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 获取当前打开的 JournalView 实例 */
  getJournalView(): DaybookView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
    if (leaf && leaf.view instanceof DaybookView) return leaf.view;
    return null;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
    if (!leaf) {
      // 移动端抽屉侧栏放自定义视图不可靠（可能看不见，表现为"点了没反应"），
      // 统一在主区新标签页打开；桌面端尊重用户设置。
      const loc = Platform.isMobile ? "main" : this.settings.openLocationDesktop;
      if (loc === "left") {
        leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
      } else if (loc === "right") {
        leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      } else {
        leaf = workspace.getLeaf(true);
      }
      try {
        await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
      } catch (e) {
        new Notice("Daybook 打开失败：" + (e instanceof Error ? e.message : String(e)));
        throw e;
      }
    }
    workspace.revealLeaf(leaf);
  }

  /** 激活 Dashboard 视图 */
  async activateDashboard() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
