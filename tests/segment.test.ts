// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCK_ATTR,
  TRANSLATION_CLASS,
  buildSummary,
  collectBlocks,
  getBlockText,
  handleCopy,
  insertTranslation,
  isNoopTranslation,
  isTranslatableText,
  needsClampRelease,
  removeAllTranslations,
  shouldSkip,
} from '../src/content/page/dom';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('collectBlocks', () => {
  it('收集段落、标题与列表项', () => {
    const root = mount(`
      <article>
        <h1>Hello world</h1>
        <p>First paragraph of the article.</p>
        <ul><li>An item in the list</li></ul>
      </article>`);
    const texts = collectBlocks(root).map(getBlockText);
    expect(texts).toEqual(['Hello world', 'First paragraph of the article.', 'An item in the list']);
  });

  it('容器本身不被当作段落，而是继续往下找', () => {
    const root = mount(`<div id="wrap"><div id="inner"><p>Nested paragraph text</p></div></div>`);
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tagName).toBe('P');
  });

  it('跳过代码块、脚本与表单控件', () => {
    const root = mount(`
      <div>
        <pre><code>const a = 1;</code></pre>
        <script>var x = 1;</script>
        <textarea>An editable value</textarea>
        <p>Real translatable text</p>
      </div>`);
    expect(collectBlocks(root).map(getBlockText)).toEqual(['Real translatable text']);
  });

  it('跳过 contenteditable 区域与 notranslate 标记', () => {
    const root = mount(`
      <div>
        <div contenteditable="true"><p>Editable rich text</p></div>
        <p class="notranslate">Do not translate me</p>
        <p translate="no">Also skipped</p>
        <p>Translatable here</p>
      </div>`);
    expect(collectBlocks(root).map(getBlockText)).toEqual(['Translatable here']);
  });

  it('跳过已经处理过的段落', () => {
    const root = mount(`<div><p data-ll-block="done">Already translated</p><p>Fresh text</p></div>`);
    expect(collectBlocks(root).map(getBlockText)).toEqual(['Fresh text']);
  });

  it('跳过纯数字、纯符号与过短的文本', () => {
    const root = mount(`<div><p>12345</p><p>—— 。，</p><p>a</p><p>OK</p></div>`);
    expect(collectBlocks(root).map(getBlockText)).toEqual(['OK']);
  });

  it('段落文本折叠多余空白', () => {
    const root = mount(`<p>  line one\n\n   line   two  </p>`);
    expect(getBlockText(collectBlocks(root)[0]!)).toBe('line one line two');
  });

  it('包含行内标签时整段作为一个单元', () => {
    const root = mount(`<p>Text with <a href="#">a link</a> inside it</p>`);
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(getBlockText(blocks[0]!)).toBe('Text with a link inside it');
  });

  it('整张卡片是一个 <a> 时，外层容器不算段落', () => {
    // 线上真实问题：三张卡片被拼成一大段翻译，译文落在卡片外面
    const root = mount(`
      <div class="cards">
        <a class="card" href="/a"><h3>仕事を探す</h3><p>経験や希望条件に合う案件を探せます。</p></a>
        <a class="card" href="/b"><h3>人材を探す</h3><p>必要なスキルや体制に合う人材を探せます。</p></a>
      </div>`);
    const texts = collectBlocks(root).map(getBlockText);
    // 每张卡片的标题与正文各自成段，而不是把三张卡片拼成一段
    expect(texts).toEqual([
      '仕事を探す',
      '経験や希望条件に合う案件を探せます。',
      '人材を探す',
      '必要なスキルや体制に合う人材を探せます。',
    ]);
  });

  it('Web Component 包裹的卡片同样按段落拆开', () => {
    const root = mount(`
      <div class="grid">
        <my-card><div><h3>标题一</h3><p>第一段正文内容</p></div></my-card>
        <my-card><div><h3>标题二</h3><p>第二段正文内容</p></div></my-card>
      </div>`);
    const texts = collectBlocks(root).map(getBlockText);
    expect(texts).toEqual(['标题一', '第一段正文内容', '标题二', '第二段正文内容']);
  });

  it('全 span + 内联样式的卡片（线上真实结构）按段落拆开', () => {
    // 复刻 enger.jp 的结构：整页用 span 和 display 内联样式搭建，
    // 卡片内没有块级标签，图标是 aria-hidden 的图标字体连字
    const root = mount(`
      <div data-r="cards" style="display:grid">
        <a data-r="card" href="/freelance" style="display:flex;flex-direction:column">
          <span aria-hidden="true" style="display:block"><span class="ms">work</span></span>
          <span style="display:block">案件を探している個人の方</span>
          <span style="display:block">仕事を探す</span>
          <span style="display:block">経験や希望条件に合う案件を探せます。</span>
          <span style="display:flex">案件・サポートを見る<span class="ms" aria-hidden="true">arrow_forward</span></span>
        </a>
      </div>`);
    expect(collectBlocks(root).map(getBlockText)).toEqual([
      '案件を探している個人の方',
      '仕事を探す',
      '経験や希望条件に合う案件を探せます。',
      '案件・サポートを見る',
    ]);
  });

  it('aria-hidden 的装饰性图标文本不进入译文', () => {
    const root = mount(`
      <div style="display:block">
        <span aria-hidden="true">arrow_forward</span>
        <span style="display:block">要看的内容</span>
      </div>`);
    const texts = collectBlocks(root).map(getBlockText);
    expect(texts).toEqual(['要看的内容']);
  });

  it('子元素只是行内标签时，容器仍按整段处理', () => {
    const root = mount(`<div><span>一段用 span 包起来的完整文字</span></div>`);
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(getBlockText(blocks[0]!)).toBe('一段用 span 包起来的完整文字');
  });

  it('不把 script / style 里的源码当作正文', () => {
    const root = mount(`
      <div>
        <div><script>function r(a){return a.dataset.x}</script></div>
        <div><style>.a{display:none}</style></div>
        <p>Real content</p>
      </div>`);
    // 只包含脚本的容器不应被当作段落，否则整段 JS 会被送去翻译
    expect(collectBlocks(root).map(getBlockText)).toEqual(['Real content']);
  });

  it('表格按单元格分段（真实浏览器对 thead/tbody/tr/td 的计算 display）', () => {
    // 线上真实问题：整张表格被收作一段，译文以一行挂在表格末尾
    const root = mount(`
      <table style="display:table">
        <thead style="display:table-header-group">
          <tr style="display:table-row">
            <th style="display:table-cell">Approach</th>
            <th style="display:table-cell">Requests per page</th>
          </tr>
        </thead>
        <tbody style="display:table-row-group">
          <tr style="display:table-row">
            <td style="display:table-cell">Whole page at once</td>
            <td style="display:table-cell">1 very large request</td>
          </tr>
        </tbody>
      </table>`);
    expect(collectBlocks(root).map(getBlockText)).toEqual([
      'Approach',
      'Requests per page',
      'Whole page at once',
      '1 very large request',
    ]);
  });

  it('容器既有块级子元素又有直接文本时，直接文本不会被漏掉', () => {
    // 线上真实问题：嵌套列表的外层 li 直接文字、容器里的引导语会被 collectBlocks 丢弃
    const root = mount(`
      <ul style="display:block">
        <li style="display:list-item">
          Outer direct text
          <p style="display:block">Inner paragraph</p>
        </li>
      </ul>
      <div style="display:block">
        Intro text directly in the container
        <p style="display:block">Block child paragraph</p>
      </div>`);
    const blocks = collectBlocks(root);
    expect(blocks.map(getBlockText)).toEqual([
      'Outer direct text',
      'Inner paragraph',
      'Intro text directly in the container',
      'Block child paragraph',
    ]);
    // 直接文本被包进了带标记的包裹层
    expect(root.querySelectorAll('[data-ll-wrap]')).toHaveLength(2);
  });

  it('孤儿文本包裹层在还原时拆掉，原文回到原位', () => {
    const root = mount(`
      <div id="host" style="display:block">
        <p style="display:block">Block one</p>
        Orphan trailing text here
      </div>`);
    const host = root.querySelector('#host')!;
    const [wrapper] = collectBlocks(root);
    expect(wrapper!.hasAttribute('data-ll-wrap')).toBe(true);
    insertTranslation(wrapper!, '包裹层译文');

    expect(removeAllTranslations()).toBe(1);
    expect(document.querySelector('[data-ll-wrap]')).toBeNull();
    expect(document.querySelector(`[${BLOCK_ATTR}]`)).toBeNull();
    // 原文恢复原状：文本节点的相对顺序不变
    expect(host.textContent!.replace(/\s+/g, ' ').trim()).toBe('Block one Orphan trailing text here');
  });

  it('包裹层内的原文参与翻译且可再次收集', () => {
    const root = mount(`
      <div style="display:block">
        <p style="display:block">Block one</p>
        Orphan trailing text here
      </div>`);
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(2);
    insertTranslation(blocks[0]!, '译文一');
    insertTranslation(blocks[1]!, '译文二');
    // 已处理的段落不再被收集
    expect(collectBlocks(root)).toHaveLength(0);
    removeAllTranslations();
    expect(collectBlocks(root)).toHaveLength(2);
  });

  it('段落里混有 script 时只取可见文字', () => {
    const root = mount(`<div><span>Visible text</span><script>var x = 1;</script></div>`);
    const blocks = collectBlocks(root);
    expect(blocks).toHaveLength(1);
    expect(getBlockText(blocks[0]!)).toBe('Visible text');
  });
});

