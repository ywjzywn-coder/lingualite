import { log } from '../shared/log';
import { callBackground } from '../shared/messages';
import { pageTranslator, restorePage, translatePage } from './page';
import { readSelection, rememberSelection, speakSelection, translateSelection } from './selection';
import { destroySelectionTrigger, initSelectionTrigger } from './selection-trigger';
import { stopSpeaking } from './tts';

// 内容脚本可能在同一页面被重复注入（例如重新加载扩展后未刷新页面），用 window 标记防重。
const FLAG = '__lingualiteContentLoaded';
const holder = window as unknown as Record<string, boolean | undefined>;

if (!holder[FLAG]) {
  holder[FLAG] = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    const { kind, text } = message as { kind?: string; text?: string };
    switch (kind) {
      case 'content:translate-selection':
        // 立即回执，翻译结果通过气泡呈现，不占用消息通道
        void translateSelection(text);
        sendResponse({ ok: true, data: { accepted: true } });
        return true;
      case 'content:speak-selection':
        speakSelection(text);
        sendResponse({ ok: true, data: { accepted: true } });
        return true;
      case 'content:translate-page':
        // 需要等设置读取与段落收集完成，才能把失败原因回传给调用方
        void translatePage().then((result) => {
          sendResponse(
            result.started
              ? { ok: true, data: { active: true } }
              : { ok: false, error: result.reason ?? '无法启动网页翻译' },
          );
        });
        return true;
      case 'content:restore-page': {
        const removed = restorePage();
        sendResponse({ ok: true, data: { active: false, removed } });
        return true;
      }
      case 'content:toggle-page':
        // 一个按钮两种状态：已翻译就还原，否则翻译
        void (async () => {
          if (pageTranslator.isActive) {
            const removed = restorePage();
            sendResponse({ ok: true, data: { active: false, removed } });
            return;
          }
          const result = await translatePage();
          sendResponse(
            result.started
              ? { ok: true, data: { active: true } }
              : { ok: false, error: result.reason ?? '无法启动网页翻译' },
          );
        })();
        return true;
      case 'content:get-page-state':
        sendResponse({ ok: true, data: { active: pageTranslator.isActive } });
        return true;
      default:
        return false;
    }
  });

  // 记住最近一次选区，供弹窗按钮在页面失焦后仍能取到文本
  rememberSelection();
  readSelection();

  // 划词后就近弹出小按钮，点一下即翻译（不必绕右键菜单）。
  // 开关动态生效：设置变更时启/停触发按钮，不需要刷新页面。
  let triggerActive = false;
  const applySelectFeature = (enabled: boolean): void => {
    if (enabled && !triggerActive) {
      initSelectionTrigger(() => void translateSelection());
      triggerActive = true;
    } else if (!enabled && triggerActive) {
      destroySelectionTrigger();
      triggerActive = false;
    }
  };
  void (async () => {
    const res = await callBackground({ kind: 'settings:get' });
    if (res.ok) applySelectFeature(Boolean(res.data.features.select));
  })();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = changes.settings.newValue as { features?: { select?: boolean } } | undefined;
    applySelectFeature(Boolean(next?.features?.select));
  });

  // 页面卸载前停止朗读，避免声音残留
  window.addEventListener('pagehide', () => {
    stopSpeaking();
    if (pageTranslator.isActive) pageTranslator.stop();
  });

  log.debug('内容脚本已就绪', location.href);
}
