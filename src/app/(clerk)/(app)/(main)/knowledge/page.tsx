import { Suspense } from "react";
import Link from "next/link";
import { BookOpen, Sparkles } from "lucide-react";
import { getKnowledgeBase, getKnowledgePeople } from "@/actions/knowledge";
import { DossierPane } from "@/components/knowledge/dossier-pane";
import { KnowledgeBaseView } from "@/components/knowledge/knowledge-base-view";
import { KnowledgeViewSwitch } from "@/components/knowledge/knowledge-view-switch";
import { DossierSkeleton } from "@/components/knowledge/knowledge-skeletons";
import { PeopleIndex } from "@/components/knowledge/people-index";
import { RenderStamp } from "@/components/layout/render-stamp";
import { cn } from "@/lib/utils";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * People (a list and a dossier) is the page; Overview is the flat feed it grew out of.
 * Both share one width and one header, word for word, so the switch between them stays
 * exactly where it is instead of jumping as the page changes.
 *
 * The selected person is the URL (`?p=`), so the dossier is an ordinary server component
 * that streams in behind a skeleton and can be linked, reloaded and reached with back.
 * Below `lg` the two panes are two screens: the list until someone is chosen, then the
 * dossier with a way back. That is CSS on the URL's state, not a second render path.
 */
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; p?: string }>;
}) {
  const sp = await searchParams;
  const view = sp.view === "overview" ? "overview" : "people";
  const selectedId = view === "people" && typeof sp.p === "string" && UUID.test(sp.p) ? sp.p : null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <RenderStamp />
      <div className={cn("flex-wrap items-end justify-between gap-4", selectedId ? "hidden lg:flex" : "flex")}>
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
            Knowledge base
          </h1>
          <p className="mt-1 text-muted-foreground">
            Everyone in your orbit, what Orbit knows about them, and how they fit your goals.
          </p>
        </div>
        <KnowledgeViewSwitch view={view} />
      </div>

      {view === "overview" ? <Overview /> : <People selectedId={selectedId} />}
    </div>
  );
}

async function Overview() {
  const { stats, entries } = await getKnowledgeBase();
  return <KnowledgeBaseView stats={stats} entries={entries} />;
}

async function People({ selectedId }: { selectedId: string | null }) {
  const people = await getKnowledgePeople();

  if (people.total === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center">
        <BookOpen className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 font-[family-name:var(--font-display)] text-xl text-ink">
          No one is in your orbit yet
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Import LinkedIn connections, or log notes from Capture. Each person you add gets a
          summary here, and a place in how your people connect to your goals.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Link href="/imports" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">
            Import LinkedIn
          </Link>
          <Link href="/capture" className="rounded-xl border border-border/70 px-4 py-2 text-sm">
            Log a note
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[19rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)]">
      <aside
        className={cn(
          "lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100dvh-8rem)] lg:flex-col",
          selectedId ? "hidden lg:flex" : "block"
        )}
      >
        <PeopleIndex
          rows={people.rows}
          total={people.total}
          goalCount={people.goalCount}
          selectedId={selectedId}
        />
      </aside>

      <section aria-label="Person" className={cn("min-w-0", !selectedId && "hidden lg:block")}>
        {selectedId ? (
          <Suspense key={selectedId} fallback={<DossierSkeleton />}>
            <DossierPane contactId={selectedId} />
          </Suspense>
        ) : (
          <div className="rounded-2xl border border-dashed border-border/70 px-6 py-16 text-center">
            <Sparkles className="mx-auto h-7 w-7 text-muted-foreground" />
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-xl text-ink">
              Pick someone
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              See their summary, how they bear on your goals, who they connect to, and the
              facts Orbit has kept.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
