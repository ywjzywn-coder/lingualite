/**
 * 判断一段文字是否已经是目标语言，用来避免把中文页面「翻译」成中文。
 *
 * 用浏览器内置的 chrome.i18n.detectLanguage，而不是自己打包语言检测库。
 * 但内置检测对**中日文混用汉字**这件事不可靠：纯汉字的日语片段（如「東京大学」）
 * 很容易被判成中文。所以这里不直接采信检测结果，而是叠加两条硬规则。
 */

/** 平假名与片假名。日语独有，中文文本里不会出现。 */
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/;

/** 检测置信度低于此值时不跳过，宁可多翻一句也不要漏掉整段。 */
export const MIN_SKIP_CONFIDENCE = 60;

/**
 * 低于这个长度不做跳过判定。
 *
 * 短文本的语言检测很不可靠（含汉字的日语、含假名的中文片段都可能判错），
 * 而跳过的代价是「整段没有译文」——用户看到的就是漏翻。
 * 短片段本来翻译成本就低，一律送去翻译；如果译文与原文相同，调用方会丢弃它，
 * 因此不会出现重复行。
 */
export const MIN_SKIP_LENGTH = 20;

/**
 * 是否应当跳过（判定为「已经是目标语言」）。
 * 纯函数，便于测试；实际调用见 isTargetLanguage。
 */
export function shouldSkipAsTarget(
  text: string,
  detected: string | undefined,
  percentage: number,
  targetLang: string,
): boolean {
  if (!targetLang || targetLang === 'auto') return false;
  if (!detected) return false;
  // 短文本判定不可靠，宁可多翻
  if (text.trim().length < MIN_SKIP_LENGTH) return false;
  if (percentage < MIN_SKIP_CONFIDENCE) return false;

  const target = targetLang.toLowerCase();
  const prefix = target.split('-')[0]!;
  const found = detected.toLowerCase();
  if (!found.startsWith(prefix)) return false;

  // 含假名就不是中文。目标是中文时直接否决检测结果——
  // 这条规则专门对付「汉字多的日语被判成中文」。
  if (prefix === 'zh' && KANA.test(text)) return false;

  // 目标指定了地区或字形（zh-CN / zh-TW）时，只有判定到同一种才跳过；
  // 判定到的是另一种，说明还需要转换（例如繁体转简体）
  if (target.includes('-') && found.includes('-') && found !== target) return false;

  return true;
}

export function isTargetLanguage(text: string, targetLang: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!targetLang || targetLang === 'auto') {
      resolve(false);
      return;
    }
    try {
      chrome.i18n.detectLanguage(text, (result) => {
        // 读取 lastError 以抑制控制台告警
        void chrome.runtime.lastError;
        const top = result?.languages?.[0];
        resolve(shouldSkipAsTarget(text, top?.language, top?.percentage ?? 0, targetLang));
      });
    } catch {
      resolve(false);
    }
  });
}
