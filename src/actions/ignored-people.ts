"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import {
  countIgnoredPeopleFor,
  listIgnoredPeopleFor,
  promoteIgnoredPerson,
  removeIgnoredPerson,
  type IgnoredPerson,
} from "@/lib/ignored-people";

type Fail = { ok: false; error: string };

export async function listIgnoredPeople(): Promise<{ ok: true; people: IgnoredPerson[] } | Fail> {
  try {
    const userId = await requireUserId();
    return { ok: true, people: await listIgnoredPeopleFor(userId) };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t load the ignored people — try again?") };
  }
}

export async function countIgnoredPeople(): Promise<number> {
  const userId = await requireUserId();
  return countIgnoredPeopleFor(userId).catch(() => 0);
}

export async function addIgnoredPersonAsContact(
  id: string
): Promise<{ ok: true; contactId: string; created: boolean } | Fail> {
  try {
    const userId = await requireUserId();
    const out = await promoteIgnoredPerson(userId, id);
    if (!out) return { ok: false, error: "That person is no longer on the list" };
    revalidatePath("/contacts");
    revalidatePath("/capture");
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t add them — try again?") };
  }
}

export async function forgetIgnoredPerson(id: string): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserId();
    await removeIgnoredPerson(userId, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t remove them — try again?") };
  }
}
