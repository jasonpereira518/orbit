import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { Suspense } from "react";
import Link from "next/link";
import { BookOpen, Sparkles } from "lucide-react";
import { getKnowledgePeople } from "@/actions/knowledge";
import { DossierPane } from "@/components/knowledge/dossier-pane";
import { DossierSkeleton } from "@/components/knowledge/knowledge-skeletons";
import { PeopleIndex } from "@/components/knowledge/people-index";
import { RenderStamp } from "@/components/layout/render-stamp";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

export const metadata = { title: "Knowledge" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pick a person, understand everything Orbit knows about them: a list on the left, and on the
 * right their snapshot with their history below it.
 *
 * The selected person is the URL (`?p=`), so the dossier is an ordinary server component
 * that streams in behind a skeleton and can be linked, reloaded and reached with back.
 * Below `lg` the two panes are two screens: the list until someone is chosen, then the
 * dossier with a way back. That is CSS on the URL's state, not a second render path.
 *
 * There used to be a second "Overview" view here, a flat feed whose every row opened a
 * person. Its one useful part, searching inside notes and messages, lives in the list's
 * search now. A stale `?view=overview` link simply lands on the list.
 */
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>;
}) {
  const gate = await pageVisibilityGate("page.knowledge");
  if (gate) return gate;

  const sp = await searchParams;
  const selectedId = typeof sp.p === "string" && UUID.test(sp.p) ? sp.p : null;

  return (
    // The page does not scroll: it fills the route (`data-fill-route`), the header holds its
    // place, and the list and the dossier each scroll inside their own pane.
    <div
      data-fill-route
      className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4"
    >
      <RenderStamp />
      <div className={cn("shrink-0", selectedId ? "hidden lg:block" : "block")}>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Knowledge</h1>
        <p className="mt-1 text-muted-foreground">
          Everyone in your orbit and what Orbit knows about them.
        </p>
      </div>

      <People selectedId={selectedId} />
    </div>
  );
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
            <Link href="/imports" className={buttonVariants({ size: "sm" })}>
              Import LinkedIn
            </Link>
            <Link href="/capture" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Log a note
            </Link>
          </>
        }
        className="rounded-2xl border border-dashed border-border/70 py-12"
      />
    );
  }

  return (
    // From `lg` each pane scrolls on its own inside a bounded row. Below it the two are
    // separate screens and this body is the one thing that scrolls.
    <div className="grid min-h-0 flex-1 items-start gap-6 overflow-y-auto lg:grid-cols-[17rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch lg:overflow-hidden xl:grid-cols-[18rem_minmax(0,1fr)]">
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
            icon={Sparkles}
            title="Pick someone"
            description="See their summary, how they bear on your goals, who they connect to, and everything you’ve logged with them."
            className="rounded-2xl border border-dashed border-border/70 py-16"
          />
        )}
      </section>
    </div>
  );
}
