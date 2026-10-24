import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * tokens.css 里浅色与深色各写了两处（页面用 :root / 内嵌 UI 用 [data-theme]），
 * 这是为了同时满足「跟随系统偏好」和「Shadow DOM 里 :root 不匹配」。
 * 代价是同一个色板出现两次，因此用测试锁住一致性——数值漂移是这里唯一真正的风险。
 */
const css = readFileSync(resolve(__dirname, '../src/ui/tokens.css'), 'utf8');

function declarationsOf(pattern: RegExp): Map<string, string> {
  const match = pattern.exec(css);
  if (!match) throw new Error(`未在 tokens.css 中找到匹配：${pattern}`);
  const out = new Map<string, string>();
  for (const line of match[1]!.split(';')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    if (name.startsWith('--')) out.set(name, line.slice(at + 1).trim());
  }
  return out;
}

const rootLight = declarationsOf(/^:root \{([^}]*)\}/m);
const attrLight = declarationsOf(/^\[data-theme='light'\] \{([^}]*)\}/m);
const mediaDark = declarationsOf(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/m);
const attrDark = declarationsOf(/^\[data-theme='dark'\] \{([^}]*)\}/m);

describe('tokens.css 色板一致性', () => {
  it('浅色在两处定义中完全一致', () => {
    expect([...attrLight.entries()].sort()).toEqual([...rootLight.entries()].sort());
  });

  it('深色在两处定义中完全一致', () => {
    expect([...attrDark.entries()].sort()).toEqual([...mediaDark.entries()].sort());
  });

  it('两套色板覆盖同一组令牌名', () => {
    expect([...attrLight.keys()].sort()).toEqual([...attrDark.keys()].sort());
  });

  it('浅色与深色的取值不同（防止复制粘贴后忘记改）', () => {
    // shadow-color 刻意两套相同：它只作为 color-mix 的基色，深浅色的差异由透明度表达
    const themeIndependent = new Set(['--shadow-color']);
    const same = [...attrLight.entries()]
      .filter(([name, value]) => !themeIndependent.has(name) && attrDark.get(name) === value)
      .map(([name]) => name);
    expect(same).toEqual([]);
  });

  it('关键令牌存在且非空', () => {
    for (const name of ['--background', '--foreground', '--primary', '--border', '--input', '--ring']) {
      expect(attrLight.get(name)).toBeTruthy();
      expect(attrDark.get(name)).toBeTruthy();
    }
  });

  it('显式属性块排在系统深色媒体查询之后，才能在深色系统上强制浅色', () => {
    const mediaAt = css.indexOf('prefers-color-scheme: dark');
    const lightAt = css.indexOf("[data-theme='light']");
    const darkAt = css.indexOf("[data-theme='dark']");
    expect(lightAt).toBeGreaterThan(mediaAt);
    expect(darkAt).toBeGreaterThan(lightAt);
  });
});
