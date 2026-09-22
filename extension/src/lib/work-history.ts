import type { PageContext, ProfileCaptureResponse, ProfileSection } from "@contract";

/** Work history is read only from a LinkedIn profile or one of its details pages. */
export function canReadWorkHistory(page: PageContext): boolean {
  return page.site === "linkedin" && page.kind === "person" && !page.text.fromSelection;
}

/** The profile lists only some roles — the details page has them all. */
export function profileListsOnlySome(page: PageContext): boolean {
  return !page.section && page.warnings.includes("experience-shortened");
}

export function detailsUrl(page: PageContext, section: ProfileSection): string | null {
  const slug = page.identity.handle?.value;
  return slug ? `https://www.linkedin.com/in/${slug}/details/${section}/` : null;
}

export type CaptureOutcome = {
  tone: "ok" | "warn" | "error";
  text: string;
  /** Offer to open this section's details page. */
  openSection?: ProfileSection;
  /** Offer to open Orbit's AI settings. */
  settings?: boolean;
};

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * What to tell the user after a capture. A conflict isn't here: it asks a
 * question, so the view renders it as one.
 */
export function captureOutcome(res: ProfileCaptureResponse): CaptureOutcome {
  if (res.status === "saved") {
    const wh = res.workHistory;
    const saved = wh
      ? [wh.roleCount ? plural(wh.roleCount, "role") : null, wh.schoolCount ? plural(wh.schoolCount, "school") : null]
          .filter(Boolean)
          .join(" and ")
      : "work history";
    if (res.shortened?.includes("experience")) {
      return {
        tone: "warn",
        text: `Saved ${saved}. Their profile lists only some roles — the full list has the rest.`,
        openSection: "experience",
      };
    }
    return { tone: "ok", text: `Saved ${saved}.` };
  }
  if (res.status === "partial") {
    return {
      tone: "warn",
      text: "This page shows fewer than Orbit already has, so nothing changed. The full list has them all.",
      openSection: res.openSection ?? "experience",
    };
  }
  switch (res.degradedReason) {
    case "no_api_key":
      return { tone: "error", text: "Reading work history needs an AI key in Orbit.", settings: true };
    case "no_text":
      return { tone: "error", text: "There was no text on this page to read." };
    case "nothing_found":
      return { tone: "warn", text: "No roles or schools on this page." };
    default:
      return { tone: "error", text: "Couldn't read that page. Try again." };
  }
}
