/**
 * The part of a custom sky's remount key that tracks who is in it.
 *
 * Sorted first: the payload's contact order is the database's heap order (no ORDER BY), which
 * can shift after any UPDATE, and an order-only change must not remount the chart.
 */
export function skyMembersDigest(contactIds: readonly string[]): number {
  const members = [...contactIds].sort().join(",");
  let digest = 0;
  for (let i = 0; i < members.length; i++) digest = (Math.imul(digest, 31) + members.charCodeAt(i)) | 0;
  return digest;
}
