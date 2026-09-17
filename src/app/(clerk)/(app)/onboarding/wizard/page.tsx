import { redirect } from "next/navigation";

/**
 * The setup wizard was folded into the one onboarding flow. Kept as a redirect so an old
 * bookmark, or a tab left open mid-wizard when this shipped, still lands somewhere real.
 */
export default function OnboardingWizardPage() {
  redirect("/onboarding");
}
