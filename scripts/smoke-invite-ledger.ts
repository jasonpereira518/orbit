/**
 * The identity chain, by IDS: waitlist join -> invite -> account -> attribution, against a
 * throwaway PGlite, with Clerk and Resend stubbed through `inviteToSite`'s injectable deps.
 *
 * WHY. Before the ledger, "how many of wave 2 signed up, and from where?" was an email match
 * against audit-log text, and an invited account was attributed `direct` because the
 * first-touch cookie lives on the waitlist host. This pins:
 *   - `inviteToSite` writes a `site_invites` row (lowercased email, wave, Clerk id, source,
 *     waitlist id, emailed) AND the audit rows, and puts the ids in the Clerk metadata;
 *   - the claim links the account by id even when the sign-up email differs, and is idempotent;
 *   - email is a fallback only when the marker carries no ids, and never takes another row;
 *   - the waitlist row's first touch lands on the account (`signup_attribution_source =
 *     'waitlist'`), unless a cookie got there first, and upgrades a premature `direct`;
 *   - events: `invite_sent`, `invite_accepted` (once), `waitlist_email_sent`;
 *   - revoke stamps `revoked_at`; a full purge deletes the waitlist row and anonymises the ledger.
 *
 * Run: npx tsx scripts/smoke-invite-ledger.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, interestListSignups, productEvents, siteInvites, userSettings } from "../src/db/schema";
import { joinInterestListCore } from "../src/lib/interest-list-join";
import {
  SiteInviteError,
  inviteToSite,
  linkInviteToAccount,
  recordSiteInvite,
  revokeSiteInvite,
  type InviteDeps,
} from "../src/lib/site-invites";
import { recordDirectVisit, recordFirstTouch } from "../src/lib/attribution";
import { ensureUserSettings } from "../src/lib/user-settings";
import { purgeUserData } from "../src/lib/user-data";
import { run } from "./smoke/_env";

const ADMIN = "user_smoke_ledger_admin";
const U_MAIN = "user_smoke_ledger_main";
const U_EMAIL = "user_smoke_ledger_email";
const U_DIRECT = "user_smoke_ledger_direct";
const U_COOKIE = "user_smoke_ledger_cookie";
const U_EXISTING = "user_smoke_ledger_existing";
const PREFIX = "smoke-ledger-";
const FAN = `${PREFIX}Fan@Example.test`;
const MANUAL = `${PREFIX}manual@example.test`;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** `track()` is fire-and-forget; poll until the rows it should have written exist. */
async function events(name: string, filter?: (p: Record<string, unknown>) => boolean, want = 1) {
  const db = await getDb();
  for (let i = 0; i < 60; i++) {
    const rows = (await db.select().from(productEvents).where(eq(productEvents.name, name))).filter((r) =>
      filter ? filter(r.properties) : true
    );
    if (rows.length >= want) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await db.select().from(productEvents).where(eq(productEvents.name, name))).filter((r) =>
    filter ? filter(r.properties) : true
  );
}

/** A Clerk stand-in: records what it was asked and hands back stable ids. */
function fakeClerk(opts: { existingUserId?: string } = {}) {
  const created: Array<{ emailAddress: string; publicMetadata: Record<string, unknown> }> = [];
  const idByEmail = new Map<string, string>();
  const revoked: string[] = [];
  const updatedMetadata: Array<{ id: string; publicMetadata: Record<string, unknown> }> = [];
  const clerk: NonNullable<InviteDeps["clerk"]> = {
    users: {
      getUserList: async () => ({ data: opts.existingUserId ? [{ id: opts.existingUserId }] : [] }),
      updateUserMetadata: async (id, params) => {
        updatedMetadata.push({ id, publicMetadata: params.publicMetadata });
        return {};
      },
    },
    invitations: {
      createInvitation: async (args) => {
        created.push({ emailAddress: args.emailAddress, publicMetadata: args.publicMetadata });
        // `ignoreExisting`: the same address gets the SAME invitation back.
        const id = idByEmail.get(args.emailAddress) ?? `inv_${created.length}_${randomUUID().slice(0, 6)}`;
        idByEmail.set(args.emailAddress, id);
        return { id, url: `https://app.example.test/sign-up?__clerk_ticket=${id}` };
      },
      revokeInvitation: async (id) => {
        revoked.push(id);
        return { emailAddress: [...idByEmail.entries()].find(([, v]) => v === id)?.[0] ?? "unknown@example.test" };
      },
    },
  };
  return { clerk, created, revoked, updatedMetadata };
}

