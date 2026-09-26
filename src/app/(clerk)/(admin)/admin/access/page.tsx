import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { InviteForm, InviteRowActions, StealthSwitch } from "@/components/admin/site-access";
import { isClerkConfigured } from "@/lib/demo-account";
import { getSiteMode } from "@/lib/site-access";
import { listSiteInvites, type SiteInviteRow } from "@/lib/site-invites";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Access" };

/** Absolute date, spelled out, matching the waitlist roster. */
function absolute(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

const STATUS_LABEL: Record<SiteInviteRow["status"], string> = {
  pending: "Waiting",
  accepted: "Signed up",
  revoked: "Revoked",
  expired: "Expired",
};

/**
 * Who can get into the site: the stealth switch, and the invitations that let new people
 * past it. See `src/lib/site-access.ts` for what stealth does and `src/lib/site-invites.ts`
 * for how an invitation gets someone in.
 *
 * The invitation list is Clerk's own — Clerk tracks whether each one was accepted, revoked or
 * expired, so Orbit keeps no copy to drift from it. A Clerk failure empties that panel and
 * says so, never 500s the switch above it.
 */
export default async function AdminAccessPage() {
  const clerkOn = isClerkConfigured();
  const [mode, invites] = await Promise.all([
    getSiteMode({ fresh: true }),
    listSiteInvites().catch((err: unknown) => {
      console.error("[admin] invitation list failed", err);
      return null;
    }),
  ]);

  return (
    <>
      <AdminPageHeader
        title="Access"
        subtitle="Whether the site is open, and who's been invited in while it isn't."
      />

      <div className="space-y-6">
        <AdminPanel title="Stealth">
          <StealthSwitch
            stealth={mode.stealth}
            fromConsole={mode.fromConsole}
            stealthSinceLabel={mode.stealthSince ? `${absolute(mode.stealthSince)} UTC` : null}
          />
        </AdminPanel>

        <AdminPanel title="Invite someone">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              An invitation lets one address create an account, even in stealth. Clerk sends the
              email, or leave that off and send the link yourself.
            </p>
            <InviteForm clerkOn={clerkOn} />
          </div>
        </AdminPanel>

        <AdminPanel title="Invitations">
          {invites === null ? (
            <EmptyState>Couldn’t load invitations from Clerk. Reload to try again.</EmptyState>
          ) : invites.length === 0 ? (
            <EmptyState>{clerkOn ? "No invitations yet." : "No Clerk keys on this server."}</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Email</Th>
                  <Th>Status</Th>
                  <Th>Sent</Th>
                  <Th className="text-right">Actions</Th>
                </>
              }
            >
              {invites.map((invite) => (
                <tr key={invite.id} className="border-b border-border/40 last:border-0">
                  <Td className="font-medium text-ink">{invite.email}</Td>
                  <Td>
                    <span
                      className={cn(
                        "text-xs",
                        invite.status === "accepted" && "text-primary",
                        invite.status === "pending" && "text-foreground",
                        (invite.status === "revoked" || invite.status === "expired") &&
                          "text-muted-foreground"
                      )}
                    >
                      {STATUS_LABEL[invite.status] ?? invite.status}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">
                    <span title={`${absolute(invite.createdAt)} UTC`}>
                      <RelativeTime date={invite.createdAt.toISOString()} /> ago
                    </span>
                  </Td>
                  <Td className="text-right">
                    {invite.status === "pending" ? (
                      <InviteRowActions id={invite.id} email={invite.email} url={invite.url} />
                    ) : null}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
