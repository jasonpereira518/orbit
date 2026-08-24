import { loadAdminUserRows } from "@/lib/admin-metrics";
import { getDataProtection } from "@/lib/admin-data-protection";
import { mrrReconciliation } from "@/lib/admin-economics";
import { contactCapPicture, gateDemand, paidFeatureUsage, tierFindings } from "@/lib/admin-pricing";
import { getAiOperationAdoption } from "@/lib/admin-product-health";
import { monthlyInfraCents } from "@/lib/infra-costs";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import { formatCents } from "@/lib/admin-economics";

/**
 * Questions the data has already answered, that nobody has acted on.
 *
 * WHY THIS IS NOT JUST ANOTHER ALERT LIST. `buildAlerts` answers "who is stuck right now"
 * — things that name a person and need a reply today. This answers something slower and
 * easier to never get round to: the console has been quietly telling you something for
 * weeks, and because no single screen shouts, nobody looked.
 *
 * The distinction that keeps it useful is that every item here is a DECISION, not a task.
 * "Three accounts have sat at the free cap for a month" is not something to fix; it is
 * evidence that the cap may be set wrong, and the action is to think. If an item can be
 * dispatched by clicking something, it belongs on Overview's alert list or on Health.
 *
 * Each links to the screen that produced it, because the decision needs the surrounding
 * numbers and a summary line is not enough to make it on.
 */

export type Decision = {
  id: string;
  headline: string;
  detail: string;
  href: string;
  /** `watch` reads as "worth knowing"; `act` as "this is costing you something now". */
  tone: "act" | "watch";
};

export async function decisionsWaiting(): Promise<Decision[]> {
  const out: Decision[] = [];

  const rows = await loadAdminUserRows().catch(() => []);

  /* ------------------------------------------------------------------- pricing */

  const cap = await contactCapPicture(rows).catch(() => null);
  if (cap && cap.stalledAtCap.length > 0) {
    out.push({
      id: "cap.stalled",
      headline: `${cap.stalledAtCap.length} account${cap.stalledAtCap.length === 1 ? " has" : "s have"} sat at the ${cap.limit}-contact cap for over a month`,
      detail:
        "They met the paywall and declined. Enough of these means the cap is annoying people rather than converting them.",
      href: "/admin/product",
      tone: "act",
    });
  }

  const [demand, paidUsage] = await Promise.all([
    gateDemand().catch(() => []),
    paidFeatureUsage().catch(() => new Map<string, number | null>()),
  ]);
  const unwanted = tierFindings(demand, paidUsage).filter(
    (f) => f.verdict === "unwanted"
  );
  if (unwanted.length > 0) {
    out.push({
      id: "tier.unwanted",
      headline: `${unwanted.length} gated feature${unwanted.length === 1 ? "" : "s"} nobody has asked for and no paying account uses`,
      detail: `${unwanted.map((f) => f.feature).join(", ")} — either in the wrong tier, or not worth maintaining.`,
      href: "/admin/product",
      tone: "watch",
    });
  }

  const aiOps = await getAiOperationAdoption().catch(() => null);
  if (aiOps && aiOps.neverUsed.length > 0) {
    out.push({
      id: "ops.never-used",
      headline: `${aiOps.neverUsed.length} AI operation${aiOps.neverUsed.length === 1 ? " has" : "s have"} never been run by anyone`,
      detail: `${aiOps.neverUsed.slice(0, 4).join(", ")}${aiOps.neverUsed.length > 4 ? "…" : ""}. Code that costs maintenance and earns nothing.`,
      href: "/admin/product",
      tone: "watch",
    });
  }

  /* --------------------------------------------------------------------- money */

  const drift = await mrrReconciliation().catch(() => null);
  if (drift && !drift.agrees) {
    out.push({
      id: "mrr.drift",
      headline: "Revenue does not reconcile",
      detail: `The ledger and live subscription state disagree by ${formatCents(drift.driftCents)}. Almost always a dropped billing webhook.`,
      href: "/admin/billing",
      tone: "act",
    });
  }

  const infra = await monthlyInfraCents(new Date()).catch(() => 0);
  if (infra === 0) {
    out.push({
      id: "infra.missing",
      headline: "No infrastructure cost recorded for this month",
      detail:
        "Break-even is being computed against zero fixed cost, so it reads far better than it is.",
      href: "/admin/billing",
      tone: "act",
    });
  }

  const offer = await lifetimeOffer().catch(() => null);
  if (offer?.needsStandardPrice) {
    out.push({
      id: "lifetime.price",
      headline: "Lifetime is still selling at the introductory price",
      detail: `${offer.sold} sold, past the introductory allocation. Add STRIPE_LIFETIME_STANDARD_PRICE_ID to close it.`,
      href: "/admin/billing",
      tone: "act",
    });
  }

  /* ----------------------------------------------------------- data protection */

  const protection = await getDataProtection().catch(() => null);
  if (protection && protection.orphans.length > 0) {
    const total = protection.orphans.reduce((a, o) => a + o.rows, 0);
    out.push({
      id: "purge.orphans",
      headline: `${total} row${total === 1 ? "" : "s"} survived an account deletion`,
      detail: `In ${protection.orphans.map((o) => o.table).join(", ")}. Three tables have reached production unpurged so far.`,
      href: "/admin/health",
      tone: "act",
    });
  }

  if (protection && protection.denials.length > 0) {
    out.push({
      id: "admin.denied",
      headline: `${protection.denials.length} refused attempt${protection.denials.length === 1 ? "" : "s"} to reach this console`,
      detail:
        "The gate answered 404 and gave nothing away, but on a console with one operator a second name is worth reading.",
      href: "/admin/health",
      tone: "watch",
    });
  }

  // `act` first: the ordering is the opinion, since a list read top-down should surface
  // what is costing something now before what is merely worth knowing.
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "act" ? -1 : 1));
}
