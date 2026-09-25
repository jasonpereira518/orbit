/**
 * The admin invitation email (src/lib/site-invite-email.ts): the boarding pass that replaces
 * Clerk's stock invitation. Builds both variants and checks what a recipient depends on —
 * the link, their address, the greeting, the board-by date — and that nothing they typed
 * reaches the HTML unescaped.
 *
 * Pure: builds strings, sends nothing. Run: npx tsx scripts/smoke-site-invite-email.ts
 */
import { buildSiteInviteEmail } from "../src/lib/site-invite-email";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

process.env.APP_BASE_URL = "https://orbit.test";
const url = "https://clerk.orbit.test/v1/tickets/accept?ticket=abc&redirect_url=x";
const expiresAt = new Date(Date.UTC(2026, 9, 25, 12));

console.log("The invitation…");
const invite = buildSiteInviteEmail({
  email: "maya@example.com",
  url,
  kind: "invite",
  planet: "mars",
  firstName: "Maya",
  expiresAt,
});
check("the subject names the pass", invite.subject === "Now boarding: your Orbit pass");
check("the button carries the ticket link, escaped", invite.html.includes(url.replace(/&/g, "&amp;")));
check("the plain text carries it raw", invite.text.includes(url));
check("it greets them by name", invite.html.includes("Your wait is over, Maya.") && invite.text.startsWith("Your wait is over, Maya."));
check("the passenger is their address", invite.html.includes("maya@example.com"));
check("it shows the board-by date", invite.html.includes("Oct 25, 2026") && invite.text.includes("Board by: Oct 25, 2026"));
check("it uses their planet, from the app's own domain", invite.html.includes("https://orbit.test/landing/planets/mars.png"));
check("it boards", invite.html.includes("Board Orbit"));
check("it is signed", invite.text.includes("— Jason"));

console.log("\nWithout a name, and with hostile input…");
const bare = buildSiteInviteEmail({ email: "a@b.co", url, kind: "invite", planet: "earth", firstName: "  ", expiresAt });
check("a blank name falls back to the plain greeting", bare.html.includes("Your wait is over.</td>"));
const hostile = buildSiteInviteEmail({
  email: "x@y.co",
  url,
  kind: "invite",
  planet: "earth",
  firstName: `<script>alert("hi")</script>`,
  expiresAt,
});
check("a typed name is escaped", !hostile.html.includes("<script>") && hostile.html.includes("&lt;script&gt;"));

console.log("\nThe existing-account variant…");
const existing = buildSiteInviteEmail({
  email: "old@example.com",
  url: "https://orbit.test/sign-in",
  kind: "existing-account",
  planet: "earth",
});
check("it signs in rather than boarding", existing.html.includes("Sign in to Orbit") && !existing.html.includes("Board Orbit"));
check("it has no board-by date", !existing.html.includes("Board by") && !existing.text.includes("Board by"));

console.log("\nThe invitation email reads right.");
