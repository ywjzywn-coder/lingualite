/**
 * 内嵌 UI 共用的图标：24×24 viewBox 的实心 Material 路径，fill 跟随 currentColor，
 * 因此在浅色/深色令牌下自动配色，不依赖 emoji 或字体渲染差异。
 * 用法：插进 innerHTML，尺寸由 .icon（ui/base.ts）或组件自己的 CSS 控制。
 */

function icon(path: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

/** 翻译（划词触发按钮）：「文/A」双语组合图标。 */
export const ICON_TRANSLATE = icon(
  'M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z',
);

/** 朗读（气泡里的原文/译文按钮）。 */
export const ICON_VOLUME = icon(
  'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
);

/** 关闭（气泡、进度胶囊共用）。 */
export const ICON_CLOSE = icon(
  'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
);
