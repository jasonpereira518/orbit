/**
 * The demo workspace: exactly the listed email is one, its integrations read as connected
 * without a single grant being stored, anything the account really set up keeps its true
 * status line, and the seed script refuses every other account.
 *
 * Run: npx tsx scripts/smoke-demo-workspace.ts
 */
import "./smoke/_env";

import { spawnSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, imports, outlookConnections, userSettings } from "../src/db/schema";
import type { IntegrationStatuses } from "../src/actions/integrations";
import { DEMO_WORKSPACE_EMAILS, isDemoWorkspace, isDemoWorkspaceEmail } from "../src/lib/demo-workspace";
import {
  demoGmailConnectionStatus,
  demoOutlookConnectionStatus,
  withDemoIntegrationStatuses,
} from "../src/lib/demo-workspace-connections";
import { recordDemoDriveImport, recordDemoRecruiterScan } from "../src/lib/demo-workspace-actions";
import { connectionSummary } from "../src/lib/connection-status";

const DEMO = "smoke-demo-workspace";
const OTHER = "smoke-demo-workspace-other";
const DEMO_EMAIL = DEMO_WORKSPACE_EMAILS[0];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  await db.delete(imports).where(inArray(imports.userId, [DEMO, OTHER]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [DEMO, OTHER]));
}

async function main() {
  console.log("Demo workspace smoke test (pglite)…");

  console.log("\nwho is the demo workspace");
  check("the listed address is", isDemoWorkspaceEmail(DEMO_EMAIL));
  check("case and whitespace do not matter", isDemoWorkspaceEmail(`  ${DEMO_EMAIL.toUpperCase()} `));
  check("a lookalike is not", !isDemoWorkspaceEmail(DEMO_EMAIL.replace("@", "+x@")));
  check("another domain is not", !isDemoWorkspaceEmail(DEMO_EMAIL.replace("gmail.com", "gmail.co")));
  check("no email is not", !isDemoWorkspaceEmail(null) && !isDemoWorkspaceEmail(""));

  const db = await getDb();
  await cleanup();
  await db.insert(userSettings).values([
    { userId: DEMO, email: DEMO_EMAIL },
    { userId: OTHER, email: "someone.else@example.com" },
  ]);
  check("the account with that email is", await isDemoWorkspace(DEMO));
  check("an account with another email is not", !(await isDemoWorkspace(OTHER)));

  console.log("\nconnections read as connected");
  const gmail = demoGmailConnectionStatus(DEMO_EMAIL);
  check("Gmail is connected and healthy", gmail.connected && gmail.status === "active" && gmail.configured);
  check("…as the account's own address", gmail.emailAddress === DEMO_EMAIL);
  check("…with every feature allowed", gmail.canRead && gmail.canSend && gmail.canImportContacts && gmail.hasCalendarScope && gmail.canImportDrive);
  check("…synced recently, next sync ahead", Date.parse(gmail.lastSyncedAt!) < Date.now() && Date.parse(gmail.nextSyncAt!) > Date.now());
  check("the Integrations card says Connected", connectionSummary(gmail).detail === "Connected");
  const outlook = demoOutlookConnectionStatus(DEMO_EMAIL);
  check("Outlook is connected with every scope", outlook.connected && outlook.hasContactsScope && outlook.hasCalendarScope && outlook.hasMailScope);

  const real: IntegrationStatuses = {
    ai: { state: "on", detail: "Anthropic key saved" },
    api: { state: "on", detail: "3 keys" },
    webhooks: { state: "off", detail: "None" },
    google: { state: "off", detail: "Not connected" },
    outlook: "unknown",
  };
  const lifted = withDemoIntegrationStatuses(real);
  const every = ["google", "gmail", "outlook", "linkedin", "outreach", "apollo", "webhooks", "calendar", "calendar_ics", "luma", "eventbrite", "api", "zapier"] as const;
  const off = every.filter((k) => {
    const s = lifted[k];
    return !s || s === "unknown" || s.state !== "on";
  });
  check("every integration reads on", off.length === 0, off.join(", "));
  check("a real status keeps its own line", lifted.api !== "unknown" && lifted.api?.detail === "3 keys");
  check("the AI key line is untouched", lifted.ai !== "unknown" && lifted.ai?.detail === "Anthropic key saved");

  console.log("\nprovider actions record an outcome instead of calling out");
  const scanId = await recordDemoRecruiterScan(DEMO, "gmail_recruiter_scan", DEMO_EMAIL);
  const scan = await db.query.imports.findFirst({ where: eq(imports.id, scanId) });
  check("a scan finishes at once", scan?.status === "completed" && scan.userId === DEMO);
  const drive = await recordDemoDriveImport(DEMO, [{ name: "Notes" }, { name: "Deck" }]);
  check("a Drive import finishes with the picked files", drive.totalRows === 2);
  const gmailRows = await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, DEMO) });
  const outlookRows = await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, DEMO) });
  check("no grant is ever stored", !gmailRows && !outlookRows);

  console.log("\nthe seed script only touches the demo workspace");
  const refused = spawnSync("npx", ["tsx", "scripts/seed-demo-workspace.ts", "--email", "someone.else@example.com"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });
  check("another email is refused", refused.status === 1 && /not a demo-workspace account/.test(refused.stderr), refused.stderr.slice(0, 300));
  const unconfirmed = spawnSync("npx", ["tsx", "scripts/seed-demo-workspace.ts", "--email", DEMO_EMAIL], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://nobody@localhost:1/none" },
  });
  check("a remote database needs --confirm", unconfirmed.status === 1 && /--confirm/.test(unconfirmed.stderr), unconfirmed.stderr.slice(0, 300));

  await cleanup();
  if (failures > 0) {
    console.error(`\n${failures} demo workspace check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll demo workspace checks passed.");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("\nFAILED:", e);
  await cleanup().catch(() => null);
  process.exit(1);
});
