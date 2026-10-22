import { z } from "zod";
import { OPPORTUNITY_KINDS, type OpportunityKind } from "@/lib/opportunity-kinds";

/**
 * What the browser may send to the /capture job actions (`src/actions/capture-jobs.ts`).
 *
 * These mirror the TypeScript parameter types the actions already declared, so a well-formed
 * call parses to the same value. The point is the call that is not well formed: a wrong-typed
 * field used to reach the row writers (`sourceKind: "carrier-pigeon"` queued a job whose
 * source no code path handles) or a `.trim()` on a number.
 */

export const CAPTURE_JOB_SOURCES = ["messy", "voice", "meeting", "scan", "phone", "api"] as const;

const optionalText = z.string().nullish();

const seedPersonSchema = z.object({
  name: optionalText,
  email: optionalText,
  linkedinUrl: optionalText,
  title: optionalText,
  company: optionalText,
});

export const captureParseHintsSchema = z.object({
  eventDate: optionalText,
  seedPeople: z.array(seedPersonSchema).optional(),
  interactionType: optionalText,
  goals: z.array(z.string()).optional(),
});

export const queueCaptureJobSchema = z.object({
  jobId: optionalText,
  text: z.string(),
  hints: captureParseHintsSchema.nullish(),
  sourceKind: z.enum(CAPTURE_JOB_SOURCES),
  entryPoint: z.enum(["capture", "profile"]).optional(),
  seedContactId: optionalText,
  meetingSessionId: optionalText,
  batchGroupId: optionalText,
  sourceLabel: optionalText,
  mentionPicks: z.array(z.object({ id: z.string(), name: z.string() })).nullish(),
  force: z.boolean().optional(),
});

const opportunityKind = z.enum(OPPORTUNITY_KINDS.map((k) => k.value) as [OpportunityKind, ...OpportunityKind[]]);

const captureChoicesSchema = z.object({
  reminders: z
    .object({
      checked: z.array(z.string()),
      overrides: z.record(
        z.string(),
        z.object({
          personName: optionalText,
          dueDateIso: z.string().optional(),
          title: z.string().optional(),
        })
      ),
    })
    .optional(),
  meeting: z
    .object({
      extraReminderKeys: z.array(z.string()),
      titles: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  opportunities: z
    .object({
      checked: z.array(z.string()),
      kinds: z.record(z.string(), opportunityKind).optional(),
    })
    .optional(),
});

export const recordCaptureChoicesSchema = z.object({ jobId: z.string(), choices: captureChoicesSchema });

export const discardCaptureJobSchema = z.object({
  jobId: z.string(),
  opts: z.object({ stopping: z.boolean().optional() }).optional(),
});
