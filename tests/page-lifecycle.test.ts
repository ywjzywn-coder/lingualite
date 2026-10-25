// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 网页翻译生命周期回归测试。
 *
 * 覆盖三类真实事故：
 * 1. 逐段语言检测等待期间点「还原原文」——修复前会留下 skipped 标记、进度胶囊复活；
 * 2. 启动流程未完成时并发再点一次——修复前会产生两个 IntersectionObserver；
 * 3. 站点改掉已翻译段落的文字——修复前旧译文永远挂着不更新。
 *
 * IntersectionObserver / chrome.* 都用可控制的替身。
 */

type DetectCallback = (result: {
  isReliable: boolean;
  languages: Array<{ language: string; percentage: number }>;
}) => void;

const state = {
  settings: { features: { page: true, select: true, video: true, vocab: true, asr: true }, targetLang: 'zh-CN' },
  /** manual：检测请求进队列由测试放行；auto：立刻按 autoDetect 返回。 */
  detectMode: 'auto' as 'auto' | 'manual',
  detectQueue: [] as DetectCallback[],
  /** auto 模式下返回的语言。 */
  autoDetect: 'en' as string,
  translateCalls: [] as string[][],
  /** immediate：sendMessage 立刻回执；deferred：挂起等待测试手动放行。 */
  translateMode: 'immediate' as 'immediate' | 'deferred',
  translateDeferreds: [] as Array<(res: unknown) => void>,
  pageStates: [] as boolean[],
};

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    queueMicrotask(() =>
      this.callback(
        [{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    lastError: undefined,
    async sendMessage(message: { kind: string; active?: boolean; req?: { texts?: string[] } }) {
      switch (message.kind) {
        case 'settings:get':
          return { ok: true, data: state.settings };
        case 'page:state':
          state.pageStates.push(Boolean(message.active));
          return { ok: true, data: { saved: true } };
        case 'translate': {
          const texts = message.req?.texts ?? [];
          state.translateCalls.push(texts);
          if (state.translateMode === 'deferred') {
            return new Promise((resolve) => state.translateDeferreds.push(resolve));
          }
          return {
            ok: true,
            data: {
              texts: texts.map((t) => `译(${t.slice(0, 10)})`),
              engine: '模拟引擎',
              from: 'en',
              to: 'zh-CN',
              cachedCount: 0,
              requestCount: 1,
            },
          };
        }
        default:
          return { ok: false, error: `未实现的消息：${message.kind}` };
      }
    },
  },
  i18n: {
    detectLanguage(_text: string, callback: DetectCallback) {
      if (state.detectMode === 'manual') {
        state.detectQueue.push(callback);
        return;
      }
      callback({ isReliable: true, languages: [{ language: state.autoDetect, percentage: 90 }] });
    },
  },
};

vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

const { restorePage, translatePage } = await import('../src/content/page');

/** 放行一个挂起中的语言检测请求（manual 模式）。 */
function resolveDetect(language: string): void {
  const callback = state.detectQueue.shift();
  if (!callback) throw new Error('没有待处理的检测请求');
  callback({ isReliable: true, languages: [{ language, percentage: 90 }] });
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  state.detectMode = 'auto';
  state.detectQueue = [];
  state.autoDetect = 'en';
  state.translateCalls = [];
  state.translateMode = 'immediate';
  state.translateDeferreds = [];
  state.pageStates = [];
  FakeIntersectionObserver.instances = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  restorePage();
});

describe('网页翻译生命周期', () => {
  it('逐段语言检测等待期间点还原：不留标记、不插译文、胶囊不复活', async () => {
    document.body.innerHTML = '<p>First paragraph text</p><p>Second paragraph text</p>';
    state.detectMode = 'manual';
    state.translateMode = 'deferred';

    const started = translatePage();
    await tick(0);
    // 整页判定为目标语言，才会走逐段检测路径
    resolveDetect('zh');
    expect(await started).toEqual({ started: true });
    expect(state.pageStates.at(-1)).toBe(true);

    // 等 flush 触发、runBatch 停在逐段语言检测的 await 上
    await tick(200);
    expect(state.detectQueue).toHaveLength(1);
    expect(document.querySelectorAll('[data-ll-block]').length).toBeGreaterThan(0);

    // 此刻还原：旧实现会在检测返回后把段落标成 skipped，进度胶囊重新出现
    restorePage();
    resolveDetect('zh');

    await tick(700);
    expect(document.querySelectorAll('.ll-tr')).toHaveLength(0);
    expect(document.querySelectorAll('[data-ll-block]')).toHaveLength(0);
    expect(document.querySelector('#lingualite-chip')).toBeNull();
    expect(state.pageStates.at(-1)).toBe(false);
    // 还原之后不该再发出任何翻译请求
    expect(state.translateCalls).toHaveLength(0);
  });

  it('启动未完成时并发再点一次，只创建一个观察器', async () => {
    document.body.innerHTML = '<p>First paragraph text</p><p>Second paragraph text</p>';
    state.autoDetect = 'en';

    const [first, second] = await Promise.all([translatePage(), translatePage()]);
    expect(first.started).toBe(true);
    expect(second.started).toBe(true);
    expect(FakeIntersectionObserver.instances).toHaveLength(1);

    await tick(400);
    expect(document.querySelectorAll('.ll-tr')).toHaveLength(2);
  });

  it('已翻译段落的文字被站点改掉后，会自动重新翻译', async () => {
    document.body.innerHTML = '<p id="a">Original text one</p>';
    state.autoDetect = 'en';

    await translatePage();
    await tick(400);
    expect(state.translateCalls).toHaveLength(1);
    expect(document.querySelector('.ll-tr')?.textContent).toBe('译(Original t)');

    // 站点改原文：characterData 变更 → 600ms 重扫确认 → 重新入队翻译
    const paragraph = document.querySelector('#a')!;
    paragraph.firstChild!.nodeValue = 'Brand new content here';
    await tick(900);

    expect(state.translateCalls).toHaveLength(2);
    expect(state.translateCalls[1]).toEqual(['Brand new content here']);
    expect(document.querySelectorAll('.ll-tr')).toHaveLength(1);
  });

  it('站点用 textContent 整体重写已翻译段落后，也会重新翻译（childList 路径）', async () => {
    document.body.innerHTML = '<p id="a">Original text one</p>';
    state.autoDetect = 'en';

    await translatePage();
    await tick(400);
    expect(document.querySelector('.ll-tr')?.textContent).toBe('译(Original t)');

    // textContent 赋值 = 移除全部子节点再插入新文本节点 → childList 变更。
    // 虚拟列表复用节点就是这种模式；修复前 done 标记不失效，译文永久丢失。
    document.querySelector('#a')!.textContent = 'Replaced via textContent';
    await tick(900);

    expect(state.translateCalls).toHaveLength(2);
    expect(state.translateCalls[1]).toEqual(['Replaced via textContent']);
    expect(document.querySelectorAll('.ll-tr')).toHaveLength(1);
    expect(document.querySelector('.ll-tr')?.textContent).toBe('译(Replaced v)');
  });

  it('请求挂起期间原文被改写：旧响应作废，按新原文重新请求', async () => {
    document.body.innerHTML = '<p id="a">Original text one</p>';
    state.autoDetect = 'en';
    state.translateMode = 'deferred';

    await translatePage();
    await tick(200); // flush 已发出 translate 请求并挂起
    expect(state.translateCalls).toHaveLength(1);

    // 挂起期间站点重写段落内容
    document.querySelector('#a')!.textContent = 'Replaced while in flight';
    await tick(50);

    // 放行旧响应：内容与请求时不一致，应丢弃并按当前文本重新请求
    const resolve = state.translateDeferreds.shift();
    resolve?.({
      ok: true,
      data: {
        texts: ['译(Original t)'],
        engine: '模拟引擎',
        from: 'en',
        to: 'zh-CN',
        cachedCount: 0,
        requestCount: 1,
      },
    });
    // 重新入队的请求改回即时回执，才能观察最终插入的译文
    state.translateMode = 'immediate';
    await tick(400);

    expect(state.translateCalls).toHaveLength(2);
    expect(state.translateCalls[1]).toEqual(['Replaced while in flight']);
    expect(document.querySelector('.ll-tr')?.textContent).toBe('译(Replaced w)');
  });

  it('深层容器内追加的段落会被局部重扫发现并翻译（不整页重扫）', async () => {
    document.body.innerHTML = `
      <section id="outer"><div id="list">
        <p>First nested item</p><p>Second nested item</p>
      </div></section>
      <div id="far-away"><p>Unrelated distant paragraph stays untouched</p></div>`;
    state.autoDetect = 'en';

    await translatePage();
    await tick(400);
    expect(document.querySelectorAll('.ll-tr')).toHaveLength(3);
    expect(state.translateCalls).toHaveLength(1);

    // 只在深层容器 #list 里追加新段落：重扫根 = #list，从其父级扫描即可发现，
    // 远处的 #far-away 不在扫描范围内（它已标记，行为上无差别，但扫描范围是局部的）
    const list = document.querySelector('#list')!;
    const p3 = document.createElement('p');
    p3.textContent = 'Third item appended into the nested list';
    list.append(p3);
    await tick(900);

    expect(state.translateCalls).toHaveLength(2);
    expect(state.translateCalls[1]).toEqual(['Third item appended into the nested list']);
    expect(document.querySelectorAll('.ll-tr')).toHaveLength(4);
    // 已有段落的译文不受影响
    expect(document.querySelector('#far-away .ll-tr')?.textContent).toBe('译(Unrelated )');
  });
});
