import { SettingsForm } from "@/components/settings/settings-form";

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Settings
        </h1>
        <p className="mt-1 text-muted-foreground">
          Choose your AI provider, paste an API key, and manage your data.
        </p>
      </div>
      <SettingsForm />
    </div>
  );
}
