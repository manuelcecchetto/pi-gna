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
