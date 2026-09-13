import { getPlanOverview, getSettings } from "@/actions/settings";
import { listGoals } from "@/actions/goals";
import { getCurrentUserProfile, isClerkConfigured } from "@/lib/auth";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { DataSettings } from "@/components/settings/data-settings";
import { GoalsSettings } from "@/components/settings/goals-settings";
import { TargetCompaniesSettings } from "@/components/settings/target-companies-settings";
import { getSchools, getTargetCompanies } from "@/actions/target-companies";
import { HelpSettings } from "@/components/settings/help-settings";
import { KnowledgeSettings } from "@/components/settings/knowledge-settings";
import { IntegrationsSettings } from "@/components/settings/integrations-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { PlanSettings } from "@/components/settings/plan-settings";
import { ProfileSettings } from "@/components/settings/profile-settings";
import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsSectionNav } from "@/components/settings/settings-section-nav";
import {
  INTEGRATION_TABS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsGroupKey,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { surfaceKeyForSettingsId, FEEDBACK_SURFACE_KEY } from "@/lib/surfaces";

/**
 * Anchor for a card that stands alone. Ids and grouping live in `sections.ts`.
 *
 * Renders nothing at all when an operator has hidden this section — not a placeholder, and
 * not an empty anchor div, which would leave a gap in its group.
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

const GROUP = Object.fromEntries(SETTINGS_GROUPS.map((g) => [g.key, g])) as Record<
  SettingsGroupKey,
  (typeof SETTINGS_GROUPS)[number]
>;

/**
 * One of the five named groups, and the rail's anchor for it. Renders nothing when every
 * card in it is hidden, so a label never floats above an empty stretch of page — and the
 * rail, built from the same visibility, never offers a row that scrolls nowhere.
 */
function Group({
  group,
  visible,
  children,
}: {
  group: SettingsGroupKey;
  visible: boolean;
  children: React.ReactNode;
}) {
  if (!visible) return null;
  const { id, label } = GROUP[group];
  return (
    <section id={id} aria-labelledby={`${id}-label`} className="scroll-mt-8 space-y-4">
      <h2
        id={`${id}-label`}
        className="px-1 text-[0.8125rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase"
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

export default async function SettingsPage() {
  const [
    initialSettings,
    initialGoals,
    profile,
    planOverview,
    visibility,
    targetCompanies,
    schools,
  ] = await Promise.all([
    getSettings(),
    listGoals(),
    getCurrentUserProfile(),
    getPlanOverview(),
    requireUserId().then(resolveSurfaceVisibility),
    getTargetCompanies(),
    getSchools(),
  ]);

  const { hidden } = visibility;
  const shows = (id: SettingsSectionId) => !hidden.has(surfaceKeyForSettingsId(id));

  // Service tabs follow their own settings surface; importer tabs follow the page they
  // were lifted from, so hiding /imports cannot be undone by reaching it through Settings.
  const integrationTabs = INTEGRATION_TABS.filter((tab) =>
    "section" in tab ? shows(tab.section) : !hidden.has(tab.surface)
  ).map((tab) => tab.id);

  const groupVisible = (group: SettingsGroupKey) =>
    group === "integrations"
      ? integrationTabs.length > 0
      : SETTINGS_SECTIONS.some((s) => s.group === group && shows(s.id));

  const railSections = SETTINGS_GROUPS.filter((g) => groupVisible(g.key)).map((g) => ({
    id: g.id,
    label: g.label,
  }));

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Settings
        </h1>
        <p className="mt-1 text-muted-foreground">
          Your account, how Orbit behaves, what it connects to, and your data.
        </p>
      </div>

      <Group group="account" visible={groupVisible("account")}>
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
      </Group>

      <Group group="preferences" visible={groupVisible("preferences")}>
        {shows("settings-appearance") || shows("settings-notifications") ? (
          <SettingsSection
            title="Appearance and notifications"
            description="How Orbit looks, and when it gets your attention."
          >
            {shows("settings-appearance") ? (
              <AppearanceSettings initialTheme={initialSettings.theme} />
            ) : null}
            {shows("settings-notifications") ? (
              <NotificationSettings
                initialAccountEnabled={initialSettings.desktopNotificationsEnabled}
              />
            ) : null}
          </SettingsSection>
        ) : null}
        <Section id="settings-goals" hidden={hidden}>
          <GoalsSettings initialGoals={initialGoals} />
        </Section>
        <Section id="settings-targets" hidden={hidden}>
          <TargetCompaniesSettings
            initialCompanies={targetCompanies}
            initialSchools={schools}
          />
        </Section>
      </Group>

      <Group group="integrations" visible={groupVisible("integrations")}>
        <IntegrationsSettings
          tabs={integrationTabs}
          initialSettings={initialSettings}
          canUseRecruiters={initialSettings.plan.canUseRecruiters}
        />
      </Group>

      <Group group="resources" visible={groupVisible("resources")}>
        <SettingsSection
          title="Knowledge and help"
          description="What Orbit knows about your network, and help getting the most out of it."
        >
          {shows("settings-knowledge") ? <KnowledgeSettings /> : null}
          {shows("settings-help") ? (
            <HelpSettings feedbackEnabled={!hidden.has(FEEDBACK_SURFACE_KEY)} />
          ) : null}
        </SettingsSection>
      </Group>

      <Group group="data" visible={groupVisible("data")}>
        <Section id="settings-data" hidden={hidden}>
          <DataSettings />
        </Section>
      </Group>

      <SettingsSectionNav sections={railSections} />
    </div>
  );
}
