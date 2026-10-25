import { log } from '../../shared/log';
import { callBackground } from '../../shared/messages';
import { hideChip, scheduleChipHide, showChip, type ChipCallbacks } from './chip';
import {
  BLOCK_ATTR,
  TRANSLATION_CLASS,
  buildSummary,
  collectBlocks,
  getBlockText,
  handleCopy,
  injectStyle,
  insertTranslation,
  isNoopTranslation,
  isTranslatableText,
  markError,
  markPending,
  markSkipped,
  removeAllTranslations,
  removeStyle,
} from './dom';
import { isTargetLanguage } from './lang';

/** 每批送多少段。段数太大单次响应变慢，太小则请求次数多。 */
const BATCH_SIZE = 10;
/** 攒批延迟：可视区滚动时把连续进入的段落合并成一批。 */
const FLUSH_DELAY_MS = 150;
/** SPA 动态插入内容后的重扫延迟。 */
const RESCAN_DELAY_MS = 600;
/** 预取范围：提前 1200px 开始翻译，滚动到该位置时译文已就绪。 */
const ROOT_MARGIN = '1200px 0px 1200px 0px';
/**
 * 自有注入节点的识别选择器（模块常量：MutationObserver 回调每条记录都要用，
 * 提为常量避免每次调用都重新构建字符串与选择器解析）。
 */
const OURS_SELECTOR = `.${TRANSLATION_CLASS}, #lingualite-chip, #lingualite-host, #lingualite-selection-trigger, [data-ll-ui]`;
/** 局部重扫的根节点数上限：超过说明页面在整体重构，退回全量扫描。 */
const RESCAN_ROOT_LIMIT = 12;

export type StartResult = { started: boolean; reason?: string };

class PageTranslator {
  private active = false;
  /** start 正在进行的启动流程（读取设置、检测语言期间）。 */
  private starting = false;
  private generation = 0;
  private observer: IntersectionObserver | null = null;
  private mutator: MutationObserver | null = null;
  private queue: HTMLElement[] = [];
  private failed: HTMLElement[] = [];
  /** 本次会话已经处理过的段落。防止「入队后、标记前」的空档里被重扫重复排队。 */
  private touched = new Set<HTMLElement>();
  /** 原文被站点改掉、等待重扫确认的段落。 */
  private stale = new Set<HTMLElement>();
  /** 发生过站点侧 DOM 变更的子树根，重扫时只扫这些位置。 */
  private rescanRoots = new Set<Element>();
  /** 每个段落上次翻译/跳过时的原文，用于判断动态文本是否真的变了。 */
  private lastTexts = new WeakMap<HTMLElement, string>();
  private inflight = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private done = 0;
  private total = 0;
  private summary = '';
  private targetLang = '';
  /**
   * 整页是否已经是目标语言。
   *
   * 逐段判断语言对中日文并不可靠——双方共用汉字，纯汉字的日语片段很容易被判成中文，
   * 一旦跳过就是「整段没有译文」，而漏翻比多翻一次的代价大得多。
   * 所以只在整页就是目标语言（即用户翻了一个本来就是中文的页面）时才启用逐段跳过；
   * 其他情况一律送去翻译，遇到本来就无需翻译的片段由 isNoopTranslation 丢弃。
   */
  private pageInTargetLanguage = false;

  get isActive(): boolean {
    return this.active;
  }

  private chipCallbacks: ChipCallbacks = {
    onRestore: () => {
      this.stop();
    },
    onRetry: () => this.retryFailed(),
  };

