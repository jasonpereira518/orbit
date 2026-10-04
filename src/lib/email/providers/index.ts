import type { EmailProviderId } from "@/db/schema";
import { demoProvider } from "@/lib/email/providers/demo";
import { gmailProvider } from "@/lib/email/providers/gmail";
import type { MailProvider } from "@/lib/email/providers/types";

const overrides = new Map<EmailProviderId, MailProvider>();

export function providerFor(id: EmailProviderId): MailProvider {
  const override = overrides.get(id);
  if (override) return override;
  if (id === "gmail") return gmailProvider;
  if (id === "demo") return demoProvider;
  throw new Error(`Mail provider ${id} is not available yet`);
}

/** Smoke tests only: swap a provider for a fake. Pass null to restore. */
export function setProviderOverride(id: EmailProviderId, provider: MailProvider | null) {
  if (provider) overrides.set(id, provider);
  else overrides.delete(id);
}
