/**
 * 网页沉浸式翻译的 DOM 层：段落切分、译文插入、还原、复制保护。
 *
 * 设计要点：
 * - 译文插在**原段落内部**末尾（display:block 的 span），而不是作为兄弟节点。
 *   兄弟节点会改变父级 flex/grid 布局，插在 li/td 外层还会破坏列表与表格结构。
 * - 用 span 而非 div，因为 div 不能出现在 <p> 内部。
 * - 不使用 Shadow DOM：译文要与正文一起参与查找、选区与复制。
 */

export const TRANSLATION_CLASS = 'll-tr';
export const LOADING_CLASS = 'll-tr--loading';
export const ERROR_CLASS = 'll-tr--error';
export const STYLE_ID = 'll-page-style';

/** 标记段落已处理（pending / done / error），避免重复翻译。 */
export const BLOCK_ATTR = 'data-ll-block';

/** 孤儿文本包裹层（容器里直接挂着的正文文本），还原时整个拆掉。 */
export const WRAP_CLASS = 'll-wrap';
export const WRAP_ATTR = 'data-ll-wrap';

/** 记录被我们临时解除的裁剪样式，还原时用。 */
export const CLAMP_ATTR = 'data-ll-clamp';

/** 这些标签内部的内容一律不翻译（代码、控件、媒体等）。 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'BUTTON',
  'SVG',
  'MATH',
  'CANVAS',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'OBJECT',
  'EMBED',
  'RUBY',
  'RT',
  'RP',
]);

const HAS_LETTER = /\p{L}/u;
const MIN_TEXT_LENGTH = 2;

/**
 * 被视为「块级盒子」的 display 取值。
 * 用计算样式而不是标签名来判断，因为现在很多站点整页都用 <span> + 内联样式搭建，
 * 标签名完全看不出层级。浏览器会把 flex/grid 子项自动块化，所以这类 span 的
 * 计算 display 就是 block，用这里能正确识别。
 * contents 表示元素本身不生成盒子、子元素参与外层排版，因此同样要往下钻。
 */
const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'table',
  'table-row',
  'table-cell',
  'table-caption',
  'table-header-group',
  'table-row-group',
  'table-footer-group',
  'flex',
  'grid',
  'contents',
]);

/** 每次扫描重建，避免站点在响应式断点改变 display 后用上过期判断。 */
let blockCache = new WeakMap<Element, boolean>();

/**
 * 元素在排版上是否把内容切成了多块（决定「是否还要继续往下拆分」）。
 *
 * 除了块级 display，还有一类必须一起算进来：**行内元素内部包着块级盒子**。
 * 例如整张卡片是一个未设样式的 `<a>`，它自己的 display 是 inline，
 * 但内部装着标题与正文，排版上依然是多块内容——漏掉这种情况就会把整块区域当成一个段落。
 * 结果按元素缓存，整棵子树每个元素只算一次。
 */
export function isBlockBox(element: Element): boolean {
  const cached = blockCache.get(element);
  if (cached !== undefined) return cached;
  // 先占位，防御性地避免自引用
  blockCache.set(element, false);

  let result = false;
  try {
    const display = getComputedStyle(element).display;
    if (BLOCK_DISPLAYS.has(display)) {
      result = true;
    } else if (display.startsWith('inline')) {
      result = hasBlockChild(element);
    }
  } catch {
    result = false;
  }
  blockCache.set(element, result);
  return result;
}

/** 内部是否还有块级盒子：有就说明它是容器，要继续往下拆。 */
export function hasBlockChild(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    if (isBlockBox(child)) return true;
  }
  return false;
}

