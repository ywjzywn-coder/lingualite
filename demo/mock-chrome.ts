/**
 * 预览用的 chrome API 替身。
 * 必须在扩展页面入口之前被导入（ESM 按 import 顺序求值），因此单独成模块。
 */
import { DEFAULT_SETTINGS, createProvider } from '../src/shared/settings';
import { version } from '../package.json';

const settings = structuredClone({
  ...DEFAULT_SETTINGS,
  engine: 'llm',
  style: 'literal',
  glossaryText: 'prompt=提示词\ncontext window=上下文窗口\n# 这一行是注释\nembedding => 向量',
  extraInstructions: '统一用“您”称呼读者。',
  providers: [
    { ...createProvider('deepseek'), apiKey: 'sk-demo-key-not-real', model: 'deepseek-chat' },
    { ...createProvider('siliconflow') },
    { ...createProvider('ollama') },
  ],
  activeProviderId: 'deepseek',
});

const mock = {
  runtime: {
    lastError: undefined,
    getManifest: () => ({ version }),
    async sendMessage(message: { kind: string; patch?: unknown }) {
      switch (message.kind) {
        case 'settings:get':
          return { ok: true, data: settings };
        case 'settings:patch': {
          Object.assign(settings, message.patch);
          return { ok: true, data: settings };
        }
        case 'cache:clear':
          return { ok: true, data: { cleared: true } };
        case 'page:state':
          return { ok: true, data: { saved: true } };
        default:
          return { ok: false, error: `预览环境未实现：${message.kind}` };
      }
    },
    async openOptionsPage() {
      window.open('options.html', '_blank');
    },
  },
  tabs: {
    async query() {
      return [{ id: 1 }];
    },
    async sendMessage(_tabId: number, message: { kind?: string }) {
      if (message?.kind === 'content:get-page-state') {
        return { ok: true, data: { active: false } };
      }
      return { ok: true, data: { accepted: true } };
    },
  },
};

(globalThis as unknown as { chrome: unknown }).chrome = mock;
