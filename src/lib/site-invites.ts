/**
 * Admin invitations: the way into the site while it is in stealth.
 *
 * An invitation is a Clerk invitation. Its link lands on `/sign-up?__clerk_ticket=…`, which
 * `stealthGate` lets through, and Clerk's `<SignUp/>` consumes the ticket. It carries the
 * `siteInvite` marker in its public metadata, which Clerk copies onto the account it creates
 * — that marker is what `isHeldByStealth` looks for, so an invited account is never held.
 *
 * An address that ALREADY has an account (typically one a Google sign-in created during
 * stealth, now held) cannot take an invitation — Clerk refuses one for an existing user — so
 * the marker goes straight onto that user and they are handed the sign-in link instead.
 *
 * AN INVITATION MAKES THE ACCOUNT FOUNDING-ELIGIBLE (pricing v2), not just a way past stealth:
 * its first paid subscription gets founding pricing (`recordSiteInvite`). It is no longer a
 * comp. The existing-account path records it on the spot; a new account when it first appears —
 * from the `user.created` webhook, with the onboarding page as the backstop for a webhook that
 * never lands (`claimSiteInviteGrant`).
 *
 * THE EMAIL IS ORBIT'S, not Clerk's: Clerk is always told `notify: false`, and when the admin
 * asks for the link to be emailed, `site-invite-email.ts` sends the boarding pass with the
 * invitation's own ticket URL inside. `emailed` reports what Resend actually accepted.
 *
 * THE LEDGER. Clerk sends and redeems an invitation but keeps no wave, no link to the waitlist
 * row and an admin list capped at 25, so Orbit keeps its own `site_invites` row per invitation
 * (and per existing account granted access). `inviteToSite` writes it; the Clerk invitation's
 * public metadata carries its id and the waitlist row's id (`siteInvite: {by, at, inviteId,
 * interestSignupId}`) so that `user.created` (or the onboarding backstop) links the account
 * BY ID, with the lowercased email only as a fallback for invitations that predate the ledger.
 * `linkInviteToAccount` is that link, and it is idempotent: a second run changes nothing.
 *
 * No auth here; the server actions in `src/actions/admin.ts` are the gate.
 */
import { clerkClient } from "@clerk/nextjs/server";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { interestListSignups, siteInvites, userSettings } from "@/db/schema";
import { applyWaitlistAttribution } from "@/lib/attribution";
import { deterministicEventId } from "@/lib/product-event-ids";
import { track } from "@/lib/product-events";
import { reportError } from "@/lib/report-error";
import { isClerkConfigured } from "@/lib/demo-account";
import { getAppBaseUrl } from "@/lib/app-url";
import { recordAdminAction } from "@/lib/admin-audit";
import { hasSiteInvite, markStealthCleared, SITE_INVITE_METADATA_KEY } from "@/lib/site-access";
import { ensureUserSettings } from "@/lib/user-settings";
import { asWelcomePlanet, type WelcomePlanet } from "@/lib/welcome-planets";
import {
  DEFAULT_INVITE_PLANET,
  buildSiteInviteEmail,
  sendSiteInviteEmail,
  type SiteInviteEmailKind,
} from "@/lib/site-invite-email";

const INVITE_EXPIRES_DAYS = 30;
/**
 * The note invitations wrote on the comp they granted before pricing v2 — kept because
 * existing comps carry it, and the v130 backfill uses it to find those accounts.
 */
export const LEGACY_INVITE_COMP_NOTE = "Invited by an admin";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SiteInviteResult =
  | { kind: "invited"; email: string; url: string | null; emailed: boolean }
  | { kind: "existing-account"; email: string; url: string; emailed: boolean };

export type SiteInviteRow = {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: Date;
  url: string | null;
  /** The operator's wave label from the ledger, when the invitation has one. */
  waveId?: string | null;
};

export class SiteInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteInviteError";
  }
}

/** A wave label: `w1`, `w12`. The operator's own name for a batch of invitations. */
export const WAVE_PATTERN = /^w\d{1,3}$/;

/** Null for blank; throws a message the Access form can show for anything else. */
export function normalizeWave(raw: string | null | undefined): string | null {
  const wave = raw?.trim().toLowerCase() ?? "";
  if (!wave) return null;
  if (!WAVE_PATTERN.test(wave)) {
    throw new SiteInviteError("A wave looks like w1, w2, w12.");
  }
  return wave;
}

export function normalizeInviteEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    throw new SiteInviteError("That doesn't look like an email address.");
  }
  return email;
}

function requireClerk() {
  if (!isClerkConfigured()) {
    throw new SiteInviteError("Invitations need Clerk, and this server has no Clerk keys.");
  }
}

