import { describe, expect, it } from 'vitest';
import { diffSettings } from '../src/options/settings-diff';
import { normalizeSettings } from '../src/shared/settings';

describe('diffSettings 按字段回写', () => {
  it('完全一致时返回空补丁', () => {
    const settings = normalizeSettings({});
    expect(diffSettings(settings, settings)).toEqual({});
    expect(diffSettings(settings, structuredClone(settings))).toEqual({});
  });

  it('只包含被修改的顶层字段', () => {
    const saved = normalizeSettings({});
    const current = normalizeSettings({ targetLang: 'ja', style: 'formal' });
    const patch = diffSettings(saved, current);
    expect(Object.keys(patch).sort()).toEqual(['style', 'targetLang']);
  });

  it('嵌套对象内容相同但引用不同时不误报', () => {
    const saved = normalizeSettings({});
    const current = structuredClone(saved);
    // 引用不同、内容相同的 providers / features 不应出现在补丁里
    expect(diffSettings(saved, current)).toEqual({});
  });

  it('provider 内部修改体现为整个 providers 键', () => {
    const saved = normalizeSettings({});
    const current = normalizeSettings({});
    current.providers[0]!.apiKey = 'sk-new';
    const patch = diffSettings(saved, current);
    expect(Object.keys(patch)).toEqual(['providers']);
    expect((patch.providers as Array<{ apiKey: string }>)[0]!.apiKey).toBe('sk-new');
  });
});
