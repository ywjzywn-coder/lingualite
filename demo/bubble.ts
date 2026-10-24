import { hideBubble, showBubble } from '../src/content/bubble';

const handlers = {
  onSpeakSource: () => log('朗读原文'),
  onSpeakTranslated: () => log('朗读译文'),
};

const paragraph = document.getElementById('paragraph')!;
const status = document.getElementById('status')!;

function log(message: string) {
  status.textContent = message;
  console.log(message);
}

/** 用当前页面上的真实选区作为锚点，模拟扩展的真实行为。 */
function anchorFromSelection() {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width || rect.height) return { left: rect.left, top: rect.top, bottom: rect.bottom };
  }
  return { left: 80, top: 120, bottom: 144 };
}

const SOURCE = 'Translation quality depends heavily on the context you provide.';

document.getElementById('btn-loading')!.addEventListener('click', () => {
  showBubble({ sourceText: SOURCE, status: 'loading' }, anchorFromSelection(), handlers);
});

document.getElementById('btn-done')!.addEventListener('click', () => {
  showBubble(
    {
      sourceText: SOURCE,
      status: 'done',
      translated: '翻译质量在很大程度上取决于你提供的上下文。',
      engine: 'Google 免费接口',
    },
    anchorFromSelection(),
    handlers,
  );
});

document.getElementById('btn-long')!.addEventListener('click', () => {
  showBubble(
    {
      sourceText:
        'This is a deliberately long sentence used to check how the bubble wraps and whether it stays inside the viewport when the translation is much longer than the source text.',
      status: 'done',
      translated:
        '这是一个刻意写得很长的句子，用来检查气泡在译文远长于原文时如何换行、以及是否始终停留在视口范围内而不会被裁掉。',
      engine: 'DeepSeek · deepseek-chat',
    },
    anchorFromSelection(),
    handlers,
  );
});

document.getElementById('btn-error')!.addEventListener('click', () => {
  showBubble(
    { sourceText: SOURCE, status: 'error', error: '接口返回 HTTP 401：invalid api key' },
    anchorFromSelection(),
    handlers,
  );
});

document.getElementById('btn-hide')!.addEventListener('click', () => {
  hideBubble();
  log('已隐藏');
});

paragraph.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? '';
  if (text) log(`已选中：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
});
