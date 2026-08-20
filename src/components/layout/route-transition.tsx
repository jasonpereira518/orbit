import { ViewTransition } from "react";

/**
 * Route-level cross-fade via the View Transitions API.
 *
 * Remounting is owned by `(app)/template.tsx` (Next templates remount on
 * nav), which gives every navigation an exit/enter pair. Shared client work
 * (AvatarBackfill, etc.) must live in `(app)/layout` / AppShell above the
 * template — not under it.
 *
 * Contacts ↔ recruiters navigations carry `people-fwd` / `people-back`
 * transition types (see PeopleListShell); the page fade steps aside so the
 * list's directional slide owns those. The staged content reveal (header →
 * cards) is the `.reveal-mount` cascade inside pages, not VT pseudo-elements,
 * so it also runs on hard loads and in browsers without the VT API.
 */
export function RouteTransition({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition
      enter={{ "people-fwd": "none", "people-back": "none", default: "page-enter" }}
      exit={{ "people-fwd": "none", "people-back": "none", default: "page-exit" }}
      default="none"
    >
      <div>{children}</div>
    </ViewTransition>
  );
}
