import { getKnowledgeBase } from "@/actions/knowledge";
import { KnowledgeBaseView } from "@/components/knowledge/knowledge-base-view";

export default async function KnowledgePage() {
  const { stats, entries } = await getKnowledgeBase();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Knowledge base
        </h1>
        <p className="mt-1 text-muted-foreground">
          Everything Orbit knows about your network — imported messages, notes,
          summaries, and key facts.
        </p>
      </div>

      <KnowledgeBaseView stats={stats} entries={entries} />
    </div>
  );
}
