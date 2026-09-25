import { Platform } from "obsidian";
import completionAudioBase64 from "../assets/complete.mp3";
import type { DaybookSettings } from "./settings";

const SOUND_URI = `data:audio/mpeg;base64,${completionAudioBase64}`;

interface HapticsBridge {
  impactLight?: (options?: { style?: "light" | "medium" | "heavy" }) => Promise<unknown>;
}
type FeedbackWindow = Window & {
  Capacitor?: { Plugins?: Record<string, HapticsBridge | undefined> };
  navigator: Navigator & { vibrate?: (pattern: number | number[]) => boolean };
};

/**
 * 完成反馈（仅移动端）：勾选待办、打卡达到当日目标时给一次轻微震动 + 完成音效。
 * 音效以 Base64 内联在 main.js 里，不依赖插件目录下的额外文件。
 */
export class CompletionFeedback {
  private audio: HTMLAudioElement | null = null;

  constructor(private getSettings: () => DaybookSettings) {}

  /**
   * 必须在点击事件的同步上下文里调用：移动端 webview 只在用户手势内放行震动与音频播放。
   * 因此各入口在写盘之前就调用它，而不是等保存成功之后。
   */
  notify(): void {
    if (!Platform.isMobile) return;
    const settings = this.getSettings();
    // 反馈失败绝不能影响勾选/打卡本身，因此各自独立吞掉异常
    try {
      if (settings.completionHaptic !== false) this.vibrate();
    } catch {
      /* 该 webview 未提供震动能力 */
    }
    try {
      if (settings.completionSound !== false) this.playSound();
    } catch {
      /* 音频解码失败或系统拦截 */
    }
  }

  private vibrate(): void {
    const win = activeWindow as FeedbackWindow;
    const haptics = win.Capacitor?.Plugins?.Haptics;
    if (haptics?.impactLight) {
      void Promise.resolve(haptics.impactLight({ style: "light" })).catch(() => {});
      return;
    }
    win.navigator.vibrate?.(15);
  }

  private playSound(): void {
    if (!this.audio) {
      this.audio = new Audio(SOUND_URI);
      this.audio.volume = 0.6;
    }
    this.audio.currentTime = 0;
    void Promise.resolve(this.audio.play()).catch(() => {});
  }
}
