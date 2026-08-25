import { getPlanOverview, getSettings } from "@/actions/settings";
import { listGoals } from "@/actions/goals";
import { getCurrentUserProfile, isClerkConfigured } from "@/lib/auth";
import { AiSettings } from "@/components/settings/ai-settings";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { DataSettings } from "@/components/settings/data-settings";
import { GoalsSettings } from "@/components/settings/goals-settings";
import { HelpSettings } from "@/components/settings/help-settings";
import { KnowledgeSettings } from "@/components/settings/knowledge-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { CalendarFeedSettings } from "@/components/settings/calendar-feed-settings";
import { OutreachSettings } from "@/components/settings/outreach-settings";
import { PlanSettings } from "@/components/settings/plan-settings";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { SettingsSectionNav } from "@/components/settings/settings-section-nav";
import type { SettingsSectionId } from "@/components/settings/sections";

/** Anchor for the section rail. Ids and order live in `sections.ts`. */
function Section({
  id,
  children,
}: {
  id: SettingsSectionId;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-8">
      {children}
    </div>
  );
}

export default async function SettingsPage() {
  const [initialSettings, initialGoals, profile, planOverview] =
    await Promise.all([
      getSettings(),
      listGoals(),
      getCurrentUserProfile(),
      getPlanOverview(),
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
      <Section id="settings-profile">
        <ProfileSettings
          profile={profile}
          clerkEnabled={isClerkConfigured()}
          initialSocialLinks={initialSettings.socialLinks}
        />
      </Section>
      <Section id="settings-plan">
        <PlanSettings
          entitlements={planOverview.entitlements}
          usage={planOverview.usage}
        />
      </Section>
      <Section id="settings-goals">
        <GoalsSettings initialGoals={initialGoals} />
      </Section>
      <Section id="settings-appearance">
        <AppearanceSettings initialTheme={initialSettings.theme} />
      </Section>
      <Section id="settings-ai">
        <AiSettings initialSettings={initialSettings} />
      </Section>
      <Section id="settings-notifications">
        <NotificationSettings />
      </Section>
      <Section id="settings-calendar">
        <CalendarFeedSettings />
      </Section>
      <Section id="settings-outreach">
        <OutreachSettings initial={initialSettings.outreach} />
      </Section>
      <Section id="settings-knowledge">
        <KnowledgeSettings />
      </Section>
      <Section id="settings-help">
        <HelpSettings />
      </Section>
      <Section id="settings-data">
        <DataSettings />
      </Section>

      <SettingsSectionNav />
    </div>
  );
}
