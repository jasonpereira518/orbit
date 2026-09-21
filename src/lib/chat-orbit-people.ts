import type { ChatStep } from "@/lib/chat-stream-protocol";

/**
 * Who circles the planet while an answer is being worked out.
 *
 * Pure, so the rule that keeps the scene honest is testable: the people shown are people the
 * pipeline actually touched, and they change as it narrows.
 *
 *   - While the search is still ranking, its top candidates are shown — they are who is in
 *     play, and showing them the moment they are found is the point of the scene.
 *   - Once `rank` has finished, those candidates are replaced by whoever survived it. A
 *     contact who circled for a moment and then left is one the rerank dropped, which is
 *     exactly what happened.
 *   - People the user named, and overdue follow-ups, stay throughout: no ranking removes them.
 */

export type OrbitPerson = {
  id: string;
  name: string;
  photoUrl: string | null;
};

/** Two rings hold this many between them; more would crowd the faces into each other. */
export const ORBIT_CAPACITY = 8;

export function collectOrbitPeople(
  steps: readonly ChatStep[],
  limit: number = ORBIT_CAPACITY
): OrbitPerson[] {
  const rankDone = steps.some((s) => s.kind === "rank" && s.status === "done");
  const people = new Map<string, OrbitPerson>();

  for (const step of steps) {
    // The candidates give way to the survivors, which arrive on the rank step.
    if (step.kind === "search" && rankDone) continue;
    for (const ref of step.refs ?? []) {
      if (ref.kind !== "contact") continue;
      const known = people.get(ref.id);
      if (!known) {
        people.set(ref.id, { id: ref.id, name: ref.name, photoUrl: ref.photoUrl ?? null });
      } else if (!known.photoUrl && ref.photoUrl) {
        // The same person reported by two stages; whichever learned the photo first wins.
        known.photoUrl = ref.photoUrl;
      }
    }
  }

  return [...people.values()].slice(0, limit);
}
