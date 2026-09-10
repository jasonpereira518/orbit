import type { SignalSource } from "../types";
import { commitmentDueSource } from "./commitment-due";
import { dormantSource } from "./dormant";
import { neverContactedSource } from "./never-contacted";
import { openLoopSource } from "./open-loop";
import { postEventSource } from "./post-event";
import { scheduledFollowUpSource } from "./scheduled-follow-up";
import { threadQuietSource } from "./thread-quiet";

export const DAILY_SOURCES: SignalSource[] = [
  commitmentDueSource,
  scheduledFollowUpSource,
  openLoopSource,
  postEventSource,
  dormantSource,
  threadQuietSource,
  neverContactedSource,
];
