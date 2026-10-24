import { detectPageTheme } from './page-theme';
import { createShadowHost, isolateEvents, mountToTopLayer, watchFullscreen } from './ui/base';
import { ICON_TRANSLATE } from './ui/icons';

/**
 * 划词触发按钮：选中文字后在选区末尾就近出现一个小按钮，点一下就翻译。
 *
 * 有了它，划词翻译不必再绕右键菜单（右键 → 找到条目 → 点击，三步）。
 * 菜单入口保留，两条路都通。
 */

const HOST_ID = 'lingualite-selection-trigger';
const MARGIN = 6;
const SIZE = 28;

const LAYOUT_CSS = `
.trigger {
  position: fixed;
  z-index: 2147483647;
  width: ${SIZE}px;
  height: ${SIZE}px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--card);
  color: var(--card-foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  opacity: 0;
  transform: scale(0.85);
  transition: opacity 0.12s ease, transform 0.12s ease, border-color 0.12s, color 0.12s, background-color 0.12s;
  box-shadow: 0 6px 18px -6px color-mix(in oklab, var(--shadow-color) 45%, transparent);
}
.trigger .icon {
  width: 15px;
  height: 15px;
}
.trigger.visible {
  opacity: 1;
  transform: scale(1);
}
.trigger:hover {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--primary-foreground);
  transform: scale(1.08);
}
`;

interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

let host: HTMLDivElement | null = null;
let button: HTMLButtonElement | null = null;
let handler: (() => void) | null = null;
let anchor: Anchor | null = null;

function mount(): void {
  if (host?.isConnected) return;

  const created = createShadowHost(HOST_ID);
  host = created.host;

  const layout = document.createElement('style');
  layout.textContent = LAYOUT_CSS;
  created.root.append(layout);

  button = document.createElement('button');
  button.type = 'button';
  button.className = 'll-root trigger';
  button.innerHTML = ICON_TRANSLATE;
  button.title = '翻译选中文本';
  created.root.append(button);
  isolateEvents(button);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const run = handler;
    hideSelectionTrigger();
    run?.();
  });

  // 全屏播放视频时挂到全屏元素内部，否则会被 top layer 盖住。
  // 这个按钮与页面同生命周期，不需要在别处解绑。
  mountToTopLayer(host);
  watchFullscreen(host);
}

function position(): void {
  if (!button || !anchor) return;
  const maxLeft = window.innerWidth - SIZE - MARGIN;
  let left = anchor.left + MARGIN;
  let top = anchor.bottom + MARGIN;
  if (left > maxLeft) left = Math.max(MARGIN, maxLeft);
  if (top + SIZE > window.innerHeight - MARGIN) {
    const above = anchor.top - SIZE - MARGIN;
    top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - SIZE - MARGIN);
  }
  button.style.left = `${Math.round(left)}px`;
  button.style.top = `${Math.round(top)}px`;
}

function selectionRect(): Anchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!selection.toString().trim()) return null;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!last || (last.width === 0 && last.height === 0)) return null;
  return { left: last.right, top: last.top, bottom: last.bottom };
}

function showAt(next: Anchor): void {
  mount();
  if (!button) return;
  anchor = next;
  button.dataset.theme = detectPageTheme();
  button.classList.add('visible');
  position();
}

export function hideSelectionTrigger(): void {
  anchor = null;
  button?.classList.remove('visible');
}

const onMouseUp = (event: MouseEvent): void => {
  if (host && event.composedPath().includes(host)) return;
  // 等一帧，让浏览器先把选区更新完
  window.setTimeout(() => {
    const rect = selectionRect();
    if (rect) showAt(rect);
    else hideSelectionTrigger();
  }, 0);
};

const onMouseDown = (event: MouseEvent): void => {
  if (host && event.composedPath().includes(host)) return;
  hideSelectionTrigger();
};

const onKeyDown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') hideSelectionTrigger();
};

/** 位置会失效，直接收起而不是跟着跑 */
const hideOnViewportChange = (): void => hideSelectionTrigger();

let bound = false;

export function initSelectionTrigger(onActivate: () => void): void {
  handler = onActivate;
  if (bound) return;
  bound = true;

  // 在捕获阶段监听：页面自己的 mouseup 处理器通常不会阻止冒泡到这里
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', hideOnViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', hideOnViewportChange, { passive: true });
}

/** 划词开关关闭时卸载：移除全部监听并收起按钮，不残留任何页面交互。 */
export function destroySelectionTrigger(): void {
  hideSelectionTrigger();
  if (!bound) return;
  bound = false;
  handler = null;
  document.removeEventListener('mouseup', onMouseUp, true);
  document.removeEventListener('mousedown', onMouseDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', hideOnViewportChange, { capture: true });
  window.removeEventListener('resize', hideOnViewportChange);
}
