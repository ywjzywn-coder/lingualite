export const SETTINGS_KEY = 'settings';

export type EngineKind = 'google' | 'llm';

/** 思考强度预设。统一映射到 reasoning_effort，可用 extraBody 覆盖成厂商私有字段。 */
export type ReasoningEffort = 'default' | 'none' | 'low' | 'medium' | 'high';

/** 翻译风格档。只影响提示词里追加的风格片段。 */
export type TranslationStyle = 'natural' | 'literal' | 'casual' | 'formal';

export interface ProviderConfig {
  id: string;
  label: string;
  /** OpenAI 兼容根地址，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort: ReasoningEffort;
  /** 额外的请求体字段（JSON），最后合并，可覆盖上面任何字段 */
  extraBody: string;
  /** 额外的请求头（JSON） */
  extraHeaders: string;
  /** 每批发送的段落数 */
  batchSize: number;
}

export interface FeatureFlags {
  page: boolean;
  select: boolean;
}

export interface Settings {
  version: 1;
  sourceLang: string;
  targetLang: string;
  engine: EngineKind;
  activeProviderId: string;
  providers: ProviderConfig[];
  /** 翻译风格档 */
  style: TranslationStyle;
  /** 追加在全部内置规则之后的要求，用来微调风格而不破坏规则 */
  extraInstructions: string;
  /** 术语表，每行一条「原文=译法」 */
  glossaryText: string;
  /** LLM 失败时自动降级到 Google 免费接口 */
  fallbackToGoogle: boolean;
  /** 是否把页面/视频上下文交给 LLM */
  useContext: boolean;
  features: FeatureFlags;
}

export interface LangOption {
  code: string;
  label: string;
}

export const LANGS: LangOption[] = [
  { code: 'auto', label: '自动检测' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ru', label: 'Русский' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'ar', label: 'العربية' },
  { code: 'th', label: 'ไทย' },
  { code: 'vi', label: 'Tiếng Việt' },
];

export const TARGET_LANGS = LANGS.filter((l) => l.code !== 'auto');

export const PROVIDER_PRESETS: Array<Pick<ProviderConfig, 'id' | 'label' | 'baseUrl' | 'model'>> = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '' },
];

export function createProvider(presetId: string): ProviderConfig {
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0]!;
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: '',
    temperature: 0,
    reasoningEffort: 'default',
    extraBody: '',
    extraHeaders: '',
    batchSize: 10,
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  engine: 'google',
  activeProviderId: 'deepseek',
  providers: [createProvider('deepseek')],
  style: 'natural',
  extraInstructions: '',
  glossaryText: '',
  fallbackToGoogle: true,
  useContext: true,
    features: { page: true, select: true },
};

const EFFORTS: ReasoningEffort[] = ['default', 'none', 'low', 'medium', 'high'];
const STYLES: TranslationStyle[] = ['natural', 'literal', 'casual', 'formal'];

/**
 * 解析术语表。每行一条，支持 `原文=译法` 与 `原文=>译法`；`#` 开头为注释。
 * 译法里本身含 `=` 也没问题，只按第一个分隔符切分。
 */
export function parseGlossary(text: string, limit = 100): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const arrow = line.indexOf('=>');
    const at = arrow >= 0 ? arrow : line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + (arrow >= 0 ? 2 : 1)).trim();
    if (!key || !value) continue;
    entries.push([key, value]);
    if (entries.length >= limit) break;
  }
  return entries;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeProvider(raw: unknown, fallback: ProviderConfig): ProviderConfig {
  const src = (raw ?? {}) as Partial<ProviderConfig>;
  const effort = EFFORTS.includes(src.reasoningEffort as ReasoningEffort)
    ? (src.reasoningEffort as ReasoningEffort)
    : fallback.reasoningEffort;
  return {
    id: asString(src.id, fallback.id),
    label: asString(src.label, fallback.label),
    baseUrl: asString(src.baseUrl, fallback.baseUrl).trim(),
    apiKey: asString(src.apiKey, fallback.apiKey),
    model: asString(src.model, fallback.model).trim(),
    temperature: asNumber(src.temperature, fallback.temperature, 0, 2),
    reasoningEffort: effort,
    extraBody: asString(src.extraBody, fallback.extraBody),
    extraHeaders: asString(src.extraHeaders, fallback.extraHeaders),
    batchSize: Math.round(asNumber(src.batchSize, fallback.batchSize, 1, 50)),
  };
}

