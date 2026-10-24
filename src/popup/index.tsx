import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { activeTab, callBackground, sendToTab, type ContentCommand } from '../shared/messages';
import { TARGET_LANGS, type Settings } from '../shared/settings';
import { applyTheme } from '../ui/apply-theme';

const VERSION = chrome.runtime.getManifest().version;

function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageTranslated, setPageTranslated] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [res, tab] = await Promise.all([callBackground({ kind: 'settings:get' }), activeTab()]);
      // 扩展页面收到的永远是全量设置；PublicSettings 只发给内容脚本
      if (res.ok) setSettings(res.data as Settings);
      else setError(res.error);
      setTabId(tab?.id ?? null);
    })();
  }, []);

  // 查询当前页是否已翻译，决定按钮显示「翻译此页」还是「还原原文」
  useEffect(() => {
    if (tabId === null) return;
    void (async () => {
      const res = await sendToTab(tabId, { kind: 'content:get-page-state' });
      if (res.ok) {
        setPageTranslated(Boolean((res.data as { active?: boolean } | undefined)?.active));
      }
    })();
  }, [tabId]);

  const patch = useCallback(async (patchValue: unknown) => {
    const res = await callBackground({ kind: 'settings:patch', patch: patchValue });
    if (res.ok) setSettings(res.data);
    else setError(res.error);
  }, []);

  const run = useCallback(
    async (kind: ContentCommand['kind']) => {
      setActionError(null);
      if (tabId === null) {
        setActionError('拿不到当前标签页，请刷新页面后重试');
        return;
      }
      const res = await sendToTab(tabId, { kind });
      // 成功时关掉弹窗，让用户直接看到页面上的结果
      if (res.ok) window.close();
      else setActionError(res.error);
    },
    [tabId],
  );

  const clearCache = useCallback(async () => {
    const res = await callBackground({ kind: 'cache:clear' });
    setNotice(res.ok ? '翻译缓存已清空' : null);
    if (!res.ok) setError(res.error);
  }, []);

  if (error && !settings) {
    return <div class="status error">后台没有响应：{error}</div>;
  }
  if (!settings) {
    return <div class="hint">加载中…</div>;
  }

  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  const llmReady = Boolean(provider?.baseUrl && provider?.model);

  return (
    <>
      <header class="row" style="margin-bottom:0.75rem">
        <strong class="app-title">轻译 LinguaLite</strong>
        <span class="grow" />
        <span class="hint">v{VERSION}</span>
      </header>

      <div class="card">
        <div class="card-title">当前页面</div>
        <div class="row">
          <button
            class={pageTranslated ? 'btn grow' : 'btn btn-primary grow'}
            style="justify-content:center"
            onClick={() => void run('content:toggle-page')}
          >
            {pageTranslated ? '还原原文' : '翻译此页（双语对照）'}
          </button>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn grow" style="justify-content:center" onClick={() => void run('content:translate-selection')}>
            翻译所选文本
          </button>
          <button class="btn" onClick={() => void run('content:speak-selection')}>
            朗读
          </button>
        </div>
        <div class="hint" style="margin-top:6px">
          只翻可视区域，滚动会继续；右下角有进度与还原。划词请先选中文字，或用右键菜单。
        </div>
        {actionError && <div class="status error" style="margin-top:8px">{actionError}</div>}
      </div>

      <div class="card">
        <div class="card-title">翻译引擎</div>
        <select
          value={settings.engine}
          onChange={(e) => void patch({ engine: (e.target as HTMLSelectElement).value })}
        >
          <option value="google">Google 免费接口</option>
          <option value="llm">AI 模型（自备 API）</option>
        </select>
        {settings.engine === 'llm' && (
          <div class="hint" style="margin-top:6px">
            {llmReady ? (
              <>当前模型：{provider?.label} · {provider?.model}</>
            ) : (
              <span style="color:var(--danger)">还没配置模型接口，请到设置里填写</span>
            )}
          </div>
        )}
        <div class="field">
          <label>翻译成</label>
          <select
            value={settings.targetLang}
            onChange={(e) => void patch({ targetLang: (e.target as HTMLSelectElement).value })}
          >
            {TARGET_LANGS.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {notice && <div class="status ok" style="margin-top:10px">{notice}</div>}

      <div class="row" style="margin-top:12px">
        <button class="btn grow" style="justify-content:center" onClick={() => void chrome.runtime.openOptionsPage()}>
          打开设置
        </button>
        <button class="btn" onClick={() => void clearCache()}>
          清空缓存
        </button>
      </div>
      <div class="hint" style="margin-top:8px; text-align:center">
        功能开关、翻译风格与术语表在设置页
      </div>
    </>
  );
}

applyTheme();
render(<Popup />, document.getElementById('app')!);