/**
 * The slice of Clerk's backend client invitations use, and the email sender: injectable so a
 * smoke script can drive `inviteToSite` end to end (ledger, metadata, claim) without Clerk
 * keys or Resend. Production passes nothing and gets the real ones.
 */
export type InviteDeps = {
  clerk?: {
    users: {
      getUserList(args: { emailAddress: string[]; limit: number }): Promise<{ data: Array<{ id: string }> }>;
      updateUserMetadata(id: string, params: { publicMetadata: Record<string, unknown> }): Promise<unknown>;
    };
    invitations: {
      createInvitation(args: {
        emailAddress: string;
        redirectUrl: string;
        publicMetadata: Record<string, unknown>;
        notify: boolean;
        expiresInDays: number;
        ignoreExisting: boolean;
      }): Promise<{ id: string; url?: string | null }>;
      revokeInvitation(id: string): Promise<{ emailAddress: string }>;
    };
  };
  send?: typeof sendSiteInviteEmail;
};

export async function inviteToSite(input: {
  adminUserId: string;
  email: string;
  /** Whether Orbit emails the pass. Off, the admin copies the link and sends it themselves. */
  notify: boolean;
  /** Greets them by name in the email. Optional: waitlist rows carry no name. */
  firstName?: string | null;
  /** The operator's label for this batch (`w1`, `w2`). Optional. */
  wave?: string | null;
}, deps: InviteDeps = {}): Promise<SiteInviteResult> {
  if (!deps.clerk) requireClerk();
  const email = normalizeInviteEmail(input.email);
  const wave = normalizeWave(input.wave);
  const signup = await signupForEmail(email);
  const inviteId = randomUUID();
  const marker = {
    [SITE_INVITE_METADATA_KEY]: {
      by: input.adminUserId,
      at: new Date().toISOString(),
      // What lets the webhook / onboarding link the account by id instead of by email.
      inviteId,
      ...(signup ? { interestSignupId: signup.id } : {}),
    },
  };
  const clerk = deps.clerk ?? ((await clerkClient()) as unknown as NonNullable<InviteDeps["clerk"]>);

  const existing = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  const user = existing.data[0];
  if (user) {
    // The ledger row first: nothing has been granted yet, so a database failure here leaves
    // no half-done invite behind.
    await recordLedgerRow({
      id: inviteId,
      email,
      interestListSignupId: signup?.id ?? null,
      waveId: wave,
      clerkInvitationId: null,
      source: "existing_account",
      invitedBy: input.adminUserId,
      emailed: false,
    });
    await clerk.users.updateUserMetadata(user.id, { publicMetadata: marker });
    await markStealthCleared(user.id);
    // Founding eligibility, and the claim: the account exists, so the invite is accepted now.
    await recordSiteInvite(user.id, marker, { email });
    await recordAdminAction({
      adminUserId: input.adminUserId,
      action: "site.invite.existing_account",
      targetUserId: user.id,
      resourceType: "clerk_user",
      resourceId: user.id,
      detail: { email, inviteId, wave },
    });
    const url = `${getAppBaseUrl()}/sign-in`;
    const emailed = input.notify
      ? await emailPass({ email, url, kind: "existing-account", firstName: input.firstName }, deps.send)
      : false;
    if (emailed) await markLedgerEmailed(inviteId);
    return { kind: "existing-account", email, url, emailed };
  }

  const invitation = await clerk.invitations.createInvitation({
    emailAddress: email,
    redirectUrl: `${getAppBaseUrl()}/sign-up`,
    publicMetadata: marker,
    // Orbit sends its own email (below); Clerk's stock one would arrive alongside it.
    notify: false,
    expiresInDays: INVITE_EXPIRES_DAYS,
    // A second invite to the same address replaces nothing and fails without this; the
    // no-account check above is what keeps it from inviting an existing user.
    ignoreExisting: true,
  });

  const url = invitation.url ?? null;
  const emailed =
    input.notify && url
      ? await emailPass(
          {
            email,
            url,
            kind: "invite",
            firstName: input.firstName,
            expiresAt: new Date(Date.now() + INVITE_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
          },
          deps.send
        )
      : false;

  // The invitation exists and its link may already be out, so a ledger failure is reported,
  // never thrown: the operator must still get the link back.
  try {
    await recordLedgerRow({
      id: inviteId,
      email,
      interestListSignupId: signup?.id ?? null,
      waveId: wave,
      clerkInvitationId: invitation.id,
      source: signup ? "waitlist" : "manual",
      invitedBy: input.adminUserId,
      emailed,
    });
  } catch (err) {
    reportError(err, { where: "site_invites.record", level: "error", extra: { clerkInvitationId: invitation.id } });
  }

  await recordAdminAction({
    adminUserId: input.adminUserId,
    action: "site.invite.create",
    resourceType: "clerk_invitation",
    resourceId: invitation.id,
    detail: { email, emailed, inviteId, wave },
  });

  return { kind: "invited", email, url, emailed };
}

/** The waitlist row for an address, if it is on the list. The email is the only thing matched here. */
async function signupForEmail(email: string): Promise<{ id: string } | null> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ id: interestListSignups.id })
      .from(interestListSignups)
      .where(eq(interestListSignups.email, email))
      .limit(1);
    return row ?? null;
  } catch (err) {
    // The link is an enrichment; an invitation must not fail over it.
    reportError(err, { where: "site_invites.signup_lookup", level: "warning" });
    return null;
  }
}

