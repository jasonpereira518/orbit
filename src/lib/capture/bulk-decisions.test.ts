import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionFromDraft, draftFromItem } from "@/components/capture/review/person-deck";
import type { BulkNotePersonPreview } from "@/lib/capture/types";

describe("capture bulk decisions & person deck helper", () => {
  const mockItem = {
    key: "person-1",
    duplicates: [],
    parsed: {
      name: "Jane Doe",
      company: "Acme AI",
      role: "Lead Engineer",
      met_at: "Tech Summit",
      relationship_score_suggestion: 3,
      tags: ["AI", "Founder"],
      summary: "Discussed AI infrastructure and edge models.",
      takeaways: ["Discussed AI infrastructure", "Working on edge models"],
    },
  } as unknown as BulkNotePersonPreview;

  it("draftFromItem initializes draft with parsed values", () => {
    const draft = draftFromItem(mockItem, undefined);
    assert.equal(draft.fields.name, "Jane Doe");
    assert.equal(draft.fields.company, "Acme AI");
    assert.equal(draft.fields.role, "Lead Engineer");
    assert.equal(draft.fields.metAt, "Tech Summit");
    assert.equal(draft.closeness, 3);
    assert.deepEqual(draft.fields.takeaways, [
      "Discussed AI infrastructure",
      "Working on edge models",
    ]);
  });

  it("decisionFromDraft creates an accept decision correctly", () => {
    const draft = draftFromItem(mockItem, undefined);
    const decision = decisionFromDraft("accept", 0, draft);
    assert.equal(decision.decision, "accept");
    assert.equal(decision.index, 0);
    assert.equal(decision.relationshipScore, 3);
    assert.equal(decision.edits?.name, "Jane Doe");
    assert.equal(decision.edits?.company, "Acme AI");
  });

  it("bulk decisions can be constructed for all undecided cards", () => {
    const items: BulkNotePersonPreview[] = [
      mockItem,
      {
        key: "person-2",
        duplicates: [],
        parsed: {
          name: "John Smith",
          company: "Beta Corp",
          role: "Product Manager",
        },
      } as unknown as BulkNotePersonPreview,
    ];

    const bulkMap: Record<string, ReturnType<typeof decisionFromDraft>> = {};
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const draft = draftFromItem(it, undefined);
      bulkMap[it.key] = decisionFromDraft("accept", i, draft);
    }

    assert.equal(Object.keys(bulkMap).length, 2);
    assert.equal(bulkMap["person-1"]?.decision, "accept");
    assert.equal(bulkMap["person-1"]?.edits?.name, "Jane Doe");
    assert.equal(bulkMap["person-2"]?.decision, "accept");
    assert.equal(bulkMap["person-2"]?.edits?.name, "John Smith");
  });
});
