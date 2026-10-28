/**
 * Pins the guards that stop Outreach emailing people who do not exist (audit A7), on the
 * paths that send today:
 *
 *   - while `page.outreach` is coming soon, every Outreach server action refuses, run as demo
 *     mode's `demo-user` (like smoke-follow-up-actions) — new actions are covered by being
 *     exported, not by being listed here;
 *   - a demo prospect (`enrichment.demo`) never sends, even at a real-looking address;
 *   - a placeholder address (example.com, .test, .invalid…) stays a draft.
 *
 * The sends go to a fake mailbox; nothing leaves the machine.
 * Run: npx tsx scripts/smoke-outreach-guards.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import "../src/lib/email/origin-registrations";
import { setProviderOverride } from "../src/lib/email/providers";
import type { MailProvider } from "../src/lib/email/providers/types";
import { isSurfaceHiddenError, setSurfaceComingSoon } from "../src/lib/surface-visibility";
import { draftCampaignMessagesForUser, sendCampaignMessagesForUser, type Drafter } from "../src/lib/outreach-messages";
import { addProspectsForUser } from "../src/lib/outreach-people";
import { DEMO_PROSPECT_SEND_MESSAGE, isPlaceholderAddress } from "../src/lib/outreach-quality";
import { purgeUserData } from "../src/lib/user-data";
import * as peopleActions from "../src/actions/outreach-people";
import * as messageActions from "../src/actions/outreach-messages";
import { createCampaign, logMessageOutcome, updateCampaign } from "../src/actions/outreach";

// Demo mode: the actions run as `demo-user` with no Clerk.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
process.env.ORBIT_DEMO_DATA = "off";
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "smoke-outreach-guards-user";
const ID = "00000000-0000-0000-0000-000000000000";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Every address the fake mailbox was asked to deliver to. */
const delivered: string[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() {
    return { email: "me@x.org" };
  },
  async send(_user, message) {
    delivered.push(...message.to);
    return { providerMessageId: "pm", providerThreadId: "pt" };
  },
  async findSent() {
    return "unknown";
  },
};

const drafter: Drafter = async (_user, inputs) =>
  inputs.map((input) => ({ subject: "Hi", body: `Hello ${input.prospect.fullName}` }));

async function reset() {
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
}

run(async () => {
  await reset();
  // The suite shares one PGlite: this is page.outreach's shipped state, set explicitly so an
  // earlier smoke's release cannot leak in.
  await setSurfaceComingSoon("smoke-outreach-admin", "page.outreach", true);

  console.log("A coming-soon Outreach refuses every action, even for an admin without the preview cookie");
  const actions: Array<[string, () => Promise<unknown>]> = [
    ...Object.entries({ ...peopleActions, ...messageActions }).map(([name, fn]): [string, () => Promise<unknown>] => [
      name,
      () => (fn as (...args: unknown[]) => Promise<unknown>)(ID, [ID], ID),
    ]),
    ["createCampaign", () => createCampaign({ audienceQuery: "founders", messageIntent: "say hi", replyCta: "book_intro", defaultChannel: "email", tone: "friendly" })],
    ["updateCampaign", () => updateCampaign(ID, { name: "x" })],
    ["logMessageOutcome", () => logMessageOutcome({ messageId: ID, outcome: "replied" })],
  ];
  check("the people and messages modules export their actions", Object.keys(peopleActions).length >= 7 && Object.keys(messageActions).length >= 7, Object.keys({ ...peopleActions, ...messageActions }).join(","));
  for (const [name, call] of actions) {
    const thrown = await call().then(() => null, (err: unknown) => err);
    check(`${name} refuses`, isSurfaceHiddenError(thrown), String(thrown));
  }

  console.log("\nSends: a demo prospect never sends, a placeholder address stays a draft");
  const db = await getDb();
  setProviderOverride("gmail", fake);
  try {
    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "me@x.org",
      accessTokenEncrypted: encrypt("t"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.gmailSend,
      status: "active",
    });
    const [campaign] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Guards" }).returning();
    await addProspectsForUser(
      USER,
      campaign!.id,
      [
        { fullName: "Demo Person", company: "Acme", email: "demo@acme-co.io", origin: "manual" },
        { fullName: "Placeholder Person", company: "Acme", origin: "manual" },
      ]
    );
    const prospects = await db.query.outreachProspects.findMany({ where: eq(schema.outreachProspects.campaignId, campaign!.id) });
    const pid = (name: string) => prospects.find((p) => p.fullName === name)!.id;
    await db.update(schema.outreachProspects).set({ enrichment: { demo: true } }).where(eq(schema.outreachProspects.id, pid("Demo Person")));
    // Written directly: the add path already drops a placeholder address, so this is the row a
    // regression there (or an old row) would leave behind.
    await db.update(schema.outreachProspects).set({ email: "someone@acme.example.com" }).where(eq(schema.outreachProspects.id, pid("Placeholder Person")));
    check("isPlaceholderAddress: example.com, .test and .invalid are placeholders", isPlaceholderAddress("a@acme.example.com") && isPlaceholderAddress("a@b.test") && isPlaceholderAddress("a@demo.orbit.invalid"));
    check("isPlaceholderAddress: a real domain is not", !isPlaceholderAddress("jordan@capitalone.com"));

    await draftCampaignMessagesForUser(USER, campaign!.id, [pid("Demo Person"), pid("Placeholder Person")], { drafter });
    const drafts = await db.query.outreachMessages.findMany({ where: eq(schema.outreachMessages.stepIndex, 0) });
    const mid = (name: string) => drafts.find((m) => m.prospectId === pid(name))!.id;
    const status = async (id: string) => (await db.query.outreachMessages.findFirst({ where: eq(schema.outreachMessages.id, id) }))?.status;
    const sendsFor = async (id: string) =>
      (await db.select({ id: schema.emailSends.id }).from(schema.emailSends).where(and(eq(schema.emailSends.userId, USER), eq(schema.emailSends.originRef, id)))).length;

    const demo = await sendCampaignMessagesForUser(USER, campaign!.id, [mid("Demo Person")], { spacingMs: 0, contactWrite: OPTS });
    check("a demo prospect is refused with the sample-prospect copy", demo.sent === 0 && demo.failed[0]?.error === DEMO_PROSPECT_SEND_MESSAGE, JSON.stringify(demo));
    check("…stays a draft, with nothing in the outbox", (await status(mid("Demo Person"))) === "draft" && (await sendsFor(mid("Demo Person"))) === 0);

    const placeholder = await sendCampaignMessagesForUser(USER, campaign!.id, [mid("Placeholder Person")], { spacingMs: 0, contactWrite: OPTS });
    check("a placeholder address is refused", placeholder.sent === 0 && placeholder.failed.length === 1, JSON.stringify(placeholder));
    check("…stays a draft, with nothing in the outbox", (await status(mid("Placeholder Person"))) === "draft" && (await sendsFor(mid("Placeholder Person"))) === 0);

    check("the mailbox was never asked to deliver anything", delivered.length === 0, delivered.join());
  } finally {
    setProviderOverride("gmail", null);
    await reset();
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach guard checks passed.");
});
