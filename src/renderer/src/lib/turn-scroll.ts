/** A scroller's geometry at one scroll event. */
export interface ScrollGeometry {
  top: number;
  height: number;
  view: number;
}

/** How close to the end still counts as "at the end": iOS reports fractional offsets and rounds the heights. */
export const END_SLACK = 2;

export const distanceToEnd = ({ top, height, view }: ScrollGeometry) => height - top - view;

/**
 * Whether the view keeps following the end after a scroll from `last` to `now`. At the end it does, and so does a
 * bounce past it (iOS's rubber band moves back up to the end). Moving up without the content shrinking or the view
 * growing is you scrolling up, which stops it; those two only clamp. Anything else leaves it as it was.
 */
export function followsAfterScroll(pinned: boolean, last: ScrollGeometry, now: ScrollGeometry): boolean {
  if (distanceToEnd(now) <= END_SLACK) return true;
  if (now.top < last.top && now.height >= last.height && now.view <= last.view) return false;
  return pinned;
}

/** A scroller as `settleView` reads and moves it (an HTMLElement). */
export interface Scroller {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether the view follows the end, and the content and view heights it was last positioned for. */
export interface ViewFollow {
  pinned: boolean;
  height: number;
  view: number;
}

/**
 * Positions the view after the content or the view changed size. At the end it follows growth while output streams
 * (`follow`) and keeps the end in sight when the view gets shorter (a phone keyboard opening; a taller view already
 * clamps to it). Other growth (you expanded a step at the end) leaves the view where it is, which stops following
 * unless that is still the end. Only a change in either height moves the view, so it never fights the send glide.
 */
export function settleView(scroller: Scroller, state: ViewFollow, follow: boolean): void {
  const height = scroller.scrollHeight;
  const view = scroller.clientHeight;
  const changed = height !== state.height;
  const resized = view < state.view;
  state.height = height;
  state.view = view;
  if (!state.pinned || !(changed || resized)) return;
  if (follow || resized) scroller.scrollTop = height;
  else state.pinned = distanceToEnd({ top: scroller.scrollTop, height, view }) <= END_SLACK;
}
