import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/auth";
import { needsOnboarding } from "@/lib/onboarding";

/**
 * First-run gate for core product routes.
 * /onboarding and /settings live outside this group so they stay reachable
 * (settings is needed for API keys; onboarding must not redirect to itself).
 */
export default async function MainAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reuses the parent layout's cached requireUserId / settings bootstrap.
  const userId = await requireUserId();

  if (await needsOnboarding(userId)) {
    redirect("/onboarding");
  }

  return children;
}
