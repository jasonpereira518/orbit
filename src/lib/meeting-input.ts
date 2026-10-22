import { z } from "zod";

/**
 * What the browser may send to the meeting actions (`src/actions/meetings.ts`). Mirrors the
 * parameter types the actions declared. Before this, `recorderId: 5` or `attendees: "everyone"`
 * created a session row with those values in it.
 */

const optionalText = z.string().nullish();

export const createMeetingSessionSchema = z.object({
  title: optionalText,
  attendees: z.array(z.object({ name: z.string(), email: optionalText })).optional(),
  includesMic: z.boolean(),
  captureSurface: optionalText,
  recorderId: z.string(),
  calendarEventKey: optionalText,
  calendarSeriesId: optionalText,
});

export const analyzeMeetingSessionSchema = z.object({
  id: z.string(),
  opts: z
    .object({
      force: z.boolean().optional(),
      localDateIso: z.string().optional(),
      notes: z.string().optional(),
    })
    .default({}),
});
