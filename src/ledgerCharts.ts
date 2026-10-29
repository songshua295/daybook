/**
 * ledgerCharts.ts — 报表页的纯计算（几何 + 配色 + 数字格式化）
 *
 * 这里不碰 DOM、不依赖 Obsidian：所有函数只吃数字吐字符串/坐标，
 * 便于单独跑校验（环形图角度、平滑曲线控制点、面积分段是否闭合等）。
 * 渲染侧（ledgerPage.ts）负责把返回的 path / 坐标塞进 SVG 元素。
 *
 * 约定：坐标一律是 SVG 用户单位（与 viewBox 同尺度），y 轴向下为正。
 */

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/* 支出用暖色、收入用冷/绿色，两组都控制在中等饱和 + 中等明度，
   深色与浅色主题下都能压得住（不跟随主题变化，所以不用 var()）。 */
export const EXPENSE_COLORS = ["#E0664B", "#EE9A3F", "#D2A041", "#C8785A", "#DE8A74", "#B9762F", "#D46C6C", "#E3B24F"];
export const INCOME_COLORS = ["#2FA87C", "#3E9CB8", "#5C8FD2", "#4FBF9A", "#79AC68", "#3F86A6", "#61A6C9", "#8CBE78"];
export const OTHER_COLOR = "#9C9CA4";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 轴上界：把任意正数抬到 1/2/5×10^n 的“好看刻度”，避免图上的数字是 8377 这种 */
export function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const exp = Math.floor(Math.log(n) / Math.LN10);
  const base = Math.pow(10, exp);
  const f = n / base;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * base;
}

/** 图表上的紧凑金额：亿 / 万 / 整数，不带小数噪声 */
export function compactMoney(n: number): string {
  const neg = n < 0;
  const a = Math.abs(n);
  const trim = (v: number) => {
    const s = v.toFixed(1);
    return s.substring(s.length - 2) === ".0" ? s.substring(0, s.length - 2) : s;
  };
  let s: string;
  if (a >= 100000000) s = trim(a / 100000000) + "亿";
  else if (a >= 10000) s = trim(a / 10000) + "万";
  else s = String(Math.round(a));
  return neg ? "-" + s : s;
}

/** 百分比：0.5 → "0.5%"，整数不带小数；用于环形图右侧占比 */
export function pctText(frac: number): string {
  const p = r2(Math.abs(frac) * 100);
  return (Math.round(p * 10) % 10 === 0 ? String(Math.round(p)) : p.toFixed(1)) + "%";
}

/** 把一组值映射成绘图坐标点：横向等分，纵向按 [min, max] 线性映射进 box */
export function seriesPoints(values: number[], box: Box, max: number, min: number): Pt[] {
  const span = max - min || 1;
  const n = values.length;
  return values.map((v, i) => ({
    x: n <= 1 ? box.x + box.w / 2 : box.x + (box.w * i) / (n - 1),
    y: box.y + box.h - ((v - min) / span) * box.h,
  }));
}

/**
 * 平滑折线：Catmull-Rom 转三次贝塞尔（tension = 1/6 的标准形式）。
 * 只增不减地穿过每个数据点，所以点上的数值标注位置是准的。
 */
