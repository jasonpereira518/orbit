import { isClerkConfigured } from "@/lib/auth";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { ProfileForm } from "@/components/account/profile-form";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";

/**
 * Profile, and the account's end.
 *
 * Deleting stays on Orbit's own path (`deleteMyAccount` → `account-deletion.ts`), which
 * clears Orbit's data before the Clerk user. Clerk's own delete is switched off in the
 * dashboard precisely so this is the only way out.
 */
export default async function AccountProfilePage() {
  const clerkOn = isClerkConfigured();

  return (
    <>
      <SettingsSection title="Profile" description="Your name and picture.">
        {clerkOn ? <ProfileForm /> : <AccountDemoPanel what="Your profile" />}
      </SettingsSection>

      <SettingsSection
        title="Delete account"
        description="Your data and your sign-in, erased. There is no undo."
      >
        <DeleteAccountDialog
          trigger={
            <Button type="button" variant="destructive" size="sm">
              Delete account
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}
