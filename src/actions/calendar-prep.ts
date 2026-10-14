"use server";

import { z } from "zod";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import { eventView, getMeetingContext, type GuestNotInOrbit, type MeetingPerson } from "@/lib/meeting-context";
import { generateTalkingPoints, type TalkingPointsResult } from "@/lib/meeting-talking-points";
import { lookUpGuestFor } from "@/lib/guest-profiles";

export type MeetingPrep = {
  event: ReturnType<typeof eventView>;
  people: MeetingPerson[];
  notInOrbit: GuestNotInOrbit[];
  lastTime: { day: string; decisions: string[]; actionItems: string[] } | null;
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
      prep: found
        ? {
            event: eventView(found.event, found.tz),
            people: found.people,
            notInOrbit: found.notInOrbit,
            lastTime: found.lastTime,
          }
        : null,
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t load the meeting", "calendar.get-meeting-prep") };
  }
}

/** "Talking points" on the prep card: AI on the user's key when there is one, by rule otherwise. */
export async function getTalkingPoints(
  eventId: string
): Promise<{ ok: true; result: TalkingPointsResult } | { ok: false; error: string }> {
  try {
    const userId = await requireUserId();
    const id = z.string().uuid().parse(eventId);
    const ctx = await getMeetingContext(userId, { eventId: id }, new Date());
    if (!ctx) return { ok: false, error: "That meeting is no longer on your calendar" };
    return { ok: true, result: await generateTalkingPoints(userId, ctx) };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t write talking points", "calendar.get-talking-points") };
  }
}

const LOOKUP_COPY: Record<"no_anchor" | "not_a_guest", string> = {
  no_anchor: "Not enough to look them up safely — a personal email address doesn’t say where they work",
  not_a_guest: "They’re not on that meeting any more",
};

/** "Look up" for one guest who isn't a contact: one web search on the user's own AI key. */
export async function lookUpGuest(
  eventId: string,
  email: string
): Promise<
  | { ok: true; found: boolean; profile: { title: string | null; company: string | null; headline: string | null; linkedinUrl: string | null } | null }
  | { ok: false; error: string }
> {
  try {
    const userId = await requireUserId();
    const id = z.string().uuid().parse(eventId);
    const address = z.string().email().max(320).parse(email);
    const res = await lookUpGuestFor(userId, id, address);
    if (res.status === "no_anchor" || res.status === "not_a_guest") return { ok: false, error: LOOKUP_COPY[res.status] };
    const p = res.profile;
    return {
      ok: true,
      found: res.status === "found",
      profile: res.status === "found" ? { title: p.title, company: p.company, headline: p.headline, linkedinUrl: p.linkedinUrl } : null,
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t look them up", "calendar.look-up-guest") };
  }
}
