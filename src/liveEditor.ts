/**
 * liveEditor.ts — 内嵌 Live Preview 编辑器
 *
 * 与 Thino / Kanban 相同的方案：通过 Obsidian 内部 embed 工厂解析出
 * ScrollableMarkdownEditor（CodeMirror 6），在页面内嵌一个"源码即渲染"
 * 的 Markdown 编辑器，原生支持加粗、标题、标签、双链、图片/音频嵌入等
 * 实时渲染，同时保留 [[ 双链与 # 标签的原生补全。
 *
 * 内部 API 不稳定时自动降级为普通 <textarea>（对外接口完全一致）。
 */

import { App, Scope, TFile } from "obsidian";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";

export interface LiveEditorOptions {
  value?: string;
  placeholder?: string;
  /** 内容变化（含 setValue 触发） */
  onChange?: (value: string) => void;
  /**
   * Enter 键回调。返回 true 表示吞掉按键（不插入换行）。
   * @param mod   Ctrl/Cmd
   * @param shift Shift
   */
  onEnter?: (mod: boolean, shift: boolean) => boolean;
  onEscape?: () => void;
  onBlur?: () => void;
  /** 粘贴的图片文件（已阻止默认行为） */
  onPasteFiles?: (files: File[]) => void;
}

export interface LiveEditor {
  /** 挂载根元素（样式作用域用） */
  readonly el: HTMLElement;
  /** 是否为 CM 实时渲染编辑器（false = textarea 降级） */
  readonly isLive: boolean;
  /** 降级模式下的原生 textarea（供旧补全逻辑使用） */
  readonly nativeInput?: HTMLTextAreaElement;
  getValue(): string;
  setValue(value: string): void;
  getSelection(): { from: number; to: number };
  replaceRange(from: number, to: number, text: string): void;
  insertAtCursor(text: string): void;
  focus(): void;
  destroy(): void;
}

/* ------------------------------------------------------------------ */
/* 内部 Markdown 编辑器构造函数（解析一次后缓存）                        */
/* ------------------------------------------------------------------ */

let cachedCtor: any = null;

/**
 * 解析 Obsidian 内部的可嵌入 Markdown 编辑器类。
 * 思路：临时创建一个 md embed widget，切到编辑态，从其 editMode 上取原型。
 */
function resolveEditorCtor(app: App): any {
  if (cachedCtor) return cachedCtor;

  const embedRegistry = (app as any).embedRegistry;
  if (!embedRegistry || !embedRegistry.embedByExtension || !embedRegistry.embedByExtension.md) {
    throw new Error("embedRegistry.md unavailable");
  }

  const fakeWidget = embedRegistry.embedByExtension.md(
    { app, containerEl: document.createElement("div") },
    // 仅用于取原型，无需真实文件
    null as unknown as TFile,
    ""
  );
  fakeWidget.editable = true;
  fakeWidget.showEditor();

  const editModeProto = Object.getPrototypeOf(Object.getPrototypeOf(fakeWidget.editMode));
  cachedCtor = editModeProto.constructor;

  fakeWidget.unload();
  return cachedCtor;
}

/* ------------------------------------------------------------------ */
/* CodeMirror 6 实时渲染编辑器                                          */
/* ------------------------------------------------------------------ */

function createCmLiveEditor(
  app: App,
  parent: HTMLElement,
  opts: LiveEditorOptions,
  extraCls: string,
  sourceFile: TFile | null
): LiveEditor {
  const el = parent.createDiv({ cls: `lj-live-editor cm-s-embedded ${extraCls}` });
  // 内部编辑器类（构造签名为 (app, containerEl, MarkdownFileInfo)）
  const MarkdownEditor = resolveEditorCtor(app) as (
    new (app: App, containerEl: HTMLElement, info: unknown) => any
  );

  let destroyed = false;
  let inst: any;

  class EmbeddedMarkdownEditor extends MarkdownEditor {
    buildLocalExtensions(): Extension[] {
      const extensions = super.buildLocalExtensions();

      if (opts.placeholder) {
        extensions.push(placeholder(opts.placeholder));
      }

      if (opts.onPasteFiles) {
        extensions.push(
          EditorView.domEventHandlers({
            paste: (event: ClipboardEvent) => {
              if (!event.clipboardData) return false;
              const files = Array.from(event.clipboardData.files).filter((f) =>
                f.type.startsWith("image/")
              );
              if (files.length > 0) {
                event.preventDefault();
                opts.onPasteFiles?.(files);
                return true;
              }
              return false;
            },
          })
        );
      }

      // 最高优先级拦截 Enter，供"回车直接添加计划"使用
      extensions.push(
        Prec.highest(
          keymap.of([
            {
              key: "Enter",
              run: () => (opts.onEnter ? opts.onEnter(false, false) : false),
              shift: () => (opts.onEnter ? opts.onEnter(false, true) : false),
            },
            {
              key: "Mod-Enter",
              run: () => (opts.onEnter ? opts.onEnter(true, false) : false),
              shift: () => (opts.onEnter ? opts.onEnter(true, true) : false),
            },
            {
              key: "Escape",
              run: () => {
                opts.onEscape?.();
                return true;
              },
            },
          ])
        )
      );

      return extensions;
    }

    onUpdate(update: unknown, changed: boolean): void {
      super.onUpdate(update, changed);
      if (changed && !destroyed) {
        opts.onChange?.(inst.editor.cm.state.doc.toString());
      }
    }
  }

  // 构造：owner 即 MarkdownFileInfo，提供文件上下文（双链/嵌入解析）
  inst = new EmbeddedMarkdownEditor(app, el, {
    app,
    file: sourceFile,
    onMarkdownScroll: () => {},
    getMode: () => "source",
  });

  // 让 Obsidian 命令/补全能识别这个内嵌编辑器
  inst.owner.editMode = inst;
  inst.owner.editor = inst.editor;
  // Obsidian 1.5.8+ 必须显式 set，否则内容空白
  inst.set(opts.value ?? "");

  // 拦截全局 Mod-Enter（否则会触发"打开当前笔记"等命令）
  const scope = new Scope(app.scope);
  scope.register(["Mod"], "Enter", () => true);

  const contentDOM: HTMLElement = inst.editor.cm.contentDOM;

  const onFocusIn = () => {
    app.keymap.pushScope(scope);
    (app.workspace as any).activeEditor = inst.owner;
  };
  const onBlur = () => {
    try {
      app.keymap.popScope(scope);
    } catch {
      // scope 已弹出时忽略
    }
    if (!destroyed) opts.onBlur?.();
  };

  contentDOM.addEventListener("focusin", onFocusIn);
  contentDOM.addEventListener("blur", onBlur);

  return {
    el,
    isLive: true,

    getValue(): string {
      return inst.editor.cm.state.doc.toString();
    },

    setValue(value: string): void {
      inst.set(value);
      // set 会触发 onUpdate → onChange
    },

    getSelection(): { from: number; to: number } {
      const sel = inst.editor.cm.state.selection.main;
      return { from: sel.from, to: sel.to };
    },

    replaceRange(from: number, to: number, text: string): void {
      const cm: EditorView = inst.editor.cm;
      cm.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      cm.focus();
    },

    insertAtCursor(text: string): void {
      inst.editor.replaceSelection(text);
      inst.editor.cm.focus();
    },

    focus(): void {
      inst.editor.cm.focus();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      contentDOM.removeEventListener("focusin", onFocusIn);
      contentDOM.removeEventListener("blur", onBlur);
      try {
        app.keymap.popScope(scope);
      } catch {
        // ignore
      }
      try {
        (app.workspace as any).activeEditor = null;
      } catch {
        // ignore
      }
      try {
        inst.unload();
      } catch {
        // ignore
      }
      el.empty();
    },
  };
}

