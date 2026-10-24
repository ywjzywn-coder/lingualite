import { TranslateError, type Engine } from './types';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/t';

/** 单次请求的字符上限与分段上限，避免请求体过大被拒。 */
const MAX_CHARS_PER_REQUEST = 3500;
const MAX_SEGMENTS_PER_REQUEST = 40;
/** 单次网络请求的超时：挂死的请求不能永远占着全局串行队列。 */
const REQUEST_TIMEOUT_MS = 12_000;

let chain: Promise<unknown> = Promise.resolve();

/** 全局串行队列：Google 免费接口不能并发轰炸。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Google 免费接口的返回结构随输入条数变化，需要兼容两种形态：
 *   多个 q：["译文1", "译文2"]
 *   单个 q：[[["译文","en"]]]  （多段时逐段拼接）
 */
export function normalizeGoogleResponse(data: unknown, expected: number): string[] {
  if (!Array.isArray(data)) {
    throw new TranslateError('Google 接口返回格式无法识别');
  }
  if (data.length === expected && data.every((item) => typeof item === 'string')) {
    return data as string[];
  }
  if (expected === 1) {
    const single = joinSegments(data);
    if (single !== '') return [single];
  }
  if (data.length === expected) {
    return data.map((item) => joinSegments(item));
  }
  throw new TranslateError(`Google 接口返回 ${data.length} 段，期望 ${expected} 段`);
}

function joinSegments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  // ["译文", "en"] 或 [["片段1","en"], ["片段2","en"]]
  if (typeof value[0] === 'string') return value[0];
  return value
    .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
    .join('');
}

async function requestOnce(texts: string[], from: string, to: string): Promise<string[]> {
  const params = new URLSearchParams({
    client: 'gtx',
    dt: 't',
    sl: from || 'auto',
    tl: to,
    format: 'html',
  });
  const body = texts.map((text) => `q=${encodeURIComponent(text)}`).join('&');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // 响应体的读取也放在计时器保护内：挂死的响应不该永远占着全局串行队列
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new TranslateError(`Google 接口返回 HTTP ${res.status}`);
    }
    return normalizeGoogleResponse(await res.json(), texts.length);
  } catch (err) {
    if (err instanceof TranslateError) throw err;
    throw new TranslateError(
      controller.signal.aborted ? 'Google 接口请求超时' : 'Google 接口网络错误',
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetry(texts: string[], from: string, to: string): Promise<string[]> {
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await requestOnce(texts, from, to);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) await sleep(300 * 3 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new TranslateError('Google 翻译失败', lastError);
}

/** 按字符数与段数切批。 */
export function splitBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    const tooManyChars = chars + text.length > MAX_CHARS_PER_REQUEST && current.length > 0;
    const tooManySegments = current.length >= MAX_SEGMENTS_PER_REQUEST;
    if (tooManyChars || tooManySegments) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * 超过单请求字符上限的单段按句边界硬切，避免一段超长文本独自撑爆请求。
 * 与 splitBatches 的「切段不拆段」不同，这里会真正拆分文本，
 * 由 joinSplitTranslations 在译文回来后按原边界拼回。
 */
export function splitLongText(text: string, limit = MAX_CHARS_PER_REQUEST - 300): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed) pieces.push(trimmed);
  };
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    let current = '';
    for (const { segment } of segmenter.segment(text)) {
      if (current && current.length + segment.length > limit) {
        push(current);
        current = '';
      }
      if (segment.length > limit) {
        // 单句仍然超限：按硬长度切开
        for (let at = 0; at < segment.length; at += limit) push(segment.slice(at, at + limit));
        continue;
      }
      current += segment;
    }
    push(current);
  } else {
    for (let at = 0; at < text.length; at += limit) push(text.slice(at, at + limit));
  }
  return pieces.length > 0 ? pieces : [text];
}

/** 判断是否 CJK 字符（含全角标点）：拼接超长段的译文时用它决定要不要补空格。 */
const CJK_CHAR = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 把超长段拆分翻译后的各片拼回一整段：CJK 相邻直接连，否则补一个空格。 */
export function joinSplitTranslations(sourceChunks: string[], translatedChunks: string[]): string {
  let out = '';
  for (let i = 0; i < translatedChunks.length; i++) {
    const piece = translatedChunks[i] ?? '';
    if (i === 0) {
      out = piece;
      continue;
    }
    const prevEnd = (sourceChunks[i - 1] ?? '').slice(-1);
    const nextStart = (sourceChunks[i] ?? '').slice(0, 1);
    out += CJK_CHAR.test(prevEnd) || CJK_CHAR.test(nextStart) ? piece : ` ${piece}`;
  }
  return out;
}

export class GoogleEngine implements Engine {
  readonly id = 'google';
  readonly label = 'Google 免费接口';

  async translate(texts: string[], from: string, to: string): Promise<string[]> {
    if (texts.length === 0) return [];
    // 超长单段先按句硬切再翻译，回来按原边界拼回，保证与输入一一对应
    const expanded: string[] = [];
    const groupSizes: number[] = [];
    for (const text of texts) {
      const chunks = splitLongText(text);
      groupSizes.push(chunks.length);
      expanded.push(...chunks);
    }
    const out: string[] = [];
    for (const batch of splitBatches(expanded)) {
      const translated = await enqueue(() => requestWithRetry(batch, from, to));
      out.push(...translated);
    }
    const result: string[] = [];
    let at = 0;
    for (const size of groupSizes) {
      result.push(joinSplitTranslations(expanded.slice(at, at + size), out.slice(at, at + size)));
      at += size;
    }
    return result;
  }
}
