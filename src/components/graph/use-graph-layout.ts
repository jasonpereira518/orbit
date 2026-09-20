"use client";

import { useEffect, useMemo, useState } from "react";
import { buildHybridGraphLayout } from "@/lib/graph-layout";
import type { GraphChartProps } from "@/components/graph/graph-chart-types";

/**
 * Contacts → filtered contacts → sky, for whichever renderer is mounted.
 *
 * Shared so the two renderers cannot disagree about who is in the sky. A filter change
 * that landed on only one of them would be invisible until someone compared a phone and
 * a laptop side by side.
 */
export function useGraphLayout(props: GraphChartProps) {
  // Keyword is the one filter driven by continuous typing — debounce it so
  // the (potentially expensive) filter/layout rebuild below doesn't run on
  // every keystroke. Company/school/minScore come from discrete selects.
  const [debouncedKeyword, setDebouncedKeyword] = useState(props.keyword);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKeyword(props.keyword), 220);
    return () => clearTimeout(t);
  }, [props.keyword]);

  const filteredContacts = useMemo(() => {
    const kw = debouncedKeyword.trim().toLowerCase();
    return props.data.contacts.filter((c) => {
      // No `substantive` check here: the server already shipped only what this scope draws,
      // so filtering again would be redundant — and would silently hide pinned-in contacts
      // in the "show all" view.
      if (props.company !== "all" && c.company !== props.company) return false;
      if (props.school !== "all" && (c.school || "") !== props.school) {
        return false;
      }
      const orbit = c.orbitScore ?? c.relationshipScore ?? 1;
      if (orbit < Number(props.minScore)) return false;
      if (kw) {
        const hay = [
          c.fullName,
          c.preferredName,
          c.company,
          c.school,
          c.title,
          c.aiSummary,
          ...(c.tags || []),
          ...(c.keyFacts || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [
    props.data.contacts,
    props.company,
    props.school,
    debouncedKeyword,
    props.minScore,
  ]);

  const layout = useMemo(() => {
    return buildHybridGraphLayout(filteredContacts, props.data.summary.userName);
  }, [filteredContacts, props.data.summary.userName]);

  /**
   * Changes exactly when the set of people in the sky does. Both renderers re-frame the
   * camera on it: a filter that swaps who is drawn deserves a fresh view, while a refresh
   * that only updates the people already there keeps the one you are looking at.
   */
  const layoutKey = useMemo(
    () => filteredContacts.map((c) => c.id).join(","),
    [filteredContacts]
  );

  return { filteredContacts, layout, layoutKey };
}