const STYLE = `
.${TRANSLATION_CLASS} {
  display: block;
  margin-top: 0.3em;
  color: inherit;
  opacity: 0.85;
  font: inherit;
  line-height: inherit;
  text-align: inherit;
  white-space: normal;
  overflow-wrap: break-word;
}
.${TRANSLATION_CLASS}.${LOADING_CLASS} {
  /* 加载中不占位，避免整页出现大量"翻译中"占位块 */
  display: none;
}
.${TRANSLATION_CLASS}.${ERROR_CLASS} {
  display: block;
  opacity: 1;
  font-size: 0.92em;
  color: #d1242f;
}
/* 孤儿文本包裹层：容器里直接挂着的正文，独立成块参与排版 */
.${WRAP_CLASS} {
  display: block;
}
/* 标题的译文跟着继承了大字号会非常吵，按标题级别缩回来 */
h1 > .${TRANSLATION_CLASS} { font-size: 0.6em; }
h2 > .${TRANSLATION_CLASS} { font-size: 0.68em; }
h3 > .${TRANSLATION_CLASS},
h4 > .${TRANSLATION_CLASS},
h5 > .${TRANSLATION_CLASS},
h6 > .${TRANSLATION_CLASS} { font-size: 0.8em; }
`;

export function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.documentElement.append(style);
}

export function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * 归一化标签名。
 * HTML 元素的 tagName 是大写，但 SVG / MathML 元素属于各自命名空间，tagName 保持小写，
 * 直接拿 tagName 比对会漏掉 svg、math 这些需要跳过的节点。
 */
function tagOf(element: Element): string {
  return (element.localName || element.tagName).toUpperCase();
}

export function shouldSkip(element: Element): boolean {
  if (SKIP_TAGS.has(tagOf(element))) return true;
  if (element.hasAttribute(BLOCK_ATTR)) return true;
  if (element.classList.contains(TRANSLATION_CLASS)) return true;
  if (element.getAttribute('translate') === 'no') return true;
  // aria-hidden 标记的是装饰性内容：图标字体的连字文本（arrow_forward、bolt 之类）
  // 大多带这个属性，翻出来只会是噪音
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.matches('[contenteditable=""],[contenteditable="true"],.notranslate')) return true;
  if (element.matches('#lingualite-host,#lingualite-chip,[data-ll-ui]')) return true;
  // contenteditable 会沿祖先继承，属性选择器覆盖不到
  if ((element as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * 段落文本。
 *
 * 不能直接用 textContent：它会把 <script>/<style> 里的**源码**一并算作文本，
 * 于是整段 JS 会被送去翻译（function→函数、var→变量），译文再作为正文插回页面。
 * 这里只收集真正的文本节点，并跳过非正文标签、装饰性内容与已插入的译文。
 */
export function getBlockText(element: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.nodeValue ?? '');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (SKIP_TAGS.has(tagOf(el))) continue;
      if (el.getAttribute('translate') === 'no') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (el.classList.contains(TRANSLATION_CLASS)) continue;
      walk(el);
    }
  };
  walk(element);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function isTranslatableText(text: string): boolean {
  if (text.length < MIN_TEXT_LENGTH) return false;
  return HAS_LETTER.test(text);
}

/**
 * 译文与原文相同，说明这一段本来就无需翻译。
 *
 * 短文本的语言判定不可靠，跳过判定只能放宽；放宽之后必然会有「已经是目标语言的短片段」
 * 被送去翻译。这一步是兜底：结果没变就直接丢弃，避免页面上出现重复行。
 * 专有名词、缩写这类译出来也一样的文本同理——本来就没有展示价值。
 */
export function isNoopTranslation(source: string, translated: string | undefined): boolean {
  if (!translated) return false;
  return translated.trim() === source.trim();
}

/**
 * 收集可翻译的段落。
 *
 * 判定「哪里是段落边界」用的是**计算后的 display**，不是标签名：
 * 现在很多站点整页用 <span> + 内联样式搭建（卡片、栅格全是 span），
 * 按标签名根本看不出层级，会把整块卡片区当成一个段落，
 * 结果是几张卡片的文字被拼成一大段翻译、译文还落在卡片外面。
 *
 * 规则很简单：内部还有块级盒子就继续往下钻，没有的就是最小排版单元。
 * 容器自己直接挂着的文本（"孤儿文本"）也要包成独立段落，否则会被漏翻。
 */
