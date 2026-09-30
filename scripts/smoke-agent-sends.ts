/**
 * Assistant-drafted messages, and the seam that stops one being sent without a human.
 *
 * The assertions here are product safety properties, not features. If any of them starts
 * failing, an agent can email someone on the user's behalf without the user seeing it first:
 *
 *   - `request_send` writes a row and sends NOTHING — it reports `sent: false`, and the send
 *     paths are unreachable from it by construction rather than by choice.
 *   - Nothing reachable from MCP can approve: neither the module an agent's tool call reaches
 *     nor the MCP server itself may so much as import a send path, and no registered tool may
 *     be named as if it sends.
 *   - A pending draft can be claimed exactly once, so a double click cannot send twice.
 *   - An expired draft cannot be claimed at all.
 *   - A sent draft counts against the same daily cap as outreach.
 *
 * Run: npx tsx scripts/smoke-agent-sends.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  claimAgentSendForApproval,
  countAgentSendsToday,
  createAgentSendRequest,
  finishAgentSend,
  getAgentSendRequest,
  listPendingAgentSends,
  rejectAgentSend,
} from "../src/lib/agent-sends";
import { countSendsToday } from "../src/lib/outreach-send";
import { approveAgentSend } from "../src/lib/agent-send-approve";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { countEmailSendsToday } from "../src/lib/email/sender";
import { dispatchEmailSend } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import { MailProviderError, type MailProvider } from "../src/lib/email/providers/types";
import * as schema from "../src/db/schema";
import { generateApiKey } from "../src/lib/api/keys";
import { POST } from "../src/app/api/mcp/route";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";

const USER = "agent-send-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let rpcId = 0;
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await POST(
    new Request("https://orbit.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  );
  const body = JSON.parse(await res.text()) as {
    result?: { content?: Array<{ text: string }> };
  };
  const text = body.result?.content?.[0]?.text;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM agent_send_requests WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER}`);
  await db.execute(sql`
    INSERT INTO user_settings (user_id, comped_plan, comped_at)
    VALUES (${USER}, 'orbit', now())
    ON CONFLICT (user_id) DO UPDATE SET comped_plan = 'orbit', comped_at = now()
  `);

  const key = generateApiKey();
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${USER}, 'agent send smoke', 'api', ${key.prefix}, ${key.keyHash},
            ${JSON.stringify(["read", "write"])}::jsonb)
  `);

  // --- Nothing an agent can reach is able to send -------------------------------------------
  // A source assertion rather than a behavioural one, because the property is an absence:
  // the module an agent's tool call reaches must not even import a way to send.
  const agentReachable = readFileSync("src/lib/agent-sends.ts", "utf8");
  check(
    "agent-sends.ts imports no send path",
    !/gmail-send|outreach-send|resend/i.test(agentReachable),
    "it must stay unable to send, not merely decline to"
  );
  // Imports and tool names, not prose: the files' headers discuss `approveAgentSend` at
  // length, and a check that a comment can fail is a check nobody will trust.
  //
  // BOTH files, because the tools moved. They used to be closures inside `mcp/server.ts`,
  // and this guard read that one file; they now live in the shared registry that Orbit's own
  // chat also reads. A guard that kept pointing at the old file would have gone on passing
  // while the thing it guards moved out from under it — which is the failure mode this
  // check exists to prevent in the first place.
  const serverSource = readFileSync("src/lib/mcp/server.ts", "utf8");
  const toolSource = readFileSync("src/lib/tools/definitions.ts", "utf8");
  for (const [label, source] of [
    ["the MCP server", serverSource],
    ["the shared tool registry", toolSource],
  ] as const) {
    const imports = source.slice(0, Math.max(source.indexOf("export "), 0) || source.length);
    check(
      `${label} imports no approval or send path`,
      !/from "@\/lib\/(agent-send-approve|gmail-send|outreach-send|email\/(outbox|providers|schedule))/.test(imports),
      "an approval must not be one import away from a tool"
    );
  }

  // The names come from the registry now. Read as data rather than by regex over source, so
  // the check cannot be fooled by how a definition happens to be formatted.
  const toolNames = ORBIT_TOOLS.map((t) => t.name);
  check(
    "no registered tool approves or sends",
    // `request_send` is the allowed name because it only ever asks. Anything that reads as
    // doing the sending — send_email, send_message, approve_draft — must not exist.
    !toolNames.some((t) => /^(approve|send)/.test(t)) && toolNames.includes("request_send"),
    toolNames.join(",")
  );
  check(
    "and no tool that writes is reachable from Orbit's own chat",
    ORBIT_TOOLS.every((t) => !t.surfaces.includes("chat") || t.scope === "read"),
    ORBIT_TOOLS.filter((t) => t.surfaces.includes("chat") && t.scope !== "read")
      .map((t) => t.name)
      .join(",")
  );

  // --- request_send stages a draft and sends nothing -----------------------------------------
  const requested = await callTool(key.token, "request_send", {
    to: "someone@example.org",
    subject: "Thanks for the intro",
    body: "It was good to talk. Let me know if I can help.",
    clientName: "Claude",
  });
  check(
    "request_send reports that it did NOT send",
    requested.sent === false && requested.status === "pending_approval",
    JSON.stringify(requested)
  );
  const draftId = String(requested.draftId ?? "");
  check("request_send returns a draft id", draftId.length > 0, draftId);

  const pending = await listPendingAgentSends(USER);
  check("the draft is waiting for approval", pending.length === 1, JSON.stringify(pending.length));
  check(
    "the recipient is stored verbatim, for the human to read",
    pending[0]?.toEmail === "someone@example.org",
    pending[0]?.toEmail
  );

  const status = await getAgentSendRequest(USER, draftId);
  check("get_send_status sees it as pending", status?.status === "pending", status?.status);

  // --- A draft can be claimed exactly once ----------------------------------------------------
  const firstClaim = await claimAgentSendForApproval(USER, draftId);
  check("the first approval claims the draft", firstClaim !== null);
  const secondClaim = await claimAgentSendForApproval(USER, draftId);
  check(
    "a second approval claims nothing",
    secondClaim === null,
    "a double click must not send twice"
  );

  await finishAgentSend(draftId, { ok: true, deliveryId: "test-delivery" });
  const sent = await getAgentSendRequest(USER, draftId);
  check("a finished draft reads as sent", sent?.status === "sent", sent?.status);

  // --- Sent drafts count against the shared daily cap -----------------------------------------
  check("agent sends count today", (await countAgentSendsToday(USER)) === 1);
  check(
    "the outreach daily cap includes them",
    (await countSendsToday(USER)) === 1,
    "otherwise a connector is a way around the limit"
  );

  // --- A failed send comes back, rather than vanishing ----------------------------------------
  const retryable = await createAgentSendRequest(USER, {
    toEmail: "retry@example.org",
    body: "First attempt will fail.",
  });
  await claimAgentSendForApproval(USER, retryable.id);
  await finishAgentSend(retryable.id, { ok: false, error: "Resend API key not configured." });
  const afterFailure = await getAgentSendRequest(USER, retryable.id);
  check(
    "a failed send returns to pending, with the reason",
    afterFailure?.status === "pending" &&
      Boolean(afterFailure?.errorMessage),
    JSON.stringify({ status: afterFailure?.status, error: afterFailure?.errorMessage })
  );
  check(
    "and it can be approved again",
    (await claimAgentSendForApproval(USER, retryable.id)) !== null
  );
  await db.execute(sql`DELETE FROM agent_send_requests WHERE id = ${retryable.id}`);

  // --- Approval sends through the user's own mailbox, via the outbox ---------------------------
  let next: "ok" | "permanent" | "ambiguous" = "ok";
  let providerCalls = 0;
  const fake: MailProvider = {
    id: "gmail",
    async identity() {
      return { email: "me@acme-corp.io" };
    },
    async send() {
      providerCalls++;
      if (next !== "ok") throw new MailProviderError(next, `fake ${next}`);
      return { providerMessageId: `pm-${providerCalls}`, providerThreadId: null };
    },
    async findSent() {
      return "unknown";
    },
  };
  setProviderOverride("gmail", fake);
  const approveDraft = async (to: string) => {
    const d = await createAgentSendRequest(USER, { toEmail: to, subject: "Hi", body: "Good to meet you." });
    await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
    return { id: d.id, run: () => approveAgentSend(USER, d.id, { confirmRecipient: true }) };
  };
  try {
    const noMailbox = await approveDraft("priya@acme-corp.io");
    const refused = await noMailbox.run().then(() => null, (e: Error) => e.message);
    check("with no mailbox connected, approval refuses", refused === "Connect your email to send from your own address", String(refused));
    check("and the draft goes back to pending", (await getAgentSendRequest(USER, noMailbox.id))?.status === "pending");

    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "me@acme-corp.io",
      accessTokenEncrypted: encrypt("t"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.gmailSend,
      status: "active",
    });
    const before = await countEmailSendsToday(USER);
    const good = await noMailbox.run();
    check("approval sends", good.sent && good.status === "sent" && good.via === "gmail", JSON.stringify(good));
    const row = await getAgentSendRequest(USER, noMailbox.id);
    check("the draft reads as sent", row?.status === "sent");
    check("and counts against the shared email cap", (await countEmailSendsToday(USER)) === before + 1);

    next = "permanent";
    const bad = await approveDraft("sam@acme-corp.io");
    const badResult = await bad.run();
    check("a refused send reports failure", !badResult.sent && badResult.status === "failed", JSON.stringify(badResult));
    check("and returns the draft to pending", (await getAgentSendRequest(USER, bad.id))?.status === "pending");

    next = "ambiguous";
    const maybe = await approveDraft("lee@acme-corp.io");
    const maybeResult = await maybe.run();
    check("an unsure send is retried, not reported sent", maybeResult.status === "retrying");
    await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE origin_ref = ${maybe.id}`);
    const [queued] = await db.select().from(schema.emailSends).where(sql`origin_ref = ${maybe.id}`);
    const calls = providerCalls;
    await dispatchEmailSend(queued!.id);
    const parked = await getAgentSendRequest(USER, maybe.id);
    check("a send that may have gone out is parked as failed, never resent", parked?.status === "failed" && providerCalls === calls, JSON.stringify(parked?.status));
    check("and cannot be approved again", (await maybe.run().then(() => "sent", (e: Error) => e.message)) === "That draft is no longer waiting for approval");
  } finally {
    setProviderOverride("gmail", null);
  }

  // --- Expiry ---------------------------------------------------------------------------------
  const stale = await createAgentSendRequest(USER, {
    toEmail: "late@example.org",
    body: "Too late.",
  });
  await db.execute(sql`
    UPDATE agent_send_requests SET expires_at = now() - interval '1 day' WHERE id = ${stale.id}
  `);
  const staleClaim = await claimAgentSendForApproval(USER, stale.id);
  check("an expired draft cannot be claimed", staleClaim === null);
  const staleRow = await getAgentSendRequest(USER, stale.id);
  check("and it reads as expired", staleRow?.status === "expired", staleRow?.status);

  // --- Rejection -------------------------------------------------------------------------------
  const refused = await createAgentSendRequest(USER, {
    toEmail: "nope@example.org",
    body: "Not this one.",
  });
  check("a pending draft can be rejected", await rejectAgentSend(USER, refused.id));
  check(
    "rejecting twice changes nothing",
    !(await rejectAgentSend(USER, refused.id)),
    "the second call must find nothing pending"
  );
  const agentView = await callTool(key.token, "get_send_status", { draftId: refused.id });
  check(
    "the agent can read the refusal",
    agentView.status === "rejected",
    JSON.stringify(agentView)
  );

  // --- One user's drafts are invisible to another -----------------------------------------------
  const otherView = await getAgentSendRequest("someone-else", draftId);
  check("another account cannot read the draft", otherView === null);

  await db.execute(sql`DELETE FROM agent_send_requests WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${USER}`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll agent-send checks passed.");
});
