import { isClerkConfigured } from "@/lib/auth";
import { AccountDemoPanel } from "@/components/account/account-demo-panel";
import { DevicesList } from "@/components/account/devices-list";
import { SettingsSection } from "@/components/settings/settings-section";

/** Where this account is signed in, and how to end any of it but here. */
export default async function AccountDevicesPage() {
  const clerkOn = isClerkConfigured();

  return (
    <SettingsSection
      title="Devices"
      description="Everywhere you’re signed in. Sign out anything you don’t recognise."
    >
      {clerkOn ? <DevicesList /> : <AccountDemoPanel what="Your device list" />}
    </SettingsSection>
  );
}
