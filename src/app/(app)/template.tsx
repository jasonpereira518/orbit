import { RouteTransition } from "@/components/layout/route-transition";

export default function AppTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RouteTransition>{children}</RouteTransition>;
}
