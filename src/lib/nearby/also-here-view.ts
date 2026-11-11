import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { loadPublicCardForOwner } from "@/lib/cards/card-store";
import { alsoHereFor, type AlsoHerePerson } from "@/lib/nearby/also-here";
import { isDiscoverable } from "@/lib/nearby/discoverability";

export type AlsoHereView = {
  findable: boolean;
  discoverable: boolean;
  hiddenHere: boolean;
  hasCard: boolean;
  people: AlsoHerePerson[];
};

/**
 * Everything the "Orbit people here" card needs for one viewer at one event. Takes a user id,
 * so it lives here and NOT in a "use server" file, where any export is callable with any id.
 */
export async function alsoHereViewFor(userId: string, eventId: string): Promise<AlsoHereView> {
  const db = await getDb();
  const [[own], discoverable, card, result] = await Promise.all([
    /^[0-9a-f-]{36}$/i.test(eventId)
      ? db
          .select({ hiddenAt: events.discoveryHiddenAt })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.userId, userId)))
          .limit(1)
      : Promise.resolve([]),
    isDiscoverable(userId),
    loadPublicCardForOwner(userId),
    alsoHereFor(userId, eventId),
  ]);
  return { ...result, discoverable, hiddenHere: !!own?.hiddenAt, hasCard: !!card };
}
