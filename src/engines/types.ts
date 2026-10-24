/** 翻译引擎的公共契约。所有引擎都接收一批待翻译文本，返回等长结果数组。 */

export interface TranslateContext {
  /** 页面/视频标题 */
  title?: string;
  /** 页面地址 */
  url?: string;
  /** 页面摘要，用于给 LLM 提供整页语境 */
  summary?: string;
  /** 前文译文，做滑动窗口保证上下文连贯 */
  prev?: string[];
  /** 术语表：[原文, 译法] */
  glossary?: Array<[string, string]>;
}

export interface TranslateRequest {
  texts: string[];
  from: string;
  to: string;
  context?: TranslateContext;
  /** 指定引擎，缺省时使用设置里的引擎 */
  engine?: 'google' | 'llm';
  /** 跳过缓存读写，强制真实请求（设置页试译/连通性测试用） */
  noCache?: boolean;
}

export interface TranslateResult {
  texts: string[];
  engine: string;
  /** 实际使用的原文语言（请求留空时为设置里的值） */
  from: string;
  /** 实际使用的译文语言 */
  to: string;
  /** 命中缓存的条目数 */
  cachedCount: number;
  /** 实际发起的网络请求数 */
  requestCount: number;
}

export interface Engine {
  readonly id: string;
  readonly label: string;
  translate(texts: string[], from: string, to: string, context?: TranslateContext): Promise<string[]>;
}

export class TranslateError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TranslateError';
  }
}
