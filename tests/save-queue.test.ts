import { describe, expect, it } from 'vitest';
import { SaveSequencer } from '../src/options/save-queue';

describe('SaveSequencer 自动保存时序', () => {
  it('发送后没有新编辑时，回执允许清 dirty', () => {
    const seq = new SaveSequencer();
    seq.markEdit();
    const version = seq.begin();
    expect(seq.settle(version)).toBe(true);
  });

  it('发送后又有编辑时，回执不能清 dirty（否则新编辑被吞）', () => {
    const seq = new SaveSequencer();
    seq.markEdit();
    const version = seq.begin(); // 保存 A 发出
    seq.markEdit(); // 用户继续改成 B
    expect(seq.settle(version)).toBe(false);
  });

  it('被顶掉的保存之后，新一轮保存可以正常确认', () => {
    const seq = new SaveSequencer();
    seq.markEdit();
    const stale = seq.begin();
    seq.markEdit();
    expect(seq.settle(stale)).toBe(false);
    const fresh = seq.begin();
    expect(seq.settle(fresh)).toBe(true);
  });

  it('多次连续编辑只认最后一次', () => {
    const seq = new SaveSequencer();
    seq.markEdit();
    seq.markEdit();
    seq.markEdit();
    const version = seq.begin();
    seq.markEdit();
    expect(seq.settle(version)).toBe(false);
  });
});
