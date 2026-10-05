"use client";

import { useEffect, useMemo, useState } from "react";
import { filterSkyContacts, skyLayoutFor } from "@/lib/graph/sky-layout";
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

  const filters = useMemo(
    () => ({
      company: props.company,
      school: props.school,
      minScore: props.minScore,
      keyword: debouncedKeyword,
    }),
    [props.company, props.school, props.minScore, debouncedKeyword]
  );

  const filteredContacts = useMemo(
    () => filterSkyContacts(props.data.contacts, filters),
    [props.data.contacts, filters]
  );

  // On opening, the layout was already computed in slices before this renderer mounted
  // (`precomputeSkyLayout`); computing it here instead made it and the first render one long
  // task. A filter change still lays out here, synchronously, as it always has.
  const layout = useMemo(
    () =>
      skyLayoutFor(
        props.data.contacts,
        filteredContacts,
        filters,
        props.data.summary.userName
      ),
    [props.data.contacts, filteredContacts, filters, props.data.summary.userName]
  );

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
