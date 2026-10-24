import { beforeEach, describe, expect, it } from 'vitest';

// 内存实现的 storage.session 替身
const sessionStore = new Map<string, unknown>();

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
};

const { forgetTab, isPageTranslated, setPageTranslated, toggleMenuTitle } = await import(
  '../src/background/page-state'
);

beforeEach(() => {
  sessionStore.clear();
});

describe('toggleMenuTitle', () => {
  it('未翻译时显示翻译入口', () => {
    expect(toggleMenuTitle(false)).toBe('翻译此页（双语对照）');
  });

  it('已翻译时显示还原入口', () => {
    expect(toggleMenuTitle(true)).toBe('还原原文');
  });
});

describe('标签页翻译状态', () => {
  it('默认视为未翻译', async () => {
    expect(await isPageTranslated(123)).toBe(false);
  });

  it('记录后可以读回', async () => {
    await setPageTranslated(123, true);
    expect(await isPageTranslated(123)).toBe(true);
    // 不同标签页互不影响
    expect(await isPageTranslated(456)).toBe(false);
  });

  it('关闭状态即删除记录', async () => {
    await setPageTranslated(123, true);
    await setPageTranslated(123, false);
    expect(await isPageTranslated(123)).toBe(false);
  });

  it('forgetTab 用于标签页关闭或导航', async () => {
    await setPageTranslated(7, true);
    await forgetTab(7);
    expect(await isPageTranslated(7)).toBe(false);
  });

  it('多个标签页的状态互不覆盖', async () => {
    await setPageTranslated(1, true);
    await setPageTranslated(2, true);
    await setPageTranslated(1, false);
    expect(await isPageTranslated(1)).toBe(false);
    expect(await isPageTranslated(2)).toBe(true);
  });

  it('并发上报不同标签页时互不丢失（每个标签页一个键）', async () => {
    await Promise.all([setPageTranslated(1, true), setPageTranslated(2, true), setPageTranslated(3, true)]);
    expect(await isPageTranslated(1)).toBe(true);
    expect(await isPageTranslated(2)).toBe(true);
    expect(await isPageTranslated(3)).toBe(true);
  });

  it('storage.session 不可用时降级为未翻译而不是抛错', async () => {
    (globalThis as unknown as { chrome: { storage: { session: unknown } } }).chrome.storage.session = {
      async get() {
        throw new Error('unavailable');
      },
      async set() {
        throw new Error('unavailable');
      },
      async remove() {
        throw new Error('unavailable');
      },
    };
    await expect(setPageTranslated(9, true)).resolves.toBeUndefined();
    await expect(forgetTab(9)).resolves.toBeUndefined();
    expect(await isPageTranslated(9)).toBe(false);
  });
});