/**
 * Write the ledger row and announce it. A Clerk invitation re-issued for the same address
 * (`ignoreExisting`) comes back with the SAME invitation id, which the unique index turns into
 * a conflict: that is a resend, not a new invite, so it updates the existing row (`emailed` only
 * ever turns true; a wave only fills an empty one) and emits nothing.
 */
async function recordLedgerRow(row: {
  id: string;
  email: string;
  interestListSignupId: string | null;
  waveId: string | null;
  clerkInvitationId: string | null;
  source: "waitlist" | "manual" | "existing_account";
  invitedBy: string;
  emailed: boolean;
}): Promise<void> {
  const db = await getDb();
  const inserted = await db
    .insert(siteInvites)
    .values(row)
    .onConflictDoNothing({ target: siteInvites.clerkInvitationId })
    .returning();
  if (inserted.length === 0) {
    if (row.clerkInvitationId) {
      await db
        .update(siteInvites)
        .set({
          emailed: sql`${siteInvites.emailed} OR ${row.emailed}`,
          waveId: sql`coalesce(${siteInvites.waveId}, ${row.waveId})`,
        })
        .where(eq(siteInvites.clerkInvitationId, row.clerkInvitationId));
    }
    return;
  }
  // The operator did this, not the invitee, so no user id and actor "system": an invite is
  // never read as anyone's activity, and `is_internal` is not inherited from the admin.
  track(
    "invite_sent",
    {
      invite_id: row.id,
      ...(row.waveId ? { wave_id: row.waveId } : {}),
      source: row.source,
    },
    { actor: "system", id: deterministicEventId("invite_sent", row.id) }
  );
}

async function markLedgerEmailed(inviteId: string): Promise<void> {
  try {
    const db = await getDb();
    await db.update(siteInvites).set({ emailed: true }).where(eq(siteInvites.id, inviteId));
  } catch (err) {
    reportError(err, { where: "site_invites.emailed", level: "warning" });
  }
}

/** The planet this address was given on the waitlist, or the home planet for a direct invite. */
async function planetForInvitee(email: string): Promise<WelcomePlanet> {
  try {
    const db = await getDb();
    const row = await db.query.interestListSignups.findFirst({
      where: eq(interestListSignups.email, email),
      columns: { welcomePlanet: true },
    });
    return row?.welcomePlanet ? asWelcomePlanet(row.welcomePlanet) : DEFAULT_INVITE_PLANET;
  } catch {
    // A planet is decoration; never fail an invitation over it.
    return DEFAULT_INVITE_PLANET;
  }
}

async function emailPass(
  input: {
    email: string;
    url: string;
    kind: SiteInviteEmailKind;
    firstName?: string | null;
    expiresAt?: Date;
  },
  send: typeof sendSiteInviteEmail = sendSiteInviteEmail
): Promise<boolean> {
  const planet = await planetForInvitee(input.email);
  return send(buildSiteInviteEmail({ ...input, planet }), input.email);
}

/** The most recent invitations, newest first. Empty without Clerk. */
export async function listSiteInvites(limit = 25): Promise<SiteInviteRow[]> {
  if (!isClerkConfigured()) return [];
  const clerk = await clerkClient();
  const { data } = await clerk.invitations.getInvitationList({ limit, orderBy: "-created_at" });
  const waves = await wavesFor(data.map((inv) => inv.id));
  return data.map((inv) => ({
    id: inv.id,
    email: inv.emailAddress,
    status: inv.status as SiteInviteRow["status"],
    createdAt: new Date(inv.createdAt),
    url: inv.status === "pending" ? inv.url ?? null : null,
    waveId: waves.get(inv.id) ?? null,
  }));
}

