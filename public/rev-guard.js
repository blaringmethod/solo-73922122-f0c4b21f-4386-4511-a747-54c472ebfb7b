// public/rev-guard.js
// 投影页的单调版本围栏：只接受 revision >= 已应用版本的状态，
// 迟到的旧消息（revision 更小）一律丢弃，画面绝不会跳回旧字幕。

export function createRevisionGuard(initialRevision = 0) {
  let appliedRevision = initialRevision;
  let ignoredCount = 0;
  let lastIgnoredRevision = null;

  return {
    get appliedRevision() {
      return appliedRevision;
    },
    get ignoredCount() {
      return ignoredCount;
    },
    get lastIgnoredRevision() {
      return lastIgnoredRevision;
    },
    /** 清空已应用版本与统计（一般无需调用：服务端 reset 也保持 revision 单调递增） */
    reset(nextInitialRevision = 0) {
      appliedRevision = nextInitialRevision;
      ignoredCount = 0;
      lastIgnoredRevision = null;
    },
    /**
     * @returns {boolean} true 表示可以渲染；false 表示该消息已过期，必须丢弃。
     */
    accept(revision) {
      if (!Number.isInteger(revision)) return false;
      if (revision < appliedRevision) {
        ignoredCount += 1;
        lastIgnoredRevision = revision;
        return false;
      }
      appliedRevision = revision;
      return true;
    },
  };
}
