import { parseColor, themeFromBackground, type Rgba, type Theme } from '../shared/theme';

/**
 * 跟随页面实际背景决定深浅色。
 * 很多站点用固定浅色主题，此时只跟随系统偏好会让注入的 UI 显得突兀。
 */
export function detectPageTheme(): Theme {
  let background: Rgba | null = null;
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const parsed = parseColor(getComputedStyle(element).backgroundColor);
    if (parsed && parsed.a > 0.5) {
      background = parsed;
      break;
    }
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  return themeFromBackground(background, prefersDark);
}
