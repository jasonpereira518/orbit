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
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { surfaceKeyForSettingsId } from "@/lib/surfaces";

/**
 * Anchor for the section rail. Ids and order live in `sections.ts`.
 *
 * Renders nothing at all when an operator has hidden this section — not a placeholder, and
 * not an empty anchor div, which would leave the rail scrolling to a blank strip of page.
 */
function Section({
  id,
  hidden,
  children,
}: {
  id: SettingsSectionId;
  hidden: ReadonlySet<string>;
  children: React.ReactNode;
}) {
  if (hidden.has(surfaceKeyForSettingsId(id))) return null;
  return (
    <div id={id} className="scroll-mt-8">
      {children}
    </div>
  );
}

export default async function SettingsPage() {
  const [initialSettings, initialGoals, profile, planOverview, visibility] =
    await Promise.all([
      getSettings(),
      listGoals(),
      getCurrentUserProfile(),
      getPlanOverview(),
      requireUserId().then(resolveSurfaceVisibility),
    ]);

  const { hidden } = visibility;
  // The rail is built from the same filter the sections below use, in the same order, so
  // it can never offer a row whose anchor was not rendered.
  const railSections = SETTINGS_SECTIONS.filter(
    (section) => !hidden.has(surfaceKeyForSettingsId(section.id))
  ).map((section) => ({ id: section.id, label: section.label }));

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Settings
        </h1>
        <p className="mt-1 text-muted-foreground">
          Account, goals, AI keys, knowledge, notifications, and data controls.
        </p>
      </div>
      <Section id="settings-profile" hidden={hidden}>
        <ProfileSettings
          profile={profile}
          clerkEnabled={isClerkConfigured()}
          initialSocialLinks={initialSettings.socialLinks}
        />
      </Section>
      <Section id="settings-plan" hidden={hidden}>
        <PlanSettings
          entitlements={planOverview.entitlements}
          usage={planOverview.usage}
        />
      </Section>
      <Section id="settings-goals" hidden={hidden}>
        <GoalsSettings initialGoals={initialGoals} />
      </Section>
      <Section id="settings-appearance" hidden={hidden}>
        <AppearanceSettings initialTheme={initialSettings.theme} />
      </Section>
      <Section id="settings-ai" hidden={hidden}>
        <AiSettings initialSettings={initialSettings} />
      </Section>
      <Section id="settings-notifications" hidden={hidden}>
        <NotificationSettings />
      </Section>
      <Section id="settings-calendar" hidden={hidden}>
        <CalendarFeedSettings />
      </Section>
      <Section id="settings-outreach" hidden={hidden}>
        <OutreachSettings initial={initialSettings.outreach} />
      </Section>
      <Section id="settings-knowledge" hidden={hidden}>
        <KnowledgeSettings />
      </Section>
      <Section id="settings-help" hidden={hidden}>
        <HelpSettings />
      </Section>
      <Section id="settings-data" hidden={hidden}>
        <DataSettings />
      </Section>

      <SettingsSectionNav sections={railSections} />
    </div>
  );
}
