import { describe, expect, it } from 'vitest';
import {
  joinSplitTranslations,
  normalizeGoogleResponse,
  splitBatches,
  splitLongText,
} from '../src/engines/google';

// 这两个样例是 2026-10-01 对 translate.googleapis.com 真实请求抓到的返回结构：
// 多个 q 参数 -> 扁平字符串数组；单个 q -> 嵌套数组。
const REAL_MULTI = ['你好世界', '这是一个测试。'];
const REAL_SINGLE = [['你好。你好吗？', 'en']];

describe('normalizeGoogleResponse', () => {
  it('多段请求：扁平字符串数组', () => {
    expect(normalizeGoogleResponse(REAL_MULTI, 2)).toEqual(['你好世界', '这是一个测试。']);
  });

  it('单段请求：嵌套结构', () => {
    expect(normalizeGoogleResponse(REAL_SINGLE, 1)).toEqual(['你好。你好吗？']);
  });

  it('长文本被切成多段时逐段拼接', () => {
    const data = [[['第一句。', 'en'], ['第二句。', 'en']]];
    expect(normalizeGoogleResponse(data, 1)).toEqual(['第一句。第二句。']);
  });

  it('多段请求也可能是嵌套结构', () => {
    const data = [[['译文一', 'en']], [['译文二', 'en']]];
    expect(normalizeGoogleResponse(data, 2)).toEqual(['译文一', '译文二']);
  });

  it('段数不匹配时抛错', () => {
    expect(() => normalizeGoogleResponse(['只有一段'], 2)).toThrow();
  });

  it('非数组返回时抛错', () => {
    expect(() => normalizeGoogleResponse({ error: 'nope' }, 1)).toThrow();
  });
});

describe('splitBatches', () => {
  it('按段数上限切分', () => {
    const texts = Array.from({ length: 85 }, (_, i) => `t${i}`);
    const batches = splitBatches(texts);
    expect(batches.map((b) => b.length)).toEqual([40, 40, 5]);
  });

  it('按字符数上限切分', () => {
    const texts = ['a'.repeat(2000), 'b'.repeat(2000)];
    expect(splitBatches(texts).map((b) => b.length)).toEqual([1, 1]);
  });

  it('单段超长时仍然单独成批，不会死循环', () => {
    const batches = splitBatches(['x'.repeat(9000)]);
    expect(batches).toEqual([['x'.repeat(9000)]]);
  });

  it('空输入返回空批', () => {
    expect(splitBatches([])).toEqual([]);
  });
});

describe('splitLongText 超长单段切分', () => {
  it('短文本原样返回', () => {
    expect(splitLongText('hello world')).toEqual(['hello world']);
  });

  it('超长文本按句切分且每片不超过上限，内容不丢失', () => {
    const sentence = 'This is a sentence with some length. ';
    const text = sentence.repeat(300); // 约 11100 字符
    const pieces = splitLongText(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(3200);
    expect(pieces.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('无句读的 CJK 超长文本按硬长度切开', () => {
    const text = '汉'.repeat(9000);
    const pieces = splitLongText(text);
    expect(pieces.map((p) => p.length)).toEqual([3200, 3200, 2600]);
    expect(pieces.join('')).toBe(text);
  });
});

describe('joinSplitTranslations 回拼', () => {
  it('CJK 相邻直接拼接，不加空格', () => {
    expect(joinSplitTranslations(['汉字', '词组'], ['汉', '字'])).toBe('汉字');
  });

  it('拉丁文本相邻补一个空格', () => {
    expect(joinSplitTranslations(['abc def', 'ghi jkl'], ['ABC DEF', 'GHI JKL'])).toBe('ABC DEF GHI JKL');
  });
});
