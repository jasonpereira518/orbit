import { after } from "next/server";
import "@/lib/email/origin-registrations";
import { dispatchEmailSend } from "@/lib/email/outbox";
import { reportError } from "@/lib/report-error";

/**
 * Sends a queued email once its undo window has passed, after the response has gone out.
 * `after()` runs within the function's own maxDuration (it buys no extra time), which is
 * plenty for a 10s wait plus one 20s provider call. If this never runs — the instance is
 * recycled — the ten-minute drain sends it instead, so this is load-bearing for speed only,
 * never for delivery. The only module under src/lib/email that imports next/server.
 */
export function scheduleDispatch(id: string, sendAt: Date): void {
  const task = async () => {
    const wait = Math.max(0, sendAt.getTime() - Date.now()) + 250;
    await new Promise((resolve) => setTimeout(resolve, wait));
    await dispatchEmailSend(id).catch((err) => reportError(err, { where: "email.after-dispatch" }));
  };
  try {
    after(task);
  } catch {
    // No request scope (a script or job): the drain picks it up.
  }
}
