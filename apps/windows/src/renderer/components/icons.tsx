// 线性 SVG 图标集（lucide 风格：24 viewBox / stroke 2 / 圆头）——替代所有 emoji
import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function base(props: IconProps, children: React.ReactNode, filled = false) {
  const { size = 16, className, strokeWidth = 2 } = props;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconCalendar = (p: IconProps) =>
  base(p, <>
    <rect x="3" y="4" width="18" height="18" rx="3" />
    <path d="M16 2v4M8 2v4M3 10h18" />
    <path d="M9 16l2 2 4-4" />
  </>);

export const IconHourglass = (p: IconProps) =>
  base(p, <>
    <path d="M5 22h14" />
    <path d="M5 2h14" />
    <path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22" />
    <path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" />
  </>);

export const IconTimer = (p: IconProps) =>
  base(p, <>
    <path d="M10 2h4" />
    <path d="M12 14l3-3" />
    <circle cx="12" cy="14" r="8" />
  </>);

export const IconPlus = (p: IconProps) =>
  base(p, <><path d="M12 5v14M5 12h14" /></>);

export const IconPlay = (p: IconProps) =>
  base(p, <path d="M7 4.5v15a1 1 0 0 0 1.54.84l11.2-7.5a1 1 0 0 0 0-1.68L8.54 3.66A1 1 0 0 0 7 4.5z" />, true);

export const IconPause = (p: IconProps) =>
  base(p, <>
    <rect x="6" y="4" width="4" height="16" rx="1.5" />
    <rect x="14" y="4" width="4" height="16" rx="1.5" />
  </>, true);

export const IconReset = (p: IconProps) =>
  base(p, <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </>);

export const IconStop = (p: IconProps) =>
  base(p, <rect x="6" y="6" width="12" height="12" rx="2" />, true);

/** 分段（旗标）图标：手动分段按钮 */
export const IconSegment = (p: IconProps) =>
  base(p, <>
    <path d="M6 21V4" />
    <path d="M6 5h11.5l-3 4 3 4H6" />
  </>);

export const IconStar = (p: IconProps & { filled?: boolean }) =>
  base({ ...p }, <path d="M12 2.6l2.9 5.9 6.5.94-4.7 4.58 1.1 6.48L12 17.44 6.2 20.5l1.1-6.48-4.7-4.58 6.5-.94z" />, !!(p as any).filled);

export const IconPin = (p: IconProps & { filled?: boolean }) => {
  const { size = 16, className } = p;
  const filled = !!(p as any).filled;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      {filled
        ? <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        : <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />}
    </svg>
  );
};

export const IconPencil = (p: IconProps) =>
  base(p, <>
    <path d="M21.17 6.83a2.12 2.12 0 0 0-3-3L4 18v3h3z" />
    <path d="M14 6l4 4" />
  </>);

export const IconTrash = (p: IconProps) =>
  base(p, <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6M14 11v6" />
  </>);

export const IconDownload = (p: IconProps) =>
  base(p, <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </>);

export const IconLogout = (p: IconProps) =>
  base(p, <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </>);

export const IconSync = (p: IconProps) =>
  base(p, <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </>);

export const IconClose = (p: IconProps) =>
  base(p, <><path d="M18 6L6 18M6 6l12 12" /></>);

export const IconUser = (p: IconProps) =>
  base(p, <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
  </>);

export const IconClock = (p: IconProps) =>
  base(p, <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>);

export const IconSparkle = (p: IconProps) =>
  base(p, <>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
  </>);

export const IconSearch = (p: IconProps) =>
  base(p, <>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </>);

export const IconArrowRight = (p: IconProps) =>
  base(p, <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>);

export const IconMinus = (p: IconProps) =>
  base(p, <path d="M5 12h14" />);

export const IconSquare = (p: IconProps) =>
  base(p, <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />);

/** 番茄钟（循环轮次）图标 */
export const IconRepeat = (p: IconProps) =>
  base(p, <>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </>);

export const IconCheck = (p: IconProps) =>
  base(p, <path d="M20 6L9 17l-5-5" />);

/** 品牌标志：渐变圆环 + 指针（用于顶栏 logo，替代 emoji ⏱） */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lg-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4DC9F0" />
          <stop offset="100%" stopColor="#9381FF" />
        </linearGradient>
      </defs>
      {/* 轨道 + 270° 青紫渐变倒计时环（12 点起点，圆头） */}
      <circle cx="24" cy="24" r="15" stroke="#2C313E" strokeWidth="4.6" fill="none" />
      <circle cx="24" cy="24" r="15" stroke="url(#lg-logo)" strokeWidth="4.6" strokeLinecap="round"
        strokeDasharray="70.7 23.6" transform="rotate(-90 24 24)" />
      {/* 10:10 表针 + 中心点 */}
      <path d="M17.1 20L24 24" stroke="#F5F7FC" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M24 24l10.4-6" stroke="#F5F7FC" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="24" cy="24" r="2.6" fill="#F5F7FC" />
    </svg>
  );
}

/** 空状态插画：大型沙漏（渐变描边） */
export function EmptyArt() {
  return (
    <svg width="120" height="120" viewBox="0 0 96 96" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lg-empty" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff5d5d" />
          <stop offset="55%" stopColor="#ff8a3d" />
          <stop offset="100%" stopColor="#8b7cf7" />
        </linearGradient>
      </defs>
      <g stroke="url(#lg-empty)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M28 12h40" />
        <path d="M28 84h40" />
        <path d="M32 12v13.2c0 4.2 2.2 8.1 5.9 10.2L48 42l10.1-6.6c3.7-2.1 5.9-6 5.9-10.2V12" />
        <path d="M32 84V70.8c0-4.2 2.2-8.1 5.9-10.2L48 54l10.1 6.6c3.7 2.1 5.9 6 5.9 10.2V84" />
      </g>
      <path d="M44 70h8l-4 6z" fill="url(#lg-empty)" opacity="0.9" />
      <path d="M48 20l6 9h-12z" fill="url(#lg-empty)" opacity="0.55" />
      <circle cx="76" cy="22" r="2.6" fill="#ff8a3d" opacity="0.8" />
      <circle cx="20" cy="66" r="2" fill="#8b7cf7" opacity="0.8" />
      <circle cx="78" cy="58" r="1.6" fill="#4cc9f0" opacity="0.8" />
    </svg>
  );
}