export function collectBlocks(root: Element): HTMLElement[] {
  // 每次扫描重建缓存
  blockCache = new WeakMap();
  const blocks: HTMLElement[] = [];
  const visit = (element: Element): void => {
    if (shouldSkip(element)) return;
    if (hasBlockChild(element)) {
      wrapOrphanText(element, blocks);
      for (const child of Array.from(element.children)) {
        // 刚包裹的孤儿文本已经入列，跳过避免重复收集
        if (child.hasAttribute(WRAP_ATTR)) continue;
        visit(child);
      }
      return;
    }
    if (isTranslatableText(getBlockText(element))) blocks.push(element as HTMLElement);
  };
  for (const child of Array.from(root.children)) visit(child);
  return blocks;
}

/**
 * 容器既有块级子元素、又有直接挂在它下面的文本时，这些"孤儿文本"也要翻译。
 * 把每段连续文本包进一个块级 span 当作独立段落（保持原位置），还原时整个拆掉。
 */
function wrapOrphanText(element: Element, blocks: HTMLElement[]): void {
  let run: Node[] = [];
  const flush = (): void => {
    const text = run.map((node) => node.nodeValue ?? '').join(' ');
    if (isTranslatableText(text.replace(/\s+/g, ' ').trim())) {
      const wrapper = document.createElement('span');
      wrapper.className = WRAP_CLASS;
      wrapper.setAttribute(WRAP_ATTR, '1');
      element.insertBefore(wrapper, run[0]!);
      for (const node of run) wrapper.append(node);
      blocks.push(wrapper);
    }
    run = [];
  };
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim()) run.push(node);
    else flush();
  }
  flush();
}

/** 拆掉全部孤儿文本包裹层，把原文放回原位（还原的一部分，必须在移除译文之后调用）。 */
export function unwrapOrphanWrappers(): void {
  for (const wrapper of Array.from(document.querySelectorAll(`[${WRAP_ATTR}]`))) {
    const parent = wrapper.parentNode;
    if (!parent) continue;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }
}

/**
 * 元素的内容是否被裁剪（决定了译文插进去会不会被裁掉）。
 *
 * 卡片式列表常用 `-webkit-line-clamp: 2` 之类把说明文字截成两行，
 * 或者给容器固定高度配 `overflow: hidden`。这两种情况下，把译文插在元素内部，
 * 超出的部分会被 CSS 直接裁掉——译文其实生成好了，只是看不见。
 * 纯函数，便于测试；实际读取计算样式见 releaseClamp。
 */
export function needsClampRelease(
  style: { webkitLineClamp?: string; overflow?: string },
  scrollHeight: number,
  clientHeight: number,
): boolean {
  const clamp = style.webkitLineClamp;
  if (clamp && clamp !== 'none') return true;
  const overflow = style.overflow;
  if (overflow && overflow !== 'visible' && scrollHeight > clientHeight + 2) return true;
  return false;
}

/**
 * 解除元素的内容裁剪，让原文与译文都能完整显示。
 * 只改内联样式并把原值记在属性里，还原时精确恢复。
 */