/** 把任意来源（磁盘上的旧数据、用户输入）规范化为合法设置。 */
export function normalizeSettings(raw: unknown): Settings {
  const src = (raw ?? {}) as Partial<Settings>;
  const providersRaw = Array.isArray(src.providers) ? src.providers : [];
  const providers = providersRaw.map((p) => normalizeProvider(p, DEFAULT_SETTINGS.providers[0]!));
  if (providers.length === 0) providers.push(createProvider('deepseek'));

  const activeId = asString(src.activeProviderId, DEFAULT_SETTINGS.activeProviderId);
  const features = (src.features ?? {}) as Partial<FeatureFlags>;

  // 旧版本把自定义提示词存在服务商里，迁移成全局的「附加要求」，避免升级后静默丢失
  const extraInstructions = asString(src.extraInstructions, '').trim()
    ? asString(src.extraInstructions, '')
    : asString(
        providersRaw
          .map((p) => (p as { systemPrompt?: unknown })?.systemPrompt)
          .find((value) => typeof value === 'string' && value.trim()),
        '',
      );

  return {
    version: 1,
    sourceLang: asString(src.sourceLang, DEFAULT_SETTINGS.sourceLang),
    targetLang: asString(src.targetLang, DEFAULT_SETTINGS.targetLang),
    engine: src.engine === 'llm' ? 'llm' : 'google',
    activeProviderId: providers.some((p) => p.id === activeId) ? activeId : providers[0]!.id,
    providers,
    style: STYLES.includes(src.style as TranslationStyle)
      ? (src.style as TranslationStyle)
      : DEFAULT_SETTINGS.style,
    extraInstructions,
    glossaryText: asString(src.glossaryText, ''),
    fallbackToGoogle: asBool(src.fallbackToGoogle, DEFAULT_SETTINGS.fallbackToGoogle),
    useContext: asBool(src.useContext, DEFAULT_SETTINGS.useContext),
    features: {
      page: asBool(features.page, true),
      select: asBool(features.select, true),
    },
  };
}

/** 朴素深合并：只处理普通对象与数组，数组整体替换。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object') return patch as unknown as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as unknown as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

export function findProvider(settings: Settings, id = settings.activeProviderId): ProviderConfig | undefined {
  return settings.providers.find((p) => p.id === id);
}

/** 内容脚本可见的公开设置：只含语言、风格与功能开关，密钥永不出扩展上下文。 */
export interface PublicSettings {
  sourceLang: string;
  targetLang: string;
  style: TranslationStyle;
  features: FeatureFlags;
}

export function publicSettings(settings: Settings): PublicSettings {
  return {
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    style: settings.style,
    features: { ...settings.features },
  };
}

// ---- 读写 ----
// 注意：内容脚本运行在页面源下，其 IndexedDB / localStorage 属于页面而非扩展，
// 因此设置的读写统一由 Service Worker 代理。

let memory: Settings | null = null;

export async function getSettings(force = false): Promise<Settings> {
  if (memory && !force) return memory;
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    memory = normalizeSettings(stored[SETTINGS_KEY]);
  } catch {
    memory = normalizeSettings(undefined);
  }
  return memory;
}

export async function saveSettings(next: Settings): Promise<Settings> {
  const normalized = normalizeSettings(next);
  memory = normalized;
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

/**
 * 串行化写队列：多个上下文同时 patch 时按到达顺序逐个合并，
 * 避免「读-改-写」在并发下互相覆盖（后写的把先写的字段丢掉）。
 */
let writeChain: Promise<unknown> = Promise.resolve();

export async function patchSettings(patch: unknown): Promise<Settings> {
  const run = writeChain.then(async () => {
    const current = await getSettings(true);
    return saveSettings(deepMerge(current, patch));
  });
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 校验服务商的额外 JSON 字段，返回第一个问题的可读描述；合法时返回 null。 */
export function validateProviderJson(provider: ProviderConfig): string | null {
  const fields: Array<[string, string]> = [
    ['额外请求参数', provider.extraBody],
    ['额外请求头', provider.extraHeaders],
  ];
  for (const [label, raw] of fields) {
    const text = raw.trim();
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `${label}必须是一个 JSON 对象`;
      }
    } catch {
      return `${label}不是合法的 JSON`;
    }
  }
  return null;
}

/** 供存储变更事件调用，丢弃进程内缓存。 */
export function invalidateSettingsCache(): void {
  memory = null;
}
