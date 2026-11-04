/**
 * aiClient.ts — 第三方大模型调用（非流式）
 *
 * 只做三套协议，覆盖设置里内置的全部厂商：
 * - openai：/chat/completions（OpenAI、DeepSeek、通义、Kimi、智谱、OpenRouter、Ollama…）
 * - anthropic：/messages（Claude）
 * - gemini：/models/{model}:generateContent（Google）
 *
 * 网络走 Obsidian 的 requestUrl（绕过 CORS，移动端也可用），不用 fetch。
 * 非流式：一次返回完整 JSON，方便严格解析「待写入动作」后再让用户确认。
 */
import { requestUrl } from "obsidian";
import type { DaybookSettings } from "./settings";
import { aiVendor, type AiProtocol } from "./settings";

export type AiRole = "system" | "user" | "assistant";
export interface AiChatMessage {
  role: AiRole;
  content: string;
}

export interface AiRuntimeConfig {
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  vendorName: string;
}

export class AiRequestError extends Error {}

function isLocalHost(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
}

/** 合并厂商预设与用户覆盖值；空字符串 = 用预设置 */
export function resolveAiConfig(settings: DaybookSettings): AiRuntimeConfig {
  const vendor = aiVendor(settings.aiProvider);
  const customBase = (settings.aiBaseUrl ?? "").trim().replace(/\/+$/, "");
  const customModel = (settings.aiModel ?? "").trim();
  return {
    protocol: vendor.protocol,
    baseUrl: customBase || vendor.baseUrl.replace(/\/+$/, ""),
    model: customModel || vendor.model,
    apiKey: (settings.aiApiKey ?? "").trim(),
    vendorName: vendor.name,
  };
}

/** 缺少配置时的可读提示；返回 null = 配置齐全 */
export function aiConfigProblem(settings: DaybookSettings): string | null {
  const cfg = resolveAiConfig(settings);
  if (!cfg.baseUrl) return "还没有填写 API 地址";
  if (!cfg.model) return "还没有填写模型名";
  if (!cfg.apiKey && !isLocalHost(cfg.baseUrl)) return "还没有填写 API Key";
  return null;
}

function parseErrorMessage(e: unknown): string {
  const err = e as { status?: number; message?: string; json?: { error?: { message?: string }; message?: string } };
  const fromJson = err?.json?.error?.message ?? err?.json?.message;
  if (fromJson) return String(fromJson);
  if (err?.status) return `HTTP ${err.status}${err.message ? `：${err.message}` : ""}`;
  return e instanceof Error ? e.message : String(e);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  try {
    const res = await requestUrl({
      url,
      method: "POST",
      headers,
      contentType: "application/json",
      body: JSON.stringify(body),
      throw: false,
    });
    if (res.status >= 400) {
      const msg = res.json?.error?.message ?? res.json?.message ?? res.text?.slice(0, 200) ?? "";
      throw new AiRequestError(`接口返回 ${res.status}${msg ? `：${msg}` : ""}`);
    }
    return res.json;
  } catch (e) {
    if (e instanceof AiRequestError) throw e;
    throw new AiRequestError(parseErrorMessage(e));
  }
}

async function callOpenAi(cfg: AiRuntimeConfig, messages: AiChatMessage[]): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const json = await postJson(`${cfg.baseUrl}/chat/completions`, headers, {
    model: cfg.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature: 0.2,
    max_tokens: 2048,
  });
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AiRequestError("接口没有返回内容");
  }
  return content.trim();
}

/** Anthropic / Gemini 要求 user / assistant 交替：合并连续同角色消息 */
function mergeRoles(messages: AiChatMessage[]): AiChatMessage[] {
  const out: AiChatMessage[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  return out;
}

async function callAnthropic(cfg: AiRuntimeConfig, messages: AiChatMessage[]): Promise<string> {
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const chat = mergeRoles(messages.filter(m => m.role !== "system"));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
  const json = await postJson(`${cfg.baseUrl}/messages`, headers, {
    model: cfg.model,
    max_tokens: 2048,
    temperature: 0.2,
    ...(system ? { system } : {}),
    messages: chat,
  });
  const content = Array.isArray(json?.content)
    ? json.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("")
    : "";
  if (!content.trim()) throw new AiRequestError("接口没有返回内容");
  return content.trim();
}

async function callGemini(cfg: AiRuntimeConfig, messages: AiChatMessage[]): Promise<string> {
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const contents = mergeRoles(messages.filter(m => m.role !== "system"))
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const url = `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const json = await postJson(url, { "Content-Type": "application/json" }, {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  const parts = json?.candidates?.[0]?.content?.parts;
  const content = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? "").join("") : "";
  if (!content.trim()) {
    const blocked = json?.candidates?.[0]?.finishReason;
    throw new AiRequestError(blocked ? `接口没有返回内容（${blocked}）` : "接口没有返回内容");
  }
  return content.trim();
}

/** requestUrl 不支持取消：用超时兜底，至少让页面结束「正在思考」 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = activeWindow.setTimeout(() => {
      reject(new AiRequestError("请求超时（60 秒），请检查网络或换用更快的模型"));
    }, ms);
    task.then(
      value => { activeWindow.clearTimeout(timer); resolve(value); },
      error => { activeWindow.clearTimeout(timer); reject(error); },
    );
  });
}

/** 发送一次对话，返回纯文本回复；失败抛 AiRequestError */
export async function chatComplete(settings: DaybookSettings, messages: AiChatMessage[]): Promise<string> {
  const problem = aiConfigProblem(settings);
  if (problem) throw new AiRequestError(problem);
  const cfg = resolveAiConfig(settings);
  const task = cfg.protocol === "anthropic"
    ? callAnthropic(cfg, messages)
    : cfg.protocol === "gemini"
      ? callGemini(cfg, messages)
      : callOpenAi(cfg, messages);
  return withTimeout(task, 60000);
}

/** 设置页「测试连接」用：最小的往返请求 */
export async function testAiConnection(settings: DaybookSettings): Promise<string> {
  return chatComplete(settings, [{ role: "user", content: "只回复两个字：可用" }]);
}
