import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listDuplicates, listRecentMerges } from "@/actions/duplicates";
import { DuplicateReviewList } from "@/components/contacts/duplicate-review-list";

export const metadata: Metadata = {
  title: "Duplicates",
};

/**
 * The cleanup surface for duplicates that already exist.
 *
 * New contacts cannot become exact duplicates any more — identifiers are unique per user in
 * `contact_identities`, and a confident name match folds on its own — so everything listed
 * here is either historical, or a pair the app was not confident enough to merge for you.
 */
export default async function DuplicatesPage() {
  const [{ certain, proposed }, recentMerges] = await Promise.all([
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

      <DuplicateReviewList
        certain={certain}
        proposed={proposed}
        recentMerges={recentMerges}
      />
    </div>
  );
}
