/**
 * 页内换页回到顶部：让出 sticky 顶栏（.db-topbar）的实测高度。
 *
 * 原生 scrollIntoView({ block: "start" }) 会把目标顶到滚动口最上沿，
 * 而 sticky 顶栏仍压在同一位置（z-index 20），页面头部会被盖掉一截；
 * 安卓上顶栏还带状态栏安全区，遮挡更明显。
 * scroll-margin 又不方便跟随安全区/折叠后的实际高度，所以这里直接量。
 */
export function scrollPageToTop(host: HTMLElement): void {
  if (!host.isConnected) return;
  const scroller = host.closest<HTMLElement>(".db-journal-root");
  if (!scroller) {
    host.scrollIntoView({ block: "start" });
    return;
  }
  const bar = scroller.querySelector<HTMLElement>(".db-topbar");
  const barH = bar ? bar.getBoundingClientRect().height : 0;
  // 用父容器（composer）对齐，保留页面顶部自带的 padding
  const box = host.parentElement ?? host;
  const delta = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top - barH;
  if (Math.abs(delta) > 1) scroller.scrollTop += delta;
}
