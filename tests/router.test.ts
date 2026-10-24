import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用内存实现替身 chrome.storage，让 Service Worker 侧的路由可以在 Node 里跑通。
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
    onChanged: { addListener() {} },
  },
  runtime: {
    getManifest: () => ({ version: '0.0.0' }),
    getURL: (path = '') => `chrome-extension://unit-test/${path}`,
  },
};

const { handleMessage } = await import('../src/background/router');
const { invalidateSettingsCache, SETTINGS_KEY } = await import('../src/shared/settings');

/** 构造一个按调用次数返回不同结果的 fetch 替身。 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

beforeEach(() => {
  store.clear();
  invalidateSettingsCache();
  vi.restoreAllMocks();
});

describe('router 消息分发', () => {
  it('ping 有响应', async () => {
    const res = await handleMessage({ kind: 'ping' });
    expect(res).toEqual({ ok: true, data: { pong: true } });
  });

  it('未知消息类型返回错误而不是抛出', async () => {
    const res = await handleMessage({ kind: 'nope' } as never);
    expect(res.ok).toBe(false);
  });

  it('settings:get 在首次运行时给出默认值', async () => {
    const res = await handleMessage({ kind: 'settings:get' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const settings = res.data as { engine: string; targetLang: string };
      expect(settings.engine).toBe('google');
      expect(settings.targetLang).toBe('zh-CN');
    }
  });

  it('settings:patch 只改传入的字段并持久化', async () => {
    await handleMessage({ kind: 'settings:patch', patch: { targetLang: 'ja' } });
    const res = await handleMessage({ kind: 'settings:get' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const settings = res.data as { targetLang: string; sourceLang: string; engine: string };
      expect(settings.targetLang).toBe('ja');
      expect(settings.sourceLang).toBe('auto');
      expect(settings.engine).toBe('google');
    }
    expect(store.has(SETTINGS_KEY)).toBe(true);
  });

  it('settings:patch 会把非法值规范化', async () => {
    const res = await handleMessage({ kind: 'settings:patch', patch: { engine: 'gpt' } });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { engine: string }).engine).toBe('google');
  });

  it('内容脚本来源的 settings:get 只返回公开字段，密钥不出扩展', async () => {
    await handleMessage({
      kind: 'settings:patch',
      patch: {
        providers: [
          {
            id: 'p',
            label: 'P',
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'sk-secret',
            model: 'm',
            temperature: 0,
            reasoningEffort: 'none',
            extraBody: '',
            extraHeaders: '',
            batchSize: 10,
          },
        ],
        activeProviderId: 'p',
      },
    });

    // 内容脚本：运行在页面源（https URL），即使带 tab.id 也只给公开字段
    const fromContentScript = await handleMessage(
      { kind: 'settings:get' },
      { tab: { id: 7 }, url: 'https://example.com/article', origin: 'https://example.com' } as never,
    );
    expect(fromContentScript.ok).toBe(true);
    if (fromContentScript.ok) {
      const data = fromContentScript.data as Record<string, unknown>;
      expect(Object.keys(data).sort()).toEqual(['features', 'sourceLang', 'style', 'targetLang']);
      expect(JSON.stringify(data)).not.toContain('sk-secret');
    }

    // 扩展页面（popup/options）仍然拿全量设置。
    // 回归防护：设置页打开在标签页里，sender 同时带 tab.id 和扩展源 URL——
    // 曾因只用 tab 判断而被误判成内容脚本，导致设置页 providers 缺失崩溃。
    const fromOptionsPage = await handleMessage(
      { kind: 'settings:get' },
      {
        tab: { id: 7 },
        url: 'chrome-extension://unit-test/options.html',
        origin: 'chrome-extension://unit-test',
      } as never,
    );
    expect(fromOptionsPage.ok).toBe(true);
    if (fromOptionsPage.ok) {
      const data = fromOptionsPage.data as { providers: Array<{ apiKey: string }> };
      expect(data.providers[0]!.apiKey).toBe('sk-secret');
    }

    // 无 sender（popup 等扩展上下文）同样拿全量
    const fromPage = await handleMessage({ kind: 'settings:get' });
    expect(fromPage.ok).toBe(true);
    if (fromPage.ok) {
      const data = fromPage.data as { providers: Array<{ apiKey: string }> };
      expect(data.providers[0]!.apiKey).toBe('sk-secret');
    }
  });

  it('settings:patch 拒绝内容脚本来源，扩展页面可以修改', async () => {
    const fromContentScript = await handleMessage(
      { kind: 'settings:patch', patch: { targetLang: 'ja' } },
      { tab: { id: 7 }, url: 'https://example.com/page', origin: 'https://example.com' } as never,
    );
    expect(fromContentScript.ok).toBe(false);

    // 被拒绝的补丁不应生效
    const untouched = await handleMessage({ kind: 'settings:get' });
    if (untouched.ok) expect((untouched.data as { targetLang: string }).targetLang).toBe('zh-CN');

    const fromOptions = await handleMessage(
      { kind: 'settings:patch', patch: { targetLang: 'ko' } },
      { tab: { id: 7 }, url: 'chrome-extension://unit-test/options.html' } as never,
    );
    expect(fromOptions.ok).toBe(true);
    const check = await handleMessage({ kind: 'settings:get' });
    if (check.ok) expect((check.data as { targetLang: string }).targetLang).toBe('ko');
  });
});

describe('translate 全链路（Google 引擎）', () => {
  it('按顺序返回译文，并对重复段落去重', async () => {
    const calls = stubFetch((_url, init) => {
      const body = String(init?.body ?? '');
      const count = body.split('&').filter((part) => part.startsWith('q=')).length;
      return jsonResponse(Array.from({ length: count }, (_, i) => `译文${i + 1}`));
    });

    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['alpha', 'beta', 'alpha'], from: 'auto', to: 'zh-CN' },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { texts: string[]; requestCount: number; engine: string };
      expect(data.texts).toEqual(['译文1', '译文2', '译文1']);
      expect(data.engine).toBe('Google 免费接口');
    }
    // 三个段落只有两个唯一文本，应当只发一次请求
    expect(calls).toHaveLength(1);
  });

  it('空输入直接返回空结果，不发请求', async () => {
    const calls = stubFetch(() => jsonResponse([]));
    const res = await handleMessage({ kind: 'translate', req: { texts: [], from: 'auto', to: 'zh-CN' } });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('超过单批段数上限时自动切批', async () => {
    await handleMessage({ kind: 'settings:patch', patch: { targetLang: 'zh-CN' } });
    const calls = stubFetch((_url, init) => {
      const body = String(init?.body ?? '');
      const count = body.split('&').filter((part) => part.startsWith('q=')).length;
      return jsonResponse(Array.from({ length: count }, (_, i) => `t${i}`));
    });
    const texts = Array.from({ length: 45 }, (_, i) => `text-${i}`);
    const res = await handleMessage({ kind: 'translate', req: { texts, from: 'auto', to: 'zh-CN' } });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { texts: string[] }).texts).toHaveLength(45);
    expect(calls).toHaveLength(2);
  });

  it('Google 接口失败时返回可读错误', async () => {
    stubFetch(() => jsonResponse({ message: 'rate limited' }, false, 429));
    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['hello'], from: 'auto', to: 'zh-CN' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/429/);
  });

  it('调用方省略语言时，用设置里的原文/译文语言兜底', async () => {
    await handleMessage({ kind: 'settings:patch', patch: { sourceLang: 'en', targetLang: 'ja' } });
    stubFetch((_url, init) => {
      const body = String(init?.body ?? '');
      const count = body.split('&').filter((part) => part.startsWith('q=')).length;
      return jsonResponse(Array.from({ length: count }, (_, i) => `訳${i}`));
    });
    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['hello'], from: '', to: '' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { from: string; to: string; texts: string[] };
      expect(data.from).toBe('en');
      expect(data.to).toBe('ja');
      expect(data.texts).toEqual(['訳0']);
    }
  });

  it('结果里回带实际使用的语言，供界面显示与朗读用', async () => {
    stubFetch(() => jsonResponse(['译文']));
    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['hello'], from: 'auto', to: 'ko' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { from: string; to: string };
      expect(data.from).toBe('auto');
      expect(data.to).toBe('ko');
    }
  });
});

describe('translate 全链路（LLM 引擎）', () => {
  beforeEach(async () => {
    await handleMessage({
      kind: 'settings:patch',
      patch: {
        engine: 'llm',
        fallbackToGoogle: false,
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
            systemPrompt: '',
            batchSize: 10,
          },
        ],
        activeProviderId: 'test',
      },
    });
  });

  it('按批量协议发送并解析回等长结果', async () => {
    const calls = stubFetch((url, init) => {
      expect(url).toBe('https://api.example.com/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('test-model');
      expect(body.reasoning_effort).toBe('none');
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).toContain('Simplified Chinese');
      const user = body.messages[1].content as string;
      const chunks = user.split('\n%%\n');
      expect(chunks[0]).toBe('<<1>>alpha');
      expect(chunks[1]).toBe('<<2>>beta');
      return jsonResponse({
        choices: [{ message: { content: '<<1>>甲\n%%\n<<2>>乙' } }],
      });
    });

    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['alpha', 'beta'], from: 'auto', to: 'zh-CN' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { texts: string[] }).texts).toEqual(['甲', '乙']);
    expect(calls).toHaveLength(1);
  });

  it('模型返回段数不对时给出明确错误', async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: '<<1>>只有一段' } }] }));
    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['alpha', 'beta'], from: 'auto', to: 'zh-CN' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/段落数/);
  });

  it('模型失败且关闭降级时报错而非静默返回原文', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'no key' } }, false, 401));
    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['alpha'], from: 'auto', to: 'zh-CN' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/401/);
  });

  it('模型失败但开启降级时改用 Google 补上', async () => {
    await handleMessage({ kind: 'settings:patch', patch: { fallbackToGoogle: true } });
    stubFetch((url) => {
      if (url.includes('api.example.com')) return jsonResponse({ error: 'boom' }, false, 500);
      return jsonResponse(['谷歌译文']);
    });
    const res = await handleMessage({
      kind: 'translate',
      req: { texts: ['alpha'], from: 'auto', to: 'zh-CN' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { texts: string[]; engine: string };
      expect(data.texts).toEqual(['谷歌译文']);
      expect(data.engine).toContain('降级');
    }
  });
});
