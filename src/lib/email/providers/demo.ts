import { randomUUID } from "node:crypto";
import { demoWorkspaceEmail } from "@/lib/demo-workspace";
import type { MailProvider } from "@/lib/email/providers/types";

/**
 * The demo workspace's mailbox: sends are recorded as sent and nothing leaves Orbit, the same
 * way recruiter sends already short-circuited it. The workspace stores no OAuth tokens.
 */
export const demoProvider: MailProvider = {
  id: "demo",
  async identity(userId) {
    const email = await demoWorkspaceEmail(userId);
    return email ? { email } : null;
  },
  async send() {
    return { providerMessageId: `demo-${randomUUID()}`, providerThreadId: null };
  },
  async findSent() {
    return null;
  },
};
