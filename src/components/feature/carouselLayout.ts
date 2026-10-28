/** Space between cards, in px. */
export const GAP = 24;

/** Cards per view, with the next card peeking in so it is clear the row scrolls. */
export function viewsFor(width: number): number {
  return width < 640 ? 1.15 : width < 1024 ? 2.2 : width < 1280 ? 3.15 : 4.15;
}
