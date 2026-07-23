/** Direction for contacts ↔ recruiters list transitions. Module-scoped so it survives the click → navigate gap. */
let pendingDirection = 0;

export const PEOPLE_NAV_COOKIE = "orbit_people_nav";

export function setPeopleNavDirection(direction: -1 | 0 | 1) {
  pendingDirection = direction;
}

export function takePeopleNavDirection(): -1 | 0 | 1 {
  const d = pendingDirection;
  pendingDirection = 0;
  return d as -1 | 0 | 1;
}

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
