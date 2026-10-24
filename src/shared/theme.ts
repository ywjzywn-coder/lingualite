export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Theme = 'light' | 'dark';

/** 解析 CSS 颜色里的 rgb()/rgba() 形式，其它形式（如 color-mix）返回 null。 */
export function parseColor(value: string): Rgba | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1]!.split(',').map((part) => Number.parseFloat(part.trim()));
  const [r, g, b, a = 1] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a };
}

function toLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度，0 为纯黑，1 为纯白。 */
export function relativeLuminance(color: Pick<Rgba, 'r' | 'g' | 'b'>): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** 背景亮度低于该阈值就按深色主题处理。 */
export const DARK_LUMINANCE_THRESHOLD = 0.4;

/**
 * 决定气泡用浅色还是深色。
 * 优先跟随**页面实际背景**（很多站点用固定浅色主题，此时跟随系统偏好会很突兀），
 * 页面背景透明或无法解析时再退回系统偏好。
 */
export function themeFromBackground(background: Rgba | null, prefersDark: boolean): Theme {
  if (background && background.a > 0.5) {
    return relativeLuminance(background) < DARK_LUMINANCE_THRESHOLD ? 'dark' : 'light';
  }
  return prefersDark ? 'dark' : 'light';
}
