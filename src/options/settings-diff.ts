import type { Settings } from '../shared/settings';

/**
 * 计算设置页需要回写的字段：只发送相对「服务器已知状态」有变化的顶层键。
 *
 * 设置页一直用整份快照保存的话，会把它加载后其他界面（弹窗、另一个设置页）
 * 刚写入的修改用旧值覆盖回去。按 diff 发送后，没动过的字段根本不出现在补丁里，
 * 后台串行合并时那些字段自然保留。
 */
export function diffSettings(saved: Settings, current: Settings): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(current) as Array<keyof Settings>) {
    const before = saved[key];
    const after = current[key];
    if (before === after) continue;
    // providers / features 是对象与数组，用稳定的序列化比较
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    patch[key] = after;
  }
  return patch as Partial<Settings>;
}
