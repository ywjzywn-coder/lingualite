/**
 * 记录哪些标签页当前处于「已翻译」状态，用来决定右键菜单显示「翻译此页」还是「还原原文」。
 *
 * 存在 chrome.storage.session：Service Worker 会被随时回收，内存变量靠不住；
 * 而 session 区随浏览器关闭自动清空，正好符合「本次浏览会话内哪些页面已翻译」的语义。
 *
 * 每个标签页一个键：并发上报各自原子写入，不会出现「读整表-改-写回」互相覆盖的问题。
 */

function keyFor(tabId: number): string {
  return `translatedTab:${tabId}`;
}

export async function setPageTranslated(tabId: number, active: boolean): Promise<void> {
  try {
    if (active) await chrome.storage.session.set({ [keyFor(tabId)]: true });
    else await chrome.storage.session.remove(keyFor(tabId));
  } catch {
    // storage.session 不可用时退化为「一律视为未翻译」
  }
}

export async function isPageTranslated(tabId: number): Promise<boolean> {
  try {
    const stored = await chrome.storage.session.get(keyFor(tabId));
    return stored[keyFor(tabId)] === true;
  } catch {
    return false;
  }
}

/** 标签页关闭或导航时清掉记录。 */
export async function forgetTab(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.remove(keyFor(tabId));
  } catch {
    // 忽略
  }
}

/** 菜单标题：未翻译显示「翻译此页」，已翻译显示「还原原文」。 */
export function toggleMenuTitle(active: boolean): string {
  return active ? '还原原文' : '翻译此页（双语对照）';
}
