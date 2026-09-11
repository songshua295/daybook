import { Plugin } from "obsidian";
import { LifeJournalView, VIEW_TYPE_JOURNAL } from "./JournalView";
import {
  LifeJournalSettings,
  LifeJournalSettingTab,
  DEFAULT_SETTINGS,
  ThemeName,
  UIStyle,
} from "./settings";

export default class LifeJournalPlugin extends Plugin {
  settings: LifeJournalSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new LifeJournalView(leaf, this));

    this.addRibbonIcon("book-open", "Daybook · 记录即意义", () => {
      this.activateView();
    });

    this.addSettingTab(new LifeJournalSettingTab(this.app, this));

    // 应用风格 & 主题
    this.applyUIStyle();
    this.applyTheme();

    this.addCommand({
      id: "open-life-journal",
      name: "打开 Daybook",
      callback: () => this.activateView(),
    });

    console.log("Daybook v3.1.6 已加载 ✦");
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_JOURNAL);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.settings.typeEnabled = Object.assign({}, DEFAULT_SETTINGS.typeEnabled, (loaded as any)?.typeEnabled ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 应用 UI 风格（在 body 上切换 lj-style-xxx class） */
  applyUIStyle() {
    const body = document.body;
    const styles: UIStyle[] = ["minimal", "neon", "soft"];
    styles.forEach(s => body.removeClass(`lj-style-${s}`));
    body.addClass(`lj-style-${this.settings.uiStyle}`);
  }

  /** 应用配色皮肤（在 body 上切换 lj-theme-xxx class） */
  applyTheme() {
    const body = document.body;
    const themes: ThemeName[] = ["forest", "ocean", "desert", "cherry", "dusk", "midnight", "lavender", "matcha", "obsidian"];
    themes.forEach(t => body.removeClass(`lj-theme-${t}`));
    body.addClass(`lj-theme-${this.settings.theme}`);
  }

  /** 获取当前打开的 JournalView 实例 */
  getJournalView(): LifeJournalView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
    if (leaf && leaf.view instanceof LifeJournalView) return leaf.view;
    return null;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)[0];
    if (!leaf) {
      // 按设置决定打开位置：left=左侧边栏 / main=主窗口新标签页 / right=右侧边栏
      if (this.settings.openLocation === "left") {
        leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
      } else if (this.settings.openLocation === "right") {
        leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      } else {
        leaf = workspace.getLeaf(true);
      }
      await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
