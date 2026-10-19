import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { SharedAvatarActions } from "@/components/admin/shared-avatar-actions";
import { requireAdminUserId } from "@/lib/admin";
import { listSharedAvatars } from "@/lib/admin-avatars";

export const metadata = { title: "Admin · Shared photos" };

/**
 * Blocked shared LinkedIn photos, and a slug search over the whole pool. A takedown starts
 * from a contact page; this is where to find it again, undo it, or check a slug by name. A
 * searched slug with no row can be blocked ahead of any lookup (a removal request from
 * someone no account has yet).
 */
export default async function AdminAvatarsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdminUserId();
  const q = (await searchParams).q?.trim().slice(0, 100) || undefined;
  const rows = await listSharedAvatars({ q });
  const unseen = q && !rows.some((r) => r.slug === q.toLowerCase()) ? q.toLowerCase() : null;

  return (
    <>
      <AdminPageHeader
        title="Shared photos"
        subtitle="Public LinkedIn photos shared across accounts. Blocked slugs are never fetched."
      />
      <form method="get" className="mb-4 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="LinkedIn slug, e.g. jane-doe"
          aria-label="Search by LinkedIn slug"
          className="h-8 w-72 rounded-md border border-border bg-background px-2 text-sm"
          autoComplete="off"
        />
        <button type="submit" className="h-8 rounded-md border border-border/70 px-3 text-xs hover:bg-muted">
          Search
        </button>
      </form>
      {unseen && (
        <div className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            No row for <span className="font-mono text-xs text-foreground">{unseen}</span> yet. Block it so it is never
            fetched:
          </span>
          <SharedAvatarActions slug={unseen} blocked={false} />
        </div>
      )}
      <AdminPanel title={q ? `Matches for “${q}”` : `Blocked (${rows.length})`}>
        {rows.length === 0 ? (
          <EmptyState>{q ? "No shared photo row for that slug." : "Nothing is blocked."}</EmptyState>
        ) : (
          <AdminTable
            label="Shared photos"
            minWidth="sm"
            head={
              <>
                <Th>Slug</Th>
                <Th>State</Th>
                <Th>Blocked</Th>
                <Th>{""}</Th>
              </>
            }
          >
            {rows.map((r) => (
              <tr key={r.slug} className="border-b border-border/40 last:border-b-0">
                <Td className="font-mono text-xs">{r.slug}</Td>
                <Td className="text-muted-foreground">
                  {r.blockedAt ? "Blocked" : r.imageUrl ? `Photo (${r.source})` : "No photo found"}
                </Td>
                <Td>{r.blockedAt ? <><RelativeTime date={r.blockedAt} /> ago</> : "—"}</Td>
                <Td>
                  <SharedAvatarActions slug={r.slug} blocked={r.blockedAt !== null} />
                </Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </AdminPanel>
    </>
  );
}
