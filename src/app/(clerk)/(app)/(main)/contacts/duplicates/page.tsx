import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import type { Metadata } from "next";
import { listDuplicates, listRecentMerges } from "@/actions/duplicates";
import { requireUserId } from "@/lib/auth";
import { mergeConfidentDuplicates } from "@/lib/duplicate-sweep";
import { openEngines } from "@/lib/decisions/engine";
import { DuplicateReviewList } from "@/components/contacts/duplicate-review-list";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { DuplicatesListSkeleton } from "@/components/loading/page-skeletons";
import { RenderStamp } from "@/components/layout/render-stamp";

export const metadata: Metadata = {
  title: "Duplicates",
};

/**
 * The questions the app could not answer for itself.
 *
 * Sweeps first, lists second. Anything at or above the confidence line — a shared email,
 * LinkedIn profile or X handle, a shared name plus employer or role — is merged on the way
 * in and never appears here. Putting a pair in front of someone alongside the words "these
 * are the same person" and asking them to confirm it is work the app should have done.
 *
 * The sweep runs on render rather than only on deploy so that a duplicate created by a
 * hand-edit (someone corrects an email to one another contact already holds) is resolved by
 * the time anyone looks. It is idempotent and costs a single query when there is nothing to
 * do, which is the normal case.
 */
export default async function DuplicatesPage() {
  const gate = await pageVisibilityGate("page.contacts");
  if (gate) return gate;

  // The library function, NOT the server action that wraps it: the action calls
  // `revalidatePath`, and Next refuses that during a render. Nothing needs revalidating
  // here anyway — every contact surface is dynamic, so the next request re-reads.
  const userId = await requireUserId();

  return (
    <PageShell>
      <RenderStamp />
      <PageHeader
        title="Duplicates"
        back={{ href: "/contacts", label: "Contacts" }}
        description="Orbit merges duplicates for you whenever it can tell they are the same person. These are the ones it wasn’t sure about. Merging keeps everything: notes, interactions, reminders and tags all move to the record you keep, and the other one is hidden rather than deleted. Every merge can be undone."
      />

      {/* The header is static; only the list waits on the sweep and the reads. */}
      <Suspense fallback={<DuplicatesListSkeleton />}>
        <DuplicatesList userId={userId} />
      </Suspense>
    </PageShell>
  );
}

async function DuplicatesList({ userId }: { userId: string }) {
  // Same order as before: settle whatever can be merged automatically, THEN read what is
  // left — reading first would list pairs the sweep is about to merge. With a decision
  // model, a merge that rests only on a name is checked first (Jev only — the sweep never
  // waits on a chat model; see duplicate-sweep.ts).
  await mergeConfidentDuplicates(userId, { engines: await openEngines(userId) });

  const [{ proposed }, recentMerges] = await Promise.all([
    listDuplicates(),
    listRecentMerges(),
  ]);

  return <DuplicateReviewList proposed={proposed} recentMerges={recentMerges} />;
}
