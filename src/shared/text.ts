/** 选区文本清洗：折叠空白并限制长度，便于作为单条翻译请求发送。 */
export const MAX_SELECTION_CHARS = 1000;

export function cleanSelectionText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SELECTION_CHARS);
}

/** 从 <html lang> 猜原文语言，用于朗读时设置发音。 */
export function guessPageLang(): string | undefined {
  const lang = document.documentElement.lang?.trim();
  if (!lang) return undefined;
  return lang;
}
