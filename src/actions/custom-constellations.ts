"use server";

/**
 * Custom constellations: the browser-facing edge. Each action derives the user from the session,
 * checks its input here, and leaves the work to `src/lib/custom-constellations.ts`.
 */
import { requireUserForSurface } from "@/lib/plan-guards";
import { resolvePlan } from "@/lib/entitlements";
import { getConstellationLimitForPlan } from "@/lib/plans/plan-config";
import { UserFacingError } from "@/lib/errors";
import { ensureUserSettings } from "@/lib/user-settings";
import {
  addConstellationMember,
  createCustomConstellation,
  deleteCustomConstellation,
  listCustomConstellations,
  removeConstellationMember,
  renameCustomConstellation,
  type ConstellationTab,
} from "@/lib/custom-constellations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, max: number, what: string): string {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t || t.length > max) throw new UserFacingError(`${what} needs 1 to ${max} characters`);
  return t;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new UserFacingError("That constellation or person couldn’t be found");
  return value;
}

export async function createConstellation(prompt: string): Promise<{ id: string }> {
  const userId = await requireUserForSurface("page.graph");
  const asked = text(prompt, 300, "Describe the group");
  const { plan } = resolvePlan(await ensureUserSettings(userId));
  return createCustomConstellation(userId, asked, plan);
}

export async function listConstellations(): Promise<ConstellationTab[]> {
  return listCustomConstellations(await requireUserForSurface("page.graph"));
}

/** The strip's data in one call. Only a boolean crosses to the client: the free cap is a number, the paid one is `Infinity`. */
export async function getConstellationTabs(): Promise<{ tabs: ConstellationTab[]; canCreate: boolean }> {
  const userId = await requireUserForSurface("page.graph");
  const [tabs, settings] = await Promise.all([listCustomConstellations(userId), ensureUserSettings(userId)]);
  const { plan } = resolvePlan(settings);
  return { tabs, canCreate: tabs.length < getConstellationLimitForPlan(plan) };
}

export async function renameConstellation(id: string, name: string): Promise<boolean> {
  const userId = await requireUserForSurface("page.graph");
  return renameCustomConstellation(userId, uuid(id), text(name, 60, "The name"));
}

export async function deleteConstellation(id: string): Promise<boolean> {
  const userId = await requireUserForSurface("page.graph");
  return deleteCustomConstellation(userId, uuid(id));
}

export async function addToConstellation(id: string, contactId: string): Promise<boolean> {
  const userId = await requireUserForSurface("page.graph");
  return addConstellationMember(userId, uuid(id), uuid(contactId));
}

export async function removeFromConstellation(id: string, contactId: string): Promise<boolean> {
  const userId = await requireUserForSurface("page.graph");
  return removeConstellationMember(userId, uuid(id), uuid(contactId));
}
