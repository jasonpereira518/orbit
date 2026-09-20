import { aiOperationLabel } from "@/lib/ai-operations";

/** DB-free: the AI usage card imports these. */
export type UsageSummaryRow = {
  operation: string;
  label: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the per-call estimates recorded at write time. */
  costMicros: number;
  /** Successful calls with no estimate (unpriced model, or no token counts reported). */
  unpricedCalls: number;
};

export type UsageSummary = {
  since: string;
  days: number;
  rows: UsageSummaryRow[];
  totalCalls: number;
  totalCostMicros: number;
  unpricedCalls: number;
};

/** The `operation` ids AI call sites record, in words a person would use. */
export function usageOperationLabel(operation: string): string {
  return aiOperationLabel(operation);
}
