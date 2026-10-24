/** 用工具栏角标给出一次性提示，避免"点了没反应"的困惑。 */
export function flashBadge(tabId: number, text: string, title: string, durationMs = 4000): void {
  try {
    void chrome.action.setBadgeText({ tabId, text });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#d1242f' });
    void chrome.action.setTitle({ tabId, title: `轻译：${title}` });
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: '' });
      void chrome.action.setTitle({ tabId, title: '轻译 LinguaLite' });
    }, durationMs);
  } catch {
    // 标签页可能已关闭，忽略
  }
}
