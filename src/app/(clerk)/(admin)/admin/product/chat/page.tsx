import { AdminPanel } from "@/components/admin/primitives";
import { OrbitVoiceSwitch } from "@/components/admin/orbit-voice-switch";
import { requireAdminPage } from "@/lib/admin";
import { getVoiceSettings } from "@/lib/voice/settings";
import { ProductHeader } from "../product-header";
export const metadata = { title: "Admin · Product · Chat" };
export default async function AdminChatProductPage() {
  await requireAdminPage();
  const state = await getVoiceSettings();
  return (
    <>
      <ProductHeader />
      <AdminPanel title="Orbit Voice">
        <OrbitVoiceSwitch
          enabled={state.enabled}
          configured={state.configured}
        />
      </AdminPanel>
    </>
  );
}
