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
import { generateApiKey } from "../src/lib/api/keys";
import { POST } from "../src/app/api/mcp/route";

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
  // Imports and tool names, not prose: the file's header discusses `approveAgentSend` at
  // length, and a check that a comment can fail is a check nobody will trust.
  const serverSource = readFileSync("src/lib/mcp/server.ts", "utf8");
  const serverImports = serverSource.slice(0, serverSource.indexOf("export function"));
  check(
    "the MCP server imports no approval or send path",
    !/from "@\/lib\/(agent-send-approve|gmail-send|outreach-send)"/.test(serverImports),
    "an approval must not be one import away from a tool"
  );
  const toolNames = [...serverSource.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  check(
    "no registered tool approves or sends",
    // `request_send` is the allowed name because it only ever asks. Anything that reads as
    // doing the sending — send_email, send_message, approve_draft — must not exist.
    !toolNames.some((t) => /^(approve|send)/.test(t)) && toolNames.includes("request_send"),
    toolNames.join(",")
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
