import { cachePrune } from '../shared/cache';
import { log } from '../shared/log';
import type { RuntimeMessage } from '../shared/messages';
import { invalidateSettingsCache, SETTINGS_KEY } from '../shared/settings';
import { ensureMenus, handleMenuClick, refreshToggleMenu, resetMenus } from './menus';
import { forgetTab } from './page-state';
import { handleMessage } from './router';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message as RuntimeMessage, sender).then(sendResponse);
  // 返回 true 表示会异步调用 sendResponse
  return true;
});

// Service Worker 随时可能被回收，每次启动都补建一次右键菜单
ensureMenus();

// 把 local 存储限制在扩展上下文：内容脚本与页面都无法直接读到设置（含 API Key）
void (async () => {
  try {
    const area = chrome.storage.local as chrome.storage.StorageArea & {
      setAccessLevel?: (options: { accessLevel: string }) => Promise<void>;
    };
    await area.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // 老版本不支持时跳过：密钥隔离已由路由层的公开设置兜住
  }
})();

chrome.runtime.onInstalled.addListener((details) => {
  log.info('扩展已安装/更新', details.reason);
  void cachePrune();
  resetMenus();
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void cachePrune();
  ensureMenus();
});

// 设置被其他上下文改动时丢弃进程内缓存
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_KEY in changes) invalidateSettingsCache();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleMenuClick(info, tab);
});

// 菜单标题要跟随「当前这个标签页」的翻译状态，所以切标签页、切换窗口时都要重算
chrome.tabs.onActivated.addListener(() => {
  void refreshToggleMenu();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshToggleMenu();
});

// 导航会清掉页面上的译文，状态也要跟着重置
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  void (async () => {
    await forgetTab(tabId);
    await refreshToggleMenu();
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId);
});
