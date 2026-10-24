import { detectPageTheme } from '../page-theme';
import { createShadowHost, isolateEvents, mountToTopLayer, watchFullscreen } from '../ui/base';
import { ICON_CLOSE } from '../ui/icons';

export interface ChipCallbacks {
  onRestore: () => void;
  onRetry: () => void;
}

export interface ChipState {
  phase: 'working' | 'done' | 'message';
  done: number;
  total: number;
  failed: number;
  message?: string;
}

const HOST_ID = 'lingualite-chip';

const LAYOUT_CSS = `
.chip {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.3125rem 0.3125rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--card);
  color: var(--card-foreground);
  box-shadow: 0 10px 30px -10px color-mix(in oklab, var(--shadow-color) 45%, transparent);
}
.chip .text {
  white-space: nowrap;
  font-size: 0.8125rem;
}
.chip .text.error {
  color: var(--destructive);
}
.chip .spinner {
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid var(--muted);
  border-top-color: var(--primary);
  border-radius: 9999px;
  animation: ll-spin 0.8s linear infinite;
}
@keyframes ll-spin {
  to { transform: rotate(360deg); }
}
`;

interface ChipElements {
  host: HTMLDivElement;
  chip: HTMLDivElement;
  spinner: HTMLSpanElement;
  text: HTMLSpanElement;
  retry: HTMLButtonElement;
  restore: HTMLButtonElement;
  close: HTMLButtonElement;
  stopFullscreenWatch: () => void;
}

let elements: ChipElements | null = null;
let callbacks: ChipCallbacks | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function mount(): ChipElements {
  if (elements?.host.isConnected) return elements;

  const created = createShadowHost(HOST_ID);
  const layout = document.createElement('style');
  layout.textContent = LAYOUT_CSS;
  created.root.append(layout);

  const chip = document.createElement('div');
  chip.className = 'll-root chip';
  chip.innerHTML = `
    <span class="spinner"></span>
    <span class="text"></span>
    <button type="button" class="btn btn-xs" data-act="retry">重试</button>
    <button type="button" class="btn btn-xs" data-act="restore">还原</button>
    <button type="button" class="btn btn-xs btn-icon" data-act="close" title="隐藏（翻译保留）">${ICON_CLOSE}</button>`;
  created.root.append(chip);
  isolateEvents(chip);

  // 全屏播放视频时挂到全屏元素内部，否则会被 top layer 盖住
  mountToTopLayer(created.host);

  elements = {
    host: created.host,
    chip,
    spinner: chip.querySelector('.spinner')!,
    text: chip.querySelector('.text')!,
    retry: chip.querySelector('button[data-act="retry"]')!,
    restore: chip.querySelector('button[data-act="restore"]')!,
    close: chip.querySelector('button[data-act="close"]')!,
    stopFullscreenWatch: watchFullscreen(created.host),
  };

  elements.retry.addEventListener('click', () => callbacks?.onRetry());
  elements.restore.addEventListener('click', () => callbacks?.onRestore());
  elements.close.addEventListener('click', () => hideChip());

  return elements;
}

export function showChip(state: ChipState, handlers: ChipCallbacks): void {
  callbacks = handlers;
  const el = mount();
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  el.chip.dataset.theme = detectPageTheme();
  el.chip.style.display = 'flex';

  const working = state.phase === 'working';
  el.spinner.style.display = working ? 'block' : 'none';
  el.retry.style.display = state.failed > 0 ? '' : 'none';
  el.text.className = state.phase === 'message' ? 'text error' : 'text';

  if (state.phase === 'message') {
    el.text.textContent = state.message ?? '';
  } else if (working) {
    el.text.textContent = state.total > 0 ? `翻译中 ${state.done}/${state.total}` : '正在查找可翻译内容…';
  } else {
    const failed = state.failed > 0 ? `，${state.failed} 段失败` : '';
    el.text.textContent = `已翻译 ${state.done} 段${failed}`;
  }
}

/** 全部完成后再等一会儿自动收起，避免长期占着页面角落。 */
export function scheduleChipHide(delayMs = 4000): void {
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideChip(), delayMs);
}

export function hideChip(): void {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  elements?.stopFullscreenWatch?.();
  elements?.host.remove();
  elements = null;
}
