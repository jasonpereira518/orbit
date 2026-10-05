"use server";

import { cookies, headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import {
  POLL_ERROR,
  POLL_VOTER_COOKIE,
  type PollResults,
  type StarAllocation,
} from "@/lib/waitlist-poll";
import { setStarsCore } from "@/lib/waitlist-poll-votes";

/**
 * The request-reading half of a poll write. Everything that decides what happens lives in
 * `lib/waitlist-poll-votes.ts`, which the smoke drives without a request.
 *
 * Reads the IP and the `wp_voter` cookie, and mints the cookie when the core says the voter
 * has none. The minted id never goes back to the client in the response — the cookie is
 * httpOnly, and the client has no use for it.
 *
 * The client sends the WHOLE allocation each time (option id → stars), never a delta: two
 * quick taps then cannot apply out of order, and the server re-checks the budget from the
 * visitor's real referral count on every write.
 *
 * A "use server" file may export only async functions, so the types the client needs are
 * spelled out in the return type rather than exported.
 */
export async function setPollStars(input: {
  allocation: StarAllocation;
  me?: string | null;
}): Promise<
  | { ok: true; allocation: StarAllocation; budget: number; results: PollResults }
  | { ok: false; message: string }
> {
  // A server action is a public POST endpoint: the types above are not enforced at runtime.
  const raw: unknown = input;
  if (raw === null || typeof raw !== "object") return { ok: false, message: POLL_ERROR };
  const { allocation, me } = raw as { allocation?: unknown; me?: unknown };
  if (allocation === null || typeof allocation !== "object") return { ok: false, message: POLL_ERROR };

  const ip = clientIpFrom(await headers());
  const jar = await cookies();
  const voterId = jar.get(POLL_VOTER_COOKIE)?.value ?? null;

  const result = await setStarsCore({ allocation, me: typeof me === "string" ? me : null, voterId }, { ip });
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
  return { ok: true, allocation: result.allocation, budget: result.budget, results: result.results };
}
