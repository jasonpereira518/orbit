"use server";
import { revalidatePath } from "next/cache";
import { requireAdminUserId } from "@/lib/admin";
import {
  setVoiceEnabled,
  setVoiceConfig,
  getVoiceSettings,
} from "@/lib/voice/settings";
import { voiceCredentials } from "@/lib/voice/providers";
import { VOICE_PROVIDERS } from "@/lib/voice/config";
import { consumeBucket } from "@/lib/rate-limit";
import { recordAdminAction } from "@/lib/admin-audit";
function refresh() {
  revalidatePath("/admin/product/chat");
  revalidatePath("/chat");
}
export async function setOrbitVoiceEnabled(enabled: boolean) {
  const adminUserId = await requireAdminUserId();
  if (typeof enabled !== "boolean") throw new Error("Choose on or off");
  await setVoiceEnabled(adminUserId, enabled);
  refresh();
}
export async function saveOrbitVoiceConfig(input: unknown) {
  const adminUserId = await requireAdminUserId();
  await setVoiceConfig(adminUserId, input);
  refresh();
}
export async function checkOrbitVoiceProvider(input: unknown) {
  const adminUserId = await requireAdminUserId();
  if (!VOICE_PROVIDERS.includes(input as (typeof VOICE_PROVIDERS)[number]))
    throw new Error("Choose a voice provider");
  const provider = input as (typeof VOICE_PROVIDERS)[number];
  await consumeBucket("voice-health", adminUserId, { limit: 3, windowSec: 60 });
  const state = await getVoiceSettings();
  let ok = false;
  try {
    await voiceCredentials(
      provider,
      "Credential check only. No CRM data is available.",
      state.config,
    );
    ok = true;
  } catch {
    /* Sanitized health status is already persisted by the adapter. */
  }
  await recordAdminAction({
    adminUserId,
    action: "site.voice.check",
    resourceType: "site_settings",
    resourceId: "1",
    detail: { provider, ok },
  });
  refresh();
  return { ok };
}
