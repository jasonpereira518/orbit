import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import Link from "next/link";
import { BookOpen, UserRound } from "lucide-react";
import { getKnowledgeBase, getKnowledgePeople } from "@/actions/knowledge";
import { DossierPane } from "@/components/knowledge/dossier-pane";
import { KnowledgeBaseView } from "@/components/knowledge/knowledge-base-view";
import { KnowledgeViewSwitch } from "@/components/knowledge/knowledge-view-switch";
import { DossierSkeleton } from "@/components/knowledge/knowledge-skeletons";
import { PeopleIndex } from "@/components/knowledge/people-index";
import { PageHeader } from "@/components/layout/page-header";
import { RenderStamp } from "@/components/layout/render-stamp";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
  const gate = await pageVisibilityGate("page.knowledge");
  if (gate) return gate;

  const sp = await searchParams;
  const view = sp.view === "overview" ? "overview" : "people";
  const selectedId = view === "people" && typeof sp.p === "string" && UUID.test(sp.p) ? sp.p : null;

  return (
    // The page does not scroll: it fills the route (`data-fill-route`), the header holds its
    // place, and the list and the dossier each scroll inside their own pane. The root is a
    // plain div rather than `PageShell` because the route wrapper reads `data-fill-route` on
    // its direct child and `PageShell` does not forward it; the width is the shell's own
    // (`full`), and the column's `gap-4` stands in for the page rhythm.
    <div data-fill-route className="flex min-h-0 w-full flex-1 flex-col gap-4">
      <RenderStamp />
      <PageHeader
        className={cn("shrink-0", selectedId && "hidden lg:flex")}
        title="Knowledge base"
        description="Everyone in your orbit, what Orbit knows about them, and how they fit your goals."
        actions={<KnowledgeViewSwitch view={view} />}
      />

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
      <EmptyState
        icon={BookOpen}
        title="No one is in your orbit yet"
        description="Import LinkedIn connections, or log notes from Capture. Each person you add gets a summary here, and a place in how your people connect to your goals."
        action={
          <>
            <Link href="/imports" className={buttonVariants()}>
              Import LinkedIn
            </Link>
            <Link href="/capture" className={buttonVariants({ variant: "outline" })}>
              Log a note
            </Link>
          </>
        }
      />
    );
  }

  return (
    // From `lg` each pane scrolls on its own inside a bounded row. Below it the two are
    // separate screens and this body is the one thing that scrolls.
    <div className="grid min-h-0 flex-1 items-start gap-6 overflow-y-auto lg:grid-cols-[19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:overflow-hidden xl:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className={cn("lg:flex lg:min-h-0 lg:flex-col", selectedId ? "hidden lg:flex" : "block")}>
        <PeopleIndex
          rows={people.rows}
          total={people.total}
          goalCount={people.goalCount}
          selectedId={selectedId}
        />
      </aside>

      <section
        aria-label="Person"
        className={cn("min-w-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain", !selectedId && "hidden lg:block")}
      >
        {selectedId ? (
          <Suspense key={selectedId} fallback={<DossierSkeleton />}>
            <DossierPane contactId={selectedId} />
          </Suspense>
        ) : (
          <EmptyState
            icon={UserRound}
            title="Pick someone"
            description="See their summary, how they bear on your goals, who they connect to, and the facts Orbit has kept."
            className="py-16"
          />
        )}
      </section>
    </div>
  );
}
