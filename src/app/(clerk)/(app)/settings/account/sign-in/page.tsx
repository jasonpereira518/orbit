import { isClerkConfigured } from "@/lib/auth";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * How this account gets in: the addresses it can be reached at, and the providers it can
 * arrive through. The screens themselves are client components on Clerk's user resource —
 * this page is only the gate and the frame.
 */
export default async function AccountSignInPage() {
  const clerkOn = isClerkConfigured();

  if (!clerkOn) {
    return (
      <SettingsSection title="Sign-in" description="The addresses and accounts you sign in with.">
        <AccountDemoPanel what="Your sign-in methods" />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title="Email addresses"
        description="Where Orbit reaches you, and what you can sign in with."
      >
        <p className="text-sm text-muted-foreground">Email management arrives in the next step</p>
      </SettingsSection>
      <SettingsSection
        title="Connected accounts"
        description="Providers you can sign in through."
      >
        <p className="text-sm text-muted-foreground">Connected accounts arrive in the next step</p>
      </SettingsSection>
    </>
  );
}
