/**
 * 预览用：强制指定浅色/深色。
 *
 * 从 tokens.css 提取对应的令牌，避免预览另外维护一份配色。
 * 同时同步原生控件的 color-scheme。
 */
const LIGHT_BLOCK = /\[data-theme='light'\]\s*\{([^}]*)\}/;
const DARK_BLOCK = /\[data-theme='dark'\]\s*\{([^}]*)\}/;

function parseDeclarations(block: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!block) return out;
  for (const line of block.split(';')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.startsWith('--')) out.set(name, value);
  }
  return out;
}

export async function forceTheme(mode: 'light' | 'dark'): Promise<number> {
  const css = await fetch('tokens.css').then((res) => res.text());
  const declarations = parseDeclarations((mode === 'light' ? LIGHT_BLOCK : DARK_BLOCK).exec(css)?.[1]);
  const root = document.documentElement;
  for (const [name, value] of declarations) root.style.setProperty(name, value);
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  return declarations.size;
}

(globalThis as unknown as { forceTheme: typeof forceTheme }).forceTheme = forceTheme;
