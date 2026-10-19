"use server";

import { deleteOwnAccount } from "@/lib/account-deletion";
import { ACCOUNT_DELETE_CONFIRMATION } from "@/lib/account-deletion-shared";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { z } from "zod";
import { defineAction, failResult } from "@/lib/input/action";

/**
 * Deletes the signed-in account. The typed confirmation is re-checked here because an
 * action is reachable by direct POST, not only through the dialog.
 */
export const deleteMyAccount = defineAction(
  { schema: z.tuple([z.looseObject({ confirmation: z.string() })]), invalid: failResult },
  async (userId, input: {
    confirmation: string;
  }): Promise<ActionResult<{ redirectTo: "/" }>> => {
    return asActionResult(async () => {
      if (input.confirmation.trim().toLowerCase() !== ACCOUNT_DELETE_CONFIRMATION) {
        throw new UserFacingError(`Type ${ACCOUNT_DELETE_CONFIRMATION} to confirm`);
      }
      await deleteOwnAccount(userId);
      return { redirectTo: "/" as const };
    });
  }
);
