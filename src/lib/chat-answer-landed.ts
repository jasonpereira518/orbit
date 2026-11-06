/**
 * What a finished answer changes outside its own bubble (`sendQuestion`'s `onDone`).
 *
 * The thread it answered always moves to the top of the history under the name the server
 * settled on — even when the person has since moved to another thread, because the rail hides
 * an untitled thread that is not open, so skipping this would make that chat vanish.
 *
 * The header title is different: it names the thread ON SCREEN. An answer that outlived a
 * switch must not rename the conversation the person moved to.
 */
export type LandedThread = {
  id: string;
  title: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** The title to put in the header, or null to leave the header alone. */
export function headerTitleAfterAnswer(
  answeredThreadId: string,
  openThreadId: string | null,
  title: string | null | undefined
): string | null {
  return title && answeredThreadId === openThreadId ? title : null;
}

/** The history list with the answered thread first, named `title`. */
export function threadsAfterAnswer<T extends LandedThread>(
  prev: readonly T[],
  answeredThreadId: string,
  title: string | null | undefined,
  now: Date
): LandedThread[] {
  return [
    { id: answeredThreadId, title: title ?? null, createdAt: now, updatedAt: now },
    ...prev.filter((t) => t.id !== answeredThreadId),
  ];
}
