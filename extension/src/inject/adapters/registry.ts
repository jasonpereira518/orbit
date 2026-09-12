import { gmailAdapter } from "./gmail";
import { genericAdapter } from "./generic";
import { linkedinAdapter } from "./linkedin";
import { xAdapter } from "./x";
import type { SiteAdapter } from "./types";

/** Ordered, first match wins. `generic` matches everything and stays last. */
export const ADAPTERS: SiteAdapter[] = [
  linkedinAdapter,
  xAdapter,
  gmailAdapter,
  genericAdapter,
];

export function adapterFor(url: URL): SiteAdapter {
  return ADAPTERS.find((adapter) => adapter.matches(url)) ?? genericAdapter;
}
