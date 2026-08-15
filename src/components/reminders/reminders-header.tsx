/**
 * Static reminders header, rendered by BOTH page.tsx and loading.tsx so
 * client navigation shows identical pixels before and after data arrives.
 */
export function RemindersHeader() {
  return (
    <div className="reveal-mount">
      <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
        Reminders
      </h1>
      <p className="mt-1 text-muted-foreground">
        Create, organize into lists, and take quick actions based on what each
        reminder means.
      </p>
    </div>
  );
}
