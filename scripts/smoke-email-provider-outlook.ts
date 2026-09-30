/**
 * Outlook provider: the sendMail payload, error classification (incl. the ambiguous 5xx rule),
 * the x-orbit-send-id header, and findSent with and without Mail.Read. Fetch is mocked.
 * Run: npx tsx scripts/smoke-email-provider-outlook.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { ORBIT_SEND_HEADER, outlookProvider, sendMailPayload } from "../src/lib/email/providers/outlook";
import { MailProviderError } from "../src/lib/email/providers/types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-outlook-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Mode = "ok" | "400" | "401" | "403" | "413" | "429" | "500" | "503" | "504" | "network";
let mode: Mode = "ok";
let headerInSent: string | null = null;
const calls: { url: string; method: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  if (url.includes("/me/sendMail")) {
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode !== "ok") return new Response(JSON.stringify({ error: { code: "x", message: "nope" } }), { status: Number(mode) });
    return new Response(null, { status: 202 });
  }
  if (url.includes("/mailFolders/sentitems/messages?")) {
    return Response.json({
      value: [
        { id: "m-other", conversationId: "c-0", subject: "Something else" },
        { id: "m-1", conversationId: "c-1", subject: "Hi" },
      ],
    });
  }
  if (url.includes("/messages/m-1?")) {
    return Response.json({
      id: "m-1",
      conversationId: "c-1",
      internetMessageHeaders: headerInSent ? [{ name: ORBIT_SEND_HEADER, value: headerInSent }] : [],
    });
  }
  return new Response("unexpected", { status: 599 });
}) as typeof fetch;

const MSG = {
  from: { name: "Me", email: "me@contoso.io" },
  to: ["a@x.org"],
  cc: ["c@x.org"],
  bcc: ["b@x.org"],
  subject: "Hi",
  bodyText: "Body",
  bodyHtml: null,
  messageId: "<id-1@orbit.mail>",
};
const OPTS = { sendId: "row-1" };

async function kind(m: Mode): Promise<string> {
  mode = m;
  try {
    await outlookProvider.send(USER, MSG, OPTS);
    return "ok";
  } catch (e) {
    return e instanceof MailProviderError ? e.kind : `raw:${String(e)}`;
  }
}

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    console.log("payload");
    const p = sendMailPayload(MSG, MSG.messageId);
    check(
      "to/cc/bcc as recipients",
      p.message.toRecipients[0]?.emailAddress.address === "a@x.org" &&
        p.message.ccRecipients.length === 1 &&
        p.message.bccRecipients[0]?.emailAddress.address === "b@x.org"
    );
    check("plain body as Text", p.message.body.contentType === "Text" && p.message.body.content === "Body");
    check("html body as HTML", sendMailPayload({ ...MSG, bodyHtml: "<p>x</p>" }, "h").message.body.contentType === "HTML");
    check("the send header is x- prefixed", ORBIT_SEND_HEADER.startsWith("x-"));
    check("carries the send header", p.message.internetMessageHeaders.some((h) => h.name === ORBIT_SEND_HEADER && h.value === MSG.messageId));
    check("saved to Sent Items", p.saveToSentItems === true);
    check("no From override (the signed-in mailbox sends)", !("from" in p.message));

    await db.insert(schema.outlookConnections).values({
      userId: USER,
      emailAddress: "Me@Contoso.io",
      accessTokenEncrypted: encrypt("tok"),
      refreshTokenEncrypted: encrypt("ref"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: MICROSOFT_SCOPES.contacts,
      status: "active",
    });
    const where = eq(schema.outlookConnections.userId, USER);
    check("no send scope → no identity", (await outlookProvider.identity(USER)) === null);
    await db.update(schema.outlookConnections).set({ scopes: `${MICROSOFT_SCOPES.contacts} ${MICROSOFT_SCOPES.mailSend}` }).where(where);
    check("send scope → lowercased identity", (await outlookProvider.identity(USER))?.email === "me@contoso.io");

    console.log("send");
    calls.length = 0;
    mode = "ok";
    const res = await outlookProvider.send(USER, MSG, OPTS);
    check("202 → sent, with no ids (Graph returns none)", res.providerMessageId === null && res.providerThreadId === null);
    check("exactly one sendMail POST", calls.filter((c) => c.url.includes("/me/sendMail") && c.method === "POST").length === 1);
    check("400 → permanent", (await kind("400")) === "permanent");
    check("413 → permanent", (await kind("413")) === "permanent");
    check("401 → auth", (await kind("401")) === "auth");
    check("403 → auth", (await kind("403")) === "auth");
    check("429 → transient", (await kind("429")) === "transient");
    check("503 → transient", (await kind("503")) === "transient");
    check("500 → ambiguous", (await kind("500")) === "ambiguous");
    check("504 → ambiguous", (await kind("504")) === "ambiguous");
    check("network → ambiguous", (await kind("network")) === "ambiguous");
    calls.length = 0;
    await kind("503");
    check("sendMail is never retried inside the provider", calls.filter((c) => c.url.includes("/me/sendMail")).length === 1);

    console.log("findSent");
    const ref = { rfcMessageId: MSG.messageId, subject: "Hi", since: new Date(Date.now() - 60_000) };
    check("no Mail.Read → unknown", (await outlookProvider.findSent(USER, ref)) === "unknown");
    await db.update(schema.outlookConnections).set({ scopes: `${MICROSOFT_SCOPES.mailSend} ${MICROSOFT_SCOPES.mail}` }).where(where);
    headerInSent = MSG.messageId;
    calls.length = 0;
    const hit = await outlookProvider.findSent(USER, ref);
    check("header match → found, with ids", typeof hit === "object" && hit?.providerMessageId === "m-1" && hit.providerThreadId === "c-1", JSON.stringify(hit));
    check("only same-subject candidates are opened", !calls.some((c) => c.url.includes("/messages/m-other")));
    const search = calls.find((c) => c.url.includes("/mailFolders/sentitems/messages?"));
    check("the search is bounded by time", Boolean(search && decodeURIComponent(search.url).includes("sentDateTime ge ")));
    headerInSent = "<someone-else@orbit.mail>";
    check("same subject, different header → not found", (await outlookProvider.findSent(USER, ref)) === null);

    console.log("reauth");
    await db.update(schema.outlookConnections).set({ status: "needs_reauth" }).where(where);
    check("needs_reauth → no identity", (await outlookProvider.identity(USER)) === null);
    check("needs_reauth → send is auth, never ambiguous", (await kind("ok")) === "auth");
  } finally {
    globalThis.fetch = realFetch;
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Outlook provider checks passed.");
}

run(main);
