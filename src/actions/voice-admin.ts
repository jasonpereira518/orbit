"use server";
import { revalidatePath } from "next/cache";
import { requireAdminUserId } from "@/lib/admin";
import { setVoiceEnabled } from "@/lib/voice/settings";
export async function setOrbitVoiceEnabled(enabled: boolean) {
  const adminUserId = await requireAdminUserId();
  if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
  await setVoiceEnabled(adminUserId, enabled);
  revalidatePath("/admin/product/chat");
  revalidatePath("/chat");
}
