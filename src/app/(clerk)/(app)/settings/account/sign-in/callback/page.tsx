import { isClerkConfigured } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SsoReturn } from "@/components/account/sso-return";

/**
 * The return leg of connecting a provider.
 *
 * Clerk's OAuth handshake finishes in the browser, so this route exists only to mount the
 * component that completes it and then send the person back to /settings, where they can
 * reopen the account dialog. The dialog itself has no URL of its own to return to — see the
 * 2026-09-23 amendment in `docs/superpowers/specs/2026-09-22-account-page-clerk-revision-design.md`.
 * With no Clerk keys there is no handshake to finish, so it just bounces.
 */
export default async function SignInCallbackPage() {
  if (!isClerkConfigured()) redirect("/settings");
  return <SsoReturn />;
}
