/**
 * Per-instance copy of each viewer's duplicates badge count.
 *
 * `/contacts` renders the badge on every visit and on every `router.refresh()` a filter change
 * makes, and the count's name-collision half is a self-join over the whole network (63 ms at
 * 10k contacts, ~0.5 s at 100k even with `contacts_user_name_norm_idx`). The badge only says
 * whether there is anything to review and whether it is 99+, so a minute behind is fine:
 * merges, unmerges, dismissals and new suggestions on this instance forget it at once, and
 * other instances catch up within the TTL. Leaf module: no imports, so both the reader and
 * the writers can depend on it without a cycle.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const memo = new Map<string, { at: number; value: Promise<number> }>();

export function rememberedDuplicateCount(userId: string, compute: () => Promise<number>): Promise<number> {
  const hit = memo.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = compute();
  // A failed count is not remembered: the next render tries again.
  value.catch(() => {
    if (memo.get(userId)?.value === value) memo.delete(userId);
  });
  if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value!);
  memo.set(userId, { at: Date.now(), value });
  return value;
}

/** Drop the cached count — one viewer's, or everyone's. For writers and tests. */
export function forgetDuplicateCount(userId?: string): void {
  if (userId) memo.delete(userId);
  else memo.clear();
}
