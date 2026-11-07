// Only the contacts list resumes where you left off, and only when you got there by
// back/forward. A link click (e.g. "See more" -> /contacts?followUp=due) starts at the top.
export function shouldRestoreScroll(pathname: string, historyTraversal: boolean) {
  return historyTraversal && pathname === "/contacts";
}
