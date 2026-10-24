import { log } from '../shared/log';

/** 用浏览器内置语音合成朗读文本，无需任何服务端。 */
export function speak(text: string, lang?: string): void {
  const content = text.trim();
  if (!content) return;
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    if (lang && lang !== 'auto') utterance.lang = lang;
    utterance.rate = 0.95;
    speechSynthesis.speak(utterance);
  } catch (err) {
    log.debug('朗读失败', err);
  }
}

export function stopSpeaking(): void {
  try {
    speechSynthesis.cancel();
  } catch {
    // 忽略
  }
}
