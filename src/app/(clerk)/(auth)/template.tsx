import { RouteTransition } from "@/components/layout/route-transition";

export default function AuthTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RouteTransition>{children}</RouteTransition>;
}
