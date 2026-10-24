import type { TranslateContext } from './types';
import type { TranslationStyle } from '../shared/settings';

/**
 * 提示词版本号。改动模板或风格片段时必须递增，否则旧缓存不会失效。
 * v2：重写规则结构，新增风格档。
 */
export const PROMPT_VERSION = 2;

export const SEPARATOR = '%%';

export interface PromptOptions {
  to: string;
  from: string;
  context?: TranslateContext;
  useContext: boolean;
  style: TranslationStyle;
  /** 用户附加要求，追加在全部规则之后。 */
  extraInstructions?: string;
}

const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic',
  th: 'Thai',
  vi: 'Vietnamese',
};

export function langName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

/**
 * 固定规则。这一段必须保持稳定：
 * 它在每个请求里重复出现，只有内容完全一致才能命中厂商的前缀缓存。
 * 随批次变化的东西（页码、进度之类）不能写进来。
 */
const BASE_PROMPT = `You are a professional translator. Translate every chunk into {{target}}.

INPUT
The input contains several chunks. Chunks are separated by a line containing only {{separator}}, and each chunk starts with an index tag like <<1>>.

OUTPUT FORMAT
- Return only the translations, in the same structure: same index tags, same {{separator}} separators, same order, same count.
- Never merge, split or reorder chunks; never add headings, notes, alternatives or the original text.
- Never wrap the output in code fences.

QUALITY
- Translate the meaning, not the words. Write the way a native {{target}} writer would: natural word order and idiomatic phrasing, not translationese.
- Do not explain, soften, or add anything absent from the source; do not omit anything either.
- Match the register: casual stays casual, technical stays technical, formal stays formal.
- Short fragments stay short. A navigation item or button label must not become a full sentence.
- If a chunk is ambiguous, translate it literally instead of inventing context.

TERMINOLOGY
- Keep unchanged: code identifiers, function, file and command names, URLs, email addresses, version numbers.
- Keep brand, product and company names in their original form unless a well-established {{target}} name exists.
- Use exactly the translations given in the terminology list, and one consistent translation per term across this document.
- If the same source text appears more than once, translate it identically.

DETAILS
- Preserve numbers, units, dates and inline symbols, formatted the way {{target}} readers expect.
- Use the punctuation conventions of {{target}} (full-width for Chinese, Japanese and Korean).
- If a chunk is already in {{target}}, or contains nothing translatable, return it unchanged.`;

/** 风格档：只在默认「自然流畅」之外追加差异部分，默认档不额外消耗 token。 */
const STYLE_SNIPPETS: Record<TranslationStyle, string> = {
  natural: '',
  literal: `STYLE — FAITHFUL
- Stay close to the source sentence structure and word order, so a reader can map each translated phrase back onto the original.
- Prefer the most direct equivalent of each word over a freer paraphrase.
- Accept slightly less idiomatic phrasing when that preserves the original structure. Do not add or drop connectives.`,
  casual: `STYLE — CONVERSATIONAL
- Write the way people actually speak: shorter sentences, everyday words, natural contractions.
- Use the phrasing a native speaker would use in conversation, not in an essay or a manual.`,
  formal: `STYLE — FORMAL
- Keep a formal written register. Avoid colloquialisms and contractions.
- Prefer established technical and academic terminology over everyday wording.`,
};

export const STYLE_OPTIONS: Array<{ value: TranslationStyle; label: string; hint: string }> = [
  { value: 'natural', label: '自然流畅', hint: '默认。像母语者写的一样自然' },
  { value: 'literal', label: '忠实直译', hint: '保留原文语序，方便逐句对照学习，中文会略生硬' },
  { value: 'casual', label: '口语化', hint: '贴近日常说话，适合对话与字幕' },
  { value: 'formal', label: '正式书面', hint: '正式语域，术语优先' },
];

