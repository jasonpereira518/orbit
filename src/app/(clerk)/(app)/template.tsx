import { RouteFocus } from "@/components/layout/route-focus";
import { RouteTransition } from "@/components/layout/route-transition";
import { ScrollRestoration } from "@/components/layout/scroll-restoration";

export default function AppTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RouteTransition>
      <ScrollRestoration />
      <RouteFocus />
      {children}
    </RouteTransition>
  );
}
