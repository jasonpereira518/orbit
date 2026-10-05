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
      {/*
        A plain block by default, which content-sizes it and so breaks the shell's bounded
        flex column for every page below it (why /chat and /graph size themselves from the
        viewport). A page that wants the bounded height marks its root with the
        data-fill-route attribute, and only then does this wrapper become a flex column
        that passes the height down. Every other page renders exactly as before.
      */}
      <div className="has-[>[data-fill-route]]:flex has-[>[data-fill-route]]:min-h-0 has-[>[data-fill-route]]:flex-1 has-[>[data-fill-route]]:flex-col">
        {children}
      </div>
    </ViewTransition>
  );
}
