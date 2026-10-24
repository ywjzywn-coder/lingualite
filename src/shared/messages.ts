import type { PublicSettings, Settings } from './settings';
import type { TranslateRequest, TranslateResult } from '../engines/types';

/** 各上下文之间统一的消息协议。所有请求都由 Service Worker 兜底处理。 */
export type RuntimeMessage =
  | { kind: 'ping' }
  | { kind: 'settings:get' }
  | { kind: 'settings:patch'; patch: unknown }
  | { kind: 'translate'; req: TranslateRequest }
  | { kind: 'cache:clear' }
  /** 内容脚本上报网页翻译状态，用于刷新右键菜单标题 */
  | { kind: 'page:state'; active: boolean };

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  error: string;
}

export type Result<T> = Ok<T> | Err;

export type MessageResultMap = {
  ping: { pong: true };
  /** 扩展页面拿到全量设置；内容脚本只拿到不含密钥的公开子集 */
  'settings:get': Settings | PublicSettings;
  'settings:patch': Settings;
  translate: TranslateResult;
  'cache:clear': { cleared: true };
  'page:state': { saved: true };
};

export async function callBackground<K extends RuntimeMessage['kind']>(
  msg: Extract<RuntimeMessage, { kind: K }>,
): Promise<Result<MessageResultMap[K]>> {
  try {
    const res = (await chrome.runtime.sendMessage(msg)) as Result<MessageResultMap[K]> | undefined;
    if (!res) return { ok: false, error: '扩展后台没有响应，请尝试重新加载扩展' };
    return res;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 后台 / 弹窗 -> 内容脚本 的指令。 */
export type ContentCommand =
  | { kind: 'content:translate-selection'; text?: string }
  | { kind: 'content:speak-selection'; text?: string }
  /** 已翻译就还原，未翻译就翻译——菜单与弹窗都只用一个按钮 */
  | { kind: 'content:toggle-page' }
  | { kind: 'content:translate-page' }
  | { kind: 'content:restore-page' }
  /** 查询当前页是否处于已翻译状态 */
  | { kind: 'content:get-page-state' };;

/** 把浏览器抛出的连接错误翻译成人话，避免用户看到 "Receiving end does not exist"。 */
function humanizeSendError(message: string): string {
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return '这个页面不允许扩展运行（浏览器内置页面、扩展商店等），请到普通网页上使用';
  }
  return message;
}

export async function sendToTab(tabId: number, command: ContentCommand): Promise<Result<unknown>> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, command)) as Result<unknown> | undefined;
    return res ?? { ok: true, data: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: humanizeSendError(message) };
  }
}

/** 当前窗口的活动标签页。无需 tabs 权限即可拿到 id。 */
export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
