declare const __DEV__: boolean;

const PREFIX = '[轻译]';

export const isDev = __DEV__;

export const log = {
  debug(...args: unknown[]) {
    if (isDev) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]) {
    console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]) {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]) {
    console.error(PREFIX, ...args);
  },
};
