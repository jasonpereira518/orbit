import { listUnresolvedMentions } from "@/actions/unresolved-mentions";
import { UnresolvedMentionsReview } from "@/components/mentions/unresolved-mentions-review";

export default async function MentionsReviewPage() {
  const mentions = await listUnresolvedMentions();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Mentions to review
        </h1>
        <p className="mt-1 text-muted-foreground">
          People your notes named but didn&apos;t log as contacts yet.
        </p>
      </div>
      <UnresolvedMentionsReview mentions={mentions} />
    </div>
  );
}
