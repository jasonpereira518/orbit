export const PEOPLE_NAV_COOKIE = "orbit_people_nav";

/** Direction for contacts ↔ recruiters list transitions (View Transition typed). */
export function directionForPeopleNav(
  from: "contacts" | "recruiters",
  to: "contacts" | "recruiters"
): -1 | 0 | 1 {
  if (from === to) return 0;
  return to === "recruiters" ? 1 : -1;
}

/** Short-lived cookie so loading.tsx can skip skeletons during people toggle nav. */
export function markPeopleNavInBrowser() {
  if (typeof document === "undefined") return;
  document.cookie = `${PEOPLE_NAV_COOKIE}=1; Path=/; Max-Age=15; SameSite=Lax`;
}

export function clearPeopleNavInBrowser() {
  if (typeof document === "undefined") return;
  document.cookie = `${PEOPLE_NAV_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
