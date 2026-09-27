/**
 * Pins the guards that stop Orbit emailing people who do not exist (audit A7).
 *
 * Without an Apollo key, `searchPeople` invents sample prospects. They used to get the
 * model-guessed REAL company domain (alex.chen@capitalone.com), were stored pre-selected,
 * and nothing on the send paths looked at `enrichment.demo`. Runs the real server actions
 * as demo mode's `demo-user`, like smoke-follow-up-actions.
 *
 * Run: npx tsx scripts/smoke-outreach-guards.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { outreachCampaigns, outreachMessages, outreachProspects, userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  DEMO_PROSPECT_SEND_MESSAGE,
  PLACEHOLDER_ADDRESS_SEND_MESSAGE,
  isPlaceholderAddress,
  prospectSearchStatus,
} from "../src/lib/outreach-quality";
import { sendOutreachMessage, getOutreachSendConfig } from "../src/lib/outreach-send";
import { bulkSendOutreach, previewBulkSendQuality, searchProspects, sendOutreachMessageAction } from "../src/actions/outreach";
import type { AudienceFilters } from "../src/db/schema";

// FIRST, so no run of this script — including the failing one — can reach a real inbox:
// with no key anywhere, a send that slips past a guard fails on "not configured".
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.APOLLO_API_KEY; // forces the demo prospect search
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "demo-user";
const OTHER = "smoke-outreach-other-tenant";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** `revalidatePath` throws outside a request, after the action's writes have landed. */
async function outsideRequest<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store")) return undefined;
    throw err;
  }
}

async function cleanup() {
  const db = await getDb();
  // Prospects and messages cascade from the campaign.
  await db.delete(outreachCampaigns).where(inArray(outreachCampaigns.userId, [USER, OTHER]));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, OTHER]));
}

async function seedCampaign(userId: string, name: string, filters: AudienceFilters) {
  const db = await getDb();
  const [campaign] = await db
    .insert(outreachCampaigns)
    .values({ userId, name, audienceQuery: "recruiters at Capital One", audienceFilters: filters, status: "active" })
    .returning();
  return campaign;
}

async function seedProspectWithMessage(
  campaignId: string,
  p: { externalId: string; fullName: string; email: string; status: string; enrichment: Record<string, unknown>; subject?: string; body?: string }
) {
  const db = await getDb();
  const first = p.fullName.split(" ")[0];
  const [prospect] = await db
    .insert(outreachProspects)
    .values({ campaignId, externalId: p.externalId, fullName: p.fullName, email: p.email, status: p.status, enrichment: p.enrichment })
    .returning();
  const [message] = await db
    .insert(outreachMessages)
    .values({
      prospectId: prospect.id,
      channel: "email",
      subject: p.subject ?? `Quick question, ${first}`,
      body: p.body ?? `Hi ${first}, I saw your work on the platform team and wanted to ask how you hire for it.`,
      status: "generated",
    })
    .returning();
  return { prospect, message };
}

