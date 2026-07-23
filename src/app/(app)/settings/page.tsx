import { getSettings } from "@/actions/settings";
import { listGoals } from "@/actions/goals";
import { getCurrentUserProfile, isClerkConfigured } from "@/lib/auth";
import { AiSettings } from "@/components/settings/ai-settings";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { DataSettings } from "@/components/settings/data-settings";
import { GoalsSettings } from "@/components/settings/goals-settings";
import { HelpSettings } from "@/components/settings/help-settings";
import { KnowledgeSettings } from "@/components/settings/knowledge-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { OutreachSettings } from "@/components/settings/outreach-settings";
import { ProfileSettings } from "@/components/settings/profile-settings";

export default async function SettingsPage() {
  const [initialSettings, initialGoals, profile] = await Promise.all([
    getSettings(),
    listGoals(),
    getCurrentUserProfile(),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Settings
        </h1>
        <p className="mt-1 text-muted-foreground">
          Account, goals, AI keys, knowledge, notifications, and data controls.
        </p>
      </div>
      <ProfileSettings
        profile={profile}
        clerkEnabled={isClerkConfigured()}
        initialSocialLinks={initialSettings.socialLinks}
      />
      <GoalsSettings initialGoals={initialGoals} />
      <AppearanceSettings initialTheme={initialSettings.theme} />
      <AiSettings initialSettings={initialSettings} />
      <NotificationSettings />
      <OutreachSettings initial={initialSettings.outreach} />
      <KnowledgeSettings />
      <HelpSettings />
      <DataSettings />
    </div>
  );
}
