import type { SignalSource } from "../types";
import { commitmentDueSource } from "./commitment-due";
import { dormantSource } from "./dormant";
import { neverContactedSource } from "./never-contacted";
import { postEventSource } from "./post-event";
import { scheduledFollowUpSource } from "./scheduled-follow-up";
import { threadQuietSource } from "./thread-quiet";

export const DAILY_SOURCES: SignalSource[] = [
  commitmentDueSource,
  scheduledFollowUpSource,
  postEventSource,
  dormantSource,
  threadQuietSource,
  neverContactedSource,
];
