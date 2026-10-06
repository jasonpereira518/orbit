import { redirect } from "next/navigation";

/** The setup wizard folded into /onboarding; old links and bookmarks land there. */
export default function OnboardingWizardPage() {
  redirect("/onboarding");
}
