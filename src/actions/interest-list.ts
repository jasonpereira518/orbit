"use server";

import { cookies, headers } from "next/headers";
import { ATTRIBUTION_COOKIE, parseAttribution } from "@/lib/attribution-parse";
import type { InterestListInput, InterestListResult } from "@/lib/interest-list";
import { joinInterestListCore } from "@/lib/interest-list-join";

/**
 * The request-reading half of the join. Everything that decides what happens lives in
 * `lib/interest-list-join.ts`, which the smoke test drives without a request.
 */
export async function joinInterestList(
  input: InterestListInput
): Promise<InterestListResult> {
  const headerList = await headers();
  // First hop in x-forwarded-for is the client; the rest are proxies.
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip")?.trim() ||
    "unknown";

  const cookieStore = await cookies();
  const attribution = parseAttribution(cookieStore.get(ATTRIBUTION_COOKIE)?.value ?? null);

  return joinInterestListCore(input, { ip, attribution });
}
