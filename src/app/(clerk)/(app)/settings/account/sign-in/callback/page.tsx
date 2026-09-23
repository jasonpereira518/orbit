import { isClerkConfigured } from "@/lib/auth";
import { redirect } from "next/navigation";
import { SsoReturn } from "@/components/account/sso-return";

/**
 * The return leg of connecting a provider.
 *
 * Clerk's OAuth handshake finishes in the browser, so this route exists only to mount the
 * component that completes it and then sends the person back to the Sign-in screen. With no
 * Clerk keys there is no handshake to finish, so it just bounces.
 */
export default async function SignInCallbackPage() {
  if (!isClerkConfigured()) redirect("/settings/account/sign-in");
  return <SsoReturn />;
}
