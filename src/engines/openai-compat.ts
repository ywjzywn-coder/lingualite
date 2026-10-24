import type { ProviderConfig, ReasoningEffort, TranslationStyle } from '../shared/settings';
import { buildSystemPrompt, buildUserPrompt, parseBatchResponse } from './prompt';
import { TranslateError, type Engine, type TranslateContext } from './types';

/**
 * 思考强度映射。各家厂商字段不同：
 *   OpenAI / 兼容实现：reasoning_effort
 *   DeepSeek 等：thinking: { type: "enabled" }
 * 这里只覆盖最通用的 reasoning_effort，其余差异交给 extraBody 原样合并覆盖。
 */
const EFFORT_MAP: Record<ReasoningEffort, Record<string, unknown> | null> = {
  default: null,
  none: { reasoning_effort: 'none' },
  low: { reasoning_effort: 'low' },
  medium: { reasoning_effort: 'medium' },
  high: { reasoning_effort: 'high' },
};

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new TranslateError('还没有填写 base URL');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranslateError(`${label} 不是合法的 JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TranslateError(`${label} 必须是一个 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

export interface ChatRequestBodyOptions {
  provider: ProviderConfig;
  system: string;
  user: string;
}

/** 组装请求体：基础字段 -> 思考强度 -> 用户自定义字段（最后合并，可覆盖一切）。 */
export function buildChatBody({ provider, system, user }: ChatRequestBodyOptions): Record<string, unknown> {
  if (!provider.model.trim()) throw new TranslateError('还没有填写模型名');
  const body: Record<string, unknown> = {
    model: provider.model.trim(),
    temperature: provider.temperature,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const effort = EFFORT_MAP[provider.reasoningEffort];
  if (effort) Object.assign(body, effort);
  Object.assign(body, parseJsonObject(provider.extraBody, '额外请求参数'));
  return body;
}

export function buildHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = provider.apiKey.trim();
  if (key) headers.authorization = `Bearer ${key}`;
  return { ...headers, ...parseJsonObject(provider.extraHeaders, '额外请求头') as Record<string, string> };
}

/** 兼容 content 为字符串、内容数组、以及少数实现把结果放在 text 字段的情况。 */
export function extractContent(data: unknown): string {
  const root = data as { choices?: unknown; text?: unknown } | null;
  const choices = root?.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown };
    // finish_reason=length 表示输出因长度上限被截断：半句译文不能当成功结果去缓存
    if (choice.finish_reason === 'length') {
      throw new TranslateError('模型输出因长度上限被截断，请调小「每批段数」或调大模型输出上限');
    }
    const message = choice.message;
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => {
          if (typeof part === 'string') return part;
          const text = (part as { text?: unknown })?.text;
          return typeof text === 'string' ? text : '';
        })
        .join('');
      if (joined.trim()) return joined;
    }
  }
  if (typeof root?.text === 'string' && root.text.trim()) return root.text;
  throw new TranslateError('模型返回结构无法识别，请确认该接口兼容 OpenAI chat/completions');
}

/** 单次请求的整体超时：挂死的请求不能永远占着连接。 */
const REQUEST_TIMEOUT_MS = 60_000;

async function postChat(
  provider: ProviderConfig,
  system: string,
  user: string,
): Promise<string> {
  const url = resolveChatCompletionsUrl(provider.baseUrl);
  // 先在 try 外组装：非法 JSON、缺模型名是配置错误，不该被包装成「无法连接」
  const body = JSON.stringify(buildChatBody({ provider, system, user }));
  const headers = buildHeaders(provider);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let text: string;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    text = await res.text();
    if (!res.ok) {
      throw new TranslateError(`接口返回 HTTP ${res.status}：${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    if (controller.signal.aborted) {
      throw new TranslateError(`请求 ${url} 超时（${REQUEST_TIMEOUT_MS / 1000} 秒无响应）`, err);
    }
    throw new TranslateError(`无法连接到 ${url}，请检查 base URL 与网络`, err);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TranslateError(`接口返回的不是 JSON：${text.slice(0, 200)}`);
  }
  return extractContent(data);
}

export interface LlmEngineOptions {
  provider: ProviderConfig;
  useContext: boolean;
  style: TranslationStyle;
  extraInstructions: string;
}

export class LlmEngine implements Engine {
  readonly id: string;
  readonly label: string;

  constructor(private readonly options: LlmEngineOptions) {
    this.id = `llm:${options.provider.id}`;
    this.label = options.provider.label || options.provider.model;
  }

  async translate(texts: string[], from: string, to: string, context?: TranslateContext): Promise<string[]> {
    if (texts.length === 0) return [];
    const system = buildSystemPrompt({
      to,
      from,
      context,
      useContext: this.options.useContext,
      style: this.options.style,
      extraInstructions: this.options.extraInstructions,
    });
    const user = buildUserPrompt(texts);
    const raw = await postChat(this.options.provider, system, user);
    try {
      return parseBatchResponse(raw, texts.length);
    } catch (err) {
      throw new TranslateError(
        `模型返回的段落数与请求不匹配（${err instanceof Error ? err.message : String(err)}）`,
        err,
      );
    }
  }
}
