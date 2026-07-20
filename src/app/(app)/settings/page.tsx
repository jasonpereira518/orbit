import { getSettings } from "@/actions/settings";
import { SettingsForm } from "@/components/settings/settings-form";

export default async function SettingsPage() {
  const initialSettings = await getSettings();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Settings
        </h1>
        <p className="mt-1 text-muted-foreground">
          Appearance, AI keys, and data controls.
        </p>
      </div>
      <SettingsForm initialSettings={initialSettings} />
    </div>
  );
}
