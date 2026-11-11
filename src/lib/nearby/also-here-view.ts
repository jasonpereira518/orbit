import { alsoHereDetail, type AlsoHereDetail } from "@/lib/nearby/also-here";

export type AlsoHereView = AlsoHereDetail;

/**
 * Everything the "Orbit people here" card needs for one viewer at one event. Takes a user id,
 * so it lives here and NOT in a "use server" file, where any export is callable with any id.
 */
export async function alsoHereViewFor(userId: string, eventId: string): Promise<AlsoHereView> {
  return alsoHereDetail(userId, eventId);
}
