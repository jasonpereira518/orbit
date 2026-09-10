import { getAdminHealth, type AdminHealth } from "@/lib/admin-health";
import {
  reconcileAdminIssues,
  type DetectedAdminIssue,
} from "@/lib/admin-issues";
import type { ProviderStatus } from "@/lib/admin-providers";

function healthIssues(health: AdminHealth): DetectedAdminIssue[] {
  const issues: DetectedAdminIssue[] = [];

  for (const row of health.missingKeyAccounts) {
    issues.push({
      fingerprint: `missing-ai-key:${row.userId}:${row.provider}`,
      source: "account-health",
      severity: "warn",
      title: "AI is unavailable for an account",
      message: `No ${row.provider} key is configured.`,
      targetUserId: row.userId,
      resourceType: "account",
      resourceId: row.userId,
    });
  }

  for (const row of health.connections) {
    issues.push({
      fingerprint: `mail-connection:${row.provider}:${row.userId}`,
      source: "account-health",
      severity: "error",
      title: `${row.provider === "gmail" ? "Gmail" : "Outlook"} connection needs repair`,
      message:
        row.reason === "expired"
          ? "The provider token expired."
          : `Connection status is ${row.status}.`,
      targetUserId: row.userId,
      resourceType: `${row.provider}-connection`,
      resourceId: row.userId,
    });
  }

  for (const row of health.calendars) {
    issues.push({
      fingerprint: `calendar-feed:${row.subscriptionId}`,
      source: "account-health",
      severity: "error",
      title: "Calendar feed is failing",
      message: row.lastSyncError?.slice(0, 240) || "The last calendar sync failed.",
      targetUserId: row.userId,
      resourceType: "calendar-subscription",
      resourceId: row.subscriptionId,
    });
  }

  for (const row of health.imports) {
    issues.push({
      fingerprint: `import:${row.importId}`,
      source: "account-health",
      severity: row.stalled ? "warn" : "error",
      title: row.stalled ? "Import is stalled" : "Import failed",
      message: row.errorMessage?.slice(0, 240) || `${row.importType} needs attention.`,
      targetUserId: row.userId,
      resourceType: "import",
      resourceId: row.importId,
    });
  }

  for (const row of health.aiErrors) {
    if (row.failures < 3 && row.accounts < 2) continue;
    issues.push({
      fingerprint: `ai-failure:${row.provider}:${row.operation}:${row.errorKind}`,
      source: "account-health",
      severity: row.accounts >= 2 ? "error" : "warn",
      title: `${row.provider} failures are recurring`,
      message: `${row.failures} ${row.errorKind} failures in ${row.operation} affected ${row.accounts} account${row.accounts === 1 ? "" : "s"}.`,
      resourceType: "ai-operation",
      resourceId: row.operation,
    });
  }

  return issues;
}

export async function refreshHealthIssues(now = new Date()): Promise<AdminHealth> {
  const health = await getAdminHealth({ now, windowDays: 1 });
  await reconcileAdminIssues("account-health", healthIssues(health), now);
  return health;
}

export async function reconcileProviderIssues(
  providers: ProviderStatus[],
  now = new Date()
): Promise<void> {
  const detected: DetectedAdminIssue[] = providers
    .filter((provider) => provider.status === "degraded" || provider.status === "unavailable")
    .map((provider) => ({
      fingerprint: `provider:${provider.provider}`,
      source: "providers",
      severity: provider.status === "unavailable" ? "error" : "warn",
      title: `${provider.label} is ${provider.status}`,
      message: provider.detail,
      resourceType: "provider",
      resourceId: provider.provider,
    }));
  await reconcileAdminIssues("providers", detected, now);
}