  async start(): Promise<StartResult> {
    if (this.active || this.starting) return { started: true };

    // 入口就占用代数：还原/重启会让代数前进，从而取消仍在启动中的 start
    this.starting = true;
    const generation = ++this.generation;
    try {
      const res = await callBackground({ kind: 'settings:get' });
      if (this.generation !== generation) return { started: false, reason: '已取消' };
      if (!res.ok) return { started: false, reason: res.error };
      if (!res.data.features.page) {
        return { started: false, reason: '网页沉浸式翻译已在设置里关闭' };
      }
      this.targetLang = res.data.targetLang;

      this.active = true;
      this.done = 0;
      this.total = 0;
      this.queue = [];
      this.failed = [];
      this.touched.clear();
      this.stale.clear();
      this.rescanRoots.clear();
      this.inflight = false;

      injectStyle();
      document.addEventListener('copy', handleCopy, true);

      this.observer = new IntersectionObserver(this.onIntersect, { rootMargin: ROOT_MARGIN });

      const blocks = collectBlocks(document.body);
      this.summary = buildSummary(blocks);
      // 用标题 + 开头若干段作为样本判断整页语言：样本够长，检测才可靠
      const sample = [document.title, ...blocks.slice(0, 12).map(getBlockText)]
        .join('\n')
        .slice(0, 800);
      this.pageInTargetLanguage = await isTargetLanguage(sample, this.targetLang);
      // 检测期间可能被还原：代数变了就放弃，不能继续挂观察器
      if (!this.active || this.generation !== generation) return { started: false, reason: '已取消' };
      for (const block of blocks) this.observer.observe(block);

      this.mutator = new MutationObserver(this.onMutations);
      this.mutator.observe(document.body, { childList: true, subtree: true, characterData: true });

      reportPageState(true);

      if (blocks.length === 0) {
        showChip(
          { phase: 'message', done: 0, total: 0, failed: 0, message: '这个页面没找到可翻译的正文' },
          this.chipCallbacks,
        );
        scheduleChipHide(5000);
      } else {
        showChip({ phase: 'working', done: 0, total: 0, failed: 0 }, this.chipCallbacks);
      }
      log.debug(`网页翻译已启动，发现 ${blocks.length} 个段落`);
      return { started: true };
    } finally {
      this.starting = false;
    }
  }

  stop(): number {
    // 无条件推进代数：即使尚未激活，也要能取消仍在启动中的 start
    this.generation += 1;
    if (!this.active) return 0;
    this.active = false;

    this.observer?.disconnect();
    this.observer = null;
    this.mutator?.disconnect();
    this.mutator = null;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.rescanTimer !== undefined) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    this.queue = [];
    this.failed = [];
    this.touched.clear();
    this.rescanRoots.clear();
    this.inflight = false;
    this.done = 0;
    this.total = 0;

