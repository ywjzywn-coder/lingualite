import { log } from '../shared/log';
import { detectPageTheme } from './page-theme';
import { createShadowHost, isolateEvents, mountToTopLayer, watchFullscreen } from './ui/base';
import { ICON_CLOSE, ICON_VOLUME } from './ui/icons';

export interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

export interface BubbleData {
  sourceText: string;
  status: 'loading' | 'done' | 'error';
  translated?: string;
  engine?: string;
  error?: string;
  /** 附加提示，例如「选区超长已截断」 */
  notice?: string;
}

export interface BubbleActions {
  onSpeakSource: () => void;
  onSpeakTranslated: () => void;
}

const HOST_ID = 'lingualite-host';
const MARGIN = 8;

/** 只管布局；配色、描边、按钮外观全部来自共享的令牌与组件样式。 */
const LAYOUT_CSS = `
.bubble {
  position: fixed;
  z-index: 2147483647;
  width: min(420px, calc(100vw - 24px));
  max-height: 60vh;
  overflow: auto;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  color: var(--card-foreground);
  box-shadow: 0 10px 30px -10px color-mix(in oklab, var(--shadow-color) 40%, transparent);
}
.bubble .src {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.bubble .body {
  margin-top: 0.25rem;
}
.bubble .dst {
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.bubble .notice {
  margin-top: 0.375rem;
  font-size: 0.6875rem;
  color: var(--muted-foreground);
}
.bubble .notice:empty {
  display: none;
}
.bubble .loading {
  color: var(--muted-foreground);
}
.bubble .error {
  color: var(--destructive);
}
.bubble .foot {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-top: 0.625rem;
  padding-top: 0.625rem;
  border-top: 1px solid var(--border);
}
.bubble .engine {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.6875rem;
  color: var(--muted-foreground);
}
.bubble .spacer {
  flex: 1 1 auto;
}
`;

let host: HTMLDivElement | null = null;
let bubble: HTMLDivElement | null = null;
let currentAnchor: Anchor | null = null;
let actions: BubbleActions | null = null;
let cleanup: Array<() => void> = [];
/** 用户主动关掉了气泡：未决的翻译响应返回时不应再把气泡弹出来。 */
let dismissed = false;

function mount(): void {
  if (host?.isConnected) return;

  const created = createShadowHost(HOST_ID);
  host = created.host;

  const layout = document.createElement('style');
  layout.textContent = LAYOUT_CSS;
  created.root.append(layout);

  bubble = document.createElement('div');
  bubble.className = 'll-root bubble';
  bubble.innerHTML = `
    <div class="src"></div>
    <div class="body"></div>
    <div class="notice"></div>
    <div class="foot">
      <span class="engine"></span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-xs" data-act="speak-src" title="朗读原文">${ICON_VOLUME}原文</button>
      <button type="button" class="btn btn-xs" data-act="speak-dst" title="朗读译文">${ICON_VOLUME}译文</button>
      <button type="button" class="btn btn-xs" data-act="copy" title="复制译文">复制</button>
      <button type="button" class="btn btn-xs btn-icon" data-act="close" title="关闭">${ICON_CLOSE}</button>
    </div>`;
  created.root.append(bubble);

  isolateEvents(bubble);

  bubble.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement).closest('button')?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'speak-src':
        actions?.onSpeakSource();
        break;
      case 'speak-dst':
        actions?.onSpeakTranslated();
        break;
      case 'copy':
        void copyTranslation();
        break;
      case 'close':
        dismissBubble();
        break;
    }
  });

  mountToTopLayer(host);
  cleanup.push(watchFullscreen(host));
  addGlobalListeners();
}

async function copyTranslation(): Promise<void> {
  const text = bubble?.querySelector('.dst')?.textContent ?? '';
  if (!text) return;
  const button = bubble?.querySelector<HTMLButtonElement>('button[data-act="copy"]');
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      button.textContent = '已复制';
      setTimeout(() => (button.textContent = '复制'), 1200);
    }
  } catch (err) {
    log.debug('复制失败', err);
  }
}

function addGlobalListeners(): void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismissBubble();
  };
  const onPointerDown = (event: Event) => {
    if (host && !event.composedPath().includes(host)) dismissBubble();
  };
  let frame = 0;
  const reposition = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  cleanup.push(() => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    if (frame) cancelAnimationFrame(frame);
  });
}

function position(): void {
  if (!bubble || !currentAnchor) return;
  const rect = bubble.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - MARGIN;

  let top = currentAnchor.bottom + MARGIN;
  if (top + rect.height > window.innerHeight - MARGIN) {
    const above = currentAnchor.top - rect.height - MARGIN;
    top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
  }
  const left = Math.min(Math.max(MARGIN, currentAnchor.left), Math.max(MARGIN, maxLeft));

  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
}

/** 显示或更新气泡。重复调用会复用同一个气泡，避免闪烁。 */
export function showBubble(data: BubbleData, anchor: Anchor, handlers: BubbleActions): void {
  mount();
  if (!bubble) return;
  // 新的展示意味着这是用户要的结果：清掉上一次的「已关闭」标记
  dismissed = false;
  currentAnchor = anchor;
  actions = handlers;
  // 跟随页面实际背景，而不是系统偏好：浅色站点上不该冒出深色气泡
  bubble.dataset.theme = detectPageTheme();

  const src = bubble.querySelector('.src');
  const body = bubble.querySelector('.body');
  const notice = bubble.querySelector('.notice');
  const engine = bubble.querySelector('.engine');
  if (src) src.textContent = data.sourceText;
  if (engine) engine.textContent = data.engine ?? '';
  if (notice) notice.textContent = data.notice ?? '';

  if (body) {
    if (data.status === 'loading') {
      body.className = 'body loading';
      body.textContent = '翻译中…';
    } else if (data.status === 'error') {
      body.className = 'body error';
      body.textContent = data.error ?? '翻译失败';
    } else {
      body.className = 'body dst';
      body.textContent = data.translated ?? '';
    }
  }

  const speakTranslated = bubble.querySelector<HTMLButtonElement>('button[data-act="speak-dst"]');
  const speakSource = bubble.querySelector<HTMLButtonElement>('button[data-act="speak-src"]');
  const copy = bubble.querySelector<HTMLButtonElement>('button[data-act="copy"]');
  const ready = data.status === 'done' && Boolean(data.translated);
  if (speakTranslated) speakTranslated.disabled = !ready;
  if (copy) copy.disabled = !ready;
  if (speakSource) speakSource.disabled = !data.sourceText;

  position();
}

export function hideBubble(): void {
  for (const off of cleanup) off();
  cleanup = [];
  host?.remove();
  host = null;
  bubble = null;
  currentAnchor = null;
  actions = null;
}

/** 用户主动关闭（关闭按钮 / Esc / 点击外部）：在途的翻译结果不再弹出。 */
export function dismissBubble(): void {
  dismissed = true;
  hideBubble();
}

/** 气泡是否被用户主动关闭且此后没有再展示过。 */
export function wasBubbleDismissed(): boolean {
  return dismissed;
}
