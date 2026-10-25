import { cacheGetMany, cachePutMany } from '../shared/cache';
import { shortHash } from '../shared/hash';
import { findProvider, type Settings } from '../shared/settings';
import { GoogleEngine, splitBatches, splitLongText } from './google';
import { LlmEngine } from './openai-compat';
import { PROMPT_VERSION } from './prompt';
import { TranslateError, type Engine, type TranslateRequest, type TranslateResult, type TranslateContext } from './types';

export const googleEngine = new GoogleEngine();

export function llmEngineFor(settings: Settings): LlmEngine {
  const provider = findProvider(settings);
  if (!provider) throw new TranslateError('没有找到可用的模型配置，请先到设置里添加');
  return new LlmEngine({
    provider,
    useContext: settings.useContext,
    style: settings.style,
    extraInstructions: settings.extraInstructions,
  });
}

/**
 * 缓存键刻意**不包含**页面 URL —— 同一句话在不同页面上应命中同一条缓存。
 * 但必须包含提示词相关的一切：换模型、改 base URL、改思考强度、改系统提示词、
 * 改术语表都要让旧缓存失效（模型与引擎 id 由 cacheKeyFor 的 engineId 承担）。
 */
export function cacheKeyFor(
  engineId: string,
  from: string,
  to: string,
  promptHash: string,
  text: string,
): string {
  return [engineId, from, to, `v${PROMPT_VERSION}`, promptHash, text].join('\u0000');
}

/**
 * LLM 的提示词指纹。影响提示词的一切设置变化都必须让旧缓存失效；
 * 开启「整页上下文」时，页面标题与摘要也参与——同一段文字在不同语境下译法可能不同。
 * apiKey 刻意不参与：换 Key 不改变译文。
 */
export async function llmPromptHash(settings: Settings, context?: TranslateContext): Promise<string> {
  const provider = findProvider(settings);
  const glossary = context?.glossary?.map(([a, b]) => `${a}=>${b}`).join(';') ?? '';
  // 提示词实际会带 url 与前文（见 prompt.ts），它们影响译法，必须参与缓存身份，
  // 否则同一段文字在不同页面/不同前文下会错误命中旧缓存
  const contextPart = settings.useContext
    ? [
        context?.title ?? '',
        context?.url ?? '',
        context?.summary ?? '',
        (context?.prev ?? []).join('\u0001'),
      ].join('\n')
    : '';
  return [
    provider?.model ?? '',
    provider?.baseUrl ?? '',
    provider?.reasoningEffort ?? '',
    provider?.extraBody ?? '',
    provider?.temperature ?? 0,
    settings.style,
    settings.extraInstructions,
    settings.useContext ? '1' : '0',
    glossary,
    contextPart,
  ].join('|');
}

/** 把段落按唯一文本去重，翻译后再还原顺序，避免重复请求同一句。 */
function dedupe(texts: string[]): { unique: string[]; mapping: number[] } {
  const index = new Map<string, number>();
  const unique: string[] = [];
  const mapping: number[] = [];
  for (const text of texts) {
    let at = index.get(text);
    if (at === undefined) {
      at = unique.length;
      unique.push(text);
      index.set(text, at);
    }
    mapping.push(at);
  }
  return { unique, mapping };
}

/** 跑引擎并返回译文与真实发出的批次数（用于元信息展示，不再用估算值）。 */
async function runEngine(
  engine: Engine,
  texts: string[],
  from: string,
  to: string,
  context: TranslateContext | undefined,
  batchSize: number,
): Promise<{ texts: string[]; batches: number }> {
  const out: string[] = [];
  let batches = 0;
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const translated = await engine.translate(slice, from, to, context);
    if (translated.length !== slice.length) {
      throw new TranslateError(`${engine.label} 返回 ${translated.length} 段，期望 ${slice.length} 段`);
    }
    out.push(...translated);
    batches += 1;
  }
  return { texts: out, batches };
}

/**
 * Google 引擎的真实 HTTP 请求数。
 * 引擎内部还会按字符上限二次切批（超长单段先按句拆分），这里用同一套
 * 切批逻辑预先算出实际会发出的请求数，让「请求 N 次」的展示可信。
 */
function countGoogleRequests(texts: string[]): number {
  let total = 0;
  for (let i = 0; i < texts.length; i += 40) {
    const expanded = texts.slice(i, i + 40).flatMap((text) => splitLongText(text));
    total += splitBatches(expanded).length;
  }
  return total;
}

/**
 * 翻译入口：设置 -> 缓存 -> 引擎 -> 写缓存。
 * LLM 失败且开启了降级时，自动改用 Google 免费接口补上剩余部分。
 *
 * 缓存键规则：LLM 结果写在 LLM 键下，Google（含降级）结果永远写在 Google 自己的键下——
 * 否则模型恢复后读到的是降级译文，还被标成模型出的。
 */
