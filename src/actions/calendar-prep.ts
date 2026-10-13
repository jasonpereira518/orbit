"use server";

import { z } from "zod";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import { eventView, getMeetingContext, type MeetingPerson } from "@/lib/meeting-context";

export type MeetingPrep = {
  event: ReturnType<typeof eventView>;
  people: MeetingPerson[];
  notInOrbit: Array<{ name: string; email: string }>;
};

/** The prep card's "Show brief": the same facts the `meeting_context` chat tool reads, no model. */
export async function getMeetingPrep(
  eventId: string
): Promise<{ ok: true; prep: MeetingPrep | null } | { ok: false; error: string }> {
  try {
    const userId = await requireUserId();
    const id = z.string().uuid().parse(eventId);
    const found = await getMeetingContext(userId, { eventId: id }, new Date());
    return {
      ok: true,
      prep: found ? { event: eventView(found.event, found.tz), people: found.people, notInOrbit: found.notInOrbit } : null,
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t load the meeting", "calendar.get-meeting-prep") };
  }
}
