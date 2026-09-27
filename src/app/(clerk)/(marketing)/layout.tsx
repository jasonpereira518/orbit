import { LandingMotionProvider } from "@/components/landing/landing-motion-provider";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <LandingMotionProvider>{children}</LandingMotionProvider>;
}
