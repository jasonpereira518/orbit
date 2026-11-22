import { reportError } from "@/lib/report-error";
import {
  AdminPanel,
  AdminTable,
  EmptyState,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { InviteForm, InviteRowActions } from "@/components/admin/site-access";
import { isClerkConfigured } from "@/lib/demo-account";
import { getSiteMode } from "@/lib/site-access";
import { listSiteInvites, type SiteInviteRow } from "@/lib/site-invites";
import { cn } from "@/lib/utils";
import { AccessHeader, absoluteUtc } from "../access-header";

export const metadata = { title: "Admin · Invites" };

const STATUS_LABEL: Record<SiteInviteRow["status"], string> = {
  pending: "Waiting",
  accepted: "Signed up",
  revoked: "Revoked",
  expired: "Expired",
};

/**
 * The invitations that let new people past stealth (the switch itself is in the shared Access
 * header). See `src/lib/site-access.ts` for what stealth does and `src/lib/site-invites.ts`
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
      reportError(err, { where: "admin.access.invites", level: "warning" });
      return null;
    }),
  ]);

  return (
    <>
      <AccessHeader mode={mode} subtitle="Who's been invited in while the site is in stealth." />

      <div className="space-y-6">
        <AdminPanel title="Invite someone">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              An invitation lets one address create an account, even in stealth. Clerk sends the
              email, or leave that off and send the link yourself. A wave label (w1, w2…) is optional; it
              names this batch so waves can be compared later.
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
            <AdminTable label="Invitations"
              head={
                <>
                  <Th>Email</Th>
                  <Th>Wave</Th>
                  <Th>Status</Th>
                  <Th>Sent</Th>
                  <Th className="text-right">Actions</Th>
                </>
              }
            >
              {invites.map((invite) => (
                <tr key={invite.id} className="border-b border-border/40 last:border-0">
                  <Td className="font-medium text-ink">{invite.email}</Td>
                  <Td className="text-muted-foreground">{invite.waveId ?? "—"}</Td>
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
                    <span title={`${absoluteUtc(invite.createdAt)} UTC`}>
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
