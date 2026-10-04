"use client";

import { useState } from "react";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import { isPeopleNavInBrowser } from "@/lib/people-nav";

/**
 * A people route's `loading.tsx`.
 *
 * Arriving from the other view via the toggle, it draws just the header and toggle — the parts
 * the page will draw again in the same place — and leaves the body empty, so the switch reads
 * as one surface changing rather than the whole page (toggle included) dropping out for a
 * skeleton and coming back. Anywhere else (a link, a reload) it is the full skeleton.
 *
 * Decided in the browser: the fallback is prepared before any click, so a server-side check of
 * the in-flight marker could never have seen it.
 */
export function PeopleNavFallback({
  active,
  title,
  subtitle,
  skeleton,
}: {
  active: "contacts" | "recruiters";
  title: string;
  subtitle: string;
  skeleton: React.ReactNode;
}) {
  const [switching] = useState(() => isPeopleNavInBrowser());
  if (!switching) return skeleton;
  return (
    <PeopleListShell active={active} title={title} subtitle={subtitle} pending>
      {null}
    </PeopleListShell>
  );
}
