/** Direction for contacts ↔ recruiters list transitions. Module-scoped so it survives the click → navigate gap. */
let pendingDirection = 0;

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
