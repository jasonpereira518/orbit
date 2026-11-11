"use server";

import QRCode from "qrcode";
import { actionFailure } from "@/lib/action-failure";
import { addArrivalNoteCore, listArrivals, type Arrival } from "@/lib/cards/arrivals";
import {
  cardUrl,
  getCardForOwner,
  previewCard,
  resetCardSlug,
  saveCard,
  setCardPaused,
  type CardDraft,
  type PublicCard,
} from "@/lib/cards/card-store";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";

/**
 * The owner's side of Orbit Card. Every export is async: one non-async export in a
 * "use server" file breaks every export in it.
 */

const SURFACE = "page.card";

type Fail = { ok: false; message: string };

/** Same encoder settings and recolor as `mintScanHandoffAction`: read off a screen, themed. */
async function qrFor(slug: string) {
  const url = cardUrl(slug);
  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#000000", light: "#0000" },
  });
  return { url, svg: svg.replace(/#000000/g, "currentColor") };
}

export async function getMyCard() {
  const userId = await requireUserForReleasedSurface(SURFACE);
  return getCardForOwner(userId);
}

export async function previewMyCard(draft: CardDraft): Promise<{ ok: true; card: PublicCard } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    return { ok: true, card: await previewCard(userId, draft) };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t preview your card — try again?", "cards.preview") };
  }
}

export async function saveMyCard(draft: CardDraft): Promise<{ ok: true; slug: string } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    return { ok: true, ...(await saveCard(userId, draft)) };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t save your card — try again?", "cards.save") };
  }
}

export async function resetMyCardLink(): Promise<{ ok: true; slug: string } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    return { ok: true, ...(await resetCardSlug(userId)) };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t reset your link — try again?", "cards.reset") };
  }
}

export async function setMyCardPaused(paused: boolean): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    await setCardPaused(userId, paused);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t update your card — try again?", "cards.pause") };
  }
}

export async function getMyCardQr(): Promise<{ ok: true; svg: string; url: string } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    const card = await getCardForOwner(userId);
    if (!card) return { ok: false, message: "Create your card first" };
    return { ok: true, ...(await qrFor(card.slug)) };
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t make a QR code — try again?", "cards.qr") };
  }
}

export async function listMyArrivals(): Promise<Arrival[]> {
  const userId = await requireUserForReleasedSurface(SURFACE);
  return listArrivals(userId);
}

export async function addArrivalNote(shareId: string, text: string): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserForReleasedSurface(SURFACE);
    return await addArrivalNoteCore(userId, shareId, text);
  } catch (err) {
    return { ok: false, message: await actionFailure(err, "Couldn’t save your note — try again?", "cards.note") };
  }
}
