import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import { voiceAvailable } from "./policy";

export function voiceConfigured() {
  return Boolean(
    process.env.ELEVENLABS_API_KEY?.trim() &&
      process.env.ELEVENLABS_AGENT_ID?.trim(),
  );
}
/** Deliberately uncached: the kill switch must reach every instance on the next request. */
export async function getVoiceSettings() {
  const db = await getDb();
  const row = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.id, 1),
    columns: { orbitVoiceEnabled: true, orbitVoiceChangedAt: true },
  });
  return {
    enabled: row?.orbitVoiceEnabled === true,
    configured: voiceConfigured(),
    changedAt: row?.orbitVoiceChangedAt ?? null,
  };
}
export class VoiceUnavailableError extends Error {
  constructor() {
    super("Orbit Voice is unavailable. You can keep using text chat.");
    this.name = "VoiceUnavailableError";
  }
}
export async function requireVoiceEnabled() {
  const state = await getVoiceSettings();
  if (!voiceAvailable(state.enabled, state.configured))
    throw new VoiceUnavailableError();
  return state;
}
export async function setVoiceEnabled(adminUserId: string, enabled: boolean) {
  const before = await getVoiceSettings();
  if (enabled && !before.configured)
    throw new Error(
      "Configure the ElevenLabs key and private agent before enabling Orbit Voice.",
    );
  const db = await getDb();
  await db
    .insert(siteSettings)
    .values({
      id: 1,
      orbitVoiceEnabled: enabled,
      orbitVoiceChangedAt: sql`now()`,
      updatedBy: adminUserId,
    })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: {
        orbitVoiceEnabled: enabled,
        orbitVoiceChangedAt: sql`now()`,
        updatedBy: adminUserId,
        updatedAt: new Date(),
      },
    });
  await recordAdminAction({
    adminUserId,
    action: enabled ? "site.voice.enable" : "site.voice.disable",
    resourceType: "site_settings",
    resourceId: "1",
    detail: { from: before.enabled, to: enabled },
  });
}
