import { describe, expect, it } from 'vitest';
import { cleanSelectionText, MAX_SELECTION_CHARS } from '../src/shared/text';

describe('cleanSelectionText', () => {
  it('折叠换行与多余空格', () => {
    expect(cleanSelectionText('  hello\n\n  world  ')).toBe('hello world');
  });

  it('保留单个词', () => {
    expect(cleanSelectionText('  serendipity ')).toBe('serendipity');
  });

  it('中文之间不引入多余空格', () => {
    expect(cleanSelectionText('这是一句话\n\n另一句')).toBe('这是一句话 另一句');
  });

  it('超长选区被截断到上限，避免发出巨大的请求', () => {
    const long = 'a'.repeat(MAX_SELECTION_CHARS * 2);
    expect(cleanSelectionText(long)).toHaveLength(MAX_SELECTION_CHARS);
  });

  it('空与纯空白输入返回空串', () => {
    expect(cleanSelectionText('')).toBe('');
    expect(cleanSelectionText('   \n\t  ')).toBe('');
  });
});
