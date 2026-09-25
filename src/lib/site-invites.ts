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
 * AN INVITATION IS FULL ACCESS, not just a way past stealth: the account it lands on is comped
 * to Orbit (`grantSiteInvitePlan`). The existing-account path comps on the spot; a new account
 * is comped when it first appears — from the `user.created` webhook, with the onboarding page
 * as the backstop for a webhook that never lands (`claimSiteInviteGrant`).
 *
 * No auth here; the server actions in `src/actions/admin.ts` are the gate.
 */
import { clerkClient } from "@clerk/nextjs/server";
import { isClerkConfigured } from "@/lib/demo-account";
import { getAppBaseUrl } from "@/lib/app-url";
import { recordAdminAction } from "@/lib/admin-operations";
import { hasSiteInvite, markStealthCleared, SITE_INVITE_METADATA_KEY } from "@/lib/site-access";
import { ensureUserSettings, setCompedPlan } from "@/lib/user-settings";

const INVITE_EXPIRES_DAYS = 30;
/** The plan an invitation comps. `orbit`, not `lifetime`: only `orbit` reaches every gate. */
const INVITE_PLAN = "orbit" as const;
const INVITE_COMP_NOTE = "Invited by an admin";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SiteInviteResult =
  | { kind: "invited"; email: string; url: string | null; emailed: boolean }
  | { kind: "existing-account"; email: string; url: string };

export type SiteInviteRow = {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: Date;
  url: string | null;
};

export class SiteInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteInviteError";
  }
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

export async function inviteToSite(input: {
  adminUserId: string;
  email: string;
  /** Whether Clerk emails the link. Off, the admin copies it and sends it themselves. */
  notify: boolean;
}): Promise<SiteInviteResult> {
  requireClerk();
  const email = normalizeInviteEmail(input.email);
  const marker = { [SITE_INVITE_METADATA_KEY]: { by: input.adminUserId, at: new Date().toISOString() } };
  const clerk = await clerkClient();

  const existing = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  const user = existing.data[0];
  if (user) {
    await clerk.users.updateUserMetadata(user.id, { publicMetadata: marker });
    await markStealthCleared(user.id);
    await grantSiteInvitePlan(user.id, marker, input.adminUserId);
    await recordAdminAction({
      adminUserId: input.adminUserId,
      action: "site.invite.existing_account",
      targetUserId: user.id,
      resourceType: "clerk_user",
      resourceId: user.id,
      detail: { email },
    });
    return { kind: "existing-account", email, url: `${getAppBaseUrl()}/sign-in` };
  }

  const invitation = await clerk.invitations.createInvitation({
    emailAddress: email,
    redirectUrl: `${getAppBaseUrl()}/sign-up`,
    publicMetadata: marker,
    notify: input.notify,
    expiresInDays: INVITE_EXPIRES_DAYS,
    // A second invite to the same address replaces nothing and fails without this; the
    // no-account check above is what keeps it from inviting an existing user.
    ignoreExisting: true,
  });

  await recordAdminAction({
    adminUserId: input.adminUserId,
    action: "site.invite.create",
    resourceType: "clerk_invitation",
    resourceId: invitation.id,
    detail: { email, emailed: input.notify },
  });

  return { kind: "invited", email, url: invitation.url ?? null, emailed: input.notify };
}

/** The most recent invitations, newest first. Empty without Clerk. */
export async function listSiteInvites(limit = 25): Promise<SiteInviteRow[]> {
  if (!isClerkConfigured()) return [];
  const clerk = await clerkClient();
  const { data } = await clerk.invitations.getInvitationList({ limit, orderBy: "-created_at" });
  return data.map((inv) => ({
    id: inv.id,
    email: inv.emailAddress,
    status: inv.status as SiteInviteRow["status"],
    createdAt: new Date(inv.createdAt),
    url: inv.status === "pending" ? inv.url ?? null : null,
  }));
}

export async function revokeSiteInvite(input: { adminUserId: string; invitationId: string }) {
  requireClerk();
  const clerk = await clerkClient();
  const revoked = await clerk.invitations.revokeInvitation(input.invitationId);
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
 * Comp an invited account to Orbit. A no-op without the invitation marker, and for an
 * account that already carries any comp, so an admin's hand-set Lifetime is never downgraded.
 *
 * Only `user.created`, the existing-account invite and the onboarding backstop call this —
 * never `user.updated` — so a comp an admin later revokes from the console stays revoked
 * (the onboarding backstop only runs before onboarding is finished).
 */
export async function grantSiteInvitePlan(
  userId: string,
  publicMetadata: Record<string, unknown> | null | undefined,
  adminUserId?: string | null
): Promise<boolean> {
  if (!hasSiteInvite(publicMetadata)) return false;
  const settings = await ensureUserSettings(userId);
  if (settings.compedPlan) return false;
  const invite = publicMetadata?.[SITE_INVITE_METADATA_KEY] as { by?: unknown } | undefined;
  const by = adminUserId ?? (typeof invite?.by === "string" ? invite.by : null);
  await setCompedPlan(userId, INVITE_PLAN, { note: INVITE_COMP_NOTE, adminUserId: by });
  return true;
}

/**
 * The backstop for a missed `user.created` webhook: ask Clerk whether this account was
 * invited and comp it if so. One Clerk call, so callers gate it to accounts that plausibly
 * need it (no comp yet, still onboarding). Fails quietly — a Clerk hiccup must not break
 * the page it runs on; the next visit tries again.
 */
export async function claimSiteInviteGrant(userId: string): Promise<boolean> {
  if (!isClerkConfigured() || userId === "demo-user") return false;
  try {
    const user = await (await clerkClient()).users.getUser(userId);
    return await grantSiteInvitePlan(userId, user.publicMetadata as Record<string, unknown>);
  } catch (err) {
    console.error("[site-invites] invite grant check failed", err);
    return false;
  }
}