async function cleanup() {
  const db = await getDb();
  await db.delete(siteInvites).where(like(siteInvites.email, `${PREFIX}%`));
  await db.delete(interestListSignups).where(like(interestListSignups.email, `${PREFIX}%`));
  for (const u of [U_MAIN, U_EMAIL, U_DIRECT, U_COOKIE, U_EXISTING]) {
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await db.delete(productEvents).where(eq(productEvents.userId, u));
  }
  await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));
}

run(async () => {
  const db = await getDb();
  await cleanup();
  const sendOk: InviteDeps["send"] = async () => true;

  console.log("A waitlist join, carrying its visit…");
  const sessionId = randomUUID();
  const joined = await joinInterestListCore(
    { email: FAN, website: "", elapsedMs: 9_000, sessionId },
    {
      ip: "203.0.113.50",
      attribution: { referrer: "reddit.com", utmSource: "reddit", utmMedium: "social", utmCampaign: "launch", landingPath: "/" },
      sendWelcome: async () => true,
    }
  );
  check("the join succeeds", joined.ok === true);
  const [fanRow] = await db.select().from(interestListSignups).where(eq(interestListSignups.email, FAN.toLowerCase()));
  check("the join stores the visit's session id", fanRow?.joinSessionId === sessionId);
  const badSession = await joinInterestListCore(
    { email: `${PREFIX}badsession@example.test`, website: "", elapsedMs: 9_000, sessionId: "<script>" },
    { ip: "203.0.113.51", attribution: null, sendWelcome: async () => true }
  );
  const [badRow] = await db
    .select()
    .from(interestListSignups)
    .where(eq(interestListSignups.email, `${PREFIX}badsession@example.test`));
  check("…a session id that is not a uuid is dropped, not an error", badSession.ok === true && badRow?.joinSessionId === null);
  check("a welcome Resend accepted is counted", (await events("waitlist_email_sent", (p) => p.kind === "welcome")).length >= 1);

  console.log("\nAn invitation writes the ledger…");
  const clerkA = fakeClerk();
  let threw = false;
  try {
    await inviteToSite({ adminUserId: ADMIN, email: FAN, notify: false, wave: "wave 1" }, { clerk: clerkA.clerk });
  } catch (err) {
    threw = err instanceof SiteInviteError;
  }
  check("a malformed wave is refused", threw);
  check("…before anything is sent to Clerk", clerkA.created.length === 0);

  const result = await inviteToSite({ adminUserId: ADMIN, email: FAN, notify: true, wave: " W1 " }, { clerk: clerkA.clerk, send: sendOk });
  check("the invite is created", result.kind === "invited" && result.emailed === true);
  const [invite] = await db.select().from(siteInvites).where(eq(siteInvites.email, FAN.toLowerCase()));
  check("the email is lowercased", invite?.email === FAN.toLowerCase());
  check("the wave is normalised", invite?.waveId === "w1");
  check("the Clerk invitation id is kept", Boolean(invite?.clerkInvitationId?.startsWith("inv_")));
  check("an address on the waitlist is source 'waitlist', linked by id", invite?.source === "waitlist" && invite.interestListSignupId === fanRow!.id);
  check("invited_by and emailed come from the call", invite?.invitedBy === ADMIN && invite.emailed === true);
  const sentMeta = clerkA.created[0]?.publicMetadata?.siteInvite as Record<string, unknown> | undefined;
  check(
    "the Clerk metadata carries the ids",
    sentMeta?.inviteId === invite!.id && sentMeta?.interestSignupId === fanRow!.id && sentMeta?.by === ADMIN && typeof sentMeta?.at === "string"
  );
  const audit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.adminUserId, ADMIN), eq(adminAuditLog.action, "site.invite.create")));
  check("the existing audit row is still written", audit.some((a) => a.resourceId === invite!.clerkInvitationId));
  const sentEvents = await events("invite_sent", (p) => p.invite_id === invite!.id);
  check("invite_sent is emitted once", sentEvents.length === 1);
  check(
    "…with the wave and source, as the operator (not the invitee)",
    sentEvents[0]?.properties.wave_id === "w1" && sentEvents[0]?.properties.source === "waitlist" && sentEvents[0]?.actor === "system" && sentEvents[0]?.userId === null
  );

  await inviteToSite({ adminUserId: ADMIN, email: FAN, notify: false }, { clerk: clerkA.clerk });
  const afterResend = await db.select().from(siteInvites).where(eq(siteInvites.email, FAN.toLowerCase()));
  check("a resend of the same invitation is not a second row", afterResend.length === 1);
  check("…keeps emailed and wave", afterResend[0]?.emailed === true && afterResend[0]?.waveId === "w1");
  check("…and emits nothing", (await events("invite_sent", (p) => p.invite_id === invite!.id)).length === 1);

  const manual = await inviteToSite({ adminUserId: ADMIN, email: MANUAL, notify: false }, { clerk: clerkA.clerk });
  const [manualRow] = await db.select().from(siteInvites).where(eq(siteInvites.email, MANUAL.toLowerCase()));
  check("an address not on the waitlist is source 'manual' with no signup id", manual.kind === "invited" && manualRow?.source === "manual" && manualRow.interestListSignupId === null);
  check("…no wave, and the event omits it", manualRow?.waveId === null && (await events("invite_sent", (p) => p.invite_id === manualRow!.id))[0]?.properties.wave_id === undefined);

  console.log("\nThe account is linked by ID, even under a different email…");
  const claimMeta = clerkA.created[0]!.publicMetadata;
  await ensureUserSettings(U_MAIN);
  const founding = await recordSiteInvite(U_MAIN, claimMeta, { email: "someone.else@elsewhere.test", surface: "webhook" });
  check("founding eligibility is recorded as before", founding === true);
  const [acct] = await db.select().from(userSettings).where(eq(userSettings.userId, U_MAIN));
  check("user_settings.invite_id and interest_signup_id are set", acct?.inviteId === invite!.id && acct.interestSignupId === fanRow!.id);
  check("…and founding_eligible", acct?.foundingEligible === true);
  const [accepted] = await db.select().from(siteInvites).where(eq(siteInvites.id, invite!.id));
  check("the invite records who accepted it, and when", accepted?.acceptedUserId === U_MAIN && accepted.acceptedAt instanceof Date);
  const [converted] = await db.select().from(interestListSignups).where(eq(interestListSignups.id, fanRow!.id));
  check("the waitlist row records the account and the conversion time", converted?.userId === U_MAIN && converted.convertedAt instanceof Date);
  check(
    "the waitlist's first touch is copied onto the account",
    acct?.signupAttributionSource === "waitlist" &&
      acct.signupUtmSource === "reddit" &&
      acct.signupUtmMedium === "social" &&
      acct.signupUtmCampaign === "launch" &&
      acct.signupReferrer === "reddit.com" &&
      acct.signupLandingPath === "/" &&
      acct.signupAttributedAt instanceof Date
  );
  const acceptedEvents = await events("invite_accepted", (p) => p.invite_id === invite!.id);
  check("invite_accepted is emitted once, for the account", acceptedEvents.length === 1 && acceptedEvents[0]?.userId === U_MAIN);
  check("…with days since sent", acceptedEvents[0]?.properties.days_since_sent === 0);

  console.log("\nRunning it again changes nothing…");
  const snapshot = async () => ({
    invite: (await db.select().from(siteInvites).where(eq(siteInvites.id, invite!.id)))[0],
    wait: (await db.select().from(interestListSignups).where(eq(interestListSignups.id, fanRow!.id)))[0],
    acct: (await db.select().from(userSettings).where(eq(userSettings.userId, U_MAIN)))[0],
  });
  const before = await snapshot();
  await new Promise((r) => setTimeout(r, 15));
  const again = await recordSiteInvite(U_MAIN, claimMeta, { email: "someone.else@elsewhere.test" });
  const link = await linkInviteToAccount(U_MAIN, { inviteId: invite!.id, interestSignupId: fanRow!.id });
  const after = await snapshot();
  check("recordSiteInvite reports no new founding grant", again === false);
  check("linkInviteToAccount reports no new acceptance", link.newlyAccepted === false && link.inviteId === invite!.id);
  check(
    "no timestamp or id moved",
    before.invite?.acceptedAt?.getTime() === after.invite?.acceptedAt?.getTime() &&
      before.wait?.convertedAt?.getTime() === after.wait?.convertedAt?.getTime() &&
      before.acct?.signupAttributedAt?.getTime() === after.acct?.signupAttributedAt?.getTime() &&
      before.acct?.inviteId === after.acct?.inviteId
  );
  check("no second invite_accepted", (await events("invite_accepted", (p) => p.invite_id === invite!.id)).length === 1);

  console.log("\nEmail is a fallback only when the marker has no ids…");
  const legacyEmail = `${PREFIX}legacy@example.test`;
  const decoyEmail = `${PREFIX}decoy@example.test`;
  const [legacy] = await db.insert(siteInvites).values({ email: legacyEmail, source: "manual", invitedBy: ADMIN }).returning();
  await ensureUserSettings(U_EMAIL);
  await recordSiteInvite(U_EMAIL, { siteInvite: { by: ADMIN, at: new Date().toISOString() } }, { email: legacyEmail.toUpperCase() });
  const [legacyAfter] = await db.select().from(siteInvites).where(eq(siteInvites.id, legacy!.id));
  check("a pre-ledger invitation is matched by lowercased email", legacyAfter?.acceptedUserId === U_EMAIL);
  check("…and the account points at it", (await db.select().from(userSettings).where(eq(userSettings.userId, U_EMAIL)))[0]?.inviteId === legacy!.id);

  // A marker WITH an id must never be re-matched by email onto a different row.
  const [decoy] = await db.insert(siteInvites).values({ email: decoyEmail, source: "manual", invitedBy: ADMIN }).returning();
  await db.delete(userSettings).where(eq(userSettings.userId, U_EMAIL));
  const [idOnly] = await db.insert(siteInvites).values({ email: `${PREFIX}idonly@example.test`, source: "manual", invitedBy: ADMIN }).returning();
  await ensureUserSettings(U_EMAIL);
  await recordSiteInvite(U_EMAIL, { siteInvite: { by: ADMIN, at: "x", inviteId: idOnly!.id } }, { email: decoyEmail });
  const [decoyAfter] = await db.select().from(siteInvites).where(eq(siteInvites.id, decoy!.id));
  const [idOnlyAfter] = await db.select().from(siteInvites).where(eq(siteInvites.id, idOnly!.id));
  check("an id in the marker wins", idOnlyAfter?.acceptedUserId === U_EMAIL);
  check("…and a matching email on another row is left alone", decoyAfter?.acceptedUserId === null);
  check("a marker with an id that matches no row links nothing and does not throw", (await linkInviteToAccount(U_EMAIL, { inviteId: randomUUID() })).inviteId === null);

  console.log("\nAttribution: waitlist vs cookie vs direct…");
  // The webhook can land AFTER the first app render has already written 'direct'.
  await ensureUserSettings(U_DIRECT);
  check("an account with no cookie and no waitlist row is 'direct'", (await recordDirectVisit(U_DIRECT)) === true);
  check("…stamped as such", (await db.select().from(userSettings).where(eq(userSettings.userId, U_DIRECT)))[0]?.signupAttributionSource === "direct");
  const [late] = await db
    .insert(interestListSignups)
    .values({
      email: `${PREFIX}late@example.test`,
      unsubscribeToken: randomUUID(),
      shareToken: randomUUID(),
      utmSource: "newsletter",
      referrer: "news.example.test",
      landingPath: "/waitlist/x",
    })
    .returning();
  await linkInviteToAccount(U_DIRECT, { interestSignupId: late!.id });
  const upgraded = (await db.select().from(userSettings).where(eq(userSettings.userId, U_DIRECT)))[0];
  check("a late link upgrades a premature 'direct' to the waitlist's channel", upgraded?.signupAttributionSource === "waitlist" && upgraded.signupUtmSource === "newsletter");

  const [cookieSignup] = await db
    .insert(interestListSignups)
    .values({ email: `${PREFIX}cookie@example.test`, unsubscribeToken: randomUUID(), shareToken: randomUUID(), utmSource: "reddit" })
    .returning();
  await ensureUserSettings(U_COOKIE);
  await recordFirstTouch(
    U_COOKIE,
    { referrer: null, utmSource: "producthunt", utmMedium: null, utmCampaign: null, landingPath: "/pricing" },
    "cookie"
  );
  await linkInviteToAccount(U_COOKIE, { interestSignupId: cookieSignup!.id });
  const cookieAcct = (await db.select().from(userSettings).where(eq(userSettings.userId, U_COOKIE)))[0];
  check("a cookie first touch is never overwritten by the waitlist row", cookieAcct?.signupAttributionSource === "cookie" && cookieAcct.signupUtmSource === "producthunt");
  check("…but the account is still linked to the waitlist row", cookieAcct?.interestSignupId === cookieSignup!.id);

  console.log("\nAn existing account is granted access…");
  await ensureUserSettings(U_EXISTING);
  const clerkB = fakeClerk({ existingUserId: U_EXISTING });
  const existingEmail = `${PREFIX}existing@example.test`;
  const granted = await inviteToSite({ adminUserId: ADMIN, email: existingEmail, notify: false, wave: "w2" }, { clerk: clerkB.clerk });
  check("the grant reports an existing account", granted.kind === "existing-account");
  const [existingRow] = await db.select().from(siteInvites).where(eq(siteInvites.email, existingEmail));
  check("it is a ledger row of source 'existing_account', no Clerk invitation", existingRow?.source === "existing_account" && existingRow.clerkInvitationId === null && existingRow.waveId === "w2");
  check("…accepted at once, by that account", existingRow?.acceptedUserId === U_EXISTING);
  check("the marker with ids went onto the Clerk user", (clerkB.updatedMetadata[0]?.publicMetadata.siteInvite as Record<string, unknown>)?.inviteId === existingRow!.id);
  check("invite_sent has source existing_account", (await events("invite_sent", (p) => p.invite_id === existingRow!.id))[0]?.properties.source === "existing_account");
  check("…and the account's invite_accepted is emitted", (await events("invite_accepted", (p) => p.invite_id === existingRow!.id)).length === 1);

  console.log("\nRevoking stamps the ledger…");
  const revokedId = invite!.clerkInvitationId!;
  await revokeSiteInvite({ adminUserId: ADMIN, invitationId: revokedId }, { clerk: clerkA.clerk });
  const [revokedRow] = await db.select().from(siteInvites).where(eq(siteInvites.id, invite!.id));
  check("revoked_at is set", revokedRow?.revokedAt instanceof Date);
  const revokeAudit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.adminUserId, ADMIN), eq(adminAuditLog.action, "site.invite.revoke")));
  check("…and the audit row is still written", revokeAudit.length === 1);

  console.log("\nA deleted account takes its waitlist row with it…");
  await purgeUserData(U_MAIN, { keepSettings: false });
  check("the waitlist row is deleted", (await db.select().from(interestListSignups).where(eq(interestListSignups.id, fanRow!.id))).length === 0);
  const [kept] = await db.select().from(siteInvites).where(eq(siteInvites.id, invite!.id));
  check("the ledger row stays, so a wave's counts do not change", Boolean(kept));
  check("…but no longer names the person", kept?.acceptedUserId === null && kept.email.startsWith("deleted-"));
  check("the account's events are gone", (await db.select().from(productEvents).where(eq(productEvents.userId, U_MAIN))).length === 0);

  await cleanup();
  console.log("\ninvite ledger: all checks passed");
});