describe('isTranslatableText', () => {
  it('至少要有字母', () => {
    expect(isTranslatableText('hello')).toBe(true);
    expect(isTranslatableText('你好')).toBe(true);
    expect(isTranslatableText('123')).toBe(false);
    expect(isTranslatableText('!!! ---')).toBe(false);
    expect(isTranslatableText(' ')).toBe(false);
  });
});

describe('needsClampRelease', () => {
  it('line-clamp 生效时需要解除，否则译文会被裁掉', () => {
    expect(needsClampRelease({ webkitLineClamp: '2', overflow: 'hidden' }, 100, 40)).toBe(true);
  });

  it('未做裁剪时不动它', () => {
    expect(needsClampRelease({ webkitLineClamp: 'none', overflow: 'visible' }, 40, 40)).toBe(false);
    expect(needsClampRelease({}, 40, 40)).toBe(false);
  });

  it('overflow 确实裁掉了内容时也要解除', () => {
    expect(needsClampRelease({ overflow: 'hidden' }, 100, 40)).toBe(true);
  });

  it('overflow hidden 但内容没超出时不动它', () => {
    expect(needsClampRelease({ overflow: 'hidden' }, 40, 40)).toBe(false);
  });
});

describe('isNoopTranslation', () => {
  it('译文与原文相同视为无需翻译', () => {
    expect(isNoopTranslation('网页翻译开关', '网页翻译开关')).toBe(true);
  });

  it('忽略首尾空白差异', () => {
    expect(isNoopTranslation('  设置 ', '设置')).toBe(true);
  });

  it('译文为空或缺失时不视为无需翻译（交由错误分支处理）', () => {
    expect(isNoopTranslation('设置', '')).toBe(false);
    expect(isNoopTranslation('设置', undefined)).toBe(false);
  });

  it('正常译文不会被误判', () => {
    expect(isNoopTranslation('Settings', '设置')).toBe(false);
    expect(isNoopTranslation('Settings', 'Settings 设置')).toBe(false);
  });
});

