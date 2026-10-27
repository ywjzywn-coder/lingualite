import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { STYLE_OPTIONS } from '../engines/prompt';
import { callBackground } from '../shared/messages';
import { applyTheme } from '../ui/apply-theme';
import { SaveSequencer } from './save-queue';
import { diffSettings } from './settings-diff';
import {
  LANGS,
  PROVIDER_PRESETS,
  TARGET_LANGS,
  createProvider,
  parseGlossary,
  validateProviderJson,
  type ProviderConfig,
  type ReasoningEffort,
  type Settings,
  type TranslationStyle,
} from '../shared/settings';

const VERSION = chrome.runtime.getManifest().version;
const SAVE_DELAY = 500;

const EFFORT_LABELS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'default', label: '跟随模型默认' },
  { value: 'none', label: '不用思考（最快）' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高（最强，最慢）' },
];

const SAMPLE = [
  'The quick brown fox jumps over the lazy dog.',
  'Translation quality depends heavily on the context you provide.',
  'Click the extension icon to start transcribing audio without subtitles.',
];

function text(e: Event): string {
  return (e.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
}

function checked(e: Event): boolean {
  return (e.currentTarget as HTMLInputElement).checked;
}

function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const loaded = useRef(false);
  const sequencer = useRef(new SaveSequencer());
  /** 服务器当前已知的设置快照：保存只发送与它的差异。 */
  const savedSnapshot = useRef<Settings | null>(null);
  /** settings 的镜像，让 saveNow 这类事件回调总能拿到最新表单值。 */
  const settingsRef = useRef<Settings | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    void (async () => {
      const res = await callBackground({ kind: 'settings:get' });
      // 扩展页面收到的永远是全量设置；PublicSettings 只发给内容脚本
      if (res.ok) {
        setSettings(res.data as Settings);
        savedSnapshot.current = res.data as Settings;
        loaded.current = true;
      } else {
        setError(res.error);
      }
    })();
  }, []);

  /** 立即保存当前表单（绕过防抖）。返回是否成功；失败时抛错给调用方展示。 */
  const saveNow = useCallback(async (): Promise<void> => {
    const current = settingsRef.current;
    if (!current || !loaded.current) return;
    const patch = diffSettings(savedSnapshot.current ?? current, current);
    if (Object.keys(patch).length === 0) return;
    const version = sequencer.current.begin();
    const res = await callBackground({ kind: 'settings:patch', patch });
    if (!sequencer.current.settle(version)) return; // 保存期间又有编辑，交给防抖保存
    if (res.ok) {
      savedSnapshot.current = current;
      setSavedAt(Date.now());
      setDirty(false);
      setError(null);
    } else {
      setError(res.error);
      throw new Error(res.error);
    }
  }, []);

  // 防抖自动保存：本地 state 是表单的唯一事实来源，保存结果只用于提示。
  // 回执到达时若期间又有编辑，保持 dirty 交给下一次保存，避免旧回执吞掉新修改。
  // 只发送相对服务器快照变化的字段：不能发整份快照，否则会把弹窗或其他
  // 设置页刚保存的修改用本页的旧值覆盖回去。
  useEffect(() => {
    if (!dirty || !settings || !loaded.current) return;
    const timer = setTimeout(() => {
      const patch = diffSettings(savedSnapshot.current ?? settings, settings);
      if (Object.keys(patch).length === 0) {
        // 编辑被改回去了，内容与服务器一致：直接清脏标记
        setDirty(false);
        return;
      }
      const version = sequencer.current.begin();
      void (async () => {
        const res = await callBackground({ kind: 'settings:patch', patch });
        if (!sequencer.current.settle(version)) return;
        if (res.ok) {
          savedSnapshot.current = settings;
          setSavedAt(Date.now());
          setDirty(false);
          setError(null);
        } else {
          setError(res.error);
        }
      })();
    }, SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [settings, dirty]);

  const update = useCallback((patch: (current: Settings) => Settings) => {
    sequencer.current.markEdit();
    setSettings((current) => (current ? patch(current) : current));
    setDirty(true);
  }, []);

  const updateProvider = useCallback(
    (id: string, changes: Partial<ProviderConfig>) => {
      update((current) => ({
        ...current,
        providers: current.providers.map((p) => (p.id === id ? { ...p, ...changes } : p)),
      }));
    },
    [update],
  );

  if (error && !settings) {
    return <div class="status error">无法读取设置：{error}</div>;
  }
  if (!settings) return <div class="hint">加载中…</div>;

  const active = settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0]!;

  return (
    <>
      <header>
        <h1 class="app-title">轻译 LinguaLite</h1>
        <span class="hint">
          v{VERSION}
          {dirty ? ' · 保存中…' : savedAt ? ' · 已保存' : ''}
        </span>
      </header>

      {error && <div class="status error" style="margin-bottom:12px">{error}</div>}

      <section class="card">
        <div class="card-title">翻译引擎</div>
        <div class="row">
          <span class="label">当前引擎</span>
          <select
            class="grow"
            value={settings.engine}
            onChange={(e) => update((c) => ({ ...c, engine: text(e) as Settings['engine'] }))}
          >
            <option value="google">Google 免费接口（零配置）</option>
            <option value="llm">AI 模型（自备 API）</option>
          </select>
        </div>
        <div class="hint" style="margin-top:6px">
          Google 免费接口是非官方端点，可能限流；追求质量请填自己的模型。
        </div>

        <div class="row" style="margin-top:12px">
          <span class="label">服务商</span>
          <div class="tabs grow">
            {settings.providers.map((p) => (
              <button
                key={p.id}
                class={`tab ${p.id === settings.activeProviderId ? 'active' : ''}`}
                onClick={() => update((c) => ({ ...c, activeProviderId: p.id }))}
              >
                {p.label || p.id}
              </button>
            ))}
          </div>
        </div>

        <div class="row" style="margin-top:8px">
          <span class="label">添加</span>
          <select
            id="preset-select"
            class="grow"
            value=""
            onChange={(e) => {
              const presetId = text(e);
              if (!presetId) return;
              const preset = PROVIDER_PRESETS.find((p) => p.id === presetId)!;
              let id = preset.id;
              let n = 2;
              while (settings.providers.some((p) => p.id === id)) id = `${preset.id}-${n++}`;
              const created = { ...createProvider(preset.id), id };
              update((c) => ({ ...c, providers: [...c.providers, created], activeProviderId: id }));
            }}
          >
            <option value="">选择预设…</option>
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          {settings.providers.length > 1 && (
            <button
              class="btn btn-danger"
              onClick={() =>
                update((c) => {
                  const providers = c.providers.filter((p) => p.id !== c.activeProviderId);
                  return { ...c, providers, activeProviderId: providers[0]!.id };
                })
              }
            >
              删除
            </button>
          )}
        </div>

        <div class="field">
          <label>显示名称</label>
          <input
            type="text"
            value={active.label}
            onInput={(e) => updateProvider(active.id, { label: text(e) })}
          />
        </div>
        <div class="field">
          <label>Base URL（OpenAI 兼容地址，会自动补 /chat/completions）</label>
          <input
            type="text"
            placeholder="https://api.deepseek.com/v1"
            value={active.baseUrl}
            onInput={(e) => updateProvider(active.id, { baseUrl: text(e) })}
          />
        </div>
        <div class="field">
          <label>API Key</label>
          <input
            type="password"
            placeholder="sk-…"
            value={active.apiKey}
            onInput={(e) => updateProvider(active.id, { apiKey: text(e) })}
          />
        </div>
        <div class="field">
          <label>模型名</label>
          <input
            type="text"
            placeholder="deepseek-chat"
            value={active.model}
            onInput={(e) => updateProvider(active.id, { model: text(e) })}
          />
        </div>
        <div class="row" style="margin-top:10px">
          <span class="label">思考强度</span>
          <select
            class="grow"
            value={active.reasoningEffort}
            onChange={(e) => updateProvider(active.id, { reasoningEffort: text(e) as ReasoningEffort })}
          >
            {EFFORT_LABELS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div class="hint" style="margin-top:4px">
          翻译任务通常不需要思考，选“不用思考”更快更省钱。映射到 reasoning_effort，若你的服务商用别的字段名，写在下面的额外请求参数里覆盖。
        </div>
        <div class="row" style="margin-top:0.75rem; align-items:flex-end">
          <div class="field grow" style="margin-top:0">
            <label>每批段数</label>
            <input
              type="number"
              min={1}
              max={50}
              value={active.batchSize}
              onInput={(e) => updateProvider(active.id, { batchSize: Number(text(e)) || 10 })}
            />
          </div>
          <div class="field grow" style="margin-top:0">
            <label>温度</label>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={active.temperature}
              onInput={(e) => updateProvider(active.id, { temperature: Number(text(e)) || 0 })}
            />
          </div>
        </div>

        <div class="field">
          <label>额外请求参数（JSON，会合并进请求体）</label>
          <textarea
            class="mono"
            placeholder='例如 {"thinking":{"type":"enabled"}} 或 {"top_p":0.9}'
            value={active.extraBody}
            onInput={(e) => updateProvider(active.id, { extraBody: text(e) })}
          />
        </div>
        <div class="field">
          <label>额外请求头（JSON）</label>
          <textarea
            class="mono"
            placeholder='例如 {"x-api-version":"2024-01-01"}'
            value={active.extraHeaders}
            onInput={(e) => updateProvider(active.id, { extraHeaders: text(e) })}
          />
        </div>
        {validateProviderJson(active) && (
          <div class="status error" style="margin-top:6px">
            {validateProviderJson(active)}：发起翻译时会直接失败，请先修正。
          </div>
        )}
      </section>

      <section class="card">
        <div class="card-title">语言与风格</div>
        <div class="row">
          <span class="label">原文语言</span>
          <select
            class="grow"
            value={settings.sourceLang}
            onChange={(e) => update((c) => ({ ...c, sourceLang: text(e) }))}
          >
            {LANGS.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>
        <div class="hint">
          {settings.sourceLang === 'auto'
            ? '自动检测最稳妥：无论页面是英语、日语还是其他语言都能正常翻译。'
            : '已指定原文语言。其他语言的页面会被当成这个语言处理，译文会错乱——除非你确实只看这一种语言，否则建议改回「自动检测」。'}
        </div>
        <div class="row">
          <span class="label">译文语言</span>
          <select
            class="grow"
            value={settings.targetLang}
            onChange={(e) => update((c) => ({ ...c, targetLang: text(e) }))}
          >
            {TARGET_LANGS.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>
        <div class="row">
          <span class="label">翻译风格</span>
          <select
            class="grow"
            value={settings.style}
            onChange={(e) => update((c) => ({ ...c, style: text(e) as TranslationStyle }))}
          >
            {STYLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div class="hint" style="margin-top:6px">
          {STYLE_OPTIONS.find((o) => o.value === settings.style)?.hint}
        </div>
      </section>

      <section class="card">
        <div class="card-title">术语表与附加要求</div>
        <div class="field" style="margin-top:0">
          <label>术语表（每行一条，格式：原文=译法）</label>
          <textarea
            rows={4}
            placeholder={'prompt=提示词\ncontext window=上下文窗口\n# 井号开头是注释'}
            value={settings.glossaryText}
            onInput={(e) => update((c) => ({ ...c, glossaryText: text(e) }))}
          />
        </div>
        <div class="hint">
          已解析 {parseGlossary(settings.glossaryText).length} 条。这些译法会强制注入到每次请求，保证同一术语在全篇译法一致。
        </div>
        <div class="field">
          <label>附加要求（追加在内置规则之后，用来微调而不破坏规则）</label>
          <textarea
            rows={3}
            placeholder={'例如：\n统一用“您”称呼读者\n界面按钮的译文控制在 6 个字以内'}
            value={settings.extraInstructions}
            onInput={(e) => update((c) => ({ ...c, extraInstructions: text(e) }))}
          />
        </div>
        <div class="hint">
          这里写的内容会叠加在内置规则之上，而不是替换它。内置规则负责输出格式、术语与防加戏，请尽量只补充风格偏好。
        </div>
      </section>

      <section class="card">
        <div class="card-title">行为</div>
        <label class="switch">
          <input
            type="checkbox"
            checked={settings.useContext}
            onChange={(e) => update((c) => ({ ...c, useContext: checked(e) }))}
          />
          把页面标题与摘要作为上下文交给模型（更准，略贵）
        </label>
        <label class="switch" style="margin-top:8px">
          <input
            type="checkbox"
            checked={settings.fallbackToGoogle}
            onChange={(e) => update((c) => ({ ...c, fallbackToGoogle: checked(e) }))}
          />
          模型失败时自动降级到 Google 免费接口
        </label>
      </section>

      <section class="card">
        <div class="card-title">功能开关</div>
        {(
          [
            ['page', '网页沉浸式翻译'],
            ['select', '划词 / 划句翻译'],
          ] as const
        ).map(([key, label], index) => (
          <label class="switch" key={key} style={index === 0 ? '' : 'margin-top:8px'}>
            <input
              type="checkbox"
              checked={settings.features[key]}
              onChange={(e) => update((c) => ({ ...c, features: { ...c.features, [key]: checked(e) } }))}
            />
            {label}
          </label>
        ))}
      </section>

      <TestSection
        targetLang={settings.targetLang}
        sourceLang={settings.sourceLang}
        engine={settings.engine}
        onBeforeTest={saveNow}
      />

      <section class="card">
        <div class="card-title">数据</div>
        <div class="row">
          <button
            class="btn"
            onClick={() => {
              void callBackground({ kind: 'cache:clear' }).then((res) => {
                if (!res.ok) setError(res.error);
              });
            }}
          >
            清空翻译缓存
          </button>
        </div>
        <div class="hint" style="margin-top:6px">
          所有设置、生词与缓存都只存在这台设备上，扩展没有任何服务端。
        </div>
      </section>
    </>
  );
}

interface TestProps {
  targetLang: string;
  sourceLang: string;
  engine: Settings['engine'];
  onBeforeTest: () => Promise<void>;
}

function TestSection({ targetLang, sourceLang, engine, onBeforeTest }: TestProps) {
  const [input, setInput] = useState(SAMPLE.join('\n'));
  const [output, setOutput] = useState<string | null>(null);
  const [meta, setMeta] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paragraphs = useMemo(
    () => input.split(/\n+/).map((s) => s.trim()).filter(Boolean),
    [input],
  );

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setOutput(null);
    setMeta(null);
    // 先立即保存表单（不等 500ms 防抖），否则后台用的还是旧配置，试译结果失真
    try {
      await onBeforeTest();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const started = Date.now();
    const res = await callBackground({
      kind: 'translate',
      req: {
        texts: paragraphs,
        from: sourceLang,
        to: targetLang,
        context: { title: '设置页试译' },
        // 试译的目的是验证接口连通性：绕过缓存、失败不降级，强制真实请求
        noCache: true,
      },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOutput(res.data.texts.join('\n'));
    setMeta(
      `引擎 ${res.data.engine} · ${Date.now() - started} ms · 请求 ${res.data.requestCount} 次 · 命中缓存 ${res.data.cachedCount} 段`,
    );
  }, [paragraphs, sourceLang, targetLang, onBeforeTest]);

  return (
    <section class="card">
      <div class="card-title">试译</div>
      <div class="hint" style="margin-bottom:8px">
        先保存当前表单，再用它发起真实请求验证接口（每行当作一段，共 {paragraphs.length} 段）。模型失败会直接报错，不会悄悄降级到 Google。
      </div>
      <textarea rows={5} value={input} onInput={(e) => setInput(text(e))} />
      <div class="row" style="margin-top:8px">
        <button class="btn btn-primary" disabled={busy || paragraphs.length === 0} onClick={() => void run()}>
          {busy ? '翻译中…' : `翻译成 ${targetLang}`}
        </button>
        <span class="hint">当前引擎：{engine === 'llm' ? 'AI 模型' : 'Google 免费接口'}</span>
      </div>
      {error && <div class="status error" style="margin-top:10px">{error}</div>}
      {meta && <div class="hint" style="margin-top:10px">{meta}</div>}
      {output && <textarea rows={5} readOnly style="margin-top:8px" value={output} />}
    </section>
  );
}

applyTheme();
render(<Options />, document.getElementById('app')!);
