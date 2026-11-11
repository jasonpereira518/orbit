import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import { deepgramEnabled } from "@/lib/deepgram";
import { voiceAvailable } from "./policy";
import {
  DEFAULT_VOICE_CONFIG,
  voiceConfigSchema,
  otherVoiceProvider,
  type VoiceConfig,
  type VoiceProvider,
  type VoiceHealthMap,
} from "./config";

export function voiceConfigured(provider: VoiceProvider = "deepgram") {
  return provider === "deepgram"
    ? deepgramEnabled()
    : Boolean(
        process.env.ELEVENLABS_API_KEY?.trim() &&
          process.env.ELEVENLABS_AGENT_ID?.trim(),
      );
}
/** Never cache the kill switch or provider selection across requests. */
export async function getVoiceSettings() {
  const db = await getDb();
  const row = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.id, 1),
    columns: {
      orbitVoiceEnabled: true,
      orbitVoiceChangedAt: true,
      orbitVoiceConfig: true,
      orbitVoiceHealth: true,
    },
  });
  const config = voiceConfigSchema.parse(
    row?.orbitVoiceConfig ?? DEFAULT_VOICE_CONFIG,
  );
  const providers = {
    deepgram: voiceConfigured("deepgram"),
    elevenlabs: voiceConfigured("elevenlabs"),
  };
  return {
    enabled: row?.orbitVoiceEnabled === true,
    configured: providers[config.provider],
    providers,
    changedAt: row?.orbitVoiceChangedAt ?? null,
    config,
    health: row?.orbitVoiceHealth ?? ({} as VoiceHealthMap),
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
  // Selection-specific configuration is checked by the chosen adapter, including explicit fallback.
  if (!state.enabled) throw new VoiceUnavailableError();
  return state;
}
export async function voicePublicState() {
  const state = await getVoiceSettings();
  const alternative = otherVoiceProvider(state.config.provider);
  return {
    enabled: voiceAvailable(
      state.enabled,
      state.configured ||
        (state.config.fallback === "offer-alternative" &&
          state.providers[alternative]),
    ),
    provider: state.config.provider,
    fallbackProvider:
      state.config.fallback === "offer-alternative" &&
      state.providers[alternative]
        ? alternative
        : null,
    revision: state.changedAt?.toISOString() ?? null,
  };
}
async function persistVoiceConfig(
  adminUserId: string,
  changes: { enabled?: boolean; config?: VoiceConfig },
) {
  const db = await getDb();
  const fields = {
    ...(changes.enabled === undefined
      ? {}
      : { orbitVoiceEnabled: changes.enabled }),
    ...(changes.config === undefined ? {} : { orbitVoiceConfig: changes.config }),
    orbitVoiceChangedAt: sql`now()`,
    updatedBy: adminUserId,
    updatedAt: sql`now()`,
  };
  // A concurrent model/provider save must never turn the master switch back on.
  await db
    .insert(siteSettings)
    .values({ id: 1, ...fields })
    .onConflictDoUpdate({ target: siteSettings.id, set: fields });
}
export async function setVoiceEnabled(adminUserId: string, enabled: boolean) {
  const before = await getVoiceSettings();
  if (enabled && !before.configured)
    throw new Error(
      "Configure the selected voice provider before enabling Orbit Voice",
    );
  await persistVoiceConfig(adminUserId, { enabled });
  await recordAdminAction({
    adminUserId,
    action: enabled ? "site.voice.enable" : "site.voice.disable",
    resourceType: "site_settings",
    resourceId: "1",
    detail: { from: before.enabled, to: enabled },
  });
}
export async function setVoiceConfig(adminUserId: string, input: unknown) {
  const config = voiceConfigSchema.parse(input);
  const before = await getVoiceSettings();
  if (before.enabled && !voiceConfigured(config.provider))
    throw new Error(
      "Configure the selected provider or turn Orbit Voice off before switching",
    );
  await persistVoiceConfig(adminUserId, { config });
  await recordAdminAction({
    adminUserId,
    action: "site.voice.configure",
    resourceType: "site_settings",
    resourceId: "1",
    detail: { from: before.config, to: config },
  });
}
export async function recordVoiceHealth(
  provider: VoiceProvider,
  ok: boolean,
  code: string,
) {
  const db = await getDb();
  const health = {
    status: ok ? "ready" : "error",
    checkedAt: new Date().toISOString(),
    code,
  };
  // Update only one provider, without racing another provider check or changing the config generation.
  await db
    .insert(siteSettings)
    .values({ id: 1, orbitVoiceHealth: { [provider]: health } })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: {
        orbitVoiceHealth: sql`coalesce(${siteSettings.orbitVoiceHealth}, '{}'::jsonb) || ${JSON.stringify({ [provider]: health })}::jsonb`,
      },
    });
}
