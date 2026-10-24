import { describe, expect, it, vi } from 'vitest';
import {
  LlmEngine,
  buildChatBody,
  buildHeaders,
  extractContent,
  resolveChatCompletionsUrl,
} from '../src/engines/openai-compat';
import { createProvider } from '../src/shared/settings';

function provider(patch: Partial<ReturnType<typeof createProvider>> = {}) {
  return { ...createProvider('custom'), baseUrl: 'https://api.example.com/v1', model: 'test-model', ...patch };
}

describe('resolveChatCompletionsUrl', () => {
  it('自动补全 /chat/completions', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('容忍结尾斜杠', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/v1///')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('已写全路径时原样使用', () => {
    expect(resolveChatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('空地址抛错', () => {
    expect(() => resolveChatCompletionsUrl('   ')).toThrow();
  });
});

describe('buildChatBody', () => {
  it('带上模型、温度与双消息', () => {
    const body = buildChatBody({ provider: provider({ temperature: 0.3 }), system: 'S', user: 'U' });
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0.3);
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
  });

  it('默认不发送思考强度字段', () => {
    const body = buildChatBody({ provider: provider({ reasoningEffort: 'default' }), system: 'S', user: 'U' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('思考强度映射到 reasoning_effort', () => {
    const body = buildChatBody({ provider: provider({ reasoningEffort: 'high' }), system: 'S', user: 'U' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('额外请求参数最后合并，可以覆盖任何字段', () => {
    const body = buildChatBody({
      provider: provider({
        extraBody: '{"thinking":{"type":"enabled"},"temperature":1.5}',
      }),
      system: 'S',
      user: 'U',
    });
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.temperature).toBe(1.5);
  });

  it('额外请求参数不是 JSON 时给出可读错误', () => {
    expect(() => buildChatBody({ provider: provider({ extraBody: '{oops' }), system: 'S', user: 'U' })).toThrow(
      /额外请求参数/,
    );
  });

  it('缺少模型名时抛错', () => {
    expect(() => buildChatBody({ provider: provider({ model: ' ' }), system: 'S', user: 'U' })).toThrow(/模型名/);
  });
});

describe('buildHeaders', () => {
  it('没填 key 时不带 Authorization（适配本地 Ollama）', () => {
    expect(buildHeaders(provider({ apiKey: '' })).authorization).toBeUndefined();
  });

  it('填了 key 时使用 Bearer', () => {
    expect(buildHeaders(provider({ apiKey: 'sk-abc' })).authorization).toBe('Bearer sk-abc');
  });

  it('额外请求头会合并进来', () => {
    const headers = buildHeaders(provider({ extraHeaders: '{"x-api-version":"2024-01-01"}' }));
    expect(headers['x-api-version']).toBe('2024-01-01');
  });
});

describe('extractContent', () => {
  it('标准字符串 content', () => {
    expect(extractContent({ choices: [{ message: { content: '你好' } }] })).toBe('你好');
  });

  it('分段数组 content', () => {
    const data = { choices: [{ message: { content: [{ text: '你' }, { text: '好' }] } }] };
    expect(extractContent(data)).toBe('你好');
  });

  it('少数实现把结果放在 text 字段', () => {
    expect(extractContent({ text: '你好' })).toBe('你好');
  });

  it('无法识别时抛错', () => {
    expect(() => extractContent({ choices: [] })).toThrow(/无法识别/);
  });

  it('finish_reason=length 表示输出被截断，抛错而不是返回半句', () => {
    const data = { choices: [{ finish_reason: 'length', message: { content: '<<1>>半句译文' } }] };
    expect(() => extractContent(data)).toThrow(/截断/);
  });

  it('正常 finish 不受影响', () => {
    const data = { choices: [{ finish_reason: 'stop', message: { content: '你好' } }] };
    expect(extractContent(data)).toBe('你好');
  });
});

describe('postChat 配置错误不该被报成网络问题', () => {
  it('额外请求参数是非法 JSON 时直接给出字段错误，且不发起网络请求', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch 不应被调用');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const engine = new LlmEngine({
      provider: provider({ extraBody: '{oops' }),
      useContext: true,
      style: 'natural',
      extraInstructions: '',
    });
    await expect(engine.translate(['alpha'], 'auto', 'zh-CN')).rejects.toThrow(/额外请求参数/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
