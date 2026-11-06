/**
 * The deep-space panel the dashboard's two foot cards share: /pricing's own sky gradient
 * with a few fixed stars on it. Static gradients rather than a canvas — this is decoration on
 * a dashboard, not a set piece worth an rAF loop.
 *
 * Painted in fixed colours, not theme tokens, on purpose: it is a window onto the same night
 * sky in light and dark mode, and the text laid over it is chosen to match.
 */
export function DeepSpace({ accent = "242,193,78" }: { accent?: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 140% at 50% 20%, #0f1630 0%, #0a1024 42%, #060915 72%, #03050c 100%)",
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: [
            "radial-gradient(1.4px 1.4px at 12% 24%, rgba(232,243,241,0.9), transparent)",
            "radial-gradient(1px 1px at 27% 68%, rgba(232,243,241,0.55), transparent)",
            `radial-gradient(1.6px 1.6px at 44% 18%, rgba(${accent},0.85), transparent)`,
            "radial-gradient(1px 1px at 61% 52%, rgba(232,243,241,0.5), transparent)",
            "radial-gradient(1.2px 1.2px at 74% 28%, rgba(232,243,241,0.75), transparent)",
            "radial-gradient(1px 1px at 88% 62%, rgba(232,243,241,0.45), transparent)",
            "radial-gradient(1.3px 1.3px at 36% 84%, rgba(232,243,241,0.6), transparent)",
            `radial-gradient(1px 1px at 92% 16%, rgba(${accent},0.6), transparent)`,
            "radial-gradient(1px 1px at 5% 78%, rgba(232,243,241,0.5), transparent)",
            "radial-gradient(1.2px 1.2px at 52% 90%, rgba(232,243,241,0.6), transparent)",
            "radial-gradient(1px 1px at 82% 88%, rgba(232,243,241,0.4), transparent)",
          ].join(","),
        }}
      />
    </>
  );
}
