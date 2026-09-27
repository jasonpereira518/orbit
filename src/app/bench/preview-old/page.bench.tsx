import { OldPreviewBench } from "./old-preview-bench";

/**
 * The dashboard preview as it was — the full NetworkGraph in compact mode — on the same synthetic
 * 150-contact network, so `/bench/preview` has a baseline. Bench-only.
 */
export default function OldPreviewBenchPage() {
  return <OldPreviewBench />;
}
