/**
 * One sky that shows every cluster form, shared by the smokes that draw them.
 *
 * - Northwind: a 27-person company whose titles split it into a leadership core and three
 *   function petals (engineering, design, sales) — the "petal" form.
 * - Chapel Hill: a 6-person school — the "ring" form.
 * - Duo Labs: two people at one company — the "binary" form.
 * - Four engineers, each at a different one-off company — one role cluster, "Engineers",
 *   drawn open with a dotted line and the subtitle "across 4 companies".
 *
 * Deterministic: no clock, no randomness. Every contact carries the required
 * `GraphContactInput` fields.
 */
import type { GraphContactInput } from "../../src/lib/graph-layout";

function person(id: string, opts: Partial<GraphContactInput> = {}): GraphContactInput {
  return {
    id,
    fullName: `Person ${id}`,
    company: null,
    title: null,
    relationshipScore: 3,
    lastInteractionAt: "2026-08-20T00:00:00.000Z",
    nextFollowUpAt: null,
    tags: [],
    aiSummary: null,
    keyFacts: null,
    ...opts,
  };
}

export function anatomyFixture(): GraphContactInput[] {
  return [
    ...["VP Engineering", "CTO", "Co-founder"].map((title, i) =>
      person(`nw-l${i}`, { company: "Northwind", title, orbitScore: 5 - i })
    ),
    ...Array.from({ length: 11 }, (_, i) =>
      person(`nw-e${i}`, { company: "Northwind", title: "Software Engineer", orbitScore: 1 + ((i * 3) % 5) })
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      person(`nw-d${i}`, { company: "Northwind", title: "Product Designer", orbitScore: 1 + ((i * 2) % 5) })
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      person(`nw-s${i}`, { company: "Northwind", title: "Account Executive", orbitScore: 1 + (i % 5) })
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      person(`ch${i}`, { school: "Chapel Hill", orbitScore: 1 + (i % 5) })
    ),
    person("duo0", { company: "Duo Labs", orbitScore: 4 }),
    person("duo1", { company: "Duo Labs", orbitScore: 2 }),
    person("eng0", { company: "Acme Robotics", title: "Backend Engineer", orbitScore: 3 }),
    person("eng1", { company: "Nimbus Labs", title: "Software Engineer", orbitScore: 4 }),
    person("eng2", { company: "Quill Systems", title: "Platform Engineer", orbitScore: 2 }),
    person("eng3", { company: "Harbor Data", title: "Staff Engineer", orbitScore: 3 }),
  ];
}
