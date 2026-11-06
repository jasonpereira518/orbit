"use server";

import { z } from "zod";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import { eventView, getMeetingContext, type GuestNotInOrbit, type LinkedEvent, type MeetingPerson } from "@/lib/meeting-context";
import { generateTalkingPoints, type TalkingPointsResult } from "@/lib/meeting-talking-points";
import { lookUpGuestFor, type GuestBrief } from "@/lib/guest-profiles";
import { saveResearchedPersonForUser } from "@/lib/web-research";

export type MeetingPrep = {
  event: ReturnType<typeof eventView>;
  people: MeetingPerson[];
  notInOrbit: GuestNotInOrbit[];
  lastTime: { day: string; decisions: string[]; actionItems: string[] } | null;
  linkedEvent: LinkedEvent | null;
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
            linkedEvent: found.linkedEvent,
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

const LOOKUP_COPY: Record<"no_anchor" | "not_a_guest" | "not_sure", string> = {
  not_sure: "Couldn’t be sure which person this is",
  no_anchor: "Not enough to look them up safely — a personal email address doesn’t say where they work",
  not_a_guest: "They’re not on that meeting any more",
};

/** "Look up" for one guest who isn't a contact: Find people's research, on the user's own AI key. */
export async function lookUpGuest(
  eventId: string,
  email: string
): Promise<
  | { ok: true; profile: GuestBrief }
  | { ok: false; error: string }
> {
  try {
    const userId = await requireUserId();
    const id = z.string().uuid().parse(eventId);
    const address = z.string().email().max(320).parse(email);
    const res = await lookUpGuestFor(userId, id, address);
    if (res.status === "found") return { ok: true, profile: res.brief };
    if (res.status === "refused") return { ok: false, error: res.message };
    return { ok: false, error: LOOKUP_COPY[res.status] };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t look them up", "calendar.look-up-guest") };
  }
}

/**
 * "Add" for a guest who was looked up: the brief becomes a contact with its work history, the
 * way Find people's "Save to Orbit" does. Takes the brief's key, never its content, and only
 * this account's cached brief can be read — so nothing the client sends is written as fact.
 */
export async function addGuestFromBrief(key: string): Promise<{ ok: true; contactId: string } | { ok: false; error: string }> {
  try {
    const userId = await requireUserId();
    const saved = await saveResearchedPersonForUser(userId, z.string().regex(/^[0-9a-f]{64}$/).parse(key));
    if (!saved) return { ok: false, error: "That lookup has expired — look them up again to add them" };
    return { ok: true, contactId: saved.contactId };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t add them", "calendar.add-guest") };
  }
}