describe('shouldSkip', () => {
  it('识别应跳过的标签', () => {
    const root = mount(`<div><p>text</p></div>`);
    expect(shouldSkip(root.querySelector('p')!)).toBe(false);
  });

  it('跳过 SVG 与 MathML——它们的 tagName 是小写，容易漏判', () => {
    const root = mount(`
      <div>
        <svg><text>icon label</text></svg>
        <math><mi>x</mi></math>
        <p>Real text</p>
      </div>`);
    expect(shouldSkip(root.querySelector('svg')!)).toBe(true);
    expect(shouldSkip(root.querySelector('math')!)).toBe(true);
    // SVG 内部的文字不应被当作段落收集
    expect(collectBlocks(root).map(getBlockText)).toEqual(['Real text']);
  });
});

describe('insertTranslation / removeAllTranslations', () => {
  it('译文插在原段落内部，原文保持可读顺序', () => {
    const root = mount(`<p id="target">Original text</p>`);
    const block = root.querySelector('#target')!;
    insertTranslation(block, '译文内容');

    const span = block.querySelector(`.${TRANSLATION_CLASS}`)!;
    expect(span.textContent).toBe('译文内容');
    expect(span.getAttribute('translate')).toBe('no');
    expect(block.getAttribute(BLOCK_ATTR)).toBe('done');
    // 原文仍在译文之前
    expect(block.textContent).toBe('Original text译文内容');
  });

  it('用 span 而非 div，才能安全放进 <p>', () => {
    const root = mount(`<p id="target">Original text</p>`);
    const block = root.querySelector('#target')!;
    const span = insertTranslation(block, '译文');
    expect(span.tagName).toBe('SPAN');
  });

  it('还原会移除全部译文并清掉标记', () => {
    const root = mount(`<p id="a">First</p><p id="b">Second</p>`);
    insertTranslation(root.querySelector('#a')!, '一');
    insertTranslation(root.querySelector('#b')!, '二');

    expect(removeAllTranslations()).toBe(2);
    expect(document.querySelector(`.${TRANSLATION_CLASS}`)).toBeNull();
    expect(document.querySelector(`[${BLOCK_ATTR}]`)).toBeNull();
    expect(document.body.textContent).toBe('FirstSecond');
  });

  it('还原后段落可以再次被收集', () => {
    const root = mount(`<p id="a">Some text here</p>`);
    const block = root.querySelector('#a')!;
    insertTranslation(block, '译文');
    expect(collectBlocks(root)).toHaveLength(0);

    removeAllTranslations();
    expect(collectBlocks(root)).toHaveLength(1);
  });
});

