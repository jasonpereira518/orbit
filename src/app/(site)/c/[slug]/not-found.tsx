/** One calm message for every refusal: unknown, reset, paused or unreleased look the same. */
export default function CardNotFound() {
  return (
    <main
      id="main-content"
      className="landing-root flex min-h-dvh items-center justify-center oc-dust px-5 text-center text-[#e8f3f1]"
    >
      <div className="max-w-sm space-y-2">
        <h1 className="font-[family-name:var(--font-display)] text-2xl tracking-tight">This card isn&apos;t available</h1>
        <p className="text-sm text-[#9aada8]">
          The link may have changed or been turned off. Ask the person who shared it for a fresh one.
        </p>
      </div>
    </main>
  );
}
