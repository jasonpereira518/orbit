"use server";

import { recordAccountAudit } from "@/lib/account-audit";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAppBaseUrl } from "@/lib/app-url";
import { clearApiKey } from "@/actions/settings";
import {
  OPENROUTER_STATE_COOKIE,
  challengeFor,
  createVerifier,
  encodeState,
} from "@/lib/openrouter-oauth";
import { z } from "zod";
import { defineAction } from "@/lib/input/action";

/**
 * Starts the OpenRouter connect round trip (spec §3). No client id, no secret, no
 * pre-registered redirect URI — OpenRouter's PKCE flow takes `callback_url` per request,
 * so this works against a local dev server exactly as it does in production.
 *
 * The authorize URL carries no `state` — OpenRouter's own auth endpoint has none — so the
 * CSRF defence is PKCE itself: an attacker's authorization code was issued against the
 * attacker's own `code_challenge`, and the exchange in the callback route runs it against
 * *this* verifier instead, which fails. The verifier is the load-bearing secret, which is
 * why it rides encrypted in the state cookie rather than plainly.
 */
export const startOpenRouterConnect = defineAction(
  { schema: z.tuple([z.looseObject({ returnTo: z.string().optional() })]) },
  async (userId, input: {
    returnTo?: string;
  }): Promise<{ url: string }> => {
    const verifier = createVerifier();
    const challenge = challengeFor(verifier);

    const jar = await cookies();
    jar.set(
      OPENROUTER_STATE_COOKIE,
      encodeState({ userId, verifier, returnTo: input.returnTo }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        // Matches OpenRouter's own 10-minute authorization-code expiry.
        maxAge: 600,
      }
    );

    const params = new URLSearchParams({
      callback_url: `${getAppBaseUrl()}/api/openrouter/callback`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      key_label: "Orbit",
    });
    return { url: `https://openrouter.ai/auth?${params.toString()}` };
  }
);

/** Disconnects OpenRouter — the same clear a pasted key gets, so More options stays in sync. */
export const disconnectOpenRouter = defineAction(
  {},
  async (userId): Promise<void> => {
    await clearApiKey("openrouter");
    await recordAccountAudit({ userId, action: "integration.disconnect", resourceType: "openrouter" });
    revalidatePath("/settings");
  }
);
