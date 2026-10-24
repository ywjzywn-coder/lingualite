import { describe, expect, it } from 'vitest';
import { parseColor, relativeLuminance, themeFromBackground } from '../src/shared/theme';

describe('parseColor', () => {
  it('解析 rgb()', () => {
    expect(parseColor('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('解析 rgba() 并保留透明度', () => {
    expect(parseColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('无法解析的形式返回 null', () => {
    expect(parseColor('transparent')).toBeNull();
    expect(parseColor('color(srgb 0 0 0)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('纯黑为 0，纯白为 1', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});

describe('themeFromBackground', () => {
  it('浅色背景判为 light', () => {
    expect(themeFromBackground(parseColor('rgb(251, 251, 253)'), true)).toBe('light');
  });

  it('深色背景判为 dark', () => {
    expect(themeFromBackground(parseColor('rgb(31, 33, 39)'), false)).toBe('dark');
  });

  it('中灰偏暗的背景判为 dark', () => {
    expect(themeFromBackground(parseColor('rgb(64, 64, 64)'), false)).toBe('dark');
  });

  it('中灰偏亮的背景判为 light', () => {
    expect(themeFromBackground(parseColor('rgb(200, 200, 200)'), true)).toBe('light');
  });

  it('背景透明时回退到系统偏好', () => {
    expect(themeFromBackground(parseColor('rgba(0, 0, 0, 0)'), true)).toBe('dark');
    expect(themeFromBackground(parseColor('rgba(0, 0, 0, 0)'), false)).toBe('light');
  });

  it('无法解析时回退到系统偏好', () => {
    expect(themeFromBackground(null, true)).toBe('dark');
  });
});
