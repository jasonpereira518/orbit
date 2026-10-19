"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, ViewTransition } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  clearPeopleNavInBrowser,
  directionForPeopleNav,
  isPeopleNavInBrowser,
  markPeopleNavInBrowser,
} from "@/lib/people-nav";

type PeopleView = "contacts" | "recruiters";

const OPTIONS: Array<{ key: PeopleView; href: string; label: string }> = [
  { key: "contacts", href: "/contacts", label: "Contacts" },
  { key: "recruiters", href: "/recruiters", label: "Recruiters" },
];

/**
 * The shared frame of /contacts and /recruiters: the page header, the Contacts / Recruiters
 * toggle in its actions slot, then the page's own toolbar and list.
 *
 * The toggle is a `SegmentedControl` in link mode. Clicking it does not follow the link
 * directly: the shell navigates itself so it can tag the transition with a direction and leave
 * the in-flight marker the route's `loading.tsx` reads (see `people-nav.ts`).
 */
export function PeopleListShell({
  active,
  title,
  subtitle,
  actions,
  pending = false,
  children,
}: {
  active: PeopleView;
  title: string;
  subtitle: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Set by the route's loading fallback. It draws this same header while the other view's
   * data loads, so it must leave the in-flight marker for the real page to read.
   */
  pending?: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [visual, setVisual] = useState<PeopleView>(active);
  // Switching views swaps this shell for an identical one (fallback, then page). Fading the
  // header in each time reads as a blink, so a switch in flight draws it already in place.
  const [settled] = useState(() => isPeopleNavInBrowser());

  useEffect(() => {
    router.prefetch("/contacts");
    router.prefetch("/recruiters");
  }, [router]);

  useEffect(() => {
    setVisual(active);
    if (!pending) clearPeopleNavInBrowser();
  }, [active, pending]);

  function navigateTo(key: PeopleView, href: string) {
    if (key === active) return;
    const dir = directionForPeopleNav(active, key);
    // Cookie lets the route's loading.tsx skip its skeleton mid-toggle.
    markPeopleNavInBrowser();
    setVisual(key);
    // Navigate immediately — the View Transition snapshots the outgoing
    // list, so no artificial exit delay is needed.
    startTransition(() => {
      router.push(href, {
        transitionTypes: [dir > 0 ? "people-fwd" : "people-back"],
      });
    });
  }

  return (
    <PageShell width="wide" spacing="tight">
      <div className="space-y-4">
        <PageHeader
          title={title}
          description={subtitle}
          reveal={!settled}
          actions={
            /*
              One shared element across the page swap. Each view is its own route, so the
              toggle is unmounted with one page and mounted with the next; naming it lets the
              browser treat the two as the same thing and hold it still, instead of the old
              copy leaving and the new one arriving.
            */
            <ViewTransition name="people-view-toggle" enter="none" exit="none" update="none" share="auto">
              <SegmentedControl
                items={OPTIONS}
                value={visual}
                onChange={(key, item) => navigateTo(key, item.href ?? `/${key}`)}
                ariaLabel="People view"
                id="people-view"
              />
            </ViewTransition>
          }
        />
        {/* Reserved while the page loads, so the actions arriving don't push the list down. */}
        {actions || pending ? (
          <div className="flex min-h-10 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      <ViewTransition
        enter={{
          "people-fwd": "people-fwd",
          "people-back": "people-back",
          default: "none",
        }}
        exit={{
          "people-fwd": "people-fwd",
          "people-back": "people-back",
          default: "none",
        }}
        default="none"
      >
        <div className="w-full">{children}</div>
      </ViewTransition>
    </PageShell>
  );
}
