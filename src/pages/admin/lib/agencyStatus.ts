/** Statuses with at least one application, in the order of the database's status catalogue; statuses it does not list are ignored. */
export function sortedStatusCounts(counts: Record<string, number> | undefined, order: ReadonlyArray<{ value: string }>): Array<[string, number]> {
  return order.filter((s) => (counts?.[s.value] ?? 0) > 0).map((s) => [s.value, counts?.[s.value] ?? 0]);
}
