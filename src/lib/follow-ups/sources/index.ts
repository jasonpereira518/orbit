import type { SignalSource } from "../types";
import { dormantSource } from "./dormant";
import { neverContactedSource } from "./never-contacted";
import { threadQuietSource } from "./thread-quiet";

/** Everything the daily pass runs. Tasks 3–5 append to this array. */
export const DAILY_SOURCES: SignalSource[] = [
  dormantSource,
  threadQuietSource,
  neverContactedSource,
];
