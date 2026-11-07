// Only the contacts list resumes where you left off, and only when you got there by
// back/forward. A link click (e.g. "See more" -> /contacts?followUp=due) starts at the top.
export function shouldRestoreScroll(pathname: string, historyTraversal: boolean) {
  return historyTraversal && pathname === "/contacts";
}

// One-shot "the next route change is a back/forward" flag. Set from a popstate listener
// (which fires before Next swaps the route); consumed by the next effect run.
let traversal = false;
export function markTraversal() {
  traversal = true;
}
export function consumeTraversal() {
  const was = traversal;
  traversal = false;
  return was;
}

// Only /contacts reacts to query changes; elsewhere (dialog deep links, OAuth return
// params) a replaceState must not jump the page to the top.
export function scrollKeySearch(pathname: string, search: string) {
  return pathname === "/contacts" ? search : "";
}
