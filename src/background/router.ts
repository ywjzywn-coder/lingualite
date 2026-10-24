import { cacheClear } from '../shared/cache';
import { log } from '../shared/log';
import type { Result, RuntimeMessage } from '../shared/messages';
import { getSettings, parseGlossary, patchSettings, publicSettings } from '../shared/settings';
import { translateTexts } from '../engines';
import { refreshToggleMenu } from './menus';
import { setPageTranslated } from './page-state';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(error: unknown): Result<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Service Worker 侧的 RPC 路由：所有跨上下文请求都在这里处理。 */
export async function handleMessage(
  message: RuntimeMessage,
  sender?: chrome.runtime.MessageSender,
): Promise<Result<unknown>> {
  if (!message || typeof message !== 'object' || typeof message.kind !== 'string') {
    return fail(new Error('无法识别的消息'));
  }
  try {
    switch (message.kind) {
      case 'ping':
        return ok({ pong: true });
      case 'settings:get': {
        const settings = await getSettings(true);
        // 扩展自己的页面（popup / options，URL 在扩展源下）拿全量设置；
        // 内容脚本运行在页面源：只返回语言/风格/开关等公开字段，API Key 不出扩展。
        // 不能用「sender 是否带 tab」判断——设置页本身就打开在标签页里，也带 tab.id。
        const extensionOrigin = chrome.runtime.getURL('');
        const fromExtensionPage =
          !sender || (sender.url ?? '').startsWith(extensionOrigin);
        return ok(fromExtensionPage ? settings : publicSettings(settings));
      }
      case 'settings:patch': {
        // 修改设置只允许扩展自己的页面（popup / options）：
        // 内容脚本没有任何改设置的场景，返回值又含完整配置，不能对它开放
        const extensionOrigin = chrome.runtime.getURL('');
        if (sender && !(sender.url ?? '').startsWith(extensionOrigin)) {
          return fail(new Error('内容脚本不能修改设置'));
        }
        return ok(await patchSettings(message.patch));
      }
      case 'translate': {
        const settings = await getSettings();
        // 调用方（内容脚本、弹窗）可以省略语言，由设置兜底
        const glossary = parseGlossary(settings.glossaryText);
        const req = {
          ...message.req,
          from: message.req.from || settings.sourceLang,
          to: message.req.to || settings.targetLang,
          context:
            glossary.length > 0
              ? {
                  ...message.req.context,
                  glossary: [...(message.req.context?.glossary ?? []), ...glossary],
                }
              : message.req.context,
        };
        return ok(await translateTexts(req, settings));
      }
      case 'cache:clear':
        await cacheClear();
        return ok({ cleared: true });
      case 'page:state': {
        const tabId = sender?.tab?.id;
        if (tabId === undefined) return fail(new Error('上报状态时缺少标签页信息'));
        await setPageTranslated(tabId, message.active);
        // 立刻刷新菜单标题，右键时看到的才是当前状态
        await refreshToggleMenu();
        return ok({ saved: true });
      }
      default:
        return fail(new Error(`未知消息类型：${(message as { kind: string }).kind}`));
    }
  } catch (err) {
    log.warn('处理消息失败', message.kind, err);
    return fail(err);
  }
}
