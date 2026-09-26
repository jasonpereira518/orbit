/**
 * The export covers every deletion category, leaks no secret column, and shows photos as
 * proxied URLs (audit B10). Run: npx tsx scripts/smoke-data-export.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { DATA_CATEGORY_IDS } from "../src/lib/data-categories";
import { collectUserExport } from "../src/lib/data-export";
import { countedTableNames, exportSourcesFor, purgeUserData } from "../src/lib/user-data";

const USER = "smoke-export-user";
const FORBIDDEN = /(_encrypted|token|secret)$/;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function seed() {
  const db = await getDb();
  await db.insert(schema.userSettings).values({ userId: USER, geminiApiKeyEncrypted: encrypt("k"), calendarFeedToken: "feed-token" });
  const [contact] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Ada Lovelace", profileImageUrl: "data:image/jpeg;base64,AAAA" }).returning();
  await db.insert(schema.contacts).values({ userId: "smoke-export-someone-else", fullName: "Not Mine" });
  await db.insert(schema.interactions).values({ userId: USER, contactId: contact.id, interactionType: "note", rawNotes: "coffee" });
  await db.insert(schema.capturePhotos).values({ userId: USER, storage: "inline", inlineData: "AAAA", contentType: "image/jpeg", byteSize: 4 });
  await db.insert(schema.reminders).values({ userId: USER, contactId: contact.id, title: "follow up", dueDate: new Date() });
  await db.insert(schema.aiSuggestions).values({ userId: USER, suggestionType: "reconnect", title: "Reach out" });
  await db.insert(schema.imports).values({ userId: USER, importType: "linkedin_connections" });
  await db.insert(schema.gmailConnections).values({ userId: USER, emailAddress: "e@x.test", accessTokenEncrypted: encrypt("a"), refreshTokenEncrypted: encrypt("r") });
  await db.insert(schema.events).values({ userId: USER, title: "Summit" });
  await db.insert(schema.userGoals).values({ userId: USER, text: "meet people" });
  await db.insert(schema.chatThreads).values({ userId: USER, title: "thread" });
  const [recruiter] = await db.insert(schema.recruiters).values({ fullName: "Rec", nameNormalized: "rec" }).returning();
  await db.insert(schema.userRecruiterLinks).values({ userId: USER, recruiterId: recruiter.id, email: "rec@x.test" });
  await db.insert(schema.apiKeys).values({ userId: USER, name: "key", prefix: "orb_live_export", keyHash: "0".repeat(64), scopes: ["read"] });
  await db.insert(schema.usageEvents).values({ userId: USER, operation: "capture.parse", provider: "gemini", model: "m", kind: "completion", keyOwner: "user" });
  await db.insert(schema.feedback).values({ userId: USER, kind: "churn_reason", text: "words" });
  await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Campaign" });
  await db.insert(schema.tags).values({ userId: USER, name: "friend" });
  return { contactId: contact.id, recruiterId: recruiter.id };
}

async function main() {
  const { contactId } = await seed();
  try {
    console.log("The registry");
    for (const id of DATA_CATEGORY_IDS) {
      const exported = new Set(exportSourcesFor(id).map((s) => s.name));
      const missing = countedTableNames(id).filter((t) => !exported.has(t));
      check(`${id}: every counted table is exported`, missing.length === 0, missing.join(", "));
    }

    console.log("\nThe export");
    const out = await collectUserExport(USER);
    for (const id of DATA_CATEGORY_IDS) {
      const rows = Object.values(out.categories[id] ?? {}).flat();
      check(`${id}: at least one row`, rows.length > 0);
    }
    const leaks: string[] = [];
    const walk = (dataset: string, rows: Record<string, unknown>[]) => {
      for (const row of rows) for (const key of Object.keys(row)) if (FORBIDDEN.test(key)) leaks.push(`${dataset}.${key}`);
    };
    for (const byName of Object.values(out.categories)) for (const [name, rows] of Object.entries(byName)) walk(name, rows);
    for (const [name, rows] of Object.entries(out.account)) walk(name, rows);
    check("no column ending _encrypted, token or secret", leaks.length === 0, [...new Set(leaks)].join(", "));
    const photo = out.categories.notes.capture_photos?.[0];
    check("capture photos are proxied URLs, not bytes", typeof photo?.url === "string" && String(photo.url).startsWith("/api/capture/photos/") && !("inline_data" in photo));
    const contact = out.categories.contacts.contacts?.find((c) => c.id === contactId);
    check("an inline avatar becomes the avatar route", contact?.profile_image_url === `/api/avatars/${contactId}`);
    check("nobody else's rows", out.categories.contacts.contacts.every((c) => c.user_id === USER));
    check("recruiter links name the recruiter", out.categories.recruiters.user_recruiter_links?.[0]?.recruiter_full_name === "Rec");

    console.log("\nPaging past one page (500 rows)");
    // Pages by key, not OFFSET, past the first page: every row exactly once, in key order.
    const db = await getDb();
    await db.insert(schema.tags).values(Array.from({ length: 1_234 }, (_, i) => ({ userId: USER, name: `bulk-tag-${i}` })));
    const paged = await collectUserExport(USER);
    const tagRows = Object.values(paged.categories).flatMap((byName) => byName.tags ?? []) as Array<{ id: string; name: string }>;
    const bulk = tagRows.filter((t) => t.name.startsWith("bulk-tag-"));
    check("every row across three pages", bulk.length === 1_234 && new Set(bulk.map((t) => t.id)).size === 1_234, `${bulk.length}`);
    const ids = tagRows.map((t) => t.id);
    check("in key order", ids.every((id, i) => i === 0 || ids[i - 1]! < id));
  } finally {
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
    await purgeUserData("smoke-export-someone-else", { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll export checks passed.");
}

run(main);
