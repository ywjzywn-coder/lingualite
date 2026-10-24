import { log } from '../shared/log';
import { sendToTab, type ContentCommand } from '../shared/messages';
import { flashBadge } from './badge';
import { isPageTranslated, toggleMenuTitle } from './page-state';

const TOGGLE_ID = 'll-toggle-page';

/**
 * 右键菜单定义。
 * 只登记**已经能用**的条目：菜单里出现点不动的项比没有更糟。
 * 网页翻译是一个可切换的条目，标题由 refreshToggleMenu() 按当前标签页的状态改写。
 */
const MENU_ITEMS: chrome.contextMenus.CreateProperties[] = [
  {
    id: TOGGLE_ID,
    title: toggleMenuTitle(false),
    // 用 all：整页翻译与右键位置无关，而很多站点的正文本身就包在链接里
    // （卡片式布局尤其常见），只写 page 会导致在那些位置压根看不到这个入口
    contexts: ['all'],
  },
  {
    id: 'll-translate-selection',
    title: '翻译选中文本',
    contexts: ['selection'],
  },
  {
    id: 'll-speak-selection',
    title: '朗读选中文本',
    contexts: ['selection'],
  },
];

const MENU_COMMANDS: Record<string, ContentCommand['kind']> = {
  [TOGGLE_ID]: 'content:toggle-page',
  'll-translate-selection': 'content:translate-selection',
  'll-speak-selection': 'content:speak-selection',
};

/**
 * 安装/更新时重建，避免旧版本的条目残留。
 * Service Worker 每次启动也会走这里：菜单是持久化的，但版本升级后 id 可能已经变了。
 */
export function resetMenus(): void {
  chrome.contextMenus.removeAll(() => {
    createAll();
    void refreshToggleMenu();
  });
}

export function ensureMenus(): void {
  createAll();
  void refreshToggleMenu();
}

function createAll(): void {
  for (const item of MENU_ITEMS) {
    chrome.contextMenus.create(item, () => {
      // 读取 lastError 以抑制「重复创建」的告警
      void chrome.runtime.lastError;
    });
  }
}

/**
 * 按当前活动标签页的状态改写菜单标题。
 * 右键菜单是全局的，所以只能跟随「最后聚焦窗口的活动标签页」——用户能右键的也就是它。
 */
export async function refreshToggleMenu(): Promise<void> {
  let active = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) active = await isPageTranslated(tab.id);
  } catch {
    // 拿不到标签页时按未翻译处理
  }
  try {
    await chrome.contextMenus.update(TOGGLE_ID, { title: toggleMenuTitle(active) });
  } catch {
    // 菜单尚未创建，下次刷新即可
  }
}

export async function handleMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const action = MENU_COMMANDS[String(info.menuItemId)];
  if (!action) return;

  if (tab?.id === undefined) {
    log.debug('菜单点击时拿不到标签页 id，忽略');
    return;
  }

  const res = await sendToTab(tab.id, { kind: action, text: info.selectionText });
  if (!res.ok) {
    log.debug('菜单指令未能送达内容脚本', res.error);
    flashBadge(tab.id, '!', res.error);
  }
}
