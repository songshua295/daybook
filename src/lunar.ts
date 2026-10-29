/**
 * lunar.ts — 公历 → 农历日 / 二十四节气（1900—2100）
 *
 * 只给记账日历视图用：格子里当天没有流水时，数字下面那行显示「节气 > 农历」。
 * 数据表见 lunarData.ts（来自 solarlunar，ISC 许可），这里是把「一天」拆成中文标签的算法。
 * 不引第三方依赖，也不依赖 moment 之外的运行时能力。
 */
import { LUNAR_INFO, TERM_INFO, TERM_NAMES, LUNAR_MONTH_NAMES } from "./lunarData";

const N1 = ["日", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const N2 = ["初", "十", "廿", "卅"];

/** 农历年 y 的总天数（含闰月） */
function lunarYearDays(y: number): number {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) if (LUNAR_INFO[y - 1900] & i) sum++;
  return sum + leapDays(y);
}
/** 农历年 y 闰哪个月，0 = 不闰 */
function leapMonth(y: number): number { return LUNAR_INFO[y - 1900] & 0xf; }
/** 农历年 y 闰月的天数 */
function leapDays(y: number): number {
  return leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0;
}
/** 农历年 y 第 m 月（非闰月）天数 */
function monthDays(y: number, m: number): number {
  return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29;
}

/** 公历 y 年第 n 个节气（n 从 1 = 小寒起）落在几号 */
function termDay(y: number, n: number): number {
  if (y < 1900 || y > 2100 || n < 1 || n > 24) return -1;
  const row = TERM_INFO[y - 1900];
  const g = Math.floor((n - 1) / 4);
  const info = parseInt("0x" + row.substring(g * 5, g * 5 + 5)).toString();
  const cut = [[0, 1], [1, 2], [3, 1], [4, 2]][(n - 1) % 4];
  return parseInt(info.substring(cut[0], cut[0] + cut[1]));
}

/** 当天是二十四节气中的哪一个（不是节气返回空串） */
export function termOf(y: number, m: number, d: number): string {
  if (y < 1900 || y > 2100) return "";
  // 每年 24 个节气分布在 12 个月里：m 月对应第 2m-1、2m 个
  if (termDay(y, m * 2 - 1) === d) return TERM_NAMES[m * 2 - 2];
  if (termDay(y, m * 2) === d) return TERM_NAMES[m * 2 - 1];
  return "";
}

export interface LunarDay {
  /** 农历日名：初一 / 十五 / 廿二 / 三十 */
  dayCn: string;
  /** 农历月名：正月 / 二月 / … / 腊月（闰月带「闰」前缀） */
  monthCn: string;
  isLeap: boolean;
}

/** 公历 → 农历（1900-01-31 = 庚子年正月初一 起算） */
export function lunarOf(y: number, m: number, d: number): LunarDay | null {
  if (y < 1900 || y > 2100) return null;
  let offset = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
  let ly = 1900;
  let temp = 0;
  for (; ly < 2101 && offset > 0; ly++) { temp = lunarYearDays(ly); offset -= temp; }
  if (offset < 0) { offset += temp; ly--; }
  const leap = leapMonth(ly);
  let isLeap = false;
  let lm = 1;
  for (; lm < 13 && offset > 0; lm++) {
    if (leap > 0 && lm === leap + 1 && !isLeap) { lm--; isLeap = true; temp = leapDays(ly); }
    else temp = monthDays(ly, lm);
    if (isLeap && lm === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && lm === leap + 1) { if (isLeap) isLeap = false; else { isLeap = true; lm--; } }
  if (offset < 0) { offset += temp; lm--; }
  const ld = offset + 1;
  const monthCn = (isLeap && leap === lm ? "闰" : "") + (LUNAR_MONTH_NAMES[lm - 1] || "");
  let dayCn: string;
  if (ld === 10) dayCn = "初十";
  else if (ld === 20) dayCn = "二十";
  else if (ld === 30) dayCn = "三十";
  else dayCn = N2[Math.floor(ld / 10)] + N1[ld % 10];
  return { dayCn, monthCn, isLeap };
}

const cache = new Map<string, string>();

/**
 * 日历格子用的中文标签：节气优先，其次农历（初一显示月名，其它显示日名）。
 * 超出 1900—2100 或算不出来时返回空串，格子留白。
 */
export function lunarLabel(dateStr: string): string {
  const hit = cache.get(dateStr);
  if (hit !== undefined) return hit;
  const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7)), d = Number(dateStr.slice(8, 10));
  let out = "";
  if (y >= 1900 && y <= 2100 && m >= 1 && d >= 1) {
    const term = termOf(y, m, d);
    if (term) out = term;
    else {
      const l = lunarOf(y, m, d);
      if (l) out = l.dayCn === "初一" ? l.monthCn : l.dayCn;
    }
  }
  if (cache.size > 800) cache.clear();
  cache.set(dateStr, out);
  return out;
}
