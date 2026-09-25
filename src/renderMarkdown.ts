import { App, MarkdownRenderer, Component } from "obsidian";

/**
 * 采用 Thino 的 markdown 实时渲染方式：
 * 1. 使用 MarkdownRenderer.render 渲染 markdown
 * 2. 处理 internal-link：检测未解析链接（is-unresolved），添加 mouseover 悬浮预览（hover-link）
 * 3. 长内容（>10 行）懒渲染：先显示「渲染内容」按钮，点击后再渲染
 * 4. 内容缓存：内容未变时跳过重渲染
 *
 * 参考: Obsidian-Thino main.js 的渲染逻辑
 */

/** 渲染选项 */
export interface RenderMarkdownOptions {
  /** 源文件路径（用于解析双链、标签等相对路径） */
  sourcePath?: string;
  /** 组件生命周期宿主（用于 MarkdownRenderer.render 的 component 参数） */
  component: Component;
  /** 长内容阈值（行数），超过则懒渲染。默认 10，设为 0/负数则禁用懒渲染 */
  lazyThreshold?: number;
  /** 渲染完成后回调（可在此追加标签点击等自定义逻辑） */
  onRendered?: (el: HTMLElement) => void;
  /** 懒渲染按钮文字 */
  lazyButtonText?: string;
}

/** 已渲染内容缓存 key（WeakMap 避免内存泄漏） */
const renderedCache = new WeakMap<HTMLElement, string>();

/**
 * 渲染 markdown 到目标元素，采用 Thino 的渲染方式。
 *
 * @param app Obsidian App 实例
 * @param content markdown 文本
 * @param el 渲染目标元素
 * @param opts 选项
 * @returns 是否实际执行了渲染（内容未变时返回 false）
 */
export async function renderMarkdown(
  app: App,
  content: string,
  el: HTMLElement,
  opts: RenderMarkdownOptions
): Promise<boolean> {
  // 内容缓存：内容未变时跳过
  if (renderedCache.get(el) === content && el.hasClass("markdown-rendered")) {
    return false;
  }

  const {
    sourcePath = "",
    component,
    lazyThreshold = 10,
    onRendered,
    lazyButtonText = "渲染内容",
  } = opts;

  const lineCount = content.split("\n").length;
  const useLazy = lazyThreshold > 0 && lineCount > lazyThreshold;

  el.empty();
  el.removeClass("markdown-rendered");
  el.addClass("raw-content");

  if (useLazy) {
    // 懒渲染：显示按钮 + 只读 textarea
    const btn = el.createEl("button", { cls: "db-render-content-btn", text: lazyButtonText });
    const raw = el.createEl("textarea", { cls: "db-raw-content" });
    raw.value = content;
    raw.disabled = true;

    const doRender = async () => {
      el.empty();
      el.removeClass("raw-content");
      await MarkdownRenderer.render(app, content, el, sourcePath, component);
      el.addClass("markdown-rendered");
      enhanceInternalLinks(app, el, sourcePath, component);
      renderedCache.set(el, content);
      onRendered?.(el);
    };

    btn.addEventListener("click", () => void doRender());
    return true; // 已初始化懒渲染
  }

  // 直接渲染
  await MarkdownRenderer.render(app, content, el, sourcePath, component);
  el.removeClass("raw-content");
  el.addClass("markdown-rendered");
  enhanceInternalLinks(app, el, sourcePath, component);
  renderedCache.set(el, content);
  onRendered?.(el);
  return true;
}

/**
 * 增强 internal-link：
 * - 检测未解析链接，添加 is-unresolved 类
 * - 添加 mouseover 事件，触发 Obsidian 原生悬浮预览（hover-link）
 *
 * 这是 Thino 渲染方式的核心增强，使渲染后的双链具备与 Obsidian 原生一致的悬浮预览体验。
 */
export function enhanceInternalLinks(
  app: App,
  container: HTMLElement,
  sourcePath: string,
  component: Component
): void {
  const links = container.querySelectorAll<HTMLElement>(".internal-link");
  links.forEach(link => {
    const linktext = link.getAttribute("data-href");
    if (!linktext) return;

    // 未解析链接检测
    const dest = app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (!dest) {
      link.addClass("is-unresolved");
    }

    // 悬浮预览：触发 Obsidian 原生 hover-link 事件
    link.addEventListener("mouseover", (event: MouseEvent) => {
      event.stopPropagation();
      app.workspace.trigger("hover-link", {
        event,
        source: "life-journal",
        hoverParent: component,
        targetEl: link,
        linktext,
        sourcePath: link.getAttribute("href") ?? sourcePath,
      });
    });
  });
}

/**
 * 强制重新渲染（忽略缓存）。
 * 用于内容被外部修改后需要刷新的场景。
 */
export async function rerenderMarkdown(
  app: App,
  content: string,
  el: HTMLElement,
  opts: RenderMarkdownOptions
): Promise<boolean> {
  renderedCache.delete(el);
  return renderMarkdown(app, content, el, opts);
}