/** 组装系统提示词：固定规则 -> 风格 -> 上下文 -> 术语表 -> 用户附加要求。 */
export function buildSystemPrompt(opts: PromptOptions): string {
  const target = langName(opts.to);
  const parts = [BASE_PROMPT.replaceAll('{{target}}', target).replaceAll('{{separator}}', SEPARATOR)];

  const style = STYLE_SNIPPETS[opts.style];
  if (style) parts.push(style);

  if (opts.from && opts.from !== 'auto') {
    parts.push(`The source language is ${langName(opts.from)}.`);
  }

  const ctx = opts.context;
  if (opts.useContext && ctx) {
    const lines: string[] = [];
    if (ctx.title) lines.push(`Title: ${ctx.title}`);
    if (ctx.url) lines.push(`URL: ${ctx.url}`);
    if (ctx.summary) lines.push(`Summary: ${ctx.summary}`);
    if (lines.length) {
      parts.push(
        `CONTEXT — the document this text comes from. Use it to keep terminology and tone consistent, but do NOT translate it:\n${lines.join('\n')}`,
      );
    }
    if (ctx.prev?.length) {
      parts.push(
        `PRECEDING TEXT — already translated, for continuity only. Do NOT translate it again:\n${ctx.prev.slice(-3).join('\n')}`,
      );
    }
  }

  const glossary = ctx?.glossary;
  if (glossary?.length) {
    const terms = glossary
      .slice(0, 100)
      .map(([src, dst]) => `- ${src} => ${dst}`)
      .join('\n');
    parts.push(`TERMINOLOGY LIST — these translations are mandatory:\n${terms}`);
  }

  // 放在最后：用户的明确要求应当压过前面的通用规则
  const extra = opts.extraInstructions?.trim();
  if (extra) {
    parts.push(`ADDITIONAL REQUIREMENTS — follow these as well:\n${extra}`);
  }

  return parts.join('\n\n');
}

/** 组装用户消息：带编号标签的分块正文。 */
export function buildUserPrompt(texts: string[]): string {
  return texts.map((text, index) => `<<${index + 1}>>${text}`).join(`\n${SEPARATOR}\n`);
}

/**
 * 解析批量翻译结果。
 * 优先按 <<n>> 标签定位（模型可能调整顺序），失败则回退到按分隔符顺序解析。
 */
export function parseBatchResponse(raw: string, expected: number): string[] {
  const text = raw.trim();
  if (expected === 1) {
    const single = stripSeparator(text);
    if (single) return [single];
  }

  const byTag = new Map<number, string>();
  const tagPattern = /<<(\d+)>>/g;
  const marks: Array<{ index: number; start: number; end: number }> = [];
  for (let m = tagPattern.exec(text); m; m = tagPattern.exec(text)) {
    marks.push({ index: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const current = marks[i]!;
    const next = marks[i + 1];
    const body = text.slice(current.end, next ? next.start : text.length);
    const cleaned = stripSeparator(body);
    if (current.index >= 1 && current.index <= expected) byTag.set(current.index, cleaned);
  }
  if (byTag.size === expected) {
    const ordered: string[] = [];
    for (let i = 1; i <= expected; i++) {
      const value = byTag.get(i);
      if (value === undefined) break;
      ordered.push(value);
    }
    if (ordered.length === expected) return ordered;
  }

  const bySeparator = text
    .split(new RegExp(`\\s*${SEPARATOR}\\s*`))
    .map((part) => stripTags(part).trim())
    .filter((part, index, arr) => !(part === '' && index === arr.length - 1));
  if (bySeparator.length === expected) return bySeparator;

  if (expected === 1 && bySeparator.length > 0) return [bySeparator.join(`\n${SEPARATOR}\n`)];

  throw new Error(`模型返回 ${bySeparator.length} 段，期望 ${expected} 段`);
}

function stripTags(text: string): string {
  return text.replace(/<<\d+>>/g, '').trim();
}

function stripSeparator(text: string): string {
  return stripTags(
    text.replace(new RegExp(`^\\s*${SEPARATOR}\\s*`), '').replace(new RegExp(`\\s*${SEPARATOR}\\s*$`), ''),
  );
}