run(async () => {
  await cleanup();
  await ensureUserSettings(USER);
  const db = await getDb();

  console.log("Sample search results are never pre-selected, and never at a real domain");
  const campaign = await seedCampaign(USER, "Smoke guards", {
    organizationNames: ["Capital One"],
    organizationDomains: ["capitalone.com"],
  });
  await outsideRequest(searchProspects(campaign.id));
  const found = await db.query.outreachProspects.findMany({ where: eq(outreachProspects.campaignId, campaign.id) });
  check("the sample search produced prospects", found.length > 0, String(found.length));
  check("none is selected", found.every((p) => p.status !== "selected"), found.map((p) => p.status).join(","));
  check("every one is marked demo", found.every((p) => (p.enrichment as { demo?: unknown } | null)?.demo === true));
  check(
    "every address is at a reserved example domain",
    found.every((p) => !p.email || isPlaceholderAddress(p.email)),
    found.map((p) => p.email).join(",")
  );
  check("prospectSearchStatus: a matching sample is suggested", prospectSearchStatus({ matchesOrg: true, isDemo: true }) === "suggested");
  check("prospectSearchStatus: a matching real prospect is selected", prospectSearchStatus({ matchesOrg: true, isDemo: false }) === "selected");
  check("prospectSearchStatus: a company mismatch is excluded", prospectSearchStatus({ matchesOrg: false, isDemo: false }) === "excluded");
  check("isPlaceholderAddress: a real domain is not a placeholder", !isPlaceholderAddress("jordan@capitalone.com"));
  check("isPlaceholderAddress: .test and example.org are", isPlaceholderAddress("a@b.test") && isPlaceholderAddress("a@example.org"));

  console.log("\nA sample prospect cannot be emailed, one at a time or in bulk");
  // The exact shape already in production: demo, selected, at a real company domain.
  const legacy = await seedProspectWithMessage(campaign.id, {
    externalId: "demo-legacy-1",
    fullName: "Alex Chen",
    email: "alex.chen@capitalone.com",
    status: "selected",
    enrichment: { demo: true },
  });
  const single = await sendOutreachMessageAction(legacy.message.id).catch((err: unknown) => ({
    ok: false as const,
    error: `threw: ${String(err)}`,
  }));
  check(
    "the single send refuses with the sample-prospect copy",
    single.ok === false && single.error === DEMO_PROSPECT_SEND_MESSAGE,
    JSON.stringify(single)
  );
  const afterSingle = await db.query.outreachMessages.findFirst({ where: eq(outreachMessages.id, legacy.message.id) });
  check("…and leaves the draft untouched (not sent, not failed)", afterSingle?.status === "generated", String(afterSingle?.status));
  const bulk = await outsideRequest(
    bulkSendOutreach({ campaignId: campaign.id, messageIds: [legacy.message.id], ignoreWarnings: true })
  );
  check(
    "the bulk send is blocked with the same reason",
    bulk?.status === "blocked" && bulk.reason.includes(DEMO_PROSPECT_SEND_MESSAGE),
    JSON.stringify(bulk)
  );

  console.log("\nA placeholder address is refused below the actions too");
  const direct = await sendOutreachMessage({
    userId: USER,
    channel: "email",
    toEmail: "someone@acme.example.com",
    subject: "Hi",
    body: "Hello",
  }).then(
    () => "sent",
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
  check("sendOutreachMessage refuses an example.com address", direct === PLACEHOLDER_ADDRESS_SEND_MESSAGE, direct);

  console.log("\nThe bulk-send preview only reads this campaign's messages");
  await ensureUserSettings(OTHER);
  const victimCampaign = await seedCampaign(OTHER, "Someone else's campaign", {});
  // Empty subject and body: had the preview read this row, it would come back blocking.
  const victim = await seedProspectWithMessage(victimCampaign.id, {
    externalId: "victim-1",
    fullName: "Victoria Private",
    email: "victoria@private.example.com",
    status: "selected",
    enrichment: {},
    subject: "",
    body: "",
  });
  const leaked = await previewBulkSendQuality({ campaignId: campaign.id, messageIds: [victim.message.id] });
  check("another tenant's message id yields nothing", leaked.issues.length === 0, JSON.stringify(leaked));
  check("…and never names their prospect", !JSON.stringify(leaked).includes("Victoria"));

  const sibling = await seedCampaign(USER, "Sibling campaign", {});
  const siblingMsg = await seedProspectWithMessage(sibling.id, {
    externalId: "sibling-1",
    fullName: "Sam Sibling",
    email: "sam@sibling.example.com",
    status: "selected",
    enrichment: {},
    subject: "",
    body: "",
  });
  const scoped = await previewBulkSendQuality({ campaignId: campaign.id, messageIds: [siblingMsg.message.id] });
  check("a message from another of your own campaigns is out of scope too", scoped.issues.length === 0, JSON.stringify(scoped));
  // A sendable draft (passes quality) in the sibling campaign: if the bulk loop reached it,
  // its send would be refused (placeholder address) and mark it "failed".
  const sendable = await seedProspectWithMessage(sibling.id, {
    externalId: "sibling-2",
    fullName: "Sasha Sibling",
    email: "sasha@sibling.example.org",
    status: "selected",
    enrichment: {},
  });
  await outsideRequest(
    bulkSendOutreach({ campaignId: campaign.id, messageIds: [sendable.message.id], ignoreWarnings: true })
  );
  const sendableAfter = await db.query.outreachMessages.findFirst({ where: eq(outreachMessages.id, sendable.message.id) });
  check("…and bulk send under this campaign never touches it", sendableAfter?.status === "generated", String(sendableAfter?.status));

  console.log("\nReplies go to the sender");
  await db.update(userSettings).set({ email: "demo.sender@orbit.example.com" }).where(eq(userSettings.userId, USER));
  const config = await getOutreachSendConfig(USER);
  check("the send config carries the sender's email as replyTo", config.replyTo === "demo.sender@orbit.example.com", String(config.replyTo));

  await cleanup();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach guard checks passed.");
});