export function smoothPath(pts: Pt[]): string {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return `M${r2(pts[0].x)},${r2(pts[0].y)}`;
  let d = `M${r2(pts[0].x)},${r2(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const pPrev = pts[i > 0 ? i - 1 : 0];
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const pNext = pts[i + 2 < n ? i + 2 : n - 1];
    const c1x = p0.x + (p1.x - pPrev.x) / 6;
    const c1y = p0.y + (p1.y - pPrev.y) / 6;
    const c2x = p1.x - (pNext.x - p0.x) / 6;
    const c2y = p1.y - (pNext.y - p0.y) / 6;
    d += `C${r2(c1x)},${r2(c1y)} ${r2(c2x)},${r2(c2y)} ${r2(p1.x)},${r2(p1.y)}`;
  }
  return d;
}

/** 平滑曲线 + 落回基线闭合，得到面积路径（基线是水平直线，正负切色交给 clip 处理） */
export function smoothAreaPath(pts: Pt[], baseY: number): string {
  const line = smoothPath(pts);
  if (!line || pts.length < 2) return "";
  const last = pts[pts.length - 1];
  const first = pts[0];
  return `${line}L${r2(last.x)},${r2(baseY)}L${r2(first.x)},${r2(baseY)}Z`;
}

/** 两点连线与基线（y = baseY）的交点 x；平行时返回 null */
export function crossX(a: Pt, b: Pt, baseY: number): number | null {
  const dy = b.y - a.y;
  if (dy === 0) return null;
  const t = (baseY - a.y) / dy;
  if (t <= 0 || t >= 1) return null;
  return a.x + (b.x - a.x) * t;
}

/**
 * 环形图扇区：从 12 点方向顺时针铺开，多块之间留一条缝。
 * 返回 { d, index }：index 是传入 values 的下标（整环会被拆成两瓣，靠下标取回配色）。
 */
export function donutArcs(values: number[], cx: number, cy: number, rOuter: number, rInner: number): { d: string; index: number }[] {
  const total = values.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  if (total <= 0) return [];
  const gap = values.filter(v => v > 0).length > 1 ? 0.03 : 0;
  const arcs: { d: string; index: number }[] = [];
  let a = -Math.PI / 2;
  values.forEach((v, index) => {
    if (!(v > 0)) return;
    const sweep = (v / total) * Math.PI * 2;
    const a0 = a + gap / 2;
    const a1 = a + sweep - gap / 2;
    // SVG 的弧在「起点 = 终点」时直接不画，所以一整圈（只有一种分类）必须拆成两瓣；
    // 剩下的窄块（跨度过小）继续画也只是条看不见的细线，同样跳过。
    if (a1 - a0 >= Math.PI * 2 - 1e-6) {
      const mid = a + sweep / 2;
      arcs.push({ d: ringArc(cx, cy, rOuter, rInner, a, mid), index });
      arcs.push({ d: ringArc(cx, cy, rOuter, rInner, mid, a + sweep), index });
    } else if (a1 - a0 > 0.012) {
      arcs.push({ d: ringArc(cx, cy, rOuter, rInner, a0, a1), index });
    }
    a += sweep;
  });
  return arcs;
}

function ringArc(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const px = (r: number, ang: number) => r2(cx + r * Math.cos(ang));
  const py = (r: number, ang: number) => r2(cy + r * Math.sin(ang));
  return `M${px(rO, a0)},${py(rO, a0)}`
    + `A${rO},${rO} 0 ${large} 1 ${px(rO, a1)},${py(rO, a1)}`
    + `L${px(rI, a1)},${py(rI, a1)}`
    + `A${rI},${rI} 0 ${large} 0 ${px(rI, a0)},${py(rI, a0)}Z`;
}

/** 一组分组数据（label + 金额 + 笔数）按金额降序，尾部合并进「其他」，返回带占比与配色的条目 */
export interface Slice { label: string; total: number; frac: number; color: string; count: number }
export function toSlices(
  groups: { label: string; total: number; count?: number }[],
  palette: string[],
  maxSlices: number,
): Slice[] {
  const sorted = groups.slice().sort((a, b) => b.total - a.total);
  const sum = sorted.reduce((s, g) => s + g.total, 0);
  const head = sorted.slice(0, maxSlices);
  const tail = sorted.slice(maxSlices);
  const rows: { label: string; total: number; count?: number }[] = tail.length
    ? head.concat([{ label: "其他", total: tail.reduce((s, g) => s + g.total, 0), count: tail.reduce((s, g) => s + (g.count || 0), 0) }])
    : head;
  return rows.map((g, i) => ({
    label: g.label,
    total: g.total,
    count: g.count || 0,
    frac: sum > 0 ? g.total / sum : 0,
    color: g.label === "其他" ? OTHER_COLOR : palette[i % palette.length],
  }));
}
