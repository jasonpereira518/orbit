import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { sendTierEmail } from "@/lib/interest-list-email";
import { sendSiteInviteEmail } from "@/lib/site-invite-email";

const RECIPIENT = "private.person@example.com";
const realFetch = globalThis.fetch;
const saved = { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL };

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_fake";
  process.env.RESEND_FROM_EMAIL = "hello@example.com";
  // Resend echoing the recipient in its message, as it does for a malformed address.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ name: "validation_error", message: `Invalid \`to\` field: ${RECIPIENT}`, statusCode: 422 }),
      { status: 422, headers: { "content-type": "application/json" } }
    ));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (saved.key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = saved.key;
  if (saved.from === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = saved.from;
});

function everything(calls: { arguments: unknown[] }[]): string {
  return calls.map((c) => c.arguments.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a) ?? String(a))).join(" ")).join("\n");
}

describe("Resend rejections are reported without the recipient", () => {
  it("site invite email", async () => {
    const errors = mock.method(console, "error", () => {});
    try {
      const ok = await sendSiteInviteEmail({ subject: "s", html: "<p>h</p>", text: "t" }, RECIPIENT);
      assert.equal(ok, false);
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /^\[orbit:site\.invite\.email\.rejected\] ref=/);
      assert.ok(!everything(errors.mock.calls).includes(RECIPIENT));
    } finally {
      errors.mock.restore();
    }
  });

  it("waitlist tier email", async () => {
    const errors = mock.method(console, "error", () => {});
    try {
      const ok = await sendTierEmail(
        RECIPIENT,
        "https://example.com/u",
        "earth",
        { ticketUrl: "https://example.com/t", shareUrl: "https://example.com/s" },
        { at: 3 } as Parameters<typeof sendTierEmail>[4]
      );
      assert.equal(ok, false);
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /^\[orbit:interest\.email\.rejected\] ref=/);
      assert.ok(!everything(errors.mock.calls).includes(RECIPIENT));
    } finally {
      errors.mock.restore();
    }
  });
});
