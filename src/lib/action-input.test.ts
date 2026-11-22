import "../../scripts/smoke/_env";
/**
 * P5.2: `parseInput` and the first-wave action schemas.
 *
 * The risk in adding a schema to a live action is not that it rejects junk; it is that it
 * rejects something a real client sends. So each schema is checked against the payload shapes
 * the UI builds (every optional field present, absent and null) as well as against junk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { INVALID_INPUT_MESSAGE, parseInput } from "@/lib/action";
import { beginChatImportSchema } from "@/lib/chat-import-input";
import { analyzeMeetingSessionSchema, createMeetingSessionSchema } from "@/lib/meeting-input";
import { createOpportunitySchema, updateOpportunitySchema } from "@/lib/opportunity-input";
import {
  discardCaptureJobSchema,
  queueCaptureJobSchema,
  recordCaptureChoicesSchema,
} from "@/lib/capture/job-input";

const accepts = (schema: z.ZodType, value: unknown) => assert.equal(schema.safeParse(value).success, true, JSON.stringify(value));
const rejects = (schema: z.ZodType, value: unknown) => assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));

describe("parseInput", () => {
  const schema = z.object({ n: z.number() });

  it("returns the parsed value", () => {
    assert.deepEqual(parseInput(schema, { n: 1, extra: true }, "test.ok"), { ok: true, value: { n: 1 } });
  });

  it("returns the shared refusal, without echoing the input or the zod message", () => {
    const secret = "sk_live_do_not_echo";
    const result = parseInput(schema, { n: secret }, "test.bad");
    assert.deepEqual(result, { ok: false, error: INVALID_INPUT_MESSAGE });
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  it("never throws, whatever it is given", () => {
    for (const junk of [null, undefined, 5, "x", [], () => 1, Symbol.iterator.description]) {
      assert.equal(parseInput(schema, junk, "test.junk").ok, false);
    }
  });
});

describe("opportunity schemas", () => {
  it("accept what the form sends", () => {
    accepts(createOpportunitySchema, { contactId: "c", kind: "job", label: "Role" });
    accepts(createOpportunitySchema, { contactId: "c", kind: "job", label: "Role", direction: null, dueDateIso: null, status: "open" });
    accepts(updateOpportunitySchema, { id: "o", patch: {} });
    accepts(updateOpportunitySchema, { id: "o", patch: { status: "closed", dueDateIso: null, direction: "they_offer" } });
  });
  it("keep kind/status free-form so normalize* can default them", () => {
    accepts(createOpportunitySchema, { contactId: "c", kind: "retired-kind", label: "x", status: "weird" });
  });
  it("reject wrong types", () => {
    rejects(createOpportunitySchema, null);
    rejects(createOpportunitySchema, { contactId: 1, kind: "job", label: "x" });
    rejects(createOpportunitySchema, { contactId: "c", kind: "job", label: ["x"] });
    rejects(updateOpportunitySchema, { id: {}, patch: {} });
    rejects(updateOpportunitySchema, { id: "o", patch: null });
    rejects(updateOpportunitySchema, { id: "o", patch: { label: 5 } });
  });
});

describe("meeting schemas", () => {
  it("accept what the recorder sends", () => {
    accepts(createMeetingSessionSchema, { includesMic: true, recorderId: "r" });
    accepts(createMeetingSessionSchema, {
      title: null,
      attendees: [{ name: "Ada", email: null }, { name: "Grace" }],
      includesMic: false,
      captureSurface: null,
      recorderId: "r",
      calendarEventKey: "k",
      calendarSeriesId: null,
    });
    accepts(analyzeMeetingSessionSchema, { id: "m" });
    accepts(analyzeMeetingSessionSchema, { id: "m", opts: { force: true, localDateIso: "2026-10-21", notes: "n" } });
  });
  it("defaults analyze opts to {}", () => {
    assert.deepEqual(analyzeMeetingSessionSchema.parse({ id: "m" }).opts, {});
  });
  it("reject wrong types", () => {
    rejects(createMeetingSessionSchema, { includesMic: "yes", recorderId: "r" });
    rejects(createMeetingSessionSchema, { includesMic: true, recorderId: 5 });
    rejects(createMeetingSessionSchema, { includesMic: true, recorderId: "r", attendees: "everyone" });
    rejects(createMeetingSessionSchema, { includesMic: true, recorderId: "r", attendees: [{ email: "a@b.c" }] });
    rejects(analyzeMeetingSessionSchema, { id: {} });
    rejects(analyzeMeetingSessionSchema, { id: "m", opts: null });
    rejects(analyzeMeetingSessionSchema, { id: "m", opts: { notes: 5 } });
  });
});

describe("capture job schemas", () => {
  it("accept every source kind and the optional fields as null or absent", () => {
    for (const sourceKind of ["messy", "voice", "meeting", "scan", "phone", "api"]) {
      accepts(queueCaptureJobSchema, { text: "met Ada", sourceKind });
    }
    accepts(queueCaptureJobSchema, {
      jobId: null,
      text: "",
      hints: { eventDate: null, seedPeople: [{ name: "Ada", email: null }], interactionType: "meeting", goals: ["g"] },
      sourceKind: "voice",
      entryPoint: "profile",
      seedContactId: null,
      meetingSessionId: null,
      batchGroupId: "b",
      sourceLabel: null,
      mentionPicks: [{ id: "1", name: "Ada" }],
      force: false,
    });
    accepts(queueCaptureJobSchema, { text: "x", sourceKind: "messy", hints: null, mentionPicks: null });
  });
  it("rejects wrong types and unknown sources", () => {
    rejects(queueCaptureJobSchema, null);
    rejects(queueCaptureJobSchema, { text: 5, sourceKind: "messy" });
    rejects(queueCaptureJobSchema, { text: "x", sourceKind: "carrier-pigeon" });
    rejects(queueCaptureJobSchema, { text: "x", sourceKind: "messy", hints: "none" });
    rejects(queueCaptureJobSchema, { text: "x", sourceKind: "messy", mentionPicks: [{ id: 1 }] });
  });
  it("accepts choices with each section absent, and rejects malformed sections", () => {
    accepts(recordCaptureChoicesSchema, { jobId: "j", choices: {} });
    accepts(recordCaptureChoicesSchema, {
      jobId: "j",
      choices: {
        reminders: { checked: ["a"], overrides: { a: { personName: null, dueDateIso: "2026-10-21", title: "t" } } },
        meeting: { extraReminderKeys: [], titles: { k: "t" } },
        opportunities: { checked: ["p:0"], kinds: { "p:0": "referral" } },
      },
    });
    rejects(recordCaptureChoicesSchema, { jobId: "j", choices: null });
    rejects(recordCaptureChoicesSchema, { jobId: "j", choices: { reminders: "all" } });
    rejects(recordCaptureChoicesSchema, { jobId: "j", choices: { opportunities: { checked: [], kinds: { k: "not-a-kind" } } } });
  });
  it("discard takes an optional stopping flag", () => {
    accepts(discardCaptureJobSchema, { jobId: "j" });
    accepts(discardCaptureJobSchema, { jobId: "j", opts: { stopping: true } });
    rejects(discardCaptureJobSchema, { jobId: {} });
    rejects(discardCaptureJobSchema, { jobId: "j", opts: "stop" });
  });
});

describe("chat import schema", () => {
  it("accepts both sources and rejects the rest", () => {
    accepts(beginChatImportSchema, { source: "whatsapp", fileName: "a.txt", selfNames: [] });
    accepts(beginChatImportSchema, { source: "imessage", fileName: "a", selfNames: ["Me"] });
    rejects(beginChatImportSchema, { source: "slack", fileName: "a", selfNames: [] });
    rejects(beginChatImportSchema, { source: "whatsapp", fileName: 5, selfNames: [] });
    rejects(beginChatImportSchema, { source: "whatsapp", fileName: "a", selfNames: "me" });
  });
});
