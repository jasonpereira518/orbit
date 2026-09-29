"use server";

import { cookies, headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { POLL_ERROR, POLL_VOTER_COOKIE, type PollOptionId, type PollResults } from "@/lib/waitlist-poll";
import { castVoteCore } from "@/lib/waitlist-poll-votes";

/**
 * The request-reading half of a poll vote. Everything that decides what happens lives in
 * `lib/waitlist-poll-votes.ts`, which the smoke drives without a request.
 *
 * Reads the IP and the `wp_voter` cookie, and mints the cookie when the core says the voter
 * has none. The minted id never goes back to the client in the response — the cookie is
 * httpOnly, and the client has no use for it.
 *
 * A "use server" file may export only async functions, so the types the client needs are
 * spelled out in the return type rather than exported.
 */
export async function castPollVote(input: {
  optionId: string;
  me?: string | null;
}): Promise<
  | { ok: true; choice: PollOptionId; results: PollResults }
  | { ok: false; message: string }
> {
  // A server action is a public POST endpoint: the types above are not enforced at runtime.
  const raw: unknown = input;
  if (raw === null || typeof raw !== "object") return { ok: false, message: POLL_ERROR };
  const { optionId, me } = raw as { optionId?: unknown; me?: unknown };
  if (typeof optionId !== "string") return { ok: false, message: POLL_ERROR };

  const ip = clientIpFrom(await headers());
  const jar = await cookies();
  const voterId = jar.get(POLL_VOTER_COOKIE)?.value ?? null;

  const result = await castVoteCore({ optionId, me: typeof me === "string" ? me : null, voterId }, { ip });
  if (!result.ok) return result;

  if (result.newVoterId) {
    jar.set(POLL_VOTER_COOKIE, result.newVoterId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return { ok: true, choice: result.choice, results: result.results };
}
