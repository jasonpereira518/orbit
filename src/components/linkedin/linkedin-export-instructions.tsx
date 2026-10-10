import { Stagger, StaggerItem } from "@/components/onboarding/onboarding-ui";
import { LINKEDIN_ARCHIVE_EMAIL_SUBJECT, LINKEDIN_ARCHIVE_LINK_HOURS } from "@/lib/linkedin-export";

/** The two steps of asking LinkedIn for an archive. */
export function LinkedInExportInstructions() {
  return (
    <Stagger as="ol" className="space-y-4">
      <StaggerItem as="li" className="flex gap-3">
        <NumberChip n={1} />
        <p className="pt-0.5 text-sm text-foreground">
          On LinkedIn&apos;s page, choose{" "}
          <span className="font-medium text-ink">Download larger data archive</span>, then{" "}
          <span className="font-medium text-ink">Request archive</span>.
        </p>
      </StaggerItem>
      <StaggerItem as="li" className="flex gap-3">
        <NumberChip n={2} />
        <p className="pt-0.5 text-sm text-foreground">
          Within a day LinkedIn emails you{" "}
          <span className="font-medium text-ink">“{LINKEDIN_ARCHIVE_EMAIL_SUBJECT}”</span>{" "}
          {`The link lasts ${LINKEDIN_ARCHIVE_LINK_HOURS} hours, so we’ll remind you to look for it.`}
        </p>
      </StaggerItem>
    </Stagger>
  );
}

function NumberChip({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {n}
    </span>
  );
}
