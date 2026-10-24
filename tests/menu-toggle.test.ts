import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 验证「右键菜单标题跟随标签页翻译状态」这条链路：
 *   内容脚本上报 page:state -> Service Worker 记录 -> 菜单标题改写
 * 菜单本身只能在真实 Chrome 里看到，但这条链路的逻辑可以在这里锁住。
 */
const sessionStore = new Map<string, unknown>();
let activeTab: { id: number } | undefined = { id: 1 };
const updates: Array<{ id: string; title?: string }> = [];

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    session: {
      async get(key: string) {
        return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) sessionStore.set(key, value);
      },
      async remove(key: string) {
        sessionStore.delete(key);
      },
    },
  },
  tabs: {
    async query() {
      return activeTab ? [activeTab] : [];
    },
  },
  contextMenus: {
    async update(id: string, properties: { title?: string }) {
      updates.push({ id, title: properties.title });
    },
  },
  runtime: { lastError: undefined },
};

const { handleMessage } = await import('../src/background/router');
const { refreshToggleMenu } = await import('../src/background/menus');
const { setPageTranslated } = await import('../src/background/page-state');

function lastTitle(): string | undefined {
  return updates.length > 0 ? updates[updates.length - 1]!.title : undefined;
}

beforeEach(() => {
  sessionStore.clear();
  updates.length = 0;
  activeTab = { id: 1 };
  vi.restoreAllMocks();
});

describe('page:state 上报', () => {
  it('记录来源标签页的翻译状态（每个标签页一个键），并立即刷新菜单标题', async () => {
    await handleMessage({ kind: 'page:state', active: true }, { tab: { id: 1 } } as never);

    expect(sessionStore.get('translatedTab:1')).toBe(true);
    expect(lastTitle()).toBe('还原原文');
  });

  it('还原后标题改回翻译入口', async () => {
    await handleMessage({ kind: 'page:state', active: true }, { tab: { id: 1 } } as never);
    await handleMessage({ kind: 'page:state', active: false }, { tab: { id: 1 } } as never);

    expect(sessionStore.has('translatedTab:1')).toBe(false);
    expect(lastTitle()).toBe('翻译此页（双语对照）');
  });

  it('缺少标签页信息时返回错误而不是静默写入', async () => {
    const res = await handleMessage({ kind: 'page:state', active: true }, {} as never);
    expect(res.ok).toBe(false);
  });
});

describe('refreshToggleMenu', () => {
  it('按当前活动标签页的状态决定标题', async () => {
    activeTab = { id: 7 };
    await setPageTranslated(7, true);

    await refreshToggleMenu();
    expect(lastTitle()).toBe('还原原文');
  });

  it('活动标签页没翻译时显示翻译入口', async () => {
    activeTab = { id: 7 };
    await setPageTranslated(8, true);

    await refreshToggleMenu();
    expect(lastTitle()).toBe('翻译此页（双语对照）');
  });

  it('切到另一个已翻译的标签页时标题跟着变', async () => {
    await setPageTranslated(1, false);
    await setPageTranslated(2, true);

    activeTab = { id: 1 };
    await refreshToggleMenu();
    const forTab1 = lastTitle();

    activeTab = { id: 2 };
    await refreshToggleMenu();

    expect(forTab1).toBe('翻译此页（双语对照）');
    expect(lastTitle()).toBe('还原原文');
  });

  it('拿不到活动标签页时退回翻译入口，不抛错', async () => {
    activeTab = undefined;
    await expect(refreshToggleMenu()).resolves.toBeUndefined();
    expect(lastTitle()).toBe('翻译此页（双语对照）');
  });

  it('菜单更新失败不抛错（菜单可能尚未创建）', async () => {
    vi.spyOn(chrome.contextMenus, 'update').mockRejectedValue(new Error('no such menu'));
    await expect(refreshToggleMenu()).resolves.toBeUndefined();
  });
});
