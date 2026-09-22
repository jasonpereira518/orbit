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
    const held: PageScope = { url: AMARA, forceCreate: true, sealed: false, picked: null };
    expect(scopeFor(held, AMARA)).toBe(held);
  });

  it('drops "add as new" when the user moves to someone else', () => {
    // The bug: Amara was ambiguous, the user chose "no — add as new", then
    // browsed to Ben, who IS a known contact. forceCreate carried over and the
    // panel offered to create a second Ben.
    const held: PageScope = { url: AMARA, forceCreate: true, sealed: false, picked: null };
    expect(scopeFor(held, BEN)).toEqual(emptyScope(BEN));
  });

  it("drops the seal ring when the user moves to someone else", () => {
    // The bug: the ring is the one hero animation, drawn once when a person is
    // added. It stayed drawn for every profile visited afterwards.
    const held: PageScope = { url: AMARA, forceCreate: false, sealed: true, picked: null };
    expect(scopeFor(held, BEN).sealed).toBe(false);
  });

  it("treats a first read (no page yet, then a page) as a change", () => {
    expect(scopeFor(emptyScope(null), AMARA).url).toBe(AMARA);
  });

  it("does not resurrect decisions when the user returns to a page", () => {
    // Held scope is only ever the latest page's, so coming back to Amara after
    // Ben starts clean rather than restoring a stale "add as new".
    const onBen: PageScope = { url: BEN, forceCreate: true, sealed: true, picked: null };
    expect(scopeFor(onBen, AMARA)).toEqual(emptyScope(AMARA));
  });

  it("drops a person picked from a list when the tab moves on", () => {
    // Picked from a search-results page, then the user browses away: the
    // panel must follow the tab, not keep showing the picked person.
    const picked = { url: "https://www.linkedin.com/in/ben-tate" } as unknown as PageScope["picked"];
    const held: PageScope = { url: AMARA, forceCreate: false, sealed: false, picked };
    expect(scopeFor(held, BEN).picked).toBeNull();
    expect(scopeFor(held, AMARA).picked).toBe(picked);
  });

  it("is a pure read — it never mutates what it was handed", () => {
    const held: PageScope = { url: AMARA, forceCreate: true, sealed: true, picked: null };
    const snapshot = { ...held };
    scopeFor(held, BEN);
    expect(held).toEqual(snapshot);
  });
});
