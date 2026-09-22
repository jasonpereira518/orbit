/**
 * A page listing several people — search results, a company's People tab, a
 * team page, a group thread. Which of them you already know, then one at a
 * time: pick a row to see (or add) that person.
 *
 * Never "add all". That is the line between reading a page and scraping a
 * site, and it is in the README for a reason: one considered contact beats
 * forty half-known ones, for the user and for everyone on the list.
 */
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { PageCandidate, PageContext, ResolveBatchItem } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Avatar, Meta, MicroLabel, Section } from "../components/ui";

const STATUS_LABEL: Record<ResolveBatchItem["status"], string> = {
  known: "In your orbit",
  possible: "Maybe",
  new: "Add",
};

export function PeopleView({
  page,
  api,
  onPick,
}: {
  page: PageContext;
  api: OrbitApi;
  onPick: (candidate: PageCandidate, item: ResolveBatchItem | null) => void;
}) {
  const candidates = page.candidates ?? [];
  const [items, setItems] = useState<ResolveBatchItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setFailed(false);
    if (candidates.length === 0) return;
    api
      .resolveBatch({ candidates }, controller.signal)
      .then((result) => setItems(result.items))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
    // Keyed on the page URL: the list is derived from the page, and a fresh
    // candidates array on every render must not refetch.
  }, [page.url, api]);

  const known = items?.filter((item) => item.status === "known").length ?? 0;

  return (
    <div className="scroll-area flex-1">
      {/* The verdict above already says how many; this says what it means. */}
      <Section hairline={false}>
        <Meta>
          {failed
            ? "Couldn't check them against your orbit."
            : items === null
              ? "Checking who you know…"
              : known === 0
                ? "You don't know any of them yet."
                : `You know ${known} of them.`}{" "}
          Pick one to see or add them.
        </Meta>
      </Section>

      <Section>
        <MicroLabel className="mb-1">People</MicroLabel>
        <div className="space-y-0.5">
          {candidates.map((candidate, index) => {
            const item = items?.find((i) => i.index === index) ?? null;
            const status = item?.status ?? null;
            return (
              <button
                key={`${candidate.profileUrl ?? candidate.email ?? candidate.name}-${index}`}
                onClick={() => onPick(candidate, item)}
                className="group flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2 py-1.5 text-left hover:bg-[var(--accent)]"
              >
                <Avatar src={item?.contact?.photoUrl} name={candidate.name} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-[18px]">{candidate.name}</span>
                  <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                    {candidate.subtitle ||
                      [item?.contact?.title, item?.contact?.company].filter(Boolean).join(" · ") ||
                      "\u00a0"}
                  </span>
                </span>
                {status ? (
                  <span
                    className={cn(
                      "shrink-0 text-[11px]",
                      status === "known" && "text-[var(--primary)]",
                      status !== "known" && "text-[var(--muted-foreground)]"
                    )}
                  >
                    {STATUS_LABEL[status]}
                  </span>
                ) : null}
                <ChevronRight
                  size={13}
                  className="shrink-0 text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
            );
          })}
        </div>
        <Meta className="mt-2">Only the people this page has already shown. Orbit never scrolls for more.</Meta>
      </Section>
    </div>
  );
}
