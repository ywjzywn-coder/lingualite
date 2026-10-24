import { beforeEach, describe, expect, it } from 'vitest';

// 内存实现替身 chrome.storage.local，验证 patchSettings 的并发串行化。
const store = new Map<string, unknown>();

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      async get(key: string) {
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
    },
  },
};

const { SETTINGS_KEY, normalizeSettings, patchSettings, publicSettings, validateProviderJson } =
  await import('../src/shared/settings');

beforeEach(() => {
  store.clear();
  store.set(SETTINGS_KEY, normalizeSettings(undefined));
});

describe('patchSettings 并发串行化', () => {
  it('并发 patch 按顺序合并，后到的不会覆盖先到的字段', async () => {
    await Promise.all([patchSettings({ targetLang: 'en' }), patchSettings({ style: 'literal' })]);
    const saved = store.get(SETTINGS_KEY) as { targetLang: string; style: string };
    expect(saved.targetLang).toBe('en');
    expect(saved.style).toBe('literal');
  });

  it('串行多次 patch 全部生效', async () => {
    await patchSettings({ targetLang: 'ja' });
    await patchSettings({ engine: 'llm' });
    await patchSettings({ extraInstructions: '统一用“您”' });
    const saved = store.get(SETTINGS_KEY) as {
      targetLang: string;
      engine: string;
      extraInstructions: string;
    };
    expect(saved.targetLang).toBe('ja');
    expect(saved.engine).toBe('llm');
    expect(saved.extraInstructions).toBe('统一用“您”');
  });
});

describe('publicSettings 密钥隔离', () => {
  it('只暴露语言、风格与功能开关，不含服务商与 API Key', () => {
    const settings = normalizeSettings({
      providers: [{ id: 'p', apiKey: 'sk-secret', model: 'm' }],
      activeProviderId: 'p',
    });
    const pub = publicSettings(settings) as unknown as Record<string, unknown>;
    expect(Object.keys(pub).sort()).toEqual(['features', 'sourceLang', 'style', 'targetLang']);
    expect(JSON.stringify(pub)).not.toContain('sk-secret');
  });
});

describe('validateProviderJson', () => {
  it('空字段合法', () => {
    const settings = normalizeSettings({});
    expect(validateProviderJson(settings.providers[0]!)).toBeNull();
  });

  it('非法 JSON 给出字段名', () => {
    const settings = normalizeSettings({ providers: [{ id: 'p', extraBody: '{oops' }] });
    expect(validateProviderJson(settings.providers[0]!)).toMatch(/额外请求参数/);
  });

  it('JSON 数组不是合法的请求体对象', () => {
    const settings = normalizeSettings({ providers: [{ id: 'p', extraHeaders: '[1,2]' }] });
    expect(validateProviderJson(settings.providers[0]!)).toMatch(/额外请求头/);
  });

  it('合法对象通过校验', () => {
    const settings = normalizeSettings({
      providers: [{ id: 'p', extraBody: '{"top_p":0.9}', extraHeaders: '{"x-a":"1"}' }],
    });
    expect(validateProviderJson(settings.providers[0]!)).toBeNull();
  });
});
