"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const LINKEDIN_DATA_URL =
  "https://www.linkedin.com/mypreferences/d/download-my-data";

type GuideVariant = "connections" | "messages";

type GuideStep = {
  title: string;
  body: string;
  imageSrc?: string;
};

const SHARED_EXPORT_STEPS: GuideStep[] = [
  {
    title: "Open Settings & Privacy",
    body: "On LinkedIn, click Me in the top nav, then Settings & Privacy.",
    imageSrc: "/guides/linkedin/export-1.png",
  },
  {
    title: "Open Download your data",
    body: "In the sidebar choose Data privacy, then click Download your data.",
    imageSrc: "/guides/linkedin/export-2.png",
  },
  {
    title: "Request your archive",
    body: "Select Download larger data archive (includes connections and more), then click Request archive. LinkedIn usually emails you within about 24 hours.",
    imageSrc: "/guides/linkedin/export-3.png",
  },
  {
    title: "Download from email",
    body: "When LinkedIn emails “Your full LinkedIn data archive is ready,” use the download link. Archives can arrive in multiple parts and expire after 72 hours.",
    imageSrc: "/guides/linkedin/export-4.png",
  },
];

const MESSAGES_FINAL: GuideStep = {
  title: "Upload Messages here",
  body: "Unzip the archive and upload messages.csv — or the whole ZIP — on this page. Orbit will find messages.csv inside the ZIP if needed.",
};

function GuideImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="mt-2 flex h-28 w-full items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/30 text-xs text-muted-foreground">
        Screenshot coming soon
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- static guide screenshots in public/
    <img
      src={src}
      alt={alt}
      className="mt-2 w-full rounded-lg border border-border/60 bg-muted/30 object-cover object-top"
      onError={() => setFailed(true)}
    />
  );
}

export function LinkedInExportGuide({ variant }: { variant: GuideVariant }) {
  const [open, setOpen] = useState(false);
  const steps =
    variant === "connections"
      ? SHARED_EXPORT_STEPS
      : [...SHARED_EXPORT_STEPS, MESSAGES_FINAL];
  const title =
    variant === "connections"
      ? "Export LinkedIn connections"
      : "Export LinkedIn messages";
  const description =
    variant === "connections"
      ? "Follow these steps to download your Connections CSV from LinkedIn."
      : "Follow these steps to download your Messages archive from LinkedIn.";

  return (
    <div className="shrink-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        How to export
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(90vh,40rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <ol className="space-y-5">
            {steps.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-primary">{step.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {step.body}
                  </p>
                  <GuideImage
                    src={step.imageSrc}
                    alt={`Step ${index + 1}: ${step.title}`}
                  />
                </div>
              </li>
            ))}
          </ol>

          <DialogFooter className="sm:justify-between">
            <a
              href={LINKEDIN_DATA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Open LinkedIn data download
              <ExternalLink className="size-3.5" />
            </a>
            <DialogClose render={<Button variant="outline" size="sm" />}>
              Got it
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
