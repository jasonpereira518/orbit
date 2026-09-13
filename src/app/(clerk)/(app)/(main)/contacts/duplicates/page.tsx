import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listDuplicates, listRecentMerges } from "@/actions/duplicates";
import { requireUserId } from "@/lib/auth";
import { mergeConfidentDuplicates } from "@/lib/duplicate-sweep";
import { DuplicateReviewList } from "@/components/contacts/duplicate-review-list";

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
  // The library function, NOT the server action that wraps it: the action calls
  // `revalidatePath`, and Next refuses that during a render. Nothing needs revalidating
  // here anyway — every contact surface is dynamic, so the next request re-reads.
  await mergeConfidentDuplicates(await requireUserId());

  const [{ proposed }, recentMerges] = await Promise.all([
    listDuplicates(),
    listRecentMerges(),
  ]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <div className="space-y-2">
        <Link
          href="/contacts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Contacts
        </Link>
        <h1 className="font-heading text-2xl">Duplicates</h1>
        <p className="text-sm text-muted-foreground">
          Orbit merges duplicates for you whenever it can tell they are the same person.
          These are the ones it wasn&rsquo;t sure about. Merging keeps everything: notes,
          interactions, reminders and tags all move to the record you keep, and the other one
          is hidden rather than deleted. Every merge can be undone.
        </p>
      </div>

      <DuplicateReviewList proposed={proposed} recentMerges={recentMerges} />
    </div>
  );
}
