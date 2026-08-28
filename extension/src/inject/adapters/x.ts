/**
 * X / Twitter adapter.
 *
 * Thinner than LinkedIn by design. The valuable signal here is the first few
 * visible posts — on this platform that is what a human actually reads before
 * reaching out, and it is far better starter fuel than the bio.
 */

import { cleanText, selectionText } from "@/inject/dom/text";
import { metaContent, parseTitle } from "@/inject/dom/meta";
import { isReservedXPath, stripTracking, xHandle } from "@/inject/dom/url";
import {
  attempt,
  emptyIdentity,
  field,
  preferField,
  type PageKind,
  type SiteAdapter,
} from "./types";

const ADAPTER_VERSION = "x-1";
const BLOB_CHARS = 4_000;

/** "Name (@handle) / X" has been the title shape across both rebrands. */
function nameFromTitle(): string | null {
  const parsed = parseTitle(document.title, ["/ X", "/ Twitter", "| X"]);
  const name = parsed.name?.replace(/\s*\(@[A-Za-z0-9_]+\)\s*$/, "").trim();
  return name || null;
}

export const xAdapter: SiteAdapter = {
  id: "x",
  adapterVersion: ADAPTER_VERSION,
  matches: (url) => /(^|\.)(x|twitter)\.com$/i.test(url.hostname),

  extract(url) {
    const warnings: string[] = [];
    const identity = emptyIdentity();
    const segments = url.pathname.split("/").filter(Boolean);
    const first = segments[0] ?? "";
    const handle = xHandle(first);

    let kind: PageKind = "unknown";
    if (handle && !isReservedXPath(handle)) {
      kind = segments[1] === "status" ? "post" : "person";
    }

    if (kind !== "unknown") {
      identity.handle = field(handle, "url", "high");
      identity.profileUrl = field(`https://x.com/${handle}`, "url", "high");
      identity.name = preferField(
        field(attempt(warnings, "title", () => nameFromTitle()), "document.title", "high"),
        field(metaContent("og:title"), "og:title", "medium")
      );
      identity.headline = preferField(
        attempt(warnings, "bio", () => {
          const bio = document.querySelector('[data-testid="UserDescription"]');
          return field(bio?.textContent, "UserDescription", "medium");
        }) ?? null,
        field(metaContent("og:description"), "og:description", "low")
      );
      identity.location = attempt(warnings, "location", () => {
        const node = document.querySelector('[data-testid="UserLocation"]');
        return field(node?.textContent, "UserLocation", "medium");
      }) ?? null;
      identity.photoUrl = field(metaContent("og:image"), "og:image", "low");
    }

    const selection = selectionText(BLOB_CHARS);
    const root =
      document.querySelector('[data-testid="primaryColumn"]') ??
      document.querySelector("main");
    const text =
      selection ??
      (kind === "unknown"
        ? { blob: "", truncated: false, charCount: 0 }
        : cleanText(root, BLOB_CHARS));

    return {
      schemaVersion: 1,
      site: "x",
      adapterVersion: ADAPTER_VERSION,
      kind,
      url: identity.profileUrl?.value ?? stripTracking(url.href),
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      identity,
      text: { ...text, fromSelection: Boolean(selection) },
      warnings,
    };
  },
};
