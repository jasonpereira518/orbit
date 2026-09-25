import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUserId, UnauthorizedError } from "@/lib/auth";
import { checkAiKey, keyCheckOutcome } from "@/lib/ai-key-check";
import { encrypt } from "@/lib/crypto";
import { DEFAULT_MODELS } from "@/lib/ai-providers";
import { applyAiKeyChange } from "@/actions/settings";
import { OPENROUTER_STATE_COOKIE, decodeState } from "@/lib/openrouter-oauth";

/** Where the connect flow lands when there is no `returnTo` to trust. */
const DEFAULT_AI_PAGE = "/settings?integration=ai";

function errorRedirect(base: URL, reason: string) {
  base.searchParams.set("openrouter", "error");
  base.searchParams.set("reason", reason);
  return NextResponse.redirect(base);
}

/**
 * OpenRouter's OAuth callback (spec §3). No `state` parameter on the way in — OpenRouter's
 * own authorize URL has none — so the CSRF defence is PKCE alone: an attacker's code was
 * issued against the attacker's `code_challenge`, and the exchange below runs it against
 * *this* verifier instead, which fails. See `startOpenRouterConnect` for the other half.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const aiPage = new URL(DEFAULT_AI_PAGE, url.origin);

  // 1. Require the Clerk session.
  let sessionUserId: string;
  try {
    sessionUserId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorRedirect(aiPage, "signed_out");
    throw err;
  }

  // 2. Read and delete the state cookie.
  const jar = await cookies();
  const raw = jar.get(OPENROUTER_STATE_COOKIE)?.value ?? null;
  jar.delete(OPENROUTER_STATE_COOKIE);
  const decoded = raw ? decodeState(raw) : null;
  if (!decoded) return errorRedirect(aiPage, "expired");

  // 3. The cookie's user must match who is signed in now.
  if (decoded.userId !== sessionUserId) return errorRedirect(aiPage, "expired");

  const returnUrl = new URL(decoded.returnTo ?? DEFAULT_AI_PAGE, url.origin);

  // 4. No code means the person cancelled on OpenRouter's screen.
  const code = url.searchParams.get("code");
  if (!code) return errorRedirect(returnUrl, "access_denied");

  // 5. Exchange the code for a key.
  let key: string;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: decoded.verifier,
        code_challenge_method: "S256",
      }),
    });
    if (!res.ok) return errorRedirect(returnUrl, "exchange_failed");
    const body = (await res.json()) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key) {
      return errorRedirect(returnUrl, "exchange_failed");
    }
    key = body.key;
  } catch {
    return errorRedirect(returnUrl, "exchange_failed");
  }

  // 6. Verify the returned key — the same check a pasted key gets.
  const outcome = keyCheckOutcome(await checkAiKey("openrouter", key), "openrouter");
  if (!outcome.save) return errorRedirect(returnUrl, "key_rejected");

  // 7. Store it and select OpenRouter, through the same write `saveAiSettings` uses — the
  // embedding-backend comparison it runs is what keeps `contact_embeddings` from mixing
  // two incompatible vector spaces, and a direct write here would bypass it.
  await applyAiKeyChange({
    userId: sessionUserId,
    provider: "openrouter",
    model: DEFAULT_MODELS.openrouter,
    encryptedKey: encrypt(key),
  });

  // 8. Done.
  returnUrl.searchParams.set("openrouter", "connected");
  return NextResponse.redirect(returnUrl);
}
