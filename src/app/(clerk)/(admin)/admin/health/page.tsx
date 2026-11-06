import { AccountsPanels } from "@/components/admin/ops-panels";
import { OpsShell } from "./_ops/ops-shell";
import { loadHealth, loadOps } from "./_ops/data";

export const metadata = { title: "Admin · Ops" };

/**
 * Ops › Accounts: what is broken for a person, right now.
 *
 * The inspector has always shown these signals one account at a time, which means a dead
 * Gmail token was only visible if you happened to open the one page it lived on. Same
 * predicates, gathered by the question they answer, and every row names the account and
 * carries the button that fixes it.
 *
 * The route stays `/admin/health` (Slack alerts link here). A snapshot, not a poll: the
 * header's Refresh re-reads it, and every fix button refreshes it after it lands.
 */
export default async function AdminOpsAccountsPage() {
  const [health, ops] = await Promise.all([loadHealth(), loadOps()]);
  return (
    <OpsShell>
      <AccountsPanels health={health} ops={ops} />
    </OpsShell>
  );
}
