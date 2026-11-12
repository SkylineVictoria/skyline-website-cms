/** Up to three short options read well as segments (SegmentedRadios); longer ones stay a plain radio list. */
export function fitsSegments(options: readonly string[] | undefined): boolean {
  return Boolean(options && options.length >= 2 && options.length <= 3 && options.every((option) => option.length <= 24));
}
