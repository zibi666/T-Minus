// 视觉令牌（取自 docs/TimeMark-v3-设计规范-AI可读.md 与 Android ui/Theme.kt 的同一组值）。
// 颜色只在这里定义一次；计时器/标签取色一律走 Contract.TIMER_PALETTE，不允许在页面里写死十六进制。
import { DEFAULT_TIMER_COLOR } from '../core/Contract';

export class T {
  static readonly BG: string = '#05060F';
  static readonly SIDEBAR: string = '#0A0D17';
  static readonly CARD: string = '#11141F';
  static readonly CARD_HI: string = '#171C2B';
  static readonly STROKE: string = '#232A3C';
  static readonly TEXT: string = '#E8EBF4';
  static readonly TEXT_LOW: string = '#8A90A3';
  static readonly DANGER: string = '#FF7B72';
  static readonly ACCENT: string = DEFAULT_TIMER_COLOR;

  static readonly R_CARD: number = 22;
  static readonly R_FIELD: number = 16;
  static readonly R_PILL: number = 999;
  static readonly R_SMALL: number = 12;

  static readonly SP: number = 16;
  static readonly SP_SM: number = 8;
  static readonly SP_LG: number = 24;

  static font(n: number): number {
    return n;
  }
}

/** 把 #RRGGBB 与透明度（0~1）合成 ArkUI 支持的 #AARRGGBB */
export function alpha(hex: string, a: number): string {
  const clean = hex.replace('#', '');
  const v = Math.max(0, Math.min(1, a));
  const aa = Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${aa}${clean.toUpperCase()}`;
}
