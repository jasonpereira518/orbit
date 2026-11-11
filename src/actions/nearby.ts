"use server";

import { actionFailure } from "@/lib/action-failure";
import { loadPublicCardForOwner } from "@/lib/cards/card-store";
import { alsoHereViewFor, type AlsoHereView } from "@/lib/nearby/also-here-view";
import { setDiscoverable, setHiddenAtEvent } from "@/lib/nearby/discoverability";
import { requireUserId } from "@/lib/auth";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";

/**
 * People at the same event. Every export is async ("use server" rule), and every one takes its
 * user from the session — never from an argument.
 */

const SURFACE = "feature.also-here";

type Fail = { ok: false; message: string };

export async function setMyDiscoverable(on: boolean): Promise<{ ok: true } | Fail> {
  try {
    // Turning it OFF must always work — even if the feature is pulled — so nobody stays
    // findable with no switch to stop it. Turning it ON needs the feature released.
    const userId = on === true ? await requireUserForReleasedSurface(SURFACE) : await requireUserId();
    if (on && !(await loadPublicCardForOwner(userId))) {
      return { ok: false, message: "Create your card first — that’s what people here will see." };
    }
    await setDiscoverable(userId, on === true);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t change that — try again?", "nearby.discoverable") };
  }
}

export async function setHiddenHere(eventId: string, hidden: boolean): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    if (typeof eventId !== "string" || !(await setHiddenAtEvent(userId, eventId, hidden === true))) {
      return { ok: false, message: "That event isn’t in your Orbit." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t change that — try again?", "nearby.hide") };
  }
}

export async function getAlsoHere(eventId: string): Promise<AlsoHereView> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  return alsoHereViewFor(userId, typeof eventId === "string" ? eventId : "");
}
