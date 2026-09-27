/**
 * Who this key belongs to, and what their plan allows.
 *
 * Small, but not optional: Zapier requires a "connection test" endpoint to validate a key
 * when someone connects the app, and uses a field from the response as the connection's
 * label. Make and n8n want the same thing. An API without this cannot ship a Zapier app.
 */
import { apiHandler, apiOk } from "@/lib/api/http";
import { ensureUserSettings } from "@/lib/user-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler({ scope: "read", bucket: "apiRead" }, async (_request, { caller }) => {
  // The key check already resolved the plan from this row; reading it once more is only for
  // the name and email.
  const settings = await ensureUserSettings(caller.userId);
  const { entitlements } = caller;
  return apiOk({
    // Zapier labels the connection with this.
    email: settings.email ?? null,
    name: [settings.firstName, settings.lastName].filter(Boolean).join(" ") || null,
    plan: entitlements.plan,
    // Lets an integration disable its own write actions rather than discovering 403s.
    scopes: caller.scopes,
    keyPrefix: caller.prefix,
  });
});
