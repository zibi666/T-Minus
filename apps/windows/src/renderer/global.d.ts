// 渲染层看到的 window.timemark —— 类型直接取自 preload 的导出对象，
// 不再手写第二份 IPC 面（历史上两处不同步是踩过的坑）。
import type { TimemarkApi } from '../../electron/preload';

declare global {
  interface Window {
    timemark: TimemarkApi;
  }
}

export {};
