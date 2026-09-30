import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";
import { surfaceKeyForSettingsId } from "@/lib/surfaces";
import { AccountNavSlot } from "@/components/account/account-nav";

/**
 * Shell for the account screens, and the one place their visibility is decided.
 *
 * These routes are the Profile section's own page, so they ride its surface key rather than
 * introducing one: an operator who has hidden `settings.profile` has hidden this too. A
 * hidden viewer goes back to /settings, which still exists, instead of getting a dead end.
 *
 * The nav rail needs the pathname, and a layout is not re-rendered on navigation between
 * its children, so the rail reads it on the client via `usePathname()` inside `AccountNav`
 * (wrapped here by `AccountNavSlot`, which keeps this layout itself a server component).
 *
 * No own padding here: `AppShell`'s content wrapper already applies it (and already treats
 * every `/settings/...` path, this one included, as Settings for its bottom padding), so
 * this mirrors `/settings` itself — spacing only, no template div re-padding the page.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const userId = await requireUserId();
  const { hidden } = await resolveSurfaceVisibility(userId);
  if (hidden.has(surfaceKeyForSettingsId("settings-profile"))) {
    redirect("/settings");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-primary">
          Your account
        </h1>
        <p className="text-sm text-muted-foreground">
          Your identity and how you sign in to Orbit.
        </p>
      </header>
      <div className="grid gap-6 sm:grid-cols-[10rem_1fr]">
        <AccountNavSlot />
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}
