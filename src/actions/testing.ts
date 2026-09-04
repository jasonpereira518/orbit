"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, imports } from "@/db/schema";
import { requireUserForSurface } from "@/lib/plan-guards";
import { seedShowcase } from "@/lib/fixtures/showcase";
import { purgeUserData } from "@/lib/user-data";
import { runEmbeddingBackfill } from "@/lib/embedding-backfill";
import {
  RESUMABLE_IMPORT_TYPES,
  runImportJobById,
} from "@/lib/import-job-dispatch";
import {
  generateDueFollowUps,
  refreshOutreachSuggestions,
} from "@/lib/reminders";

/**
 * The testing console's server actions.
 *
 * Every one of them opens with `requireUserForSurface("page.testing")` and nothing else
 * decides access. The nav filter is cosmetic and these are reachable by direct POST, so the
 * guard has to be the first statement in each — the same rule the admin actions follow, for
 * the same reason. Since `page.testing` is marked `beta` in the registry, that single call
 * enforces "signed in, a testing account, and the surface has not been killed" at once.
 *
 * Everything here is scoped to the caller's OWN account. The global sweeps
 * (`resumeStalledImports`, `runOpsSweep`) deliberately have no place on this page: they
 * take no user id and would let a tester move system-wide state. Those stay in
 * `/admin/health`, behind the operator gate.
 */

const SURFACE = "page.testing";

/** Paths whose content is derived from the network this page rewrites. */
function revalidateNetwork() {
  revalidatePath("/", "layout");
  revalidatePath("/dashboard");
  revalidatePath("/contacts");
  revalidatePath("/reminders");
  revalidatePath("/graph");
  revalidatePath("/testing");
}

/**
 * Wipe the account back to a known starting point and load the showcase network.
 *
 * The purge runs first even though `seedShowcase` replaces the network on its own: the two
 * clear different things. `seedShowcase` rewrites contacts, tags and reminders; the purge
 * also clears chat threads, imports, goals and embeddings, which is the difference between
 * "fresh contacts" and "a fresh account". A tester chasing a bug in retrieval or import
 * resume needs the second.
 *
 * Settings, API keys, plan and — critically — the beta flag itself all survive, because
 * `purgeUserData` preserves them. Losing the flag here would revoke access to the button
 * that was just pressed.
 */
export async function resetToShowcaseAction(): Promise<{
  ok: true;
  contacts: number;
  interactions: number;
  reminders: number;
}> {
  const userId = await requireUserForSurface(SURFACE);
  await purgeUserData(userId);
  const result = await seedShowcase(userId);
  revalidateNetwork();
  return {
    ok: true,
    contacts: result.contacts,
    interactions: result.interactions,
    reminders: result.reminders,
  };
}

/** Wipe the account's data and leave it empty — the first-run state. */
export async function emptyAccountAction(): Promise<{ ok: true }> {
  const userId = await requireUserForSurface(SURFACE);
  await purgeUserData(userId);
  revalidateNetwork();
  return { ok: true };
}

/**
 * Re-embed every contact.
 *
 * `runEmbeddingBackfill` only drains what is already flagged stale, so the stamp has to
 * come first or this reports "0 embedded" on an account whose embeddings are simply out of
 * date rather than missing. It returns `remaining` rather than looping: the real backfill
 * re-kicks itself through an internal route, and a server action that ran to completion
 * would sit past the request timeout on a large network. Press it again.
 */
export async function reembedContactsAction(): Promise<{
  ok: true;
  embedded: number;
  remaining: number;
}> {
  const userId = await requireUserForSurface(SURFACE);
  const db = await getDb();
  await db
    .update(contacts)
    .set({ embeddingStaleAt: new Date() })
    .where(and(eq(contacts.userId, userId), isNull(contacts.embeddingStaleAt)));
  const { embedded, remaining } = await runEmbeddingBackfill(userId);
  revalidatePath("/testing");
  return { ok: true, embedded, remaining };
}

/** Rebuild the dashboard's outreach queue and the drafted follow-ups beside it. */
export async function rebuildSuggestionsAction(): Promise<{ ok: true }> {
  const userId = await requireUserForSurface(SURFACE);
  await refreshOutreachSuggestions(userId);
  await generateDueFollowUps(userId);
  revalidatePath("/dashboard");
  revalidatePath("/reminders");
  revalidatePath("/testing");
  return { ok: true };
}

/**
 * Re-arm and re-run this account's server-owned imports.
 *
 * Re-arms the row the way `retryImport` does before dispatching, because the processors
 * resume from `status`. Only `RESUMABLE_IMPORT_TYPES` are touched — the client-driven ones
 * have no server runner and would have to be re-uploaded — and completed jobs are left
 * alone, so this is "finish what stalled", not "import everything twice".
 *
 * Awaited rather than deferred to `after()`, unlike the admin retry: a tester pressing this
 * is watching for the outcome, and the count is the whole point of the button.
 */
export async function rerunImportsAction(): Promise<{
  ok: true;
  rerun: number;
}> {
  const userId = await requireUserForSurface(SURFACE);
  const db = await getDb();
  const rows = await db
    .select({ id: imports.id })
    .from(imports)
    .where(
      and(
        eq(imports.userId, userId),
        inArray(imports.importType, [...RESUMABLE_IMPORT_TYPES]),
        sql`${imports.status} <> 'completed'`
      )
    );

  for (const row of rows) {
    await db
      .update(imports)
      .set({ status: "processing", errorMessage: null })
      .where(eq(imports.id, row.id));
    try {
      await runImportJobById(row.id);
    } catch {
      // The processor records its own failure on the row; one bad job must not stop the
      // rest, and the tester will see the status on /imports either way.
    }
  }

  revalidatePath("/imports");
  revalidatePath("/testing");
  return { ok: true, rerun: rows.length };
}
