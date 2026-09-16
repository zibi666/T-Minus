// 生成 TimeMark 应用图标（512x512 RGBA PNG，2x 超采样抗锯齿，零依赖）
// 设计 v2：深空圆角方底 + 青紫渐变倒计时环（270° 圆头）+ 柔和光晕 + 10:10 表针
const zlib = require('zlib');
const fs = require('fs');

const SIZE = 512;           // 输出尺寸
const SS = 2;               // 超采样倍数
const N = SIZE * SS;        // 采样画布尺寸
const cx = N / 2, cy = N / 2;
const ringR = 148 * SS;     // 环半径
const ringHalf = 20 * SS;   // 环半宽
const bgRadius = 108 * SS;  // 圆角方底圆角半径

// ---- 颜色（与 UI v3 令牌一致） ----
const BG_TOP = [23, 28, 43];    // #171C2B
const BG_BOT = [10, 13, 22];    // #0A0D16
const TRACK = [44, 49, 62];     // 轨道
const ARC_A = [77, 201, 240];   // #4DC9F0 青
const ARC_B = [147, 129, 255];  // #9381FF 紫
const GLOW = [90, 158, 255];    // 光晕基色
const HAND = [245, 247, 252];   // 表针
const ARC_SWEEP = 0.75 * Math.PI * 2; // 270°

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

function inRoundedRect(x, y) {
  const m = 8 * SS, r = bgRadius;
  const minX = m + r, maxX = N - m - r, minY = m + r, maxY = N - m - r;
  if (x < minX && y < minY) return (x - minX) ** 2 + (y - minY) ** 2 <= r * r;
  if (x > maxX && y < minY) return (x - maxX) ** 2 + (y - minY) ** 2 <= r * r;
  if (x > maxX && y > maxY) return (x - maxX) ** 2 + (y - maxY) ** 2 <= r * r;
  if (x < minX && y > maxY) return (x - minX) ** 2 + (y - maxY) ** 2 <= r * r;
  return x >= m && x <= N - m && y >= m && y <= N - m;
}

// 顺时针自 12 点方向的角度（弧度 0..2π）
function clockAngle(dx, dy) {
  let a = Math.atan2(dx, -dy); // top=0, right=π/2, bottom=π, left=3π/2
  if (a < 0) a += Math.PI * 2;
  return a;
}

function segDist2(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = clamp(t, 0, 1);
  const dx = px - (x1 + vx * t), dy = py - (y1 + vy * t);
  return dx * dx + dy * dy;
}

function render() {
  const buf = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5, py = y + 0.5;
      let r = 0, g = 0, b = 0, a = 0;
      if (inRoundedRect(px, py)) {
        const tBg = py / N;
        r = lerp(BG_TOP[0], BG_BOT[0], tBg);
        g = lerp(BG_TOP[1], BG_BOT[1], tBg);
        b = lerp(BG_TOP[2], BG_BOT[2], tBg);
        a = 255;
        const dx = px - cx, dy = py - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ang = clockAngle(dx, dy);
        const inArc = ang <= ARC_SWEEP;
        // 光晕：环带外侧柔和渐散（仅弧段内，随角度取青紫混合色）
        const glowBand = ringHalf + 64 * SS;
        const distToRing = Math.abs(d - ringR);
        if (distToRing < glowBand && inArc) {
          const gs = (1 - distToRing / glowBand) ** 2 * 0.20;
          const t = ang / ARC_SWEEP;
          r = Math.min(255, r + GLOW[0] * gs * lerp(1, 0.7, t));
          g = Math.min(255, g + GLOW[1] * gs);
          b = Math.min(255, b + GLOW[2] * gs * lerp(0.8, 1.15, t));
        }
        // 环：弧段渐变（青→紫），缺口为暗轨道
        if (Math.abs(d - ringR) <= ringHalf) {
          if (inArc) {
            const t = ang / ARC_SWEEP;
            r = lerp(ARC_A[0], ARC_B[0], t); g = lerp(ARC_A[1], ARC_B[1], t); b = lerp(ARC_A[2], ARC_B[2], t);
          } else {
            r = TRACK[0]; g = TRACK[1]; b = TRACK[2];
          }
        }
        // 圆头端帽：起点顶部（青）、终点左侧（紫）
        const capR = ringHalf + 5 * SS;
        const sx = cx, sy = cy - ringR;
        const ex = cx - ringR, ey = cy;
        if ((px - sx) ** 2 + (py - sy) ** 2 <= capR * capR) { r = ARC_A[0]; g = ARC_A[1]; b = ARC_A[2]; }
        if ((px - ex) ** 2 + (py - ey) ** 2 <= capR * capR) { r = ARC_B[0]; g = ARC_B[1]; b = ARC_B[2]; }
        // 10:10 表针（细圆头，白）
        const hourA = -Math.PI / 3;   // 10 点方向
        const minA = Math.PI / 3;     // 2 点方向
        const hx = cx + Math.sin(hourA) * 54 * SS, hy = cy - Math.cos(hourA) * 54 * SS;
        const mx = cx + Math.sin(minA) * 82 * SS, my = cy - Math.cos(minA) * 82 * SS;
        if (segDist2(px, py, cx, cy, hx, hy) <= (7 * SS) ** 2
          || segDist2(px, py, cx, cy, mx, my) <= (6 * SS) ** 2) {
          r = HAND[0]; g = HAND[1]; b = HAND[2];
        }
        // 中心圆点
        if (dx * dx + dy * dy <= (13 * SS) ** 2) { r = HAND[0]; g = HAND[1]; b = HAND[2]; }
        // 顶部内缘高光（细腻的一提亮）
        const mEdge = 8 * SS;
        if (py <= mEdge + 2.5 * SS) { r = Math.min(255, r + 9); g = Math.min(255, g + 10); b = Math.min(255, b + 14); }
      }
      const i = (y * N + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = a;
    }
  }
  return buf;
}

// ---- 2x 盒式降采样 ----
function downsample(big) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
          s += big[((y * SS + dy) * N + (x * SS + dx)) * 4 + c];
        }
        out[(y * SIZE + x) * 4 + c] = Math.round(s / (SS * SS));
      }
    }
  }
  return out;
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = encodePng(downsample(render()), SIZE, SIZE);
fs.writeFileSync(process.argv[2], png);
console.log('WROTE', process.argv[2], png.length, 'bytes');
