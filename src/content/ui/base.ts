import controlsCss from '../../ui/controls.css';
import tokensCss from '../../ui/tokens.css';

/**
 * Shadow DOM 里的基础样式。
 *
 * 内联的是「令牌 + 控件」两层，与扩展页面共用同一份定义，因此内嵌 UI 的设置界面
 * 不会各自漂移。页面专用组件（卡片、表单、开关等）不内联——内容脚本只带用得上的部分。
 *
 * 注意：Shadow 树里 :root 不匹配，令牌由子元素上的 data-theme 提供。
 */
export const SHADOW_BASE_CSS = `
:host { all: initial; }
${tokensCss}
${controlsCss}
*, *::before, *::after { box-sizing: border-box; }
.ll-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--foreground);
  -webkit-font-smoothing: antialiased;
}
/* 内嵌 SVG 图标（ui/icons.ts）：默认随字号缩放，组件可自行覆盖 */
.ll-root .icon {
  display: block;
  flex: none;
  width: 1em;
  height: 1em;
}
`;

/** Shadow 根节点共用的挂载与隔离样板。 */
export function createShadowHost(id: string): { host: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SHADOW_BASE_CSS;
  root.append(style);
  return { host, root };
}

/**
 * 把注入的 UI 挂到「当前能盖住一切」的容器里。
 *
 * 全屏时，全屏元素会被提升到浏览器的 top layer，渲染在普通文档之上——
 * 此时无论 z-index 设成多大，挂在 documentElement 下的 UI 都会被盖住。
 * 唯一可靠的做法是把 UI 放进全屏元素内部。
 * 视频网站（B 站、YouTube）全屏播放时会用到，非全屏时退回 documentElement。
 */
export function mountToTopLayer(host: HTMLElement): void {
  const parent = document.fullscreenElement ?? document.documentElement;
  if (host.parentElement !== parent) parent.append(host);
}

/** 进出全屏时重新挂载。返回取消监听的函数。 */
export function watchFullscreen(host: HTMLElement): () => void {
  const onChange = () => mountToTopLayer(host);
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
}

/** 阻止内嵌 UI 上的交互冒泡到宿主页面。 */
export function isolateEvents(element: HTMLElement): void {
  const types = ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'] as const;
  for (const type of types) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }
}
