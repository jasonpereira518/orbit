"use server";
import { revalidatePath } from "next/cache";
import { requireAdminUserId } from "@/lib/admin";
import {
  setVoiceEnabled,
  setVoiceConfig,
  getVoiceSettings,
} from "@/lib/voice/settings";
import { voiceCredentials } from "@/lib/voice/providers";
import { DEEPGRAM_VOICES, VOICE_PROVIDERS } from "@/lib/voice/config";
import { deepgramConfigured, speakSample } from "@/lib/deepgram";
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
/** The line every preview speaks: the greeting a real call opens with. Fixed, never user text. */
const PREVIEW_LINE = "Hi, I’m Orbit. Who would you like to catch up with?";
/** An Aura voice saying the greeting, as a data URL the admin panel can play. Admins only. */
export async function previewOrbitVoice(voice: unknown): Promise<string> {
  const adminUserId = await requireAdminUserId();
  if (!DEEPGRAM_VOICES.includes(voice as (typeof DEEPGRAM_VOICES)[number]))
    throw new Error("Choose a Deepgram voice");
  if (!deepgramConfigured()) throw new Error("Deepgram isn’t configured on this deployment");
  await consumeBucket("voice-preview", adminUserId, { limit: 20, windowSec: 60 });
  const audio = await speakSample(voice as string, PREVIEW_LINE);
  return `data:audio/mpeg;base64,${Buffer.from(audio).toString("base64")}`;
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