/* ------------------------------------------------------------------ */
/* textarea 降级实现                                                    */
/* ------------------------------------------------------------------ */

function createTextareaEditor(
  _app: App,
  parent: HTMLElement,
  opts: LiveEditorOptions,
  extraCls: string
): LiveEditor {
  const el = parent.createDiv({ cls: `lj-live-editor lj-live-editor-fallback ${extraCls}` });
  const ta = el.createEl("textarea", {
    cls: "lj-textarea lj-live-textarea",
    attr: { placeholder: opts.placeholder ?? "", rows: "3" },
  });
  ta.value = opts.value ?? "";

  ta.addEventListener("input", () => opts.onChange?.(ta.value));
  ta.addEventListener("blur", () => opts.onBlur?.());
  ta.addEventListener("paste", (event: ClipboardEvent) => {
    if (!opts.onPasteFiles || !event.clipboardData) return;
    const files = Array.from(event.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      opts.onPasteFiles(files);
    }
  });
  ta.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      const handled = opts.onEnter
        ? opts.onEnter(event.metaKey || event.ctrlKey, event.shiftKey)
        : false;
      if (handled) event.preventDefault();
    } else if (event.key === "Escape") {
      opts.onEscape?.();
    }
  });

  return {
    el,
    isLive: false,
    nativeInput: ta,

    getValue(): string {
      return ta.value;
    },

    setValue(value: string): void {
      ta.value = value;
      opts.onChange?.(value);
    },

    getSelection(): { from: number; to: number } {
      return { from: ta.selectionStart ?? 0, to: ta.selectionEnd ?? 0 };
    },

    replaceRange(from: number, to: number, text: string): void {
      const value = ta.value;
      ta.value = value.slice(0, from) + text + value.slice(to);
      const caret = from + text.length;
      ta.setSelectionRange(caret, caret);
      ta.focus();
      opts.onChange?.(ta.value);
    },

    insertAtCursor(text: string): void {
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? start;
      ta.setRangeText(text, start, end, "end");
      ta.focus();
      opts.onChange?.(ta.value);
    },

    focus(): void {
      ta.focus();
    },

    destroy(): void {
      el.empty();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 创建一个内嵌实时渲染编辑器。内部 API 不可用时自动降级为 textarea。
 *
 * @param parent     挂载容器
 * @param opts       编辑器选项
 * @param extraCls   追加到根元素的样式类（如 lj-live-editor-plan）
 * @param sourceFile 文件上下文（用于双链/附件路径解析，可为 null）
 */
export function createLiveEditor(
  app: App,
  parent: HTMLElement,
  opts: LiveEditorOptions,
  extraCls = "",
  sourceFile: TFile | null = null
): LiveEditor {
  let editor: LiveEditor;
  try {
    editor = createCmLiveEditor(app, parent, opts, extraCls, sourceFile);
  } catch (error) {
    console.warn("[Daybook] 内嵌实时编辑器不可用，回退为文本输入框：", error);
    editor = createTextareaEditor(app, parent, opts, extraCls);
  }

  // 安全网：宿主 DOM 被整体移除（页面重建/视图关闭且未显式 destroy）时自动清理
  const observer = new MutationObserver(() => {
    if (!editor.el.isConnected) editor.destroy();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const rawDestroy = editor.destroy.bind(editor);
  editor.destroy = () => {
    observer.disconnect();
    rawDestroy();
  };

  return editor;
}
