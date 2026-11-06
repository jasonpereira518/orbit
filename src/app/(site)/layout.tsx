// The marketing sheet: utilities from these pages only, no Clerk theme (see site.css).
import "../site.css";
import { LandingMotionProvider } from "@/components/landing/landing-motion-provider";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LandingMotionProvider>{children}</LandingMotionProvider>;
}
