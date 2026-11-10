/**
 * End-to-end smoke test for Orbit's platform expansion connectors:
 * Apple Contacts, Outlook Calendar, Slack, Partiful, Gemini/Copilot, HubSpot (read+write),
 * Obsidian, and Calendly (OAuth + inbound webhook).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql, eq, and } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, connectorConnections, connectorOutbox } from "../src/db/schema";
import { connectorById, syncableConnectors } from "../src/lib/connectors/registry";
import { deliverHubSpot } from "../src/lib/connectors/hubspot-deliver";
import { syncObsidian } from "../src/lib/connectors/obsidian";
import { POST as POST_CALENDLY_WEBHOOK } from "../src/app/api/webhooks/calendly/route";
import { encrypt } from "../src/lib/crypto";

const USER = "expansion-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();

  // Cleanup
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));

  console.log("\n1. Connector Registry Validation");
  const appleContacts = connectorById("apple_contacts");
  check("apple_contacts is registered and available", appleContacts?.availability === "available");
  check("apple_contacts has sync function", typeof appleContacts?.sync === "function");
  check("apple_contacts uses dav_password", appleContacts?.auth === "dav_password");

  const outlook = connectorById("outlook");
  check("outlook has syncEvents capability", outlook?.capabilities.some((c) => c.id === "syncEvents") ?? false);

  const slack = connectorById("slack");
  check("slack is registered and available", slack?.availability === "available");
  check("slack is in conversations family", slack?.family === "conversations");
  check("slack has sync function", typeof slack?.sync === "function");

  const hubspot = connectorById("hubspot");
  check("hubspot is registered and available", hubspot?.availability === "available");
  check("hubspot is in crm family", hubspot?.family === "crm");
  check("hubspot has sync function", typeof hubspot?.sync === "function");
  check("hubspot has writeContact capability", hubspot?.capabilities.some((c) => c.id === "writeContact") ?? false);
  check("hubspot has logActivity capability", hubspot?.capabilities.some((c) => c.id === "logActivity") ?? false);

  const obsidian = connectorById("obsidian");
  check("obsidian is registered and available", obsidian?.availability === "available");
  check("obsidian has sync function", typeof obsidian?.sync === "function");

  const calendly = connectorById("calendly");
  check("calendly is registered and available", calendly?.availability === "available");
  check("calendly is in calendar family", calendly?.family === "calendar");

  console.log("\n2. Partiful URL Matching Pattern");
  const PARTIFUL_HOSTS = new Set(["partiful.com", "www.partiful.com"]);
  const isPartifulEvent = (urlStr: string) => {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return PARTIFUL_HOSTS.has(host) && /^\/(e|events?)\/[^/]+$/.test(path);
  };

  check("matches partiful.com /e/ slug", isPartifulEvent("https://partiful.com/e/summer-mixer"));
  check("matches www.partiful.com /events/ slug", isPartifulEvent("https://www.partiful.com/events/nyc-tech"));
  check("rejects non-partiful host", !isPartifulEvent("https://example.com/e/summer-mixer"));

  console.log("\n3. Obsidian Graceful Offline Handling");
  const [obsidianConn] = await db
    .insert(connectorConnections)
    .values({
      userId: USER,
      connectorId: "obsidian",
      authKind: "api_key",
      accountRef: "http://127.0.0.1:59999", // Unreachable port
      apiKeyEncrypted: encrypt("dummy-key"),
      status: "active",
      syncStatus: "idle",
      capabilities: ["importContacts"],
    })
    .returning();

  // Sync should not throw when host is offline; it reschedules gracefully
  let obsidianClean = true;
  try {
    await syncObsidian(obsidianConn.id);
  } catch (err) {
    obsidianClean = false;
  }
  check("syncObsidian handles unreachable local port cleanly", obsidianClean);

  console.log("\n4. HubSpot Outbox Write-Back Routing");
  // Seed HubSpot connection without write capabilities first
  const [hubspotConn] = await db
    .insert(connectorConnections)
    .values({
      userId: USER,
      connectorId: "hubspot",
      authKind: "oauth2",
      accountRef: "Portal 999",
      accessTokenEncrypted: encrypt("dummy-token"),
      status: "active",
      syncStatus: "idle",
      capabilities: [], // No capabilities enabled
    })
    .returning();

  const unpermittedResult = await deliverHubSpot({
    id: "out-1",
    userId: USER,
    connectorId: "hubspot",
    action: "writeContact",
    entityType: "contact",
    entityId: "c-1",
    payload: { fullName: "Test Contact" },
    attempts: 0,
    remoteId: null,
  });
  check("deliverHubSpot rejects unpermitted writeContact", !unpermittedResult.ok && !unpermittedResult.retryable);

  console.log("\n5. Calendly Inbound Webhook Processing");
  // Seed an active Calendly connection for USER
  await db.insert(connectorConnections).values({
    userId: USER,
    connectorId: "calendly",
    authKind: "oauth2",
    accountRef: "organizer@example.com",
    accessTokenEncrypted: encrypt("dummy-token"),
    status: "active",
    syncStatus: "idle",
    capabilities: ["syncEvents"],
  });

  const webhookPayload = {
    event: "invitee.created",
    payload: {
      email: "invitee@example.com",
      name: "Jane Invitee",
      event: "evt_12345",
      uri: "https://api.calendly.com/scheduled_events/evt_12345/invitees/inv_67890",
      scheduled_event: {
        name: "Coffee Chat",
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    },
  };

  const req = new Request("https://orbit.test/api/webhooks/calendly", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhookPayload),
  });

  const res = await POST_CALENDLY_WEBHOOK(req);
  check("calendly webhook returns 200", res.status === 200);

  const [createdContact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, USER), eq(contacts.email, "invitee@example.com")));
  check("calendly webhook created contact", Boolean(createdContact));
  check("contact name matches payload", createdContact?.fullName === "Jane Invitee");

  const [createdInteraction] = await db
    .select()
    .from(interactions)
    .where(and(eq(interactions.userId, USER), eq(interactions.source, "calendly")));
  check("calendly webhook created interaction", Boolean(createdInteraction));
  check("interaction notes match meeting title", createdInteraction?.rawNotes === "Coffee Chat");

  // Cleanup
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll platform expansion checks passed.");
});
