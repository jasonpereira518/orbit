import { NextResponse, type NextRequest } from "next/server";
import { AdminForbiddenError, requireAdminUserId } from "@/lib/admin";
import {
  asWelcomePlanet,
  buildInterestListFollowUpEmail,
  buildInterestListWelcomeEmail,
} from "@/lib/interest-list-email";
import { buildBroadcastEmail, loadBroadcast } from "@/lib/broadcasts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Renders an email template in the browser, so it can be looked at without sending one.
 *
 * A route handler rather than a page because the output IS a whole HTML document — the
 * template owns its own `<html>` and `<body>`, and nesting that inside the admin shell
 * would render something that is not the email.
 *
 * IT GATES ITSELF. `(admin)/layout.tsx` does not run for route handlers, so the first thing
 * this does is `requireAdminUserId()`, and `AdminForbiddenError` becomes a 404 with no body
 * — a 403 would confirm the endpoint exists and gates by role.
 *
 * NOTHING HERE SENDS. The preview builds the same message the mailer would and returns it,
 * which is the point: the failure this prevents is discovering a broken template by mailing
 * it to the list.
 */

const TEMPLATES = ["welcome", "follow-up", "broadcast"] as const;
type Template = (typeof TEMPLATES)[number];

function isTemplate(value: string | null): value is Template {
  return value != null && (TEMPLATES as readonly string[]).includes(value);
}

/** Obviously fake, so a preview can never be mistaken for a real subscriber's link. */
const SAMPLE_UNSUBSCRIBE = "https://example.invalid/unsubscribe?token=preview";

export async function GET(request: NextRequest) {
  try {
    await requireAdminUserId();
  } catch (err) {
    if (err instanceof AdminForbiddenError) {
      return new NextResponse("Not found", { status: 404 });
    }
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const templateParam = url.searchParams.get("template");
  const template: Template = isTemplate(templateParam) ? templateParam : "welcome";
  const planet = asWelcomePlanet(url.searchParams.get("planet"));
  const format = url.searchParams.get("format") === "text" ? "text" : "html";

  let message: { subject: string; html: string; text: string };

  if (template === "broadcast") {
    // A real draft when one is named, so the preview shows what would actually go out.
    const id = url.searchParams.get("id");
    const draft = id ? await loadBroadcast(id) : null;
    message = buildBroadcastEmail({
      subject: draft?.subject ?? "A sample subject line",
      body:
        draft?.body ??
        "This is what a broadcast looks like.\n\nThe first paragraph is set larger, as the opening line. Everything after it is body copy.\n\nWrite plain prose — the shell, the logo and the unsubscribe footer are added for you.",
      unsubscribeUrl: SAMPLE_UNSUBSCRIBE,
    });
  } else if (template === "follow-up") {
    message = buildInterestListFollowUpEmail({
      unsubscribeUrl: SAMPLE_UNSUBSCRIBE,
      planet,
    });
  } else {
    message = buildInterestListWelcomeEmail({
      unsubscribeUrl: SAMPLE_UNSUBSCRIBE,
      planet,
    });
  }

  if (format === "text") {
    return new NextResponse(`Subject: ${message.subject}\n\n${message.text}`, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  }

  return new NextResponse(message.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