/** Wave labels from the ledger, by Clerk invitation id. Empty if the read fails: a column, not a gate. */
async function wavesFor(invitationIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (invitationIds.length === 0) return out;
  try {
    const db = await getDb();
    const rows = await db
      .select({ id: siteInvites.clerkInvitationId, wave: siteInvites.waveId })
      .from(siteInvites)
      .where(inArray(siteInvites.clerkInvitationId, invitationIds));
    for (const r of rows) if (r.id && r.wave) out.set(r.id, r.wave);
  } catch (err) {
    reportError(err, { where: "site_invites.waves", level: "warning" });
  }
  return out;
}

export async function revokeSiteInvite(
  input: { adminUserId: string; invitationId: string },
  deps: InviteDeps = {}
) {
  if (!deps.clerk) requireClerk();
  const clerk = deps.clerk ?? ((await clerkClient()) as unknown as NonNullable<InviteDeps["clerk"]>);
  const revoked = await clerk.invitations.revokeInvitation(input.invitationId);
  try {
    const db = await getDb();
    await db
      .update(siteInvites)
      .set({ revokedAt: sql`coalesce(${siteInvites.revokedAt}, now())` })
      .where(eq(siteInvites.clerkInvitationId, input.invitationId));
  } catch (err) {
    // Clerk has already revoked it; the audit row below must still be written.
    reportError(err, { where: "site_invites.revoke", level: "error", extra: { invitationId: input.invitationId } });
  }
  await recordAdminAction({
    adminUserId: input.adminUserId,
    action: "site.invite.revoke",
    resourceType: "clerk_invitation",
    resourceId: input.invitationId,
    detail: { email: revoked.emailAddress },
  });
  return { email: revoked.emailAddress };
}

/**
 * Record that an account came through a beta invitation: it is eligible for founding pricing
 * (pricing v2) — $2 off Pro or $4 off Max for the first three months of its first paid
 * subscription. Stored on the account, never inferred later.
 *
 * Invites no longer comp Orbit Pro. Accounts comped by an invitation BEFORE pricing v2 keep
 * their comp exactly as it is; this never touches `comped_plan`.
 *
 * A no-op without the invitation marker; idempotent. Only `user.created`, the existing-account
 * invite and the onboarding backstop call this — never `user.updated`.
 */
export async function recordSiteInvite(
  userId: string,
  publicMetadata: Record<string, unknown> | null | undefined,
  opts: LinkOptions = {}
): Promise<boolean> {
  if (!hasSiteInvite(publicMetadata)) return false;
  const settings = await ensureUserSettings(userId);
  let recorded = false;
  if (!settings.foundingEligible) {
    const db = await getDb();
    await db.update(userSettings).set({ foundingEligible: true, updatedAt: new Date() }).where(eq(userSettings.userId, userId));
    recorded = true;
  }
  // The ledger link runs whether or not founding was already set: it is idempotent, and the
  // webhook retrying after a half-finished first attempt must be able to complete it. Errors
  // propagate: the webhook wants the 500 (Svix retries), and `claimSiteInviteGrant` catches.
  await linkInviteToAccount(userId, readInviteMarker(publicMetadata), opts);
  return recorded;
}

/** The ids the invitation's marker carries. Anything that is not a uuid is dropped. */
export function readInviteMarker(
  publicMetadata: Record<string, unknown> | null | undefined
): { inviteId: string | null; interestSignupId: string | null } {
  const raw = publicMetadata?.[SITE_INVITE_METADATA_KEY];
  const marker = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const uuid = (v: unknown) =>
    typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null;
  return { inviteId: uuid(marker.inviteId), interestSignupId: uuid(marker.interestSignupId) };
}

type LinkOptions = {
  /** The account's primary email: the FALLBACK match, used only when the marker carries no ids. */
  email?: string | null;
  /** Where the claim happened, for the event envelope. */
  surface?: "web" | "webhook";
};

export type InviteLink = {
  inviteId: string | null;
  interestSignupId: string | null;
  /** True only on the call that first accepted the invite. */
  newlyAccepted: boolean;
};

/**
 * Link a new account to its invite and its waitlist row, once.
 *
 * BY ID. The invitation's marker names the `site_invites` row and the waitlist row; those are
 * the keys. The lowercased email is consulted only when the marker has NO ids (an invitation
 * sent before the ledger existed), because an email can differ from the one the person
 * signed up with, and a wrong match would attribute one person's signup to another's invite.
 *
 * Writes (every one guarded in SQL so a second run changes nothing):
 *   - `site_invites.accepted_user_id/accepted_at`, only while unaccepted;
 *   - `user_settings.invite_id/interest_signup_id`, only while null;
 *   - `interest_list_signups.user_id/converted_at`, only while unlinked;
 *   - the waitlist row's first touch onto `user_settings.signup_*`, unless a cookie got there first;
 *   - `invite_accepted`, once (deterministic id), with the days between send and acceptance.
 */
