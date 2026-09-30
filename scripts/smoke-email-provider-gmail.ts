/**
 * Gmail provider: error classification, Bcc handling, findSent, and sender resolution.
 * Fetch is mocked; no network. Run: npx tsx scripts/smoke-email-provider-gmail.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { gmailProvider } from "../src/lib/email/providers/gmail";
import { MailProviderError } from "../src/lib/email/providers/types";
import { resolveSender } from "../src/lib/email/sender";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-provider-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Mode = "ok" | "500" | "429" | "400" | "401" | "403" | "network" | "noid";
let mode: Mode = "ok";
const calls: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  calls.push({ url: u, body: String(init?.body ?? "") });
  if (u.includes("/messages?q=")) {
    const hit = u.includes("found");
    return new Response(JSON.stringify(hit ? { messages: [{ id: "m-found", threadId: "t-found" }] } : {}), { status: 200 });
  }
  if (mode === "network") throw new TypeError("fetch failed");
  if (mode === "noid") return new Response("{}", { status: 200 });
  if (mode !== "ok") return new Response("nope", { status: Number(mode) });
  return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), { status: 200 });
}) as typeof fetch;

const MSG = {
  from: { name: "Me", email: "me@x.org" },
  to: ["a@x.org"],
  cc: [],
  bcc: ["b@x.org"],
  subject: "Hi",
  bodyText: "Body",
  bodyHtml: null,
  messageId: "<id-1@orbit.mail>",
};

async function kind(m: Mode): Promise<string> {
  mode = m;
  try {
    await gmailProvider.send(USER, MSG, { sendId: "row-1" });
    return "ok";
  } catch (e) {
    return e instanceof MailProviderError ? e.kind : `raw:${String(e)}`;
  }
}

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    check("not connected → resolveSender refuses", (await resolveSender(USER)).ok === false);

    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "Me@X.org",
      accessTokenEncrypted: encrypt("tok"),
      refreshTokenEncrypted: encrypt("ref"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.contacts,
      status: "active",
    });
    const where = eq(schema.gmailConnections.userId, USER);
    const noScope = await resolveSender(USER);
    check("no send scope → no_send_scope", !noScope.ok && noScope.reason === "no_send_scope");

    await db.update(schema.gmailConnections).set({ scopes: `${GOOGLE_SCOPES.contacts} ${GOOGLE_SCOPES.gmailSend}` }).where(where);
    const ok = await resolveSender(USER);
    check("send scope → gmail, lowercased address", ok.ok && ok.provider === "gmail" && ok.fromEmail === "me@x.org", JSON.stringify(ok));

    mode = "ok";
    calls.length = 0;
    const sent = await gmailProvider.send(USER, MSG, { sendId: "row-1" });
    check("returns provider ids", sent.providerMessageId === "m1" && sent.providerThreadId === "t1");
    const raw = Buffer.from(JSON.parse(calls[0]!.body).raw, "base64url").toString("utf8");
    check("Bcc travels in the raw header for Gmail", /^Bcc: b@x\.org$/m.test(raw.split("\r\n\r\n")[0]!));

    check("500 → transient", (await kind("500")) === "transient");
    check("429 → transient", (await kind("429")) === "transient");
    check("400 → permanent", (await kind("400")) === "permanent");
    check("401 → auth", (await kind("401")) === "auth");
    check("403 → auth (missing scope)", (await kind("403")) === "auth");
    check("network drop → ambiguous", (await kind("network")) === "ambiguous");
    check("200 without id → ambiguous", (await kind("noid")) === "ambiguous");

    check("findSent without read scope → unknown", (await gmailProvider.findSent(USER, { rfcMessageId: "<found@x>", subject: "Hi", since: new Date(0) })) === "unknown");
    await db.update(schema.gmailConnections).set({ scopes: `${GOOGLE_SCOPES.gmailSend} ${GOOGLE_SCOPES.gmailRead}` }).where(where);
    const found = await gmailProvider.findSent(USER, { rfcMessageId: "<found@x>", subject: "Hi", since: new Date(0) });
    check("findSent with read scope finds by rfc822msgid", typeof found === "object" && found?.providerMessageId === "m-found");
    check("findSent miss → null", (await gmailProvider.findSent(USER, { rfcMessageId: "<missing@x>", subject: "Hi", since: new Date(0) })) === null);

    await db.update(schema.gmailConnections).set({ status: "needs_reauth" }).where(where);
    const re = await resolveSender(USER);
    check("needs_reauth surfaces", !re.ok && re.reason === "needs_reauth");
    check("token failure is auth, never ambiguous", (await kind("ok")) === "auth");
  } finally {
    globalThis.fetch = realFetch;
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Gmail provider checks passed.");
}

run(main);
