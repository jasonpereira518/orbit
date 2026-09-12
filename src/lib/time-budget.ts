/**
 * Wall-clock budgets for loops that do network work per item.
 *
 * A server action runs on whatever page is open and shares that page's function ceiling,
 * so any loop that awaits the network per item must be able to stop early and report what
 * it did not get to. Checked BEFORE each item, not after: one resolution can take several
 * seconds, and the point is a bounded return.
 */
export function deadlineAfter(budgetMs: number, now: () => number = Date.now): number {
  return now() + budgetMs;
}

export function deadlineReached(deadline: number, now: () => number = Date.now): boolean {
  return now() >= deadline;
}
