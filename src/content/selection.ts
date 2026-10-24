import { callBackground } from '../shared/messages';
import { log } from '../shared/log';
import { MAX_SELECTION_CHARS, cleanSelectionText, guessPageLang } from '../shared/text';
import { hideBubble, showBubble, wasBubbleDismissed, type Anchor } from './bubble';
import { speak } from './tts';

let sourceText = '';
let translatedText = '';
let targetLang = '';
/** 请求序号：只有最新一次请求可以把结果写进气泡，旧响应直接丢弃。 */
let requestSeq = 0;

const handlers = {
  onSpeakSource: () => speak(sourceText, guessPageLang()),
  onSpeakTranslated: () => speak(translatedText, targetLang),
};

export interface SelectionInfo {
  text: string;
  anchor: Anchor | null;
  /** 选区超过上限被截断时为 true，用于在气泡里提示。 */
  truncated: boolean;
}

/**
 * 记住最近一次有效选区。
 * 打开扩展弹窗会让页面失焦，部分情况下实时选区会被清空，这时需要靠记忆兜底，
 * 否则"先在页面上选中文字，再点弹窗按钮"这条路径会失效。
 */
let remembered: SelectionInfo | null = null;

function infoFromSelection(selection: Selection): SelectionInfo | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const raw = selection.toString();
  const text = cleanSelectionText(raw);
  if (!text) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const truncated = collapsed.length > text.length;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const anchor =
    rect.width || rect.height ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
  return { text, anchor, truncated };
}

export function rememberSelection(): void {
  document.addEventListener(
    'selectionchange',
    () => {
      const info = infoFromSelection(window.getSelection() as Selection);
      if (info) remembered = info;
    },
    true,
  );
}

/** 读取当前选区；实时选区为空时退回记忆值，再退回调用方传入的文本。 */
export function readSelection(fallbackText?: string): SelectionInfo {
  const selection = window.getSelection();
  if (selection) {
    const info = infoFromSelection(selection);
    if (info) {
      remembered = info;
      return info;
    }
  }
  if (remembered) return remembered;
  return { text: cleanSelectionText(fallbackText ?? ''), anchor: null, truncated: false };
}

function fallbackAnchor(): Anchor {
  return { left: Math.max(8, window.innerWidth / 2 - 180), top: 72, bottom: 96 };
}

/** 翻译选中文本并展示气泡。重复调用会复用同一个气泡。 */
export async function translateSelection(fallbackText?: string): Promise<void> {
  const seq = ++requestSeq;
  const { text, anchor, truncated } = readSelection(fallbackText);
  const position = anchor ?? fallbackAnchor();
  const notice = truncated ? `选区过长，已截取前 ${MAX_SELECTION_CHARS} 字` : undefined;

  if (!text) {
    if (seq !== requestSeq) return;
    hideBubble();
    showBubble(
      { sourceText: '', status: 'error', error: '没有选中文本。请先在页面上选中要翻译的内容。' },
      position,
      handlers,
    );
    return;
  }

  sourceText = text;
  translatedText = '';
  showBubble({ sourceText: text, status: 'loading', notice }, position, handlers);

  const res = await callBackground({
    kind: 'translate',
    req: {
      texts: [text],
      // 留空表示由后台按设置决定，避免内容脚本重复读取设置
      from: '',
      to: '',
      context: { title: document.title, url: location.href },
    },
  });

  // 过期响应（用户又选了新的内容）与被用户关掉的气泡都不再打扰
  if (seq !== requestSeq || wasBubbleDismissed()) return;

  if (!res.ok) {
    log.debug('划词翻译失败', res.error);
    showBubble({ sourceText: text, status: 'error', error: res.error, notice }, position, handlers);
    return;
  }

  translatedText = res.data.texts[0] ?? '';
  targetLang = res.data.to;
  showBubble(
    {
      sourceText: text,
      status: translatedText ? 'done' : 'error',
      translated: translatedText,
      error: translatedText ? undefined : '没有拿到译文',
      engine: res.data.engine,
      notice,
    },
    position,
    handlers,
  );
}

/** 朗读选中文本。 */
export function speakSelection(fallbackText?: string): void {
  const { text } = readSelection(fallbackText);
  if (!text) {
    hideBubble();
    showBubble(
      { sourceText: '', status: 'error', error: '没有选中文本。' },
      fallbackAnchor(),
      handlers,
    );
    return;
  }
  speak(text, guessPageLang());
}
