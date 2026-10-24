import { log } from '../shared/log';

/**
 * offscreen document 宿主。
 * M7 会在这里实现：tabCapture 音频流 -> AudioWorklet 取 PCM -> 分片 -> 语音识别。
 * 使用 USER_MEDIA 理由创建的 offscreen document 不受 Service Worker 30 秒空闲限制。
 */

log.debug('offscreen document 已加载');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if ((message as { kind?: string }).kind === 'offscreen:ping') {
    sendResponse({ ok: true, data: { ready: true } });
    return true;
  }
  return false;
});
