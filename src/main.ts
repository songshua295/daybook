import { Notice, Plugin, Platform } from "obsidian";
import { DaybookView, VIEW_TYPE_JOURNAL } from "./JournalView";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";
import {
  DaybookSettings,
  DaybookSettingTab,
  DEFAULT_SETTINGS,
  type PanelConfig,
  type PlanGroupBy,
  type PlanSortKey,
  type ReviewViewState,
} from "./settings";
import { migrateLegacyHabits, migrateHabitKeys } from "./habitManager";
import { migrateStorageRoot } from "./fileManager";
import { migrateDramaJsonToMd } from "./dramaStore";
import { CompletionFeedback } from "./feedback";
import { installFloatingField } from "./floatField";

export default class DaybookPlugin extends Plugin {
  settings: DaybookSettings = DEFAULT_SETTINGS;
  /** 移动端勾选待办 / 打卡达标时的震动 + 音效反馈 */
  readonly feedback = new CompletionFeedback(() => this.settings);

  async onload() {
    await this.loadSettings();

    // 数据根迁移：旧目录（Daily/ 等）整体迁入 Daybook/（一次性，最先执行）
    try {
      const changed = await migrateStorageRoot(this.app, this.settings);
      if (changed) await this.saveSettings();
    } catch (e) {
      console.error("Daybook: 数据根迁移失败", e);
    }

    // 旧习惯数据（data.json 定义 + _habits.md 记录）→ 每习惯一个 md 文件（一次性）
    try {
      const changed = await migrateLegacyHabits(this.app, this.settings);
      if (changed) await this.saveSettings();
    } catch (e) {
      console.error("Daybook: 习惯数据迁移失败", e);
      new Notice("习惯数据迁移失败，不影响其他功能");
    }

    // 追剧 shows.json → shows.md（一次性）
    try {
      const changed = await migrateDramaJsonToMd(this.app, this.settings);
      if (changed) await this.saveSettings();
    } catch (e) {
      console.error("Daybook: 追剧数据迁移失败", e);
    }

    // 习惯 frontmatter 英文键 → 中文键（一次性）
    try {
      const changed = await migrateHabitKeys(this.app, this.settings);
      if (changed) await this.saveSettings();
    } catch (e) {
      console.error("Daybook: 习惯属性中文化迁移失败", e);
      new Notice("习惯属性中文化迁移失败，不影响其他功能");
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

    this.addCommand({
      id: "open-ai-assistant",
      name: "打开 AI 助手",
      callback: () => {
        const view = this.getJournalView();
        if (view) { view.openAiPage(); return; }
        void this.activateView().then(() => this.getJournalView()?.openAiPage());
      },
    });

    // 移动端键盘避让悬浮编辑（Notion 式）：聚焦文本字段会被键盘盖住时，
    // 字段悬浮到键盘顶上方 8px；已在键盘上方则保持原位。详见 src/floatField.ts。
    installFloatingField(this);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    // 迁移：旧 openLocation → openLocationDesktop
    //（需在合并进 settings 前处理：首次安装时 loaded 为 null）
    if (loaded?.openLocation && !loaded.openLocationDesktop) {
      loaded.openLocationDesktop = loaded.openLocation;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // 迁移：未定制过的旧默认心情列表 → 新默认八项（用户改过则保持不动）
    const LEGACY_MOODS = "😄|开心,😐|平静,😫|疲惫,😰|焦虑,😞|难过,😮|吃惊,🤩|兴奋,🥰|感恩";
    const currentMoods = (this.settings.customMoods ?? [])
      .map(m => `${m.emoji}|${m.label}`).join(",");
    if (currentMoods === LEGACY_MOODS) {
      this.settings.customMoods = DEFAULT_SETTINGS.customMoods.map(m => ({ ...m }));
      await this.saveSettings();
    }
    // 迁移：完成时间字段名旧默认 completedAt → 完成于（用户自定义过其他值则保持不动）
    if (this.settings.todoCompletedField === "completedAt") {
      this.settings.todoCompletedField = DEFAULT_SETTINGS.todoCompletedField;
    }
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
    // 清理：记账类型已移除，剥掉历史数据里的记账章节/空版块与相关字段
    // （字段已从类型定义删除，这里用宽松类型访问旧数据.json 里的残留键）
    const legacy = this.settings as unknown as Record<string, unknown>;
    let dirty = false;
    if (Array.isArray(this.settings.panels)) {
      const before = this.settings.panels.length;
      this.settings.panels.forEach(p => {
        const n = p.sections.length;
        p.sections = p.sections.filter(sc => String(sc.type) !== "expenses");
        if (p.sections.length !== n) dirty = true;
      });
      this.settings.panels = this.settings.panels.filter(p => p.sections.length > 0);
      if (this.settings.panels.length !== before) dirty = true;
      if (this.settings.panels.length === 0) { this.settings.panels = cloneDefaults(); dirty = true; }
    }
    if ("expenseCategories" in legacy) { delete legacy.expenseCategories; dirty = true; }
    if ("expensesAddedV1" in legacy) { delete legacy.expensesAddedV1; dirty = true; }
    const typeEnabled = this.settings.typeEnabled as unknown as Record<string, unknown> | undefined;
    if (typeEnabled && "expenses" in typeEnabled) {
      delete typeEnabled.expenses;
      dirty = true;
    }
    if (dirty) await this.saveSettings();

    // 注入：记账（ledger）章节。旧版曾移除过「expenses」记账类型，这里用新类型 id +
    // ledgerPanelAddedV1 守卫，只注入一次，不与上面的旧数据清理互相打架。
    const flags = this.settings as unknown as Record<string, unknown>;
    const hasLedger = this.settings.panels.some(p => p.sections.some(s => s.type === "ledger"));
    if (!flags.ledgerPanelAddedV1 && !hasLedger) {
      this.settings.panels.push({
        id: "ledger", name: "记账",
        sections: [{ id: "ledger", emoji: "💰", label: "记账", type: "ledger", placeholder: "", enabled: true }],
      });
      flags.ledgerPanelAddedV1 = true;
      await this.saveSettings();
    }

    // 注入：追剧（drama）章节。同记账一套守卫：只注入一次，用户删掉后不再自动加回。
    const hasDrama = this.settings.panels.some(p => p.sections.some(s => s.type === "drama"));
    if (!flags.dramaPanelAddedV1 && !hasDrama) {
      this.settings.panels.push({
        id: "drama", name: "追剧",
        sections: [{ id: "drama", emoji: "\u{1F4FA}", label: "追剧", type: "drama", placeholder: "", enabled: true }],
      });
      flags.dramaPanelAddedV1 = true;
      await this.saveSettings();
    }

    // 计划视图偏好：浅合并会让旧的 reviewState 整体覆盖新默认值（新字段变 undefined），
    // 所以这里单独深合并一份，再把旧版本的分组/排序取值映射过来。
    // 顺带清掉从未接线的遗留键（groupVisible / filterCompletion / groupOrder …）。
    const rawRs = (loaded?.reviewState ?? {}) as unknown as Record<string, unknown>;
    // 旧「平铺」＝按创建日期分天；旧「date」＝按截止日期分桶
    const groupMap: Record<string, PlanGroupBy> = {
      none: "created", date: "due", priority: "priority", tag: "tag",
      created: "created",
    };
    const sortMap: Record<string, PlanSortKey> = {
      time: "created", created: "created", due: "due", priority: "priority", title: "title",
    };
    const dft = DEFAULT_SETTINGS.reviewState;
    const migrated: ReviewViewState = {
      planGroupBy: groupMap[String(rawRs.planGroupBy ?? "")] ?? dft.planGroupBy,
      planSortBy: sortMap[String(rawRs.planSortBy ?? "")] ?? dft.planSortBy,
      planShowDone: typeof rawRs.planShowDone === "boolean" ? rawRs.planShowDone : dft.planShowDone,
      planShowDetail: typeof rawRs.planShowDetail === "boolean" ? rawRs.planShowDetail : dft.planShowDetail,
    };
    this.settings.reviewState = migrated;
    if (JSON.stringify(rawRs) !== JSON.stringify(migrated)) await this.saveSettings();
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

  /** Dashboard：在日记视图内部以"下一页"形式打开（不新建标签页/leaf），
   *  日记页只隐藏不销毁，滚动位置与草稿原样保留；返回键揭开本页 */
  async activateDashboard() {
    const { workspace } = this.app;
    // 旧版独立 Dashboard 标签页（恢复的工作区里可能存在）：直接聚焦展示
    const legacy = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0];
    if (legacy) {
      workspace.revealLeaf(legacy);
      return;
    }
    let view = this.getJournalView();
    if (!view) {
      await this.activateView();
      view = this.getJournalView();
    }
    view?.openDashboard();
  }
}
