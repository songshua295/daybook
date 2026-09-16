import { Plugin, Platform } from "obsidian";
import { DaybookView, VIEW_TYPE_JOURNAL } from "./JournalView";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";
import {
  DaybookSettings,
  DaybookSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";

export default class DaybookPlugin extends Plugin {
  settings: DaybookSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

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

    console.log("Daybook 已加载");
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_JOURNAL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_DASHBOARD);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.settings.typeEnabled = Object.assign({}, DEFAULT_SETTINGS.typeEnabled, (loaded as any)?.typeEnabled ?? {});

    // 迁移：旧 openLocation → openLocationDesktop + openLocationMobile
    if ((loaded as any).openLocation && !loaded.openLocationDesktop) {
      loaded.openLocationDesktop = (loaded as any).openLocation;
      loaded.openLocationMobile = "main";
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
    // 确保 panels 存在
    if (!this.settings.panels || this.settings.panels.length === 0) {
      this.settings.panels = DEFAULT_SETTINGS.panels;
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
      const loc = Platform.isMobile ? this.settings.openLocationMobile : this.settings.openLocationDesktop;
      if (loc === "left") {
        leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
      } else if (loc === "right") {
        leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      } else {
        leaf = workspace.getLeaf(true);
      }
      await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, active: true });
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
