/**
 * The panel kept carrying one page's decisions onto the next person. These are
 * the cases it actually got wrong, written as the sequence a user performs.
 */
import { describe, expect, it } from "vitest";
import { emptyScope, scopeFor, type PageScope } from "@/panel/state/page-scope";

const AMARA = "https://www.linkedin.com/in/amara-osei";
const BEN = "https://www.linkedin.com/in/ben-tate";

describe("scopeFor", () => {
  it("keeps decisions while the user stays on one page", () => {
    const held: PageScope = { url: AMARA, forceCreate: true, sealed: false };
    expect(scopeFor(held, AMARA)).toBe(held);
  });

  it('drops "add as new" when the user moves to someone else', () => {
    // The bug: Amara was ambiguous, the user chose "no — add as new", then
    // browsed to Ben, who IS a known contact. forceCreate carried over and the
    // panel offered to create a second Ben.
    const held: PageScope = { url: AMARA, forceCreate: true, sealed: false };
    expect(scopeFor(held, BEN)).toEqual({
      url: BEN,
      forceCreate: false,
      sealed: false,
    });
  });

  it("drops the seal ring when the user moves to someone else", () => {
    // The bug: the ring is the one hero animation, drawn once when a person is
    // added. It stayed drawn for every profile visited afterwards.
    const held: PageScope = { url: AMARA, forceCreate: false, sealed: true };
    expect(scopeFor(held, BEN).sealed).toBe(false);
  });

  it("treats a first read (no page yet, then a page) as a change", () => {
    expect(scopeFor(emptyScope(null), AMARA).url).toBe(AMARA);
  });

  it("does not resurrect decisions when the user returns to a page", () => {
    // Held scope is only ever the latest page's, so coming back to Amara after
    // Ben starts clean rather than restoring a stale "add as new".
    const onBen: PageScope = { url: BEN, forceCreate: true, sealed: true };
    expect(scopeFor(onBen, AMARA)).toEqual(emptyScope(AMARA));
  });

  it("is a pure read — it never mutates what it was handed", () => {
    const held: PageScope = { url: AMARA, forceCreate: true, sealed: true };
    const snapshot = { ...held };
    scopeFor(held, BEN);
    expect(held).toEqual(snapshot);
  });
});
