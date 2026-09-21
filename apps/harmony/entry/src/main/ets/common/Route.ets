/** 页面间传参：NavDestination 的 param 是宽松的 object 类型，ArkTS 下改名传参更稳 */
export class Route {
  static argId: string = '';
}

/** 页面名（与 Index 的 navDestination 分发一致） */
export const PAGE_DETAIL: string = 'detail';
export const PAGE_FORM: string = 'form';
export const PAGE_HISTORY: string = 'history';
export const PAGE_LOGIN: string = 'login';
