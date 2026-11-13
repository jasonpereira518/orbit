import type { VoiceProvider } from "./config";
/** Minimal public wire contract; core voice code does not depend on either SDK's types. */
export type DeepgramVoiceAgentSettings = {
  listen: { provider: { type: "deepgram"; version: "v1"; model: string } };
  think: {
    provider: { type: "open_ai"; model: string };
    prompt: string;
    functions: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      defer_until_eot?: boolean;
    }>;
  };
  speak: { provider: { type: "deepgram"; model: string } };
  greeting: string;
};
export type VoiceCredentials =
  | {
      provider: "deepgram";
      accessToken: string;
      agent: DeepgramVoiceAgentSettings;
    }
  | {
      provider: "elevenlabs";
      signedUrl: string;
      instructions: string;
      tts: { modelId?: string; voiceId?: string };
    };
export type VoiceSessionStart = {
  sessionId: string;
  threadId: string;
  expiresAt: string;
  credentials: VoiceCredentials;
};
export type VoicePublicState = {
  enabled: boolean;
  provider: VoiceProvider;
  fallbackProvider: VoiceProvider | null;
  revision: string | null;
};
export type VoiceMode =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "disconnected";
export type VoiceAgentControls = {
  getLevels(): { input: number; output: number };
  disconnect(): void;
  setMuted(value: boolean): void;
  /**
   * Tell the agent something WITHOUT it being spoken. Only providers with a silent channel
   * implement it; otherwise the engine queues the note onto the next tool result (app_events).
   */
  sendContext?(text: string): void;
  /** Speak this exact line now. Deepgram only; ElevenLabs cannot speak a fixed line. */
  say?(text: string): void;
  /**
   * How much of the agent's current line has played, in seconds, for paced captions. Only
   * providers that hand Orbit the audio can say; without it captions estimate from speech rate.
   */
  getPlayback?(): { text: string | null; played: number; queued: number; complete: boolean } | null;
};
export type VoiceAgentEvents = {
  onReady(controls: VoiceAgentControls | null): void;
  onConnected(): void;
  onMode(mode: VoiceMode): void;
  onInterrupted(): void;
  onMessage(source: "user" | "ai", text: string): void;
  onCorrection(original: string, corrected: string): void;
  onError(): void;
  onDisconnected(): void;
  onTool(tool: string, input: string): Promise<string>;
  /** The person started talking (Deepgram): when a spoken confirmation's utterance began. */
  onUserStarted?(): void;
};
