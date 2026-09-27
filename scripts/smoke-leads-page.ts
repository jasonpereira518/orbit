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
import { Button } from "../src/components/ui/button";
import { APP_NAV_CORE, APP_NAV_EXTRAS, MOBILE_MORE_NAV } from "../src/components/layout/app-nav";
import { COMING_SOON_KEYS, isHrefComingSoon, surfaceKeyForHref } from "../src/lib/surfaces";
import { ComingSoon } from "../src/components/coming-soon/coming-soon";
import { LeadsHeader } from "../src/components/leads/leads-header";
import { AREA_LABELS, featureAreaForPath } from "../src/lib/feedback-report";
import type { CrmStatus } from "../src/lib/crm/types";

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

    function tsFilesRecursive(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...tsFilesRecursive(full));
        else if (/\.ts$/.test(entry.name)) out.push(full);
      }
      return out;
    }
    for (const file of tsFilesRecursive("src/lib/crm")) {
      const bytes = readFileSync(file);
      check(`${file} has no mis-encoded characters`, !/\xc3\xa2\xc2[\x80-\xbf]|\xc2[\x80-\x9f]/.test(bytes.toString("latin1")));
      check(`${file} uses curly apostrophes`, !/[A-Za-z]'[A-Za-z]/.test(code(file)));
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
    const view = (status: CrmStatus, pending: Parameters<typeof CrmCardView>[0]["pending"] = null) =>
      text(React.createElement(CrmCardView, { status, pending, onConnect: noop, onSync: noop, onDisconnect: noop }));
    const hubspotProvider: CrmStatus["providers"][number] = { id: "hubspot", label: "HubSpot", configured: true, connection: null, counts: null };
    const salesforceProvider: CrmStatus["providers"][number] = { id: "salesforce", label: "Salesforce", configured: true, connection: null, counts: null };
    const base: CrmStatus = { entitled: true, providers: [hubspotProvider, salesforceProvider] };
    const hubspotConn = {
      connectorId: "hubspot" as const,
      label: "acme.hubspot.com",
      status: "active" as const,
      syncing: false,
      lastSyncedAgo: "5 minutes ago",
      error: null,
      demo: false,
      paused: false,
      sandbox: false,
    };
    const salesforceConn = {
      connectorId: "salesforce" as const,
      label: "ada@acme.com",
      status: "active" as const,
      syncing: false,
      lastSyncedAgo: "10 minutes ago",
      error: null,
      demo: false,
      paused: false,
      sandbox: false,
    };

    const nothing = view(base);
    check(
      "nothing connected: pitch and both connect buttons",
      nothing.includes("Connect your CRM") &&
        nothing.includes("Connect HubSpot") &&
        nothing.includes("Connect Salesforce") &&
        nothing.includes("Use a sandbox"),
      nothing
    );

    const onlyHubspotConfigured = view({ entitled: true, providers: [hubspotProvider, { ...salesforceProvider, configured: false }] });
    check(
      "only HubSpot configured: Connect HubSpot present, Connect Salesforce absent, no missing-provider sentence",
      onlyHubspotConfigured.includes("Connect HubSpot") &&
        !onlyHubspotConfigured.includes("Connect Salesforce") &&
        !onlyHubspotConfigured.includes("Salesforce"),
      onlyHubspotConfigured
    );

    const neitherConfigured = view({
      entitled: true,
      providers: [
        { ...hubspotProvider, configured: false },
        { ...salesforceProvider, configured: false },
      ],
    });
    check(
      "neither configured: one sentence, no button",
      neitherConfigured.includes("isn’t set up on this server yet") &&
        !neitherConfigured.includes("Connect HubSpot") &&
        !neitherConfigured.includes("Connect Salesforce"),
      neitherConfigured
    );
    check(
      "neither configured: no provider named twice",
      (neitherConfigured.match(/HubSpot|Salesforce/g) ?? []).length <= 1,
      neitherConfigured
    );

    const notEntitled = view({ entitled: false, providers: [hubspotProvider, salesforceProvider] });
    check(
      "not entitled: the paywall, no connect buttons",
      notEntitled.includes("CRM sync is on Orbit Pro and Lifetime.") &&
        notEntitled.includes("See plans") &&
        !notEntitled.includes("Connect HubSpot") &&
        !notEntitled.includes("Connect Salesforce"),
      notEntitled
    );

    const hubspotOnly = view({
      entitled: true,
      providers: [
        { ...hubspotProvider, connection: hubspotConn, counts: { workContacts: 12, pipeline: 3, blocked: 0 } },
        salesforceProvider,
      ],
    });
    check(
      "HubSpot connected, Salesforce configured but not: HubSpot section, its counts, Sync now, and a Connect Salesforce row",
      hubspotOnly.includes("HubSpot · acme.hubspot.com") &&
        hubspotOnly.includes("12 work contacts") &&
        hubspotOnly.includes("Sync now") &&
        hubspotOnly.includes("Connect Salesforce") &&
        !hubspotOnly.includes("Connect your CRM"),
      hubspotOnly
    );

    const salesforceOnly = view({
      entitled: true,
      providers: [
        hubspotProvider,
        { ...salesforceProvider, connection: salesforceConn, counts: { workContacts: 4, pipeline: 1, blocked: 0 } },
      ],
    });
    check(
      "Salesforce connected: title and counts",
      salesforceOnly.includes("Salesforce · ada@acme.com") && salesforceOnly.includes("4 work contacts"),
      salesforceOnly
    );

    const salesforceReauth = view({
      entitled: true,
      providers: [
        hubspotProvider,
        {
          ...salesforceProvider,
          connection: { ...salesforceConn, status: "needs_reauth" as const, error: "Token endpoint returned 400" },
          counts: null,
        },
      ],
    });
    check(
      "Salesforce reauth: named reconnect sentence and button",
      salesforceReauth.includes("Salesforce needs you to reconnect") && salesforceReauth.includes("Reconnect Salesforce"),
      salesforceReauth
    );
    check("Salesforce reauth: never the stored error", !salesforceReauth.includes("Token endpoint returned 400"), salesforceReauth);

    const bothConnected: CrmStatus = {
      entitled: true,
      providers: [
        { ...hubspotProvider, connection: hubspotConn, counts: { workContacts: 12, pipeline: 3, blocked: 0 } },
        { ...salesforceProvider, connection: salesforceConn, counts: { workContacts: 4, pipeline: 1, blocked: 0 } },
      ],
    };
    const both = view(bothConnected);
    check(
      "both connected: both titles",
      both.includes("HubSpot · acme.hubspot.com") && both.includes("Salesforce · ada@acme.com"),
      both
    );
    check(
      "both connected: two Sync now, two Disconnect",
      (both.match(/Sync now/g) ?? []).length === 2 && (both.match(/Disconnect/g) ?? []).length === 2,
      both
    );

    const pendingText = view(bothConnected, { action: "sync", id: "salesforce" });
    check("pending: Syncing… appears once", (pendingText.match(/Syncing…/g) ?? []).length === 1, pendingText);
    const pendingHtml = renderToStaticMarkup(
      React.createElement(CrmCardView, {
        status: bothConnected,
        pending: { action: "sync", id: "salesforce" },
        onConnect: noop,
        onSync: noop,
        onDisconnect: noop,
      })
    );
    const buttonTags = pendingHtml.match(/<button[^>]*>/g) ?? [];
    check(
      "pending: every button is disabled",
      buttonTags.length > 0 && buttonTags.every((b) => b.includes('disabled=""')),
      buttonTags.join("\n")
    );

    // Every <Button> the card renders, with its props, by expanding the card's own (hook-free)
    // components by hand — so a check can see which handler a button would call.
    type ButtonProps = { disabled?: boolean; onClick?: () => void; children?: React.ReactNode; "aria-label"?: string };
    const buttonsOf = (node: React.ReactNode): ButtonProps[] => {
      if (Array.isArray(node)) return node.flatMap(buttonsOf);
      if (!React.isValidElement(node)) return [];
      const el = node as React.ReactElement<Record<string, unknown>>;
      if (el.type === Button) return [el.props as ButtonProps];
      if (typeof el.type === "function") return buttonsOf((el.type as (p: unknown) => React.ReactNode)(el.props));
      return buttonsOf(el.props.children as React.ReactNode);
    };
    const flat = (n: React.ReactNode): string =>
      Array.isArray(n) ? n.map(flat).join("") : typeof n === "string" || typeof n === "number" ? String(n) : React.isValidElement(n) ? flat((n.props as { children?: React.ReactNode }).children) : "";
    const cardButtons = (status: CrmStatus, onConnect: (id: string, opts?: { sandbox?: boolean }) => void = noop) =>
      buttonsOf(React.createElement(CrmCardView, { status, pending: null, onConnect, onSync: noop, onDisconnect: noop }));
    const named = (bs: ButtonProps[], name: string) => bs.filter((b) => b["aria-label"] === name);

    // F4: Salesforce syncing on its own leaves HubSpot's buttons free.
    const sfSyncing = cardButtons({
      entitled: true,
      providers: [
        { ...hubspotProvider, connection: hubspotConn, counts: { workContacts: 1, pipeline: 0, blocked: 0 } },
        { ...salesforceProvider, connection: { ...salesforceConn, syncing: true }, counts: { workContacts: 1, pipeline: 0, blocked: 0 } },
      ],
    });
    check(
      "Salesforce syncing: its own Sync now and Disconnect are disabled",
      named(sfSyncing, "Sync Salesforce now")[0]?.disabled === true && named(sfSyncing, "Disconnect Salesforce")[0]?.disabled === true,
      JSON.stringify(sfSyncing.map((b) => [b["aria-label"], b.disabled]))
    );
    check(
      "Salesforce syncing: HubSpot's Sync now and Disconnect stay enabled",
      named(sfSyncing, "Sync HubSpot now")[0]?.disabled === false && named(sfSyncing, "Disconnect HubSpot")[0]?.disabled === false,
      JSON.stringify(sfSyncing.map((b) => [b["aria-label"], b.disabled]))
    );

    // F5: accessible names contain the visible words, and name the provider where two repeat.
    const wordsIn = (b: ButtonProps) => {
      const visible = flat(b.children).trim().toLowerCase().split(/\s+/).filter(Boolean);
      const name = (b["aria-label"] ?? flat(b.children)).toLowerCase();
      return visible.every((w) => name.includes(w));
    };
    const bothButtons = cardButtons(bothConnected);
    check(
      "both connected: every button's accessible name contains its visible words",
      bothButtons.every(wordsIn),
      JSON.stringify(bothButtons.map((b) => [flat(b.children), b["aria-label"]]))
    );
    check(
      "both connected: per-provider names on the repeated buttons",
      ["Sync HubSpot now", "Sync Salesforce now", "Disconnect HubSpot", "Disconnect Salesforce"].every((n) => named(bothButtons, n).length === 1),
      JSON.stringify(bothButtons.map((b) => b["aria-label"]))
    );
    const connectButtons = cardButtons(base);
    const useSandbox = connectButtons.find((b) => flat(b.children) === "Use a sandbox");
    check("Use a sandbox: its accessible name contains its visible text", Boolean(useSandbox) && wordsIn(useSandbox!), JSON.stringify(useSandbox?.["aria-label"]));

    // F5: a sandbox connection reconnects to the sandbox; the secondary offers production.
    for (const [state, conn] of [
      ["needs reauth", { ...salesforceConn, status: "needs_reauth" as const }],
      ["paused", { ...salesforceConn, paused: true, error: "Salesforce stopped" }],
    ] as const) {
      const calls: Array<{ sandbox?: boolean } | undefined> = [];
      const record = (_id: string, opts?: { sandbox?: boolean }) => calls.push(opts);
      const status = (sandbox: boolean): CrmStatus => ({
        entitled: true,
        providers: [hubspotProvider, { ...salesforceProvider, connection: { ...conn, sandbox }, counts: null }],
      });
      const sb = cardButtons(status(true), record);
      const primary = sb.find((b) => flat(b.children) === "Reconnect Salesforce");
      const other = sb.find((b) => flat(b.children) === "Reconnect production");
      primary?.onClick?.();
      other?.onClick?.();
      check(
        `sandbox ${state}: Reconnect Salesforce goes to the sandbox, Reconnect production does not`,
        Boolean(primary && other) && calls[0]?.sandbox === true && calls[1]?.sandbox !== true && !sb.some((b) => flat(b.children) === "Reconnect a sandbox"),
        JSON.stringify(calls)
      );
      calls.length = 0;
      const prod = cardButtons(status(false), record);
      prod.find((b) => flat(b.children) === "Reconnect Salesforce")?.onClick?.();
      prod.find((b) => flat(b.children) === "Reconnect a sandbox")?.onClick?.();
      check(
        `production ${state}: Reconnect Salesforce goes to production, Reconnect a sandbox to the sandbox`,
        calls.length === 2 && calls[0]?.sandbox !== true && calls[1]?.sandbox === true,
        JSON.stringify(calls)
      );
    }

    const erred = view({
      entitled: true,
      providers: [
        {
          ...hubspotProvider,
          connection: { ...hubspotConn, error: "HubSpot is rate-limiting this account — the next sync picks up where this one stopped" },
          counts: { workContacts: 1, pipeline: 0, blocked: 2 },
        },
        salesforceProvider,
      ],
    });
    check(
      "an error and the cap are shown",
      erred.includes("rate-limiting") && erred.includes("2 customers didn’t fit your plan’s contact limit"),
      erred
    );

    const demo = view({
      entitled: true,
      providers: [
        { ...hubspotProvider, connection: { ...hubspotConn, demo: true }, counts: { workContacts: 4, pipeline: 2, blocked: 0 } },
        salesforceProvider,
      ],
    });
    check("demo: sample data, no sync", demo.includes("Sample data") && !demo.includes("Sync now"), demo);

    check(
      "one work contact is singular",
      view({
        entitled: true,
        providers: [{ ...hubspotProvider, connection: hubspotConn, counts: { workContacts: 1, pipeline: 1, blocked: 0 } }, salesforceProvider],
      }).includes("1 work contact ·")
    );
  }

  console.log("\nthe CRM card component calls the right actions and never leaks provider text");
  {
    const cardSource = code("src/components/leads/crm-card.tsx");
    check("connects with sandbox passed through", /startCrmConnectAction\(\s*id\s*,\s*\{\s*sandbox:/.test(cardSource), cardSource);
    check("syncs by id", /syncCrmNowAction\(\s*id\s*\)/.test(cardSource), cardSource);
    check("disconnects by id", /disconnectCrmAction\(\s*id\s*\)/.test(cardSource), cardSource);
    // The dialog fades out after `confirming` clears; its title must not read "Disconnect ?".
    check(
      "the dialog's label is not derived from the id cleared on close",
      /confirmingLabel\s*=\s*shownId\b/.test(cardSource) && !/confirmingLabel\s*=\s*confirming\b/.test(cardSource),
      cardSource.match(/confirmingLabel\s*=.*$/m)?.[0] ?? ""
    );
    const needsReauthBranch = cardSource.slice(
      cardSource.indexOf('"needs_reauth"'),
      cardSource.indexOf("else", cardSource.indexOf('"needs_reauth"'))
    );
    check(
      "needs_reauth toast is a fixed sentence, never the server's message",
      needsReauthBranch.includes("needs you to reconnect — use Reconnect, then sync") && !needsReauthBranch.includes("r.message ?? "),
      needsReauthBranch
    );
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