    document.removeEventListener('copy', handleCopy, true);
    const removed = removeAllTranslations();
    removeStyle();
    hideChip();
    reportPageState(false);
    log.debug(`已还原，移除 ${removed} 段译文`);
    return removed;
  }

  private onIntersect = (entries: IntersectionObserverEntry[]): void => {
    let queued = 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const block = entry.target as HTMLElement;
      this.observer?.unobserve(block);
      // 双重保险：touched 挡住会话内重复，属性挡住跨会话重复
      if (this.touched.has(block) || block.hasAttribute(BLOCK_ATTR)) continue;
      this.touched.add(block);
      // 立刻标记，缩小「已入队但未处理」的空档，重扫时才不会重复收集
      markPending(block);
      this.queue.push(block);
      this.total += 1;
      queued += 1;
    }
    if (queued === 0) return;
    this.updateChip();
    this.scheduleFlush();
  };

  private onMutations = (records: MutationRecord[]): void => {
    if (!this.active) return;
    const isOurs = (node: Node | null): boolean => {
      const element = node instanceof Element ? node : node?.parentElement ?? null;
      return Boolean(element?.closest(OURS_SELECTOR));
    };
    let relevant = false;
    for (const record of records) {
      if (record.type === 'characterData') {
        if (isOurs(record.target)) continue;
        // 已翻译/已跳过/出错的段落文字被站点改掉：标记待重扫，重扫时确认后重翻
        const host = record.target.parentElement?.closest(`[${BLOCK_ATTR}]`);
        if (host instanceof HTMLElement) {
          const state = host.getAttribute(BLOCK_ATTR);
          if (state === 'done' || state === 'skipped' || state === 'error') this.stale.add(host);
        }
        relevant = true;
        continue;
      }
      if (record.target instanceof Element && record.target.closest(OURS_SELECTOR)) {
        continue;
      }
      // 站点自己的 DOM 改动（新增或移除都算）：触发重扫
      const hasForeign =
        Array.from(record.addedNodes).some((node) => !isOurs(node)) ||
        Array.from(record.removedNodes).some((node) => !isOurs(node));
      if (!hasForeign) continue;
      relevant = true;
      if (record.target instanceof Element) {
        // 记下变更发生的子树：重扫只扫这里，滚动加载时不必整页遍历
        this.rescanRoots.add(record.target);
        // 虚拟列表复用、textContent 重写等场景会改写已翻译段落的内部结构：
        // 该段落必须失效重翻，否则旧译文残留（或原文换掉后译文整段消失）。
        // 自己插入译文走的是 OURS_SELECTOR 分支，不会进到这里。
        const host = record.target.closest(`[${BLOCK_ATTR}]`);
        if (host instanceof HTMLElement) {
          const state = host.getAttribute(BLOCK_ATTR);
          if (state === 'done' || state === 'skipped' || state === 'error') this.stale.add(host);
        }
      }
    }
    if (!relevant) return;

    if (this.rescanTimer !== undefined) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.rescan();
    }, RESCAN_DELAY_MS);
  };

  /** SPA 换页或无限滚动后重新收集段落。已处理的段落带着标记，会被自动跳过。 */
  private rescan(): void {
    if (!this.active || !this.observer) return;
    let added = 0;
    // 原文动态变化的段落：确认文字真的变了才清掉旧译文重新观察
    const stale = Array.from(this.stale);
    this.stale.clear();
    for (const block of stale) {
      const previous = this.lastTexts.get(block);
      if (previous !== undefined && getBlockText(block) === previous) continue;
      block.removeAttribute(BLOCK_ATTR);
      for (const node of Array.from(block.querySelectorAll(`.${TRANSLATION_CLASS}`))) node.remove();
      this.touched.delete(block);
      // 若它还在失败列表里，重扫路径会接管，避免重试与重扫双份入队
      this.failed = this.failed.filter((item) => item !== block);
      this.observer.unobserve(block);
      this.observer.observe(block);
      added += 1;
    }
    // 局部重扫：只遍历发生过变更的子树，社交 feed 滚动时不再整页重扫。
    // 扫描从变更目标的父级开始——目标本身若是叶子段落（如 <p>），从它内部扫
    // 会只看到行内子节点而漏掉它自己；从父级扫它就能按正常叶子处理。
    // 根数量过多说明页面在整体重构（SPA 换页），退回全量扫描。
    const recorded = this.rescanRoots;
    this.rescanRoots = new Set();
    const parentRoots = new Set<Element>();
    for (const target of recorded) parentRoots.add(target.parentElement ?? target);
    const scanRoots: Element[] =
      parentRoots.size === 0 || parentRoots.size > RESCAN_ROOT_LIMIT
        ? [document.body]
        : Array.from(parentRoots);
    for (const root of scanRoots) {
      for (const block of collectBlocks(root)) {
        if (this.touched.has(block)) continue;
        this.observer.observe(block);
        added += 1;
      }
    }
    if (added > 0) log.debug(`重扫发现 ${added} 个更新段落`);
  }

  private scheduleFlush(immediate = false): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = undefined;
        void this.flush();
      },
      immediate ? 0 : FLUSH_DELAY_MS,
    );
  }

  private async flush(): Promise<void> {
    const generation = this.generation;
    if (!this.active || this.inflight) return;
    this.inflight = true;
    try {
      await this.runBatch();
    } catch (err) {
      log.warn('网页翻译批次异常', err);
    } finally {
      // 会话已被还原/重启时不能动新会话的 inflight 标志，否则会造成并行重发
      if (generation === this.generation) this.inflight = false;
    }
    if (!this.active || generation !== this.generation) return;
    if (this.queue.length > 0) this.scheduleFlush(true);
    else this.finish();
  }

  private async runBatch(): Promise<void> {
    const generation = this.generation;
    const batch = this.queue.splice(0, BATCH_SIZE);

    const blocks: HTMLElement[] = [];
    const texts: string[] = [];
    for (const block of batch) {
      if (!block.isConnected) continue;
      const text = getBlockText(block);
      if (!isTranslatableText(text)) continue;
      // 只有整页就是目标语言时才逐段跳过，避免把纯汉字的日语误判成中文后漏翻
      if (this.pageInTargetLanguage) {
        const target = await isTargetLanguage(text, this.targetLang);
        // 检测等待期间可能被还原/重启：代数变了立刻放弃，不能继续标记
        if (!this.active || generation !== this.generation) return;
        if (target) {
          markSkipped(block);
          this.lastTexts.set(block, text);
          continue;
        }
      }
      blocks.push(block);
      texts.push(text);
    }
    // 被跳过的段落不计入总数，进度条才不会虚高
    this.total = Math.max(this.done, this.total - (batch.length - blocks.length));

    if (blocks.length === 0) {
      this.updateChip();
      return;
    }

    const res = await callBackground({
      kind: 'translate',
      req: {
        texts,
        from: '',
        to: '',
        context: { title: document.title, url: location.href, summary: this.summary },
      },
    });

    if (!this.active || generation !== this.generation) return;

    if (res.ok) {
      blocks.forEach((block, index) => {
        const translated = res.data.texts[index];
        const source = texts[index] ?? '';
        if (!block.isConnected) {
          // 段落已被站点移除：不计入完成数
          this.total = Math.max(this.done, this.total - 1);
          return;
        }
        // 请求期间原文被站点改掉（虚拟列表复用等）：旧响应作废，按当前文本重新排队。
        // 不加这条防线，旧译文会被贴到新原文下面。
        if (getBlockText(block) !== source) {
          block.removeAttribute(BLOCK_ATTR);
          this.queue.push(block);
          return;
        }
        if (!translated) {
          markError(block, '没有返回译文');
          this.failed.push(block);
          return;
        }
        // 译文与原文完全一致，说明这段本来就无需翻译（多为已经是目标语言的短片段，
        // 短文本的语言判定不可靠，只能靠结果来兜底）。丢弃它，避免出现重复行。
        if (isNoopTranslation(source, translated)) {
          markSkipped(block);
          this.lastTexts.set(block, source);
          this.total = Math.max(this.done, this.total - 1);
          return;
        }
        insertTranslation(block, translated);
        this.lastTexts.set(block, source);
        this.done += 1;
      });
    } else {
      for (const block of blocks) {
        markError(block, res.error);
        this.failed.push(block);
      }
    }
    this.updateChip();
  }

  private retryFailed(): void {
    if (this.failed.length === 0) return;
    const blocks = this.failed.splice(0);
    for (const block of blocks) {
      block.removeAttribute(BLOCK_ATTR);
      for (const node of Array.from(block.querySelectorAll(`.${TRANSLATION_CLASS}`))) node.remove();
      this.queue.push(block);
    }
    this.updateChip();
    this.scheduleFlush(true);
  }

  private finish(): void {
    if (!this.active || this.inflight) return;
    this.updateChip(true);
    if (this.failed.length === 0) scheduleChipHide();
  }

  private updateChip(finished = false): void {
    const failed = this.failed.length;
    if (finished) {
      if (this.done === 0 && failed === 0) {
        showChip(
          { phase: 'message', done: 0, total: 0, failed: 0, message: '没有找到需要翻译的内容' },
          this.chipCallbacks,
        );
        return;
      }
      showChip({ phase: 'done', done: this.done, total: this.total, failed }, this.chipCallbacks);
      return;
    }
    showChip(
      { phase: 'working', done: this.done, total: Math.max(this.total, this.done), failed },
      this.chipCallbacks,
    );
  }
}

export const pageTranslator = new PageTranslator();

/**
 * 上报翻译状态给 Service Worker。
 * 右键菜单是全局的，只能靠这里回传的状态决定显示「翻译此页」还是「还原原文」。
 */
function reportPageState(active: boolean): void {
  void callBackground({ kind: 'page:state', active });
}

export async function translatePage(): Promise<StartResult> {
  return pageTranslator.start();
}

export function restorePage(): number {
  return pageTranslator.stop();
}
