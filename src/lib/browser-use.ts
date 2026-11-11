/**
 * OpenAI Browser Use Integration for LinkedIn Outreach
 *
 * Generates prefilled prompts, structured execution tasks, and safety constraints
 * for OpenAI Browser Use / Operator agents to automate sending LinkedIn connection
 * requests with personalized notes at scale.
 */

export type LinkedInBrowserTarget = {
  prospectId: string;
  fullName: string;
  title: string | null;
  company: string | null;
  linkedinUrl: string;
  personalizedNote: string;
};

export type BrowserUseTaskConfig = {
  taskName: string;
  version: string;
  createdAt: string;
  targetsCount: number;
  targets: LinkedInBrowserTarget[];
  safetyRules: {
    maxConnectionsPerRun: number;
    delayBetweenActionsSec: [number, number];
    enforceMaxCharLimit: number;
    stopOnCaptcha: boolean;
    skipIfAlreadyConnected: boolean;
  };
  promptMarkdown: string;
  agentSystemPrompt: string;
};

/**
 * Trims note to LinkedIn's strict 300 character limit for connection requests
 */
export function sanitizeLinkedInNote(note: string): string {
  const cleaned = note.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 300) return cleaned;
  return cleaned.slice(0, 297) + "...";
}

/**
 * Generates the prefilled OpenAI Browser Use prompt and configuration
 */
export function generateLinkedInBrowserUsePrompt(
  targets: LinkedInBrowserTarget[],
  options?: {
    campaignName?: string;
    senderName?: string;
  }
): BrowserUseTaskConfig {
  const cleanTargets = targets
    .filter((t) => Boolean(t.linkedinUrl))
    .map((t) => ({
      ...t,
      personalizedNote: sanitizeLinkedInNote(t.personalizedNote),
    }));

  const targetsListFormatted = cleanTargets
    .map(
      (t, idx) => `[Target #${idx + 1}]
Name: ${t.fullName}
Role: ${t.title || "Professional"} at ${t.company || "Company"}
LinkedIn Profile: ${t.linkedinUrl}
Personalized Connection Note (${t.personalizedNote.length}/300 chars):
"${t.personalizedNote}"`
    )
    .join("\n\n");

  const promptMarkdown = `
# OpenAI Browser Use: LinkedIn Connection Task

## Objective
Log in to LinkedIn (if not already logged in) and connect with the following ${cleanTargets.length} people using their specific personalized connection notes.

---

## Safety & Rate Limiting Rules (MANDATORY)
1. **Pacing**: Wait between 6 to 12 seconds between visiting consecutive profiles. Never perform rapid clicks.
2. **Note Length**: Verify that the connection note does not exceed 300 characters before submitting.
3. **Existing Connections**: If the person is already a 1st-degree connection, or if the button says "Pending", DO NOT click anything. Log status as "ALREADY_CONNECTED" or "PENDING" and proceed to the next target.
4. **Rate Limit / Warning Modal**: If LinkedIn displays "You've reached the weekly invitation limit" or a CAPTCHA, STOP IMMEDIATELY and report the event.

---

## Step-by-Step Procedure for Each Person:
1. Navigate directly to the target's **LinkedIn Profile URL**.
2. Locate the primary action button:
   - If the button says **"Connect"**, click it.
   - If the button says **"Follow"** or **"Message"**, click the **"More"** button (or "..." menu next to Message) and look for **"Connect"**.
3. In the "You can add a note to personalize your invitation" modal, click **"Add a note"**.
4. In the text area, type the provided **Personalized Connection Note** exactly.
5. Click **"Send"**.
6. Confirm the button changes to "Pending".
7. Wait 7 seconds before proceeding to the next target URL.

---

## Target Prospect Queue (${cleanTargets.length} people):

${targetsListFormatted}

---

## Completion Report
When all targets have been processed, output a structured table of:
- Target Name
- Result: [SENT | ALREADY_CONNECTED | PENDING_ALREADY | FAILED]
- Notes / Error Details
`.trim();

  const agentSystemPrompt = `You are an automated web assistant using browser-use to send personalized connection requests on LinkedIn. Follow user safety constraints, human-like typing speeds, and stop immediately if you encounter a CAPTCHA or invitation cap.`;

  return {
    taskName: `LinkedIn Outreach - ${options?.campaignName || "Campaign"}`,
    version: "1.0",
    createdAt: new Date().toISOString(),
    targetsCount: cleanTargets.length,
    targets: cleanTargets,
    safetyRules: {
      maxConnectionsPerRun: 25,
      delayBetweenActionsSec: [6, 12],
      enforceMaxCharLimit: 300,
      stopOnCaptcha: true,
      skipIfAlreadyConnected: true,
    },
    promptMarkdown,
    agentSystemPrompt,
  };
}
