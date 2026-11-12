"use client";

import { createDismissStore } from "@/lib/dismissed-ids";

/**
 * Bell rows the user cleared that the server will keep sending: a capture waiting for
 * review, found cloud notes, a feedback reply, Radar's line. They are re-derived on every
 * pulse, so "Clear notifications" has nothing to delete; it remembers a key, and the panel
 * and the bell's badge skip rows that carry it. Per device (see `dismissed-ids.ts`).
 *
 * Its own module because the bell (every page) and the panel body (a lazy chunk) both read it.
 *
 * Keys name what the row SAYS, so more cloud notes, a new capture or a changed Radar list is
 * a different key and shows up again, and what was already cleared never does.
 */
export const panelDismissals = createDismissStore("orbit:dismissed-panel:v1");

/** `cloud-notes:found` is one id for every batch; the title is what carries the count. */
export const panelItemKey = (item: { id: string; title: string }) => `${item.id}|${item.title}`;

export const radarKey = (r: { count: number; drafts: number; names: string[] }) =>
  `radar|${r.count}|${r.drafts}|${r.names.join(",")}`;