export function releaseClamp(element: HTMLElement): void {
  if (element.hasAttribute(CLAMP_ATTR)) return;
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(element);
  } catch {
    return;
  }
  const lineClamp = (style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp;
  if (!needsClampRelease({ webkitLineClamp: lineClamp, overflow: style.overflow }, element.scrollHeight, element.clientHeight)) {
    return;
  }
  element.setAttribute(
    CLAMP_ATTR,
    JSON.stringify({
      lineClamp: (element.style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp ?? '',
      overflow: element.style.overflow,
    }),
  );
  (element.style as CSSStyleDeclaration & { webkitLineClamp?: string }).webkitLineClamp = 'unset';
  element.style.overflow = 'visible';
}

/** 还原被解除的裁剪。 */
export function restoreClamp(element: HTMLElement): void {
  const raw = element.getAttribute(CLAMP_ATTR);
  if (raw === null) return;
  try {
    const saved = JSON.parse(raw) as { lineClamp?: string; overflow?: string };
    const style = element.style as CSSStyleDeclaration & { webkitLineClamp?: string };
    style.webkitLineClamp = saved.lineClamp ?? '';
    element.style.overflow = saved.overflow ?? '';
  } catch {
    // 属性损坏时至少把标记去掉
  }
  element.removeAttribute(CLAMP_ATTR);
}

/** 插入译文。返回承载译文的节点。 */
export function insertTranslation(block: Element, text: string): HTMLElement {
  // 先解除裁剪，否则译文会被 line-clamp / 固定高度裁掉
  releaseClamp(block as HTMLElement);
  const span = document.createElement('span');
  span.className = TRANSLATION_CLASS;
  span.setAttribute('translate', 'no');
  span.setAttribute('data-ll-ui', '1');
  span.textContent = text;
  block.append(span);
  block.setAttribute(BLOCK_ATTR, 'done');
  return span;
}

export function markPending(block: Element): void {
  block.setAttribute(BLOCK_ATTR, 'pending');
}

/** 判定为「已经是目标语言」的段落。留下标记，避免反复参与后续扫描与语言检测。 */
export function markSkipped(block: Element): void {
  block.setAttribute(BLOCK_ATTR, 'skipped');
}

export function markError(block: Element, message: string): void {
  const span = document.createElement('span');
  span.className = `${TRANSLATION_CLASS} ${ERROR_CLASS}`;
  span.setAttribute('translate', 'no');
  span.setAttribute('data-ll-ui', '1');
  span.textContent = `翻译失败：${message}`;
  block.append(span);
  block.setAttribute(BLOCK_ATTR, 'error');
}

/** 移除页面上全部译文与标记，返回移除的译文数量。 */
export function removeAllTranslations(): number {
  const nodes = document.querySelectorAll(`.${TRANSLATION_CLASS}`);
  for (const node of Array.from(nodes)) node.remove();
  // 先移除译文再拆包裹层：包裹层里剩下的就只有原文文本
  unwrapOrphanWrappers();
  const marked = document.querySelectorAll(`[${BLOCK_ATTR}]`);
  for (const node of Array.from(marked)) node.removeAttribute(BLOCK_ATTR);
  const clamped = document.querySelectorAll(`[${CLAMP_ATTR}]`);
  for (const node of Array.from(clamped)) restoreClamp(node as HTMLElement);
  return nodes.length;
}

export function hasTranslations(): boolean {
  return document.querySelector(`.${TRANSLATION_CLASS}`) !== null;
}

/** 首次调用时摘取一段正文作为整页语境，供模型理解术语与主题。 */
export function buildSummary(blocks: HTMLElement[], maxChars = 400): string {
  const parts: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const text = getBlockText(block);
    if (text.length < 12) continue;
    parts.push(text);
    length += text.length;
    if (length >= maxChars) break;
  }
  return parts.join(' ').slice(0, maxChars);
}

/** 这些块级元素的文本在复制时要各占一行，避免跨块复制时内容粘成一团。 */
const BLOCKISH_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
]);

/** 在译文已剔除的副本上重建纯文本：块级元素各占一行，跳过我们的译文节点。 */
function plainTextOf(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? '';
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.classList.contains(TRANSLATION_CLASS)) continue;
    const tag = tagOf(el);
    if (tag === 'BR') {
      out += '\n';
      continue;
    }
    const inner = plainTextOf(el);
    out += BLOCKISH_TAGS.has(tag) || el.hasAttribute(WRAP_ATTR) ? `${inner}\n` : inner;
  }
  return out;
}

/**
 * 复制保护：双语文档里选中一段文字复制时，只保留原文，不把译文一起带走。
 * 通过在副本上删除译文节点实现，不改动页面本身。
 * 选区里全是译文时剥离结果为空——放行默认复制，用户拿到的就是所选内容。
 */
export function handleCopy(event: ClipboardEvent): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  if (!event.clipboardData) return;

  const holder = document.createElement('div');
  holder.append(selection.getRangeAt(0).cloneContents());
  if (!holder.querySelector(`.${TRANSLATION_CLASS}`)) return;

  const text = plainTextOf(holder)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return;

  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
}
