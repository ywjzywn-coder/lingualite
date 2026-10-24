/**
 * 扩展页面（popup / options）的主题同步。
 * 组件样式用 [data-theme="dark"] 作用域，与 Shadow DOM 内嵌 UI 共用同一套写法；
 * 组件只在 JS 渲染后存在，因此在入口渲染前设置属性不会造成闪烁。
 * 令牌本身还有 prefers-color-scheme 兜底，即使脚本未执行也是对的。
 */
export function applyTheme(): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    document.documentElement.dataset.theme = media.matches ? 'dark' : 'light';
  };
  sync();
  media.addEventListener('change', sync);
}
