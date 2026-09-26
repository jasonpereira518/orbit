import { NextResponse } from "next/server";
import { backfillContactAvatars } from "@/actions/contacts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The avatar backfill, over plain `fetch` instead of a Server Action.
 *
 * Next dispatches Server Actions one at a time per tab, and this loop — mounted on every app
 * page — spends about a second per batch on external lookups (Google, Outlook, Apollo,
 * image downloads). As an action it held that queue on every page load, so whatever the
 * person opened next (a sheet, a draft, the notifications count) waited behind it. A route
 * handler runs alongside them. Same function, same auth (`requireUserId()` inside it), same
 * result shape.
 *
 * A cookie-authenticated POST, so it refuses a cross-site Origin the way Server Actions do.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  let skipIds: string[] = [];
  try {
    const body = (await request.json()) as { skipIds?: unknown };
    if (Array.isArray(body.skipIds)) {
      skipIds = body.skipIds.filter((id): id is string => typeof id === "string").slice(0, 5000);
    }
  } catch {
    // No body or not JSON: nothing to skip.
  }

  try {
    return NextResponse.json(await backfillContactAvatars({ skipIds }));
  } catch {
    // Same shape of failure the action gave the loop: it only counts failures, it never shows
    // the text to anyone.
    return NextResponse.json({ error: "Avatar backfill failed" }, { status: 500 });
  }
}
