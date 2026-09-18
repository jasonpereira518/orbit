import { getKnowledgeBase } from "@/actions/knowledge";
import type { KnowledgeKind } from "@/lib/knowledge-base-types";
import { KnowledgeBaseView } from "@/components/knowledge/knowledge-base-view";

const KINDS: KnowledgeKind[] = ["message", "note", "summary", "key_fact", "meeting"];

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() || "";
  const kind = KINDS.includes(params.kind as KnowledgeKind)
    ? (params.kind as KnowledgeKind)
    : "all";

  const { stats, entries } = await getKnowledgeBase({ q, kind });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Knowledge base
        </h1>
        <p className="mt-1 text-muted-foreground">
          Everything Orbit knows about your network — imported messages, notes,
          summaries, and key facts.
        </p>
      </div>

      <KnowledgeBaseView
        stats={stats}
        entries={entries}
        initialQuery={q}
        initialFilter={kind}
      />
    </div>
  );
}