export async function linkInviteToAccount(
  userId: string,
  ids: { inviteId?: string | null; interestSignupId?: string | null },
  opts: LinkOptions = {}
): Promise<InviteLink> {
  const db = await getDb();
  const email = opts.email?.trim().toLowerCase() || null;
  const noIds = !ids.inviteId && !ids.interestSignupId;

  // 1. The invite row.
  let invite: typeof siteInvites.$inferSelect | null = null;
  if (ids.inviteId) {
    [invite = null] = await db.select().from(siteInvites).where(eq(siteInvites.id, ids.inviteId)).limit(1);
  } else if (noIds && email) {
    [invite = null] = await db
      .select()
      .from(siteInvites)
      .where(
        and(
          eq(siteInvites.email, email),
          isNull(siteInvites.revokedAt),
          or(isNull(siteInvites.acceptedUserId), eq(siteInvites.acceptedUserId, userId))
        )
      )
      .orderBy(desc(siteInvites.sentAt))
      .limit(1);
  }
  // An invite someone ELSE already accepted is not this account's.
  if (invite?.acceptedUserId && invite.acceptedUserId !== userId) invite = null;

  // 2. The waitlist row: the marker's id, else the invite's, else (no ids at all) the email.
  let signupId = ids.interestSignupId ?? invite?.interestListSignupId ?? null;
  if (!signupId && noIds && email) {
    const [row] = await db
      .select({ id: interestListSignups.id })
      .from(interestListSignups)
      .where(eq(interestListSignups.email, email))
      .limit(1);
    signupId = row?.id ?? null;
  }
  if (signupId) {
    // A waitlist row deleted since the invite went out must not leave a dangling id on the account.
    const [exists] = await db
      .select({ id: interestListSignups.id })
      .from(interestListSignups)
      .where(eq(interestListSignups.id, signupId))
      .limit(1);
    if (!exists) signupId = null;
  }

  // 3. Writes.
  let newlyAccepted = false;
  if (invite && !invite.acceptedUserId) {
    const accepted = await db
      .update(siteInvites)
      .set({ acceptedUserId: userId, acceptedAt: new Date() })
      .where(and(eq(siteInvites.id, invite.id), isNull(siteInvites.acceptedUserId)))
      .returning();
    newlyAccepted = accepted.length > 0;
  }

  if (invite || signupId) {
    await db
      .update(userSettings)
      .set({
        inviteId: sql`coalesce(${userSettings.inviteId}, ${invite?.id ?? null}::uuid)`,
        interestSignupId: sql`coalesce(${userSettings.interestSignupId}, ${signupId}::uuid)`,
      })
      .where(eq(userSettings.userId, userId));
  }

  if (signupId) {
    await db
      .update(interestListSignups)
      .set({ userId, convertedAt: new Date() })
      .where(and(eq(interestListSignups.id, signupId), isNull(interestListSignups.userId)));
    // The cookie lives on the waitlist host and never reaches the app host, so the waitlist
    // row is where this person's channel is recorded (audit U1).
    await applyWaitlistAttribution(userId, signupId);
  }

  if (newlyAccepted && invite) {
    const days = Math.max(0, Math.floor((Date.now() - invite.sentAt.getTime()) / 86_400_000));
    track(
      "invite_accepted",
      { invite_id: invite.id, days_since_sent: days },
      {
        userId,
        surface: opts.surface ?? "web",
        id: deterministicEventId("invite_accepted", invite.id),
      }
    );
  }

  return { inviteId: invite?.id ?? null, interestSignupId: signupId, newlyAccepted };
}

/**
 * The backstop for a missed `user.created` webhook: ask Clerk whether this account was
 * invited and record its founding eligibility and ledger link if so. One Clerk call, so callers gate it to
 * accounts that plausibly need it (not yet eligible, still onboarding). Fails quietly — a Clerk hiccup must not break
 * the page it runs on; the next visit tries again.
 */
export async function claimSiteInviteGrant(userId: string): Promise<boolean> {
  if (!isClerkConfigured() || userId === "demo-user") return false;
  try {
    const user = await (await clerkClient()).users.getUser(userId);
    const primary =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
    return await recordSiteInvite(userId, user.publicMetadata as Record<string, unknown>, {
      email: primary?.emailAddress ?? null,
    });
  } catch (err) {
    console.error("[site-invites] invite grant check failed", err);
    return false;
  }
}