export async function translateTexts(req: TranslateRequest, settings: Settings): Promise<TranslateResult> {
  const texts = req.texts.map((t) => (typeof t === 'string' ? t : String(t)));
  if (texts.length === 0) {
    return { texts: [], engine: 'none', from: req.from, to: req.to, cachedCount: 0, requestCount: 0 };
  }

  const kind = req.engine ?? settings.engine;
  const provider = findProvider(settings);
  const isLlm = kind === 'llm';
  const engineId = isLlm ? `llm:${provider?.id ?? 'none'}:${provider?.model ?? ''}` : 'google';
  const promptHash = isLlm ? await llmPromptHash(settings, req.context) : 'default';
  const noCache = req.noCache === true;

  const { unique, mapping } = dedupe(texts);
  const keys = await Promise.all(
    unique.map((text) => shortHash(cacheKeyFor(engineId, req.from, req.to, promptHash, text))),
  );
  const googleKeys = await Promise.all(
    unique.map((text) => shortHash(cacheKeyFor('google', req.from, req.to, 'default', text))),
  );

  const cached = noCache ? new Map<string, string[]>() : await cacheGetMany(keys);
  const missIndexes: number[] = [];
  const results: string[] = new Array(unique.length);
  for (let i = 0; i < unique.length; i++) {
    const hit = cached.get(keys[i]!);
    if (hit && typeof hit[0] === 'string') results[i] = hit[0];
    else missIndexes.push(i);
  }

  let requestCount = 0;
  let fallbackCacheHits = 0;
  let engineLabel = isLlm ? (provider?.label ?? 'LLM') : googleEngine.label;
  const misses = missIndexes.map((i) => unique[i]!);
  let translatedMisses: string[] = [];
  let lastError: unknown;

  if (misses.length > 0) {
    if (isLlm) {
      try {
        const engine = llmEngineFor(settings);
        const llmRun = await runEngine(
          engine,
          misses,
          req.from,
          req.to,
          req.context,
          provider?.batchSize ?? 10,
        );
        translatedMisses = llmRun.texts;
        requestCount = llmRun.batches;
      } catch (err) {
        lastError = err;
      }
    }

    // 试译（noCache）不允许降级：它的目的就是验证当前配置能否成功，
    // 悄悄用 Google 补上会让「模型配置坏了」看起来一切正常
    if (
      translatedMisses.length === 0 &&
      (kind === 'google' || (settings.fallbackToGoogle && !noCache))
    ) {
      // 降级（或本就走 Google）：先看 Google 自己的缓存，再发真实请求
      const fallbackCached = isLlm && !noCache ? await cacheGetMany(missIndexes.map((i) => googleKeys[i]!)) : new Map<string, string[]>();
      const pending: number[] = [];
      translatedMisses = new Array(misses.length).fill('');
      for (let i = 0; i < missIndexes.length; i++) {
        const hit = fallbackCached.get(googleKeys[missIndexes[i]!]!);
        if (hit && typeof hit[0] === 'string') {
          translatedMisses[i] = hit[0];
          fallbackCacheHits += 1;
        } else pending.push(i);
      }
      if (pending.length > 0) {
        const pendingTexts = pending.map((i) => misses[i]!);
        requestCount += countGoogleRequests(pendingTexts);
        const done = await runEngine(
          googleEngine,
          pendingTexts,
          req.from,
          req.to,
          req.context,
          40,
        );
        for (let i = 0; i < pending.length; i++) translatedMisses[pending[i]!] = done.texts[i]!;
      }
      engineLabel = isLlm ? `${engineLabel}（失败后降级到 Google）` : googleEngine.label;
      if (!noCache) {
        // 降级译文只写 Google 键：模型恢复后 LLM 键仍然 miss，会用模型重翻
        await cachePutMany(
          missIndexes.map((uniqueIndex, i) => ({
            key: googleKeys[uniqueIndex]!,
            texts: [translatedMisses[i]!],
            engine: 'google',
            createdAt: Date.now(),
          })),
        );
      }
    } else if (translatedMisses.length > 0 && !noCache) {
      // LLM 成功：写 LLM 键
      await cachePutMany(
        missIndexes.map((uniqueIndex, i) => ({
          key: keys[uniqueIndex]!,
          texts: [translatedMisses[i]!],
          engine: engineId,
          createdAt: Date.now(),
        })),
      );
    }

    if (translatedMisses.length === 0) {
      throw lastError instanceof Error ? lastError : new TranslateError('翻译失败');
    }
    if (translatedMisses.length !== misses.length) {
      throw new TranslateError(`引擎返回段数不匹配：${translatedMisses.length} / ${misses.length}`);
    }
    for (let i = 0; i < missIndexes.length; i++) {
      results[missIndexes[i]!] = translatedMisses[i]!;
    }
  }

  return {
    texts: mapping.map((i) => results[i] ?? ''),
    engine: engineLabel,
    from: req.from,
    to: req.to,
    // 降级时命中 Google 缓存的段落也是缓存命中，一并计入
    cachedCount: unique.length - missIndexes.length + fallbackCacheHits,
    requestCount,
  };
}

export type { TranslateContext, TranslateRequest, TranslateResult } from './types';
export { TranslateError } from './types';
