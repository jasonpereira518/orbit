/**
 * The Leads tab while it is coming soon: registered, reachable, and honest about its state.
 *
 * Pins the wiring a placeholder page can silently lose. A nav item without a surface key
 * cannot be hidden; a surface without a nav item is unreachable on mobile; a coming-soon
 * page without a `FEATURES` entry renders the generic fallback and stops promising anything;
 * a route without a feedback area files reports under "Something else". Each of those is a
 * one-line omission that no type checks, so each gets a check here.
 *
 * Structural rule, shared with the events page: the header is rendered by BOTH page.tsx and
 * loading.tsx so the streaming handoff shows identical pixels, which only works if it never
 * fetches.
 */
import React from "react";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { WarmPath } from "../src/lib/leads/warm-path";
import { WarmthChip } from "../src/components/leads/warmth-chip";
import { PathSummary } from "../src/components/leads/path-summary";
import { SharingDl } from "../src/components/leads/sharing-dl";
import { CrmCardView } from "../src/components/leads/crm-card-view";
import { APP_NAV_CORE, APP_NAV_EXTRAS, MOBILE_MORE_NAV } from "../src/components/layout/app-nav";
import { COMING_SOON_KEYS, isHrefComingSoon, surfaceKeyForHref } from "../src/lib/surfaces";
import { ComingSoon } from "../src/components/coming-soon/coming-soon";
import { LeadsHeader } from "../src/components/leads/leads-header";
import { AREA_LABELS, featureAreaForPath } from "../src/lib/feedback-report";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A module with its comments stripped, so prose describing a rule cannot trip the rule. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function text(el: React.ReactElement): string {
  return renderToStaticMarkup(el)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence `ComingSoon` falls back to when a surface has no `FEATURES` entry. */
const FALLBACK_TEASER = "We're still building this part of Orbit";

/**
 * Client components under src/components/leads. Each task that adds one appends its file here,
 * so a missing file or a lost "use client" is a failed check, not a silent build surprise.
 */
const CLIENT_COMPONENTS: string[] = [
  "join-team-card.tsx",
  "team-card.tsx",
  "find-path.tsx",
  "leads-pipeline.tsx",
  "lead-detail-sheet.tsx",
  "apollo-search.tsx",
  "crm-card.tsx",
];

function main() {
  console.log("\nnav and surface registration");
  {
    const hrefs = [...APP_NAV_CORE, ...APP_NAV_EXTRAS].map((i) => i.href);
    check("/leads is in the sidebar", hrefs.includes("/leads"), hrefs.join(" "));
    // Without this the page is unreachable on mobile.
    check("/leads is in the mobile More menu", MOBILE_MORE_NAV.some((i) => i.href === "/leads"));
    // An exact-href match, or the nav cannot hide it and smoke-surface-visibility fails.
    check(
      "/leads maps to its surface key",
      surfaceKeyForHref("/leads") === "page.leads",
      String(surfaceKeyForHref("/leads"))
    );
    check("page.leads is coming soon", COMING_SOON_KEYS.has("page.leads"));
    check("so the nav item carries the Soon tag", isHrefComingSoon("/leads"));
  }

  console.log("\nthe coming-soon screen promises the feature, not the fallback");
  {
    const screen = text(React.createElement(ComingSoon, { surfaceKey: "page.leads", label: "Leads" }));
    check("names the page", screen.includes("Leads"), screen);
    check("says coming soon", /coming soon/i.test(screen), screen);
    // A missing FEATURES entry degrades to a sentence that could be about anything.
    check("has its own teaser", !screen.includes(FALLBACK_TEASER), screen);
    check("mentions the team", /team/i.test(screen), screen);
  }

  console.log("\nfeedback filed from /leads lands in its own area");
  {
    check("/leads has a feedback area", featureAreaForPath("/leads") === "leads", featureAreaForPath("/leads"));
    check("and so do its children", featureAreaForPath("/leads/anything") === "leads");
    check("with a label for the picker", AREA_LABELS.leads === "Leads", String(AREA_LABELS.leads));
  }

  console.log("\nwhat the page shows about a path");
  {
    const path: WarmPath = {
      warmth: "hot",
      direct: [{ teammate: { userId: "u1", name: "Alex Ng", email: "alex@acme.test" }, tier: "inner", matchedOn: "email" }],
      account: [{ teammate: { userId: "u2", name: "Priya Nair", email: "priya@acme.test" }, count: 2, bestTier: "mid" }],
    };
    const full = text(React.createElement(PathSummary, { path, companyName: "Northwind" }));
    check("names the teammate and the orbit", full.includes("Alex Ng") && full.includes("Inner orbit"), full);
    check("says how they matched", full.includes("via email"), full);
    check("says how many others they know at the company", full.includes("knows 2 others at Northwind"), full);
    check("never shows a teammate's email", !full.includes("@acme.test"), full);
    const compact = text(React.createElement(PathSummary, { path, companyName: "Northwind", compact: true }));
    check("the compact line fits a row", compact.includes("Alex (inner)") && compact.includes("Northwind via Priya"), compact);
    check("and hides emails too", !compact.includes("@acme.test"), compact);
    const nobody = text(React.createElement(PathSummary, { path: { warmth: "cold", direct: [], account: [] }, companyName: null }));
    check("an empty path says so", /nobody on your team/i.test(nobody), nobody);
    for (const warmth of ["hot", "warm", "cool", "cold"] as const) {
      check(`a ${warmth} chip has a label`, text(React.createElement(WarmthChip, { warmth })).length > 3);
    }
    const dl = text(React.createElement(SharingDl));
    check("the sharing list names both sides", dl.includes("Shared while you share") && dl.includes("Never shared"), dl);
    check("it names every fact a lookup reveals", dl.includes("by email, LinkedIn, phone or X") && dl.includes("how close the closest of them is"), dl);
  }

  console.log("\nthe leads components stay client-safe");
  {
    const dir = "src/components/leads";
    const serverOnly =
      /import\s+(?!type\b)[^;]*from\s+["'](@\/db(\/[^"']*)?|@\/lib\/teams|@\/lib\/leads\/(store|pipeline|warm-path-query)|@\/lib\/apollo|@\/lib\/crm\/(manage|records|persist|connect|hubspot\/(api|sync))|@\/lib\/connectors\/(connections|token|syncs))["']/;
    for (const file of readdirSync(dir).filter((f) => /\.(tsx?)$/.test(f))) {
      check(`${file} never value-imports a server module`, !serverOnly.test(code(`${dir}/${file}`)));
      const bytes = readFileSync(`${dir}/${file}`);
      check(`${file} has no mis-encoded characters`, !/\xc3\xa2\xc2[\x80-\xbf]|\xc2[\x80-\x9f]/.test(bytes.toString("latin1")));
      check(`${file} uses curly apostrophes`, !/[A-Za-z]'[A-Za-z]/.test(code(`${dir}/${file}`)));
    }
    for (const file of CLIENT_COMPONENTS) {
      const path = `${dir}/${file}`;
      check(`${file} exists and is a client component`, existsSync(path) && /^\s*"use client";/.test(readFileSync(path, "utf8")));
    }

    for (const crmDir of ["src/lib/crm", "src/lib/crm/hubspot"]) {
      for (const file of readdirSync(crmDir).filter((f) => /\.ts$/.test(f))) {
        const bytes = readFileSync(`${crmDir}/${file}`);
        check(`${file} has no mis-encoded characters`, !/\xc3\xa2\xc2[\x80-\xbf]|\xc2[\x80-\x9f]/.test(bytes.toString("latin1")));
        check(`${file} uses curly apostrophes`, !/[A-Za-z]'[A-Za-z]/.test(code(`${crmDir}/${file}`)));
      }
    }
  }

  console.log("\nthe contact page's team pill");
  {
    const button = "src/components/contacts/team-share-button.tsx";
    check("the pill is a client component", existsSync(button) && /^\s*"use client";/.test(readFileSync(button, "utf8")));
    const buttonBytes = readFileSync(button);
    check(
      "team-share-button.tsx has no mis-encoded characters",
      !/\xc3\xa2\xc2[\x80-\xbf]|\xc2[\x80-\x9f]/.test(buttonBytes.toString("latin1"))
    );
    check("team-share-button.tsx uses curly apostrophes", !/[A-Za-z]'[A-Za-z]/.test(code(button)));
    check("the stat pills render it only when given a team", /team\s*&&\s*\(?\s*<TeamShareButton/.test(code("src/components/contacts/contact-stat-pills.tsx")));
    const contactPage = code("src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx");
    // A control for a closed feature is worse than none: the pill follows Leads' release.
    check("the contact page shows it only while Leads is released", contactPage.includes('isSurfaceReleased(u, "page.leads")'));
    check("and only to a team member", contactPage.includes("getViewerTeam("));
  }

  console.log("\nthe CRM card says the right thing in every state");
  {
    const noop = () => {};
    const view = (status: Parameters<typeof CrmCardView>[0]["status"]) =>
      text(React.createElement(CrmCardView, { status, pending: null, onConnect: noop, onSync: noop, onDisconnect: noop }));
    const base = { entitled: true, configured: true, connection: null, counts: null };
    const conn = { connectorId: "hubspot" as const, label: "acme.hubspot.com", status: "active" as const, syncing: false, lastSyncedAgo: "5 minutes ago", error: null, demo: false, paused: false };

    const locked = view({ ...base, entitled: false });
    check("free: the paywall, not a connect button", locked.includes("HubSpot sync is on Orbit Pro and Lifetime") && locked.includes("See plans") && !locked.includes("Connect HubSpot"), locked);
    const unset = view({ ...base, configured: false });
    check("unconfigured: says so, no button", unset.includes("isn’t set up on this server yet") && !unset.includes("Connect HubSpot"), unset);
    const ready = view(base);
    check("ready: the pitch and the button", ready.includes("Connect your CRM") && ready.includes("work contacts") && ready.includes("Connect HubSpot"), ready);
    const live = view({ ...base, connection: conn, counts: { workContacts: 12, pipeline: 3, blocked: 0 } });
    check("connected: account, last sync, counts", live.includes("HubSpot · acme.hubspot.com") && live.includes("Last synced 5 minutes ago") && live.includes("12 work contacts") && live.includes("3 in your pipeline"), live);
    check("connected: sync and disconnect", live.includes("Sync now") && live.includes("Disconnect") && live.includes("See work contacts"), live);
    check("healthy: no reconnect offered", !live.includes("Reconnect HubSpot"), live);
    const paused = view({
      ...base,
      connection: { ...conn, paused: true, error: "HubSpot says this connection can’t read contacts or owners — reconnect HubSpot and approve every permission" },
      counts: { workContacts: 2, pipeline: 1, blocked: 0 },
    });
    check("paused: offers Reconnect before Sync now", paused.includes("Reconnect HubSpot") && paused.indexOf("Reconnect HubSpot") < paused.indexOf("Sync now"), paused);
    const pausedUnpaid = view({ ...base, entitled: false, connection: { ...conn, paused: true, error: "HubSpot sync is on Orbit Pro and Lifetime — upgrade to keep it running" }, counts: null });
    check("paused and not entitled: no Reconnect", !pausedUnpaid.includes("Reconnect HubSpot"), pausedUnpaid);
    const first = view({ ...base, connection: { ...conn, lastSyncedAgo: null }, counts: { workContacts: 0, pipeline: 0, blocked: 0 } });
    check("never synced: when it will", first.includes("The first sync starts within a few minutes"), first);
    const running = view({ ...base, connection: { ...conn, syncing: true }, counts: { workContacts: 0, pipeline: 0, blocked: 0 } });
    check("syncing: says so", running.includes("Syncing now"), running);
    const runningHtml = renderToStaticMarkup(
      React.createElement(CrmCardView, {
        status: { ...base, connection: { ...conn, syncing: true }, counts: { workContacts: 0, pipeline: 0, blocked: 0 } },
        pending: null,
        onConnect: noop,
        onSync: noop,
        onDisconnect: noop,
      })
    );
    const disconnectButton = runningHtml.match(/<button[^>]*>Disconnect<\/button>/);
    check(
      "while syncing, the Disconnect button is disabled",
      disconnectButton !== null && disconnectButton[0].includes('disabled=""'),
      disconnectButton?.[0] ?? runningHtml
    );
    const erred = view({ ...base, connection: { ...conn, error: "HubSpot is rate-limiting this account — the next sync picks up where this one stopped" }, counts: { workContacts: 1, pipeline: 0, blocked: 2 } });
    check("an error and the cap are shown", erred.includes("rate-limiting") && erred.includes("2 customers didn’t fit your plan’s contact limit"), erred);
    const reauth = view({ ...base, connection: { ...conn, status: "needs_reauth", error: "Token endpoint returned 400" }, counts: null });
    check("needs reauth: reconnect, not sync", reauth.includes("HubSpot needs you to reconnect") && reauth.includes("Reconnect HubSpot") && !reauth.includes("Sync now"), reauth);
    check("needs reauth: the fixed body", reauth.includes("HubSpot stopped accepting Orbit’s sign-in — reconnect to keep syncing"), reauth);
    check("needs reauth: never the stored error", !reauth.includes("Token endpoint returned 400"), reauth);
    const demo = view({ ...base, connection: { ...conn, demo: true }, counts: { workContacts: 4, pipeline: 2, blocked: 0 } });
    check("demo: sample data, no sync", demo.includes("Sample data") && !demo.includes("Sync now"), demo);
    check("one work contact is singular", view({ ...base, connection: conn, counts: { workContacts: 1, pipeline: 1, blocked: 0 } }).includes("1 work contact ·"));
  }

  console.log("\nthe CRM actions are thin, gated shells");
  {
    const actions = code("src/actions/crm.ts");
    const exports = [...actions.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*([^;]*;)/g)];
    check("four actions", exports.length === 4, exports.map((m) => m[1]).join(","));
    check("each starts with requireLeadsUser", exports.every((m) => m[2].trim() === "const userId = await requireLeadsUser();"), exports.map((m) => m[2]).join(" | "));
    check("no other kind of export", !/export\s+(const|type|let|function\s)/.test(actions.replace(/export\s+async\s+function/g, "")));
    check("disconnect never checks the plan", !/disconnectCrmAction[\s\S]*?requireCrm\(/.test(actions.slice(actions.indexOf("disconnectCrmAction"))));
  }

  console.log("\nstructure");
  {
    const headerSource = code("src/components/leads/leads-header.tsx");
    check(
      "the shared header does not fetch",
      !headerSource.includes("await") && !headerSource.includes("@/actions")
    );
    check("and it renders standalone, with no props", text(React.createElement(LeadsHeader)).includes("Leads"));

    const page = code("src/app/(clerk)/(app)/(main)/leads/page.tsx");
    const gateAt = page.indexOf("pageVisibilityGate(");
    const firstAwait = page.indexOf("await ");
    // The gate must be the first thing the page awaits: a click from a sibling route skips
    // the layout-level check, and any fetch before the gate runs for a closed page.
    check("the page gates before it does anything else", gateAt > 0 && page.indexOf("await ", gateAt - 6) === firstAwait);
    check("loading.tsx renders the same header", code("src/app/(clerk)/(app)/(main)/leads/loading.tsx").includes("LeadsHeader"));

    const exportAt = page.indexOf("export default async function LeadsPage");
    for (const section of ["TeamSection", "PipelineSection", "CrmSection"]) {
      const at = page.indexOf(`async function ${section}`);
      // A section above the export would put its `await` before the gate's in the file.
      check(`${section} is declared below the page`, at > exportAt && exportAt >= 0);
    }
    check("the page renders the four parts", ["<TeamSection", "<FindPath", "<PipelineSection", "<ApolloSearch", "<CrmSection"].every((part) => page.includes(part)));
    const loading = code("src/app/(clerk)/(app)/(main)/leads/loading.tsx");
    check("loading.tsx mirrors the page", ["TeamPanelSkeleton", "FindPath", "LeadsPipelineSkeleton", "ApolloSearch", "CrmCardSkeleton"].every((part) => loading.includes(part)));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll leads page checks passed.");
}

main();
