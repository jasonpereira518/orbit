"use server";

import { revalidatePath } from "next/cache";
import {
  countIgnoredPeopleFor,
  listIgnoredPeopleFor,
  promoteIgnoredPerson,
  removeIgnoredPerson,
  type IgnoredPerson,
} from "@/lib/ignored-people";
import { actionFailure } from "@/lib/action-failure";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";

type Fail = { ok: false; error: string };

export const listIgnoredPeople = defineAction(
  { invalid: failResult, onGateError: async (err) => {
    return { ok: false as const, error: await actionFailure(err, "Couldn’t load the ignored people — try again?", "ignored-people.list-ignored-people") };
  } },
  async (userId): Promise<{ ok: true; people: IgnoredPerson[] } | Fail> => {
    try {
      return { ok: true, people: await listIgnoredPeopleFor(userId) };
    } catch (err) {
      return { ok: false, error: await actionFailure(err, "Couldn’t load the ignored people — try again?", "ignored-people.list-ignored-people") };
    }
  }
);

export const countIgnoredPeople = defineAction(
  {},
  async (userId): Promise<number> => {
    return countIgnoredPeopleFor(userId).catch(() => 0);
  }
);

export const addIgnoredPersonAsContact = defineAction(
  { schema: z.tuple([z.string()]), invalid: failResult, onGateError: async (err) => {
    return { ok: false as const, error: await actionFailure(err, "Couldn’t add them — try again?", "ignored-people.add-ignored-person-as-contact") };
  } },
  async (userId, id: string): Promise<{ ok: true; contactId: string; created: boolean } | Fail> => {
    try {
      const out = await promoteIgnoredPerson(userId, id);
      if (!out) return { ok: false, error: "That person is no longer on the list" };
      revalidatePath("/contacts");
      revalidatePath("/capture");
      return { ok: true, ...out };
    } catch (err) {
      return { ok: false, error: await actionFailure(err, "Couldn’t add them — try again?", "ignored-people.add-ignored-person-as-contact") };
    }
  }
);

export const forgetIgnoredPerson = defineAction(
  { schema: z.tuple([z.string()]), invalid: failResult, onGateError: async (err) => {
    return { ok: false as const, error: await actionFailure(err, "Couldn’t remove them — try again?", "ignored-people.forget-ignored-person") };
  } },
  async (userId, id: string): Promise<{ ok: true } | Fail> => {
    try {
      await removeIgnoredPerson(userId, id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: await actionFailure(err, "Couldn’t remove them — try again?", "ignored-people.forget-ignored-person") };
    }
  }
);
