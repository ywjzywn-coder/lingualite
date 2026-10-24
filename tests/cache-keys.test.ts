import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheRow } from '../src/shared/cache';
import { shortHash } from '../src/shared/hash';
import { normalizeSettings, type Settings } from '../src/shared/settings';

/**
 * 翻译缓存键的端到端测试。
 *
 * cache.ts 依赖 IndexedDB，这里装一个内存替身（只实现用到的最小接口），
 * 配合模块重置，让 translateTexts 的完整「缓存 -> 引擎 -> 写缓存」链路可以在 Node 里跑通。
 */

function installFakeIdb(): Map<string, CacheRow> {
  const rows = new Map<string, CacheRow>();
  class FakeRequest<T> {
    onsuccess: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public result: T) {
      // promisify 在拿到请求对象后才挂回调，因此用微任务异步触发
      queueMicrotask(() => this.onsuccess?.());
    }
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction(_store: string, _mode?: string) {
      return {
        objectStore: () => ({
          get: (key: string) => new FakeRequest<CacheRow | null>(rows.get(key) ?? null),
          put: (row: CacheRow) => {
            rows.set(row.key, row);
            return new FakeRequest(undefined);
          },
        }),
      };
    },
  };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
    open: () => new FakeRequest(db),
  };
  return rows;
}

type FetchHandler = (url: string, init: RequestInit | undefined) => unknown;

function stubFetch(handler: FetchHandler): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function llmSettings(overrides: Partial<Settings> = {}): Settings {
  return normalizeSettings({
    engine: 'llm',
    fallbackToGoogle: true,
    useContext: false,
    providers: [
      {
        id: 'test',
        label: 'Test',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        temperature: 0,
        reasoningEffort: 'none',
        extraBody: '',
        extraHeaders: '',
        batchSize: 10,
      },
    ],
    activeProviderId: 'test',
    ...overrides,
  });
}

let rows: Map<string, CacheRow>;

beforeEach(() => {
  vi.resetModules();
  rows = installFakeIdb();
});

/** 每个用例里动态导入，保证拿到与新装的 IDB 替身配套的模块实例。 */
async function loadEngines() {
  const engines = await import('../src/engines');
  const settings = await import('../src/shared/settings');
  return { ...engines, ...settings };
}

