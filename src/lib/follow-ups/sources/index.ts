import type { SignalSource } from "../types";
import { commitmentDueSource } from "./commitment-due";
import { dormantSource } from "./dormant";
import { metAnniversarySource } from "./met-anniversary";
import { neverContactedSource } from "./never-contacted";
import { openLoopSource } from "./open-loop";
import { postEventSource } from "./post-event";
import { scheduledFollowUpSource } from "./scheduled-follow-up";
import { threadQuietSource } from "./thread-quiet";
import { workAnniversarySource } from "./work-anniversary";

export const DAILY_SOURCES: SignalSource[] = [
  commitmentDueSource,
  scheduledFollowUpSource,
  openLoopSource,
  postEventSource,
  workAnniversarySource,
  metAnniversarySource,
  dormantSource,
  threadQuietSource,
  neverContactedSource,
];
