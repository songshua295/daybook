import { App, setIcon } from "obsidian";
import type DaybookPlugin from "./main";

/**
 * 闪念编辑器增强：
 * - 格式化工具栏：加粗 / 删除线 / 双链 / 标签 / 图片
 * - 自动补全：输入 [[ 触发双链补全（vault 笔记），输入 # 触发标签补全
 * - 补全支持 ↑↓ 选择、Enter/Tab 应用、Esc 关闭、点击应用
 */

export interface MemoEditorOptions {
  toolbar?: boolean;                    // 是否渲染格式化工具栏
  toolbarSlot?: HTMLElement;            // 工具栏挂载点（缺省插入 wrap 顶部）
  imageInput?: HTMLInputElement | null; // 图片文件选择 input（工具栏图片按钮触发）
  onAudioToggle?: (btn: HTMLElement) => void; // 录音按钮回调
}

interface MemoSuggestion {
  kind: "link" | "tag"; // 补全类型（应用时决定回退扫描方式）
  label: string;        // 显示文字
  detail?: string;      // 次要说明（如所在文件夹）
  insert: string;       // 应用时插入的完整文本
}

/** 检测光标前的补全触发上下文：[[query（双链）或 #query（标签） */
function detectTrigger(
  text: string,
  caret: number
): { kind: "link" | "tag"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const linkMatch = before.match(/\[\[([^\[\]|]*)$/);
  if (linkMatch) {
    return { kind: "link", query: linkMatch[1], start: caret - linkMatch[1].length - 2 };
  }
  const tagMatch = before.match(/(?:^|[\s\u3000])#([^\s#]*)$/);
  if (tagMatch) {
    return { kind: "tag", query: tagMatch[1], start: caret - tagMatch[1].length - 1 };
  }
  return null;
}

export function attachMemoEditor(
  app: App,
  plugin: DaybookPlugin,
  textarea: HTMLTextAreaElement,
  wrap: HTMLElement,
  opts: MemoEditorOptions = {}
): void {
  if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";

  // ── 格式化工具栏 ──────────────────────────────
  if (opts.toolbar) {
    const tb = opts.toolbarSlot ?? wrap.createDiv();
    tb.empty();
    tb.addClass("db-memo-toolbar");

    const insertAtCaret = (t: string) => {
      const p = textarea.selectionStart;
      textarea.value = textarea.value.slice(0, p) + t + textarea.value.slice(textarea.selectionEnd);
      textarea.selectionStart = textarea.selectionEnd = p + t.length;
      textarea.focus();
      textarea.dispatchEvent(new Event("input"));
    };
    // 用 before/after 包裹选中文本（无选中时插入占位文字并选中）
    const wrapSelection = (before: string, after: string, placeholder: string) => {
      const s = textarea.selectionStart;
      const e = textarea.selectionEnd;
      const sel = textarea.value.slice(s, e) || placeholder;
      textarea.value = textarea.value.slice(0, s) + before + sel + after + textarea.value.slice(e);
      textarea.selectionStart = s + before.length;
      textarea.selectionEnd = s + before.length + sel.length;
      textarea.focus();
      textarea.dispatchEvent(new Event("input"));
    };

    const mkBtn = (label: string, title: string, fn: () => void) => {
      const b = tb.createDiv({
        cls: "db-memo-tb-btn",
        attr: { role: "button", "aria-label": title },
        text: label,
      });
      // mousedown 阻止默认，避免点击按钮时 textarea 失焦丢失选区
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", fn);
    };

    mkBtn("B", "加粗", () => wrapSelection("**", "**", "加粗文字"));
    mkBtn("S", "删除线", () => wrapSelection("~~", "~~", "删除文字"));
    mkBtn("[[ ]]", "双链", () => wrapSelection("[[", "]]", "链接"));
    mkBtn("#", "标签（输入后自动补全）", () => {
      // 光标前已是 '#' 时不重复插入，避免 ##
      const p = textarea.selectionStart;
      if (p > 0 && textarea.value[p - 1] === "#") {
        textarea.focus();
        return;
      }
      insertAtCaret("#");
    });
    if (opts.imageInput) {
      const photoBtn = tb.createDiv({
        cls: "db-memo-tb-btn db-memo-tb-icon",
        attr: { role: "button", "aria-label": "上传照片" },
      });
      setIcon(photoBtn, "image");
      photoBtn.addEventListener("mousedown", (e) => e.preventDefault());
      photoBtn.addEventListener("click", () => opts.imageInput!.click());
    }
    if (opts.onAudioToggle) {
      const audioBtn = tb.createDiv({
        cls: "db-memo-tb-btn db-memo-tb-icon db-memo-tb-audio",
        attr: { role: "button", "aria-label": "录音" },
      });
      setIcon(audioBtn, "mic");
      audioBtn.addEventListener("mousedown", (e) => e.preventDefault());
      audioBtn.addEventListener("click", () => opts.onAudioToggle!(audioBtn));
    }
  }

  // ── 自动补全 ──────────────────────────────────
  const pop = wrap.createDiv({ cls: "db-memo-ac" });
  pop.style.display = "none";
  let items: MemoSuggestion[] = [];
  let activeIdx = -1;

  const closeAc = () => {
    pop.style.display = "none";
    pop.empty();
    items = [];
    activeIdx = -1;
  };

  /**
   * 应用补全：从当前光标位置向回扫描定位触发片段，不依赖弹层打开时存储的索引，
   * 因此光标移动、弹层过期等情况下也不会替换错位置。
   * - 标签：回退吃掉查询字符后，把紧邻的所有连续 '#' 一并折叠，替换为 '#标签 '（杜绝 ##标签）
   * - 双链：回退到 '[['（跳过查询字符，不含 [ ] |），替换为 '[[笔记名]]'
   */
  const applyItem = (item: MemoSuggestion) => {
    const caret = textarea.selectionStart;
    const value = textarea.value;
    let start = caret;

    if (item.kind === "tag") {
      while (start > 0 && !/[\s\u3000]/.test(value[start - 1]) && value[start - 1] !== "#") start--;
      while (start > 0 && value[start - 1] === "#") start--;
      // 光标前既没有查询字符也没有 '#'，说明上下文已失效
      if (start === caret && value[start - 1] !== "#") {
        closeAc();
        return;
      }
      textarea.value = value.slice(0, start) + item.insert + value.slice(caret);
    } else {
      while (start > 0 && !/[\[\]|]/.test(value[start - 1])) start--;
      if (!(start >= 2 && value.slice(start - 2, start) === "[[")) {
        closeAc();
        return;
      }
      start -= 2;
      textarea.value = value.slice(0, start) + item.insert + value.slice(caret);
    }

    const np = start + item.insert.length;
    textarea.selectionStart = textarea.selectionEnd = np;
    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
    closeAc();
  };

  const renderAc = () => {
    pop.empty();
    items.forEach((item, i) => {
      const el = pop.createDiv({ cls: `db-memo-ac-item ${i === activeIdx ? "active" : ""}` });
      el.createSpan({ cls: "db-memo-ac-label", text: item.label });
      if (item.detail) el.createSpan({ cls: "db-memo-ac-detail", text: item.detail });
      // mousedown 防止 textarea 失焦
      el.addEventListener("mousedown", (e) => { e.preventDefault(); applyItem(item); });
    });
    pop.style.display = "block";
    pop.style.left = "12px";
    pop.style.top = `${textarea.offsetTop + textarea.offsetHeight + 4}px`;
    pop.querySelector(".db-memo-ac-item.active")?.scrollIntoView({ block: "nearest" });
  };

  const openAc = (kind: "link" | "tag", query: string) => {
    if (kind === "link") {
      // 双链：vault 内所有笔记，Obsidian 风格评分排序（文件名开头 > 文件名包含 > 路径包含）
      const q = query.toLowerCase();
      const seen = new Set<string>();
      const scored: { f: any; score: number }[] = [];
      app.vault.getMarkdownFiles().forEach(f => {
        const b = f.basename.toLowerCase();
        if (seen.has(f.path)) return;
        seen.add(f.path);
        let score = -1;
        if (q === "") score = 0;
        else if (b.startsWith(q)) score = 0;
        else if (b.includes(q)) score = 1;
        else if (f.path.toLowerCase().includes(q)) score = 2;
        if (score >= 0) scored.push({ f, score });
      });
      items = scored
        .sort((a, b) => a.score - b.score || a.f.basename.localeCompare(b.f.basename, "zh"))
        .slice(0, 8)
        .map(({ f }) => ({ kind, label: f.basename, detail: f.parent?.name ?? "", insert: `[[${f.basename}]]` }));
    } else {
      // 标签：vault 全部标签（metadataCache）+ 快捷标签；开头匹配优先
      const q = query.toLowerCase();
      const tagSet = new Set<string>(plugin.settings.quickTags);
      const cachedTags = (app.metadataCache as any).getTags?.() as Record<string, number> | undefined;
      Object.keys(cachedTags ?? {}).forEach(t => tagSet.add(t));
      items = [...tagSet]
        .filter(t => q === "" || t.toLowerCase().includes(q))
        .sort((a, b) => {
          const as = a.toLowerCase().startsWith(q) ? 0 : 1;
          const bs = b.toLowerCase().startsWith(q) ? 0 : 1;
          return as - bs || a.localeCompare(b, "zh");
        })
        .slice(0, 8)
        .map(t => ({ kind, label: `#${t}`, insert: `#${t} ` }));
    }
    activeIdx = items.length > 0 ? 0 : -1;
    if (items.length === 0) {
      closeAc();
      return;
    }
    renderAc();
  };

  textarea.addEventListener("input", () => {
    const trig = detectTrigger(textarea.value, textarea.selectionStart);
    if (!trig) {
      closeAc();
      return;
    }
    openAc(trig.kind, trig.query);
  });

  // 光标移动（点击 / Home/End/左右方向键）后重新检测：
  // 上下文已失效则关闭弹层，仍然有效则刷新候选（防止过期应用错位）
  const isNavKey = (key: string) =>
    key === "ArrowUp" || key === "ArrowDown" || key === "Enter" || key === "Escape" || key === "Tab";
  const redetect = () => {
    if (pop.style.display !== "block") return;
    const trig = detectTrigger(textarea.value, textarea.selectionStart);
    if (!trig) {
      closeAc();
    } else {
      openAc(trig.kind, trig.query);
    }
  };
  textarea.addEventListener("keyup", (e) => {
    if (isNavKey(e.key)) return; // 补全导航键由 keydown 处理，避免重置选中项
    redetect();
  });
  textarea.addEventListener("click", redetect);

  // capture 阶段处理按键，优先于其他 Enter 处理器（如计划页的回车添加）
  textarea.addEventListener("keydown", (e) => {
    if (pop.style.display === "none" || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      renderAc();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      renderAc();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        applyItem(items[activeIdx]);
      } else {
        closeAc();
      }
    } else if (e.key === "Escape") {
      closeAc();
    }
  }, true);

  // 点击编辑区外部关闭补全（随插件卸载自动清理）
  plugin.registerDomEvent(document, "click", (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node)) closeAc();
  });
}