describe('缓存键与降级写入', () => {
  it('LLM 失败降级后，Google 译文写入 Google 键而不是 LLM 键', async () => {
    const { translateTexts, cacheKeyFor } = await loadEngines();
    const settings = llmSettings();
    stubFetch((url) => {
      if (url.includes('api.example.com')) return jsonResponse({ error: 'boom' }, false, 500);
      return jsonResponse(['谷歌译文']);
    });

    const res = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(res.engine).toContain('降级');
    expect(rows.size).toBe(1);

    const expectedKey = await shortHash(cacheKeyFor('google', 'auto', 'zh-CN', 'default', 'alpha'));
    const row = rows.get(expectedKey)!;
    expect(row).toBeDefined();
    expect(row.engine).toBe('google');
    expect(row.texts).toEqual(['谷歌译文']);
  });

  it('模型恢复后不会被降级缓存顶掉，会用模型重新翻译', async () => {
    const { translateTexts } = await loadEngines();
    const settings = llmSettings();
    let llmHealthy = false;
    stubFetch((url) => {
      if (url.includes('api.example.com')) {
        if (!llmHealthy) return jsonResponse({ error: 'boom' }, false, 500);
        return jsonResponse({ choices: [{ message: { content: '<<1>>模型译文' } }] });
      }
      return jsonResponse(['谷歌译文']);
    });

    await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    llmHealthy = true;
    const res = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(res.texts).toEqual(['模型译文']);
    expect(res.engine).toBe('Test');
    expect(res.requestCount).toBe(1);
  });

  it('LLM 持续失败时，后续请求直接命中 Google 降级缓存，不再重复请求 Google', async () => {
    const { translateTexts } = await loadEngines();
    const settings = llmSettings();
    let googleCalls = 0;
    stubFetch((url) => {
      if (url.includes('api.example.com')) return jsonResponse({ error: 'boom' }, false, 500);
      googleCalls += 1;
      return jsonResponse(['谷歌译文']);
    });

    const first = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(first.requestCount).toBe(1);
    expect(googleCalls).toBe(1);

    const second = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(second.texts).toEqual(['谷歌译文']);
    expect(second.requestCount).toBe(0);
    expect(googleCalls).toBe(1);
  });

  it('开启 useContext 时不同页面上下文不会互相命中缓存', async () => {
    const { translateTexts } = await loadEngines();
    const settings = llmSettings({ useContext: true });
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: `<<1>>译${calls}` } }] });
    });

    const bank = { title: 'Banking news', summary: 'financial report about banks' };
    const river = { title: 'Riverside travel', summary: 'a guide to the river bank' };

    const first = await translateTexts(
      { texts: ['The bank is steep.'], from: 'en', to: 'zh-CN', context: bank },
      settings,
    );
    const second = await translateTexts(
      { texts: ['The bank is steep.'], from: 'en', to: 'zh-CN', context: river },
      settings,
    );
    // 同一原文、同一上下文再次请求才命中缓存
    const third = await translateTexts(
      { texts: ['The bank is steep.'], from: 'en', to: 'zh-CN', context: bank },
      settings,
    );
    expect(second.texts[0]).not.toBe(first.texts[0]);
    expect(third.texts).toEqual(first.texts);
    expect(third.cachedCount).toBe(1);
    expect(calls).toBe(2);
  });

  it('换 base URL 后不命中旧缓存', async () => {
    const { translateTexts } = await loadEngines();
    const settings = llmSettings();
    let calls = 0;
    stubFetch((url) => {
      if (url.includes('/chat/completions')) {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: '<<1>>模型译文' } }] });
      }
      return jsonResponse(['谷歌译文']);
    });

    await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    settings.providers[0]!.baseUrl = 'https://api2.example.com/v1';
    const res = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(res.requestCount).toBe(1);
    expect(calls).toBe(2);
  });

  it('noCache 跳过缓存读写，强制真实请求', async () => {
    const { translateTexts } = await loadEngines();
    const settings = llmSettings();
    let calls = 0;
    stubFetch((url) => {
      if (url.includes('api.example.com')) {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: '<<1>>模型译文' } }] });
      }
      return jsonResponse(['谷歌译文']);
    });

    await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN', noCache: true }, settings);
    const res = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN', noCache: true }, settings);
    expect(res.requestCount).toBe(1);
    expect(calls).toBe(2);
    expect(rows.size).toBe(0);
  });

  it('noCache 时 LLM 失败不降级：直接报错，且不请求 Google（试译语义）', async () => {
    const { translateTexts } = await loadEngines();
    const settings = llmSettings();
    let googleCalls = 0;
    stubFetch((url) => {
      if (url.includes('api.example.com')) return jsonResponse({ error: 'boom' }, false, 500);
      googleCalls += 1;
      return jsonResponse(['谷歌译文']);
    });

    await expect(
      translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN', noCache: true }, settings),
    ).rejects.toThrow();
    expect(googleCalls).toBe(0);
    // 不写任何缓存
    expect(rows.size).toBe(0);
  });

  it('Google 作为主引擎时结果写入 Google 键，第二次命中缓存', async () => {
    const { translateTexts, cacheKeyFor } = await loadEngines();
    const settings = normalizeSettings({});
    const calls = stubFetch(() => jsonResponse(['谷歌译文']));

    const first = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(first.requestCount).toBe(1);
    const second = await translateTexts({ texts: ['alpha'], from: 'auto', to: 'zh-CN' }, settings);
    expect(second.cachedCount).toBe(1);
    expect(second.requestCount).toBe(0);
    expect(calls).toHaveLength(1);

    const expectedKey = await shortHash(cacheKeyFor('google', 'auto', 'zh-CN', 'default', 'alpha'));
    expect(rows.get(expectedKey)).toBeDefined();
  });
});
