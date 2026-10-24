import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildUserPrompt, parseBatchResponse } from '../src/engines/prompt';

describe('buildUserPrompt', () => {
  it('给每段加上编号标签并用 %% 分隔', () => {
    expect(buildUserPrompt(['Hello', 'World'])).toBe('<<1>>Hello\n%%\n<<2>>World');
  });

  it('单段也带标签', () => {
    expect(buildUserPrompt(['Hello'])).toBe('<<1>>Hello');
  });
});

describe('parseBatchResponse', () => {
  it('单段直接返回原文，去掉标签', () => {
    expect(parseBatchResponse('<<1>>你好', 1)).toEqual(['你好']);
    expect(parseBatchResponse('你好', 1)).toEqual(['你好']);
  });

  it('按标签顺序解析多段', () => {
    expect(parseBatchResponse('<<1>>你好\n%%\n<<2>>世界', 2)).toEqual(['你好', '世界']);
  });

  it('模型调换顺序时按标签归位', () => {
    expect(parseBatchResponse('<<2>>世界\n%%\n<<1>>你好', 2)).toEqual(['你好', '世界']);
  });

  it('模型漏掉标签时回退到按分隔符顺序解析', () => {
    expect(parseBatchResponse('你好\n%%\n世界', 2)).toEqual(['你好', '世界']);
  });

  it('容忍标签与换行的空白差异', () => {
    expect(parseBatchResponse('  <<1>>\n  你好\n  %%\n  <<2>>\n  世界  ', 2)).toEqual(['你好', '世界']);
  });

  it('保留译文内部的换行', () => {
    expect(parseBatchResponse('<<1>>第一行\n第二行\n%%\n<<2>>另一段', 2)).toEqual([
      '第一行\n第二行',
      '另一段',
    ]);
  });

  it('段数不匹配时抛错', () => {
    expect(() => parseBatchResponse('<<1>>只有一段', 3)).toThrow();
  });

  it('允许某段译文为空', () => {
    expect(parseBatchResponse('<<1>>\n%%\n<<2>>世界', 2)).toEqual(['', '世界']);
  });
});

describe('buildSystemPrompt', () => {
  const base = { to: 'zh-CN', from: 'auto', useContext: true, style: 'natural' as const };

  it('包含目标语言与格式约束', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toContain('Simplified Chinese');
    expect(prompt).toContain('%%');
    expect(prompt).toContain('<<1>>');
  });

  it('明确禁止代码围栏，避免解析失败', () => {
    expect(buildSystemPrompt(base)).toContain('code fences');
  });

  it('覆盖代码标识符与品牌名的处理规则', () => {
    const prompt = buildSystemPrompt(base);
    expect(prompt).toMatch(/code identifiers/i);
    expect(prompt).toMatch(/brand, product and company names/i);
  });

  it('开启上下文时带上标题与摘要，关闭时不带', () => {
    const context = { title: '示例标题', summary: '这是一段摘要' };
    expect(buildSystemPrompt({ ...base, context })).toContain('示例标题');
    expect(buildSystemPrompt({ ...base, context, useContext: false })).not.toContain('示例标题');
  });

  it('术语表按原文 => 译法注入', () => {
    const prompt = buildSystemPrompt({
      ...base,
      context: { glossary: [['prompt', '提示词']] },
    });
    expect(prompt).toContain('prompt => 提示词');
  });

  it('默认风格不追加额外片段', () => {
    const natural = buildSystemPrompt({ ...base, style: 'natural' });
    expect(natural).not.toContain('STYLE —');
  });

  it('各风格档只追加差异片段，不替换固定规则', () => {
    for (const style of ['literal', 'casual', 'formal'] as const) {
      const prompt = buildSystemPrompt({ ...base, style });
      expect(prompt).toContain('STYLE —');
      // 固定规则仍然在
      expect(prompt).toContain('code fences');
      expect(prompt).toContain('Simplified Chinese');
    }
  });

  it('忠实直译档强调保留原文语序', () => {
    expect(buildSystemPrompt({ ...base, style: 'literal' })).toMatch(/word order/i);
  });

  it('附加要求追加在最后，且不替换内置规则', () => {
    const prompt = buildSystemPrompt({ ...base, extraInstructions: '统一用“您”称呼读者' });
    expect(prompt).toContain('统一用“您”称呼读者');
    // 关键：内置规则必须保留，这正是「附加」与「替换」的区别
    expect(prompt).toContain('code fences');
    expect(prompt.indexOf('ADDITIONAL REQUIREMENTS')).toBeGreaterThan(prompt.indexOf('OUTPUT FORMAT'));
  });

  it('附加要求为空或纯空白时不影响结果', () => {
    expect(buildSystemPrompt({ ...base, extraInstructions: '   ' })).toBe(buildSystemPrompt(base));
  });
});
