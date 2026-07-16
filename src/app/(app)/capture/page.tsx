import { CaptureForm } from "@/components/capture/capture-form";

export default function CapturePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Capture
        </h1>
        <p className="mt-1 text-muted-foreground">
          Paste messy notes. Orbit extracts people, topics, and follow-ups — you approve before saving.
        </p>
      </div>
      <CaptureForm />
    </div>
  );
}
