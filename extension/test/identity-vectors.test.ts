/**
 * The extension's half of the identity contract.
 *
 * The app runs the same vectors against its own normalisers in
 * `scripts/smoke-identity-vectors.ts`. Both read `vectors/identity.json`, so a
 * change that makes one side pass and the other fail is now a failing build
 * rather than a silent "new to your orbit" for someone known for years.
 */
import { describe, expect, it } from "vitest";
import { linkedinSlug, xHandle } from "@/inject/dom/url";
import vectors from "./vectors/identity.json";

type Vector = {
  input: string | null;
  expected: string;
  app?: string;
  note?: string;
};

describe("linkedinSlug", () => {
  for (const vector of vectors.linkedinSlug as Vector[]) {
    it(`${JSON.stringify(vector.input)} → ${JSON.stringify(vector.expected)}${
      vector.note ? ` (${vector.note})` : ""
    }`, () => {
      expect(linkedinSlug(vector.input)).toBe(vector.expected);
    });
  }
});

describe("xHandle", () => {
  for (const vector of vectors.xHandle as Vector[]) {
    it(`${JSON.stringify(vector.input)} → ${JSON.stringify(vector.expected)}${
      vector.note ? ` (${vector.note})` : ""
    }`, () => {
      expect(xHandle(vector.input)).toBe(vector.expected);
    });
  }
});
