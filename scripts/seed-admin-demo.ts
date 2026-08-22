/**
 * Seeds a small but varied population so the admin console has something to render.
 * Local only — every id is prefixed so `npx tsx scripts/seed-admin-demo.ts --clean` removes it.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  calendarSubscriptions,
  chatMessages,
  chatThreads,
  contacts,
  gmailConnections,
  imports,
  interactions,
  usageEvents,
  userSettings,
} from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "demo-admin-";
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

async function clean() {
  const db = await getDb();
  const ids = (
    await db.query.userSettings.findMany({
      where: like(userSettings.userId, `${PREFIX}%`),
      columns: { userId: true },
    })
  ).map((r) => r.userId);
  if (ids.length === 0) return;
  await db.delete(usageEvents).where(inArray(usageEvents.userId, ids));
  await db.delete(interactions).where(inArray(interactions.userId, ids));
  await db.delete(contacts).where(inArray(contacts.userId, ids));
  await db.delete(chatMessages).where(inArray(chatMessages.userId, ids));
  await db.delete(chatThreads).where(inArray(chatThreads.userId, ids));
  await db.delete(imports).where(inArray(imports.userId, ids));
  await db.delete(calendarSubscriptions).where(inArray(calendarSubscriptions.userId, ids));
  await db.delete(gmailConnections).where(inArray(gmailConnections.userId, ids));
  await db.delete(adminAuditLog).where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, ids));
  console.log(`Removed ${ids.length} demo accounts.`);
}

async function main() {
  if (process.argv.includes("--clean")) {
    await clean();
    return;
  }
  await clean();

  const db = await getDb();
  const names = [
    "Marguerite Vandersteen", "Tobias Ashworth", "Priya Raghunathan",
    "Casimir Oyelaran", "Freya Lindqvist", "Ignatius Mbeki",
  ];

  for (let i = 0; i < 24; i++) {
    const id = `${PREFIX}${String(i).padStart(2, "0")}`;
    await ensureUserSettings(id);

    const signupDaysAgo = Math.floor((i / 24) * 90);
    await db
      .update(userSettings)
      .set({
        email: `person${i}@example.test`,
        createdAt: ago(90 - signupDaysAgo),
        lastActiveAt: i % 5 === 0 ? null : ago(i % 20),
        geminiApiKeyEncrypted: i % 7 === 0 ? null : "ciphertext",
        onboardingCompletedAt: i % 6 === 0 ? null : ago(80 - signupDaysAgo),
        wizardCompletedAt: i % 4 === 0 ? ago(70) : null,
        compedPlan: i === 3 ? "lifetime" : i === 11 ? "orbit" : null,
        compedNote: i === 3 ? "early believer, gave great feedback" : null,
        compedAt: i === 3 ? ago(40) : null,
        lifetimePurchasedAt: i === 5 || i === 17 ? ago(30) : null,
        subscriptionPlan: i === 8 || i === 14 || i === 20 ? "orbit" : null,
        subscriptionStatus:
          i === 8 ? "active" : i === 14 ? "past_due" : i === 20 ? "canceled" : null,
        subscriptionPeriodEnd: i === 20 ? new Date(Date.now() + 4 * DAY) : null,
        suspendedAt: i === 22 ? ago(2) : null,
        suspendedReason: i === 22 ? "spam reports from three recipients" : null,
      })
      .where(inArray(userSettings.userId, [id]));

    const contactCount = i === 0 ? 0 : Math.min(i * 3, 60);
    for (let c = 0; c < contactCount; c++) {
      const [row] = await db
        .insert(contacts)
        .values({
          userId: id,
          fullName: `${names[c % names.length]} ${c}`,
          email: `contact${c}.user${i}@example.test`,
          phone: `+1-555-${String(1000 + c).slice(0, 4)}`,
          company: ["Stripe", "Figma", "Anthropic", "Vercel"][c % 4],
          title: ["VP Eng", "Designer", "Recruiter", "Founder"][c % 4],
          notes: `Met at ${["a conference", "a coffee chat", "a dinner"][c % 3]}. Mentioned they are hiring.`,
          keyFacts: ["plays the cello", "two kids"],
          createdAt: ago(Math.max(1, 80 - signupDaysAgo - c)),
        })
        .returning();
      if (c % 3 === 0) {
        await db.insert(interactions).values({
          userId: id,
          contactId: row.id,
          interactionType: ["coffee", "call", "note"][c % 3],
          interactionDate: ago(c),
          createdAt: ago(c),
          rawNotes: "They said the round is nearly closed and they want intros.",
        });
      }
    }

    for (let u = 0; u < i; u++) {
      await db.insert(usageEvents).values({
        userId: id,
        operation: ["capture.parse", "chat.answer", "embed.contact"][u % 3],
        provider: "gemini",
        model: "gemini-3.5-flash",
        kind: "completion",
        keyOwner: "user",
        inputTokens: 1200,
        outputTokens: 400,
        estimatedCostMicros: 180,
        success: i === 13 && u % 2 === 0 ? 0 : 1,
        errorKind: i === 13 && u % 2 === 0 ? "auth" : null,
        createdAt: ago(u % 60),
      });
    }

    if (i % 5 === 0) {
      const [t] = await db
        .insert(chatThreads)
        .values({ userId: id, title: "Who do I know at Stripe", createdAt: ago(i) })
        .returning();
      await db.insert(chatMessages).values({
        threadId: t.id,
        userId: id,
        role: "user",
        content: "who do I know at Stripe that could intro me to their CTO",
        createdAt: ago(i),
      });
    }

    if (i === 2 || i === 9) {
      await db.insert(imports).values({
        userId: id,
        importType: "linkedin_connections",
        fileName: "Connections.csv",
        status: "failed",
        errorMessage: "Row 412: unparseable date '32/13/2024'",
        totalRows: 1800,
        rowsProcessed: 411,
        createdAt: ago(3),
        updatedAt: ago(3),
      });
    }
    if (i === 16) {
      await db.insert(imports).values({
        userId: id,
        importType: "linkedin_connections",
        fileName: "Connections.csv",
        status: "processing",
        totalRows: 900,
        rowsProcessed: 120,
        createdAt: ago(1),
        updatedAt: ago(1),
      });
    }
    if (i === 7) {
      await db.insert(gmailConnections).values({
        userId: id,
        emailAddress: `person${i}@gmail.test`,
        accessTokenEncrypted: "ciphertext",
        refreshTokenEncrypted: "ciphertext",
        status: "revoked",
        tokenExpiresAt: ago(5),
      });
    }
    if (i === 12) {
      await db.insert(calendarSubscriptions).values({
        userId: id,
        label: "Work calendar",
        icsUrl: "https://example.test/work.ics",
        lastSyncStatus: "error",
        lastSyncError: "HTTP 403 from the feed host",
        lastSyncedAt: ago(2),
      });
    }
  }

  console.log("Seeded 24 demo accounts (prefix demo-admin-).");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