describe('buildSummary', () => {
  it('取前若干段拼成摘要', () => {
    const root = mount(`
      <p>First sentence of the page.</p>
      <p>Second sentence with more words.</p>
      <p>Third one that should be cut off eventually.</p>`);
    const summary = buildSummary(collectBlocks(root), 40);
    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary.startsWith('First sentence')).toBe(true);
  });

  it('忽略过短的碎片', () => {
    const root = mount(`<p>hi</p><p>A long enough sentence to be included here.</p>`);
    expect(buildSummary(collectBlocks(root))).toBe('A long enough sentence to be included here.');
  });
});

describe('handleCopy 复制保护', () => {
  function makeCopyEvent(): { event: ClipboardEvent; get: () => string } {
    const store = new Map<string, string>();
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => store.set(type, value),
        getData: (type: string) => store.get(type) ?? '',
      },
    });
    return { event, get: () => store.get('text/plain') ?? '' };
  }

  function select(element: Element): void {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it('选中含译文的段落时，复制内容只保留原文', () => {
    const root = mount(`<p id="target">Original text</p>`);
    const block = root.querySelector('#target')!;
    insertTranslation(block, '译文内容');
    select(block);

    const { event, get } = makeCopyEvent();
    handleCopy(event);
    expect(get()).toBe('Original text');
    expect(event.defaultPrevented).toBe(true);
  });

  it('选区不含译文时不干预剪贴板', () => {
    const root = mount(`<p id="target">Original text</p>`);
    select(root.querySelector('#target')!);

    const { event, get } = makeCopyEvent();
    handleCopy(event);
    expect(get()).toBe('');
    expect(event.defaultPrevented).toBe(false);
  });

  it('跨多个段落复制时同样剔除译文，且段落各占一行', () => {
    const root = mount(`<p id="a">First</p><p id="b">Second</p>`);
    insertTranslation(root.querySelector('#a')!, '一');
    insertTranslation(root.querySelector('#b')!, '二');

    const range = document.createRange();
    range.setStartBefore(root.querySelector('#a')!);
    range.setEndAfter(root.querySelector('#b')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const { event, get } = makeCopyEvent();
    handleCopy(event);
    expect(get()).toBe('First\nSecond');
    expect(event.defaultPrevented).toBe(true);
  });

  it('选区全是译文时放行默认复制，而不是复制出空字符串', () => {
    const root = mount(`<p id="a">First</p>`);
    const block = root.querySelector('#a')!;
    const span = insertTranslation(block, '译文内容');
    // 选中我们插入的译文节点本身
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const { event, get } = makeCopyEvent();
    handleCopy(event);
    expect(get()).toBe('');
    expect(event.defaultPrevented).toBe(false);
  });
});
