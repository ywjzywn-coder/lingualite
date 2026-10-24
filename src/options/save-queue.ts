/**
 * 自动保存时序控制。
 *
 * 保存请求在途时用户可能继续编辑——如果旧请求的回执无条件清掉 dirty 标记，
 * 新编辑会被标成「已保存」却永远不会落盘。规则：
 * 只有「发送之后没有再编辑」的回执才允许清 dirty；否则保持 dirty，
 * 由组件里现有的防抖 effect 继续安排下一次保存。
 */
export class SaveSequencer {
  private edits = 0;
  private sentAt = -1;

  /** 每次编辑调用。 */
  markEdit(): void {
    this.edits += 1;
  }

  /** 发送保存请求，返回本次保存对应的版本号。 */
  begin(): number {
    this.sentAt = this.edits;
    return this.sentAt;
  }

  /** 回执到达：期间没有新编辑才允许清 dirty。 */
  settle(version: number): boolean {
    return version === this.edits;
  }

  /** 最近一次发送的版本号（测试与调试用）。 */
  get lastSent(): number {
    return this.sentAt;
  }
}
