/** One-tap reasons for a follow-up. The instruction lands in the editable intent field. */
export const FOLLOW_UP_INTENTS = [
  { id: "thanks", label: "Thank you", instruction: "Thank them for their time and mention one specific thing from our conversation" },
  { id: "referral", label: "Referral ask", instruction: "Ask if they’d be open to referring me for a role on their team, and offer to send my resume" },
  { id: "informational", label: "Informational chat", instruction: "Ask for 20 minutes to hear about their path and their team" },
  { id: "keep-in-mind", label: "Keep me in mind", instruction: "A short, warm note to stay in touch and ask them to keep me in mind for future roles" },
] as const;
