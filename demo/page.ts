/**
 * 网页沉浸式翻译的预览页。
 *
 * 用的是 src/content/page 里同一套代码，只替换两处外部依赖：
 *   - chrome.runtime.sendMessage：返回模拟译文（真实翻译链路由单测与联网冒烟覆盖）
 *   - chrome.i18n.detectLanguage：用简单的字符比例判断语言
 * 这样段落切分、可视区懒加载、插入位置、还原、复制保护都能在浏览器里直接验证。
 */

import { translatePage, restorePage } from '../src/content/page';
import { TRANSLATION_CLASS } from '../src/content/page/dom';
import { translateSelection } from '../src/content/selection';
import { initSelectionTrigger } from '../src/content/selection-trigger';

interface MockSettings {
  features: { page: boolean };
  targetLang: string;
}

const settings: MockSettings = { features: { page: true }, targetLang: 'zh-CN' };

/**
 * 语言判定模拟：贴近真实检测器的行为——假名判日语、谚文判韩语、汉字占比高判中文。
 * 用于验证混合语言页面下的跳过逻辑。
 *
 * 注意这是**有意简单**的近似：真实检测器（CLD）在区分中日文上比这里准，
 * 所以纯汉字的日语片段在预览里会被判成中文，而线上不会。
 */
function detectLang(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const letters = (text.match(/\p{L}/gu) ?? []).length || 1;
  return cjk / letters > 0.3 ? 'zh' : 'en';
}

/**
 * 简体特有字形：出现即认为是中文原文。
 * 只收录**日语不使用**的简体字——像「体」「来」「万」这类日语同形字不能放进来，
 * 否则纯日文会被误判成中文而原样返回。真实引擎对日文一律会翻译，模拟器要跟上。
 */
const SIMPLIFIED_ONLY =
  /[这们说时汉译设开关认让过还进东车马鸟风云应无个发电话语书习乐买卖长门问间单头实际现场华术业论请谢变边达运远连选适钱银铁错专为举]/;

function looksChinese(text: string): boolean {
  return SIMPLIFIED_ONLY.test(text);
}

const mockChrome = {
  runtime: {
    lastError: undefined,
    async sendMessage(message: { kind: string; req?: { texts?: string[] } }) {
      if (message.kind === 'settings:get') {
        return { ok: true, data: settings };
      }
      if (message.kind === 'translate') {
        // 注意：待翻译文本嵌在 req 里，与真实的消息协议保持一致
        const texts = message.req?.texts ?? [];
        // 模拟网络延迟，方便观察进度胶囊
        await new Promise((resolve) => setTimeout(resolve, 350));
        return {
          ok: true,
          data: {
            // 已经是中文原样的文本原样返回，与 Google 的真实行为一致；
            // 页面侧会据此丢弃，避免出现重复行
            texts: texts.map((text) =>
              looksChinese(text)
                ? text
                : `〔模拟译文〕${text.slice(0, 28)}${text.length > 28 ? '…' : ''}`,
            ),
            engine: '模拟引擎',
            from: 'auto',
            to: settings.targetLang,
            cachedCount: 0,
            requestCount: 1,
          },
        };
      }
      return { ok: false, error: `未实现的消息：${message.kind}` };
    },
  },
  i18n: {
    detectLanguage(text: string, callback: (result: unknown) => void) {
      callback({ isReliable: true, languages: [{ language: detectLang(text), percentage: 92 }] });
    },
  },
};

(globalThis as unknown as { chrome: unknown }).chrome = mockChrome;

const status = document.getElementById('status')!;
const featureToggle = document.getElementById('feature') as HTMLInputElement;

function log(message: string) {
  status.textContent = message;
}

featureToggle.addEventListener('change', () => {
  settings.features.page = featureToggle.checked;
  log(`网页翻译开关：${settings.features.page ? '开' : '关'}`);
});

document.getElementById('btn-translate')!.addEventListener('click', () => {
  void translatePage().then((result) => {
    log(result.started ? '已启动，观察下方正文与右下角进度' : `未启动：${result.reason}`);
  });
});

document.getElementById('btn-restore')!.addEventListener('click', () => {
  const removed = restorePage();
  log(`已还原，移除 ${removed} 段译文`);
});

document.getElementById('btn-inspect')!.addEventListener('click', () => {
  const nodes = document.querySelectorAll(`.${TRANSLATION_CLASS}`);
  const marked = document.querySelectorAll('[data-ll-block]');
  log(`译文节点 ${nodes.length} 个，已标记段落 ${marked.length} 个`);
});

log('准备就绪。点「翻译此页」开始，预览页会自动滚动以触发可视区懒翻译。');

// 划词触发按钮：在预览页里也能试（选中文字 → 选区旁出现「译」）
initSelectionTrigger(() => void translateSelection());

// 自动滚动到底部再回来，方便一次看到懒加载效果
document.getElementById('btn-scroll')!.addEventListener('click', async () => {
  const start = window.scrollY;
  for (let y = 0; y < document.body.scrollHeight; y += 400) {
    window.scrollTo(0, y);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  window.scrollTo(0, start);
  log('已往返滚动一遍，可查看懒翻译是否覆盖了整页');
});
