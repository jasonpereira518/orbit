import { AdminPanel } from "@/components/admin/primitives";
import { OrbitVoiceSwitch } from "@/components/admin/orbit-voice-switch";
import { requireAdminPage } from "@/lib/admin";
import { getVoiceSettings } from "@/lib/voice/settings";
import { voiceUsageSummary } from "@/lib/voice/admin";
import { ProductHeader } from "../product-header";
export const metadata = { title: "Admin · Product · Chat" };
export default async function AdminChatProductPage() {
  await requireAdminPage();
  const [state, usage] = await Promise.all([
    getVoiceSettings(),
    voiceUsageSummary(),
  ]);
  return (
    <>
      <ProductHeader />
      <AdminPanel title="Orbit Voice">
        <OrbitVoiceSwitch
          key={JSON.stringify(state.config)}
          enabled={state.enabled}
          configured={state.configured}
          config={state.config}
          providers={state.providers}
          health={state.health}
        />
        <div className="mt-6 overflow-x-auto border-t border-border pt-4">
          <h3 className="mb-3 text-sm font-medium">Last 24 hours</h3>
          {usage.length ? (
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 font-normal">Provider</th>
                  <th className="text-right font-normal">Starts</th>
                  <th className="text-right font-normal">Failed</th>
                  <th className="text-right font-normal">Tool calls</th>
                  <th className="text-right font-normal">Connected minutes</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={row.provider} className="border-t border-border">
                    <td className="py-2">{row.provider}</td>
                    <td className="text-right tabular-nums">{row.starts}</td>
                    <td className="text-right tabular-nums">{row.failed}</td>
                    <td className="text-right tabular-nums">
                      {row.tool_calls}
                    </td>
                    <td className="text-right tabular-nums">
                      {(row.connected_seconds / 60).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted-foreground">
              No voice sessions in the last 24 hours.
            </p>
          )}
        </div>
      </AdminPanel>
    </>
  );
}
