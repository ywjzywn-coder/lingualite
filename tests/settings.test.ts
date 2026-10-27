import { describe, expect, it } from 'vitest';
import { deepMerge, normalizeSettings, parseGlossary } from '../src/shared/settings';

describe('normalizeSettings', () => {
  it('空数据回落到默认值', () => {
    const settings = normalizeSettings(undefined);
    expect(settings.engine).toBe('google');
    expect(settings.targetLang).toBe('zh-CN');
    expect(settings.providers).toHaveLength(1);
    expect(settings.features.select).toBe(true);
  });

  it('修复越界与非法枚举', () => {
    const settings = normalizeSettings({
      engine: 'something-else',
      providers: [{ id: 'x', batchSize: 999, temperature: 9, reasoningEffort: 'ultra' }],
    });
    expect(settings.engine).toBe('google');
    expect(settings.providers[0]!.batchSize).toBe(50);
    expect(settings.providers[0]!.temperature).toBe(2);
    expect(settings.providers[0]!.reasoningEffort).toBe('default');
  });

  it('activeProviderId 指向不存在的服务商时回落到第一个', () => {
    const settings = normalizeSettings({
      activeProviderId: 'missing',
      providers: [{ id: 'a' }, { id: 'b' }],
    });
    expect(settings.activeProviderId).toBe('a');
  });

  it('服务商列表为空时补一个默认服务商', () => {
    const settings = normalizeSettings({ providers: [] });
    expect(settings.providers).toHaveLength(1);
    expect(settings.activeProviderId).toBe(settings.providers[0]!.id);
  });

  it('缺失的功能开关补成 true', () => {
    const settings = normalizeSettings({ features: { page: false } });
    expect(settings.features.page).toBe(false);
    expect(settings.features.select).toBe(true);
  });

  it('非法风格档回落到默认值', () => {
    expect(normalizeSettings({ style: 'poetic' }).style).toBe('natural');
    expect(normalizeSettings({ style: 'literal' }).style).toBe('literal');
  });

  it('把旧版本存在服务商里的自定义提示词迁移成全局附加要求', () => {
    const settings = normalizeSettings({
      providers: [{ id: 'a', systemPrompt: '统一用“您”' }],
    });
    expect(settings.extraInstructions).toBe('统一用“您”');
    // 新字段已存在时以新字段为准
    const both = normalizeSettings({
      extraInstructions: '新的要求',
      providers: [{ id: 'a', systemPrompt: '旧的要求' }],
    });
    expect(both.extraInstructions).toBe('新的要求');
  });
});

describe('parseGlossary', () => {
  it('解析等号与箭头两种写法', () => {
    expect(parseGlossary('prompt=提示词\ncontext => 上下文')).toEqual([
      ['prompt', '提示词'],
      ['context', '上下文'],
    ]);
  });

  it('忽略空行与注释', () => {
    expect(parseGlossary('\n# 注释\n\nprompt=提示词\n')).toEqual([['prompt', '提示词']]);
  });

  it('译法本身含等号时只按第一个分隔符切分', () => {
    expect(parseGlossary('a=b=c')).toEqual([['a', 'b=c']]);
  });

  it('缺少一侧或没有分隔符的行被跳过', () => {
    expect(parseGlossary('=没有原文\n没有译法=\n这行没有分隔符')).toEqual([]);
  });

  it('限制条目数量，避免提示词无限膨胀', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `k${i}=v${i}`).join('\n');
    expect(parseGlossary(lines)).toHaveLength(100);
  });
});

describe('deepMerge', () => {
  it('递归合并对象', () => {
    const merged = deepMerge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3 } });
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 3 } });
  });

  it('数组整体替换而不是逐项合并', () => {
    const merged = deepMerge({ list: [1, 2, 3] }, { list: [9] });
    expect(merged.list).toEqual([9]);
  });

  it('patch 为 undefined 时保持原值', () => {
    const merged = deepMerge({ a: 1 }, { a: undefined });
    expect(merged.a).toBe(1);
  });
});
