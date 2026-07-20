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

const CONNECTIONS_STEPS: GuideStep[] = [
  {
    title: "Open LinkedIn settings",
    body: "Click Me → Settings & Privacy on LinkedIn.",
    imageSrc: "/guides/linkedin/connections-1.png",
  },
  {
    title: "Request a copy of your data",
    body: "Go to Data privacy → Get a copy of your data.",
    imageSrc: "/guides/linkedin/connections-2.png",
  },
  {
    title: "Select Connections only",
    body: "Choose Connections (you can leave other options unchecked) → Request archive.",
    imageSrc: "/guides/linkedin/connections-3.png",
  },
  {
    title: "Download and upload here",
    body: "When LinkedIn emails you, download the archive and upload the Connections CSV on this page.",
    imageSrc: "/guides/linkedin/connections-4.png",
  },
];

const MESSAGES_STEPS: GuideStep[] = [
  {
    title: "Open data download",
    body: "LinkedIn → Me → Settings & Privacy → Data privacy → Get a copy of your data.",
    imageSrc: "/guides/linkedin/messages-1.png",
  },
  {
    title: "Select Messages",
    body: "Choose Messages → Request archive. LinkedIn may take a while to prepare the file.",
    imageSrc: "/guides/linkedin/messages-2.png",
  },
  {
    title: "Upload ZIP or CSV",
    body: "Download the archive when ready. Upload the ZIP here (Orbit finds messages.csv), or extract and upload messages.csv yourself.",
    imageSrc: "/guides/linkedin/messages-3.png",
  },
];

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
      className="mt-2 w-full rounded-lg border border-border/60 bg-muted/30 object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export function LinkedInExportGuide({ variant }: { variant: GuideVariant }) {
  const [open, setOpen] = useState(false);
  const steps = variant === "connections" ? CONNECTIONS_STEPS : MESSAGES_STEPS;
  const title =
    variant === "connections"
      ? "Export LinkedIn connections"
      : "Export LinkedIn messages";
  const description =
    variant === "connections"
      ? "Follow these steps to download your Connections CSV from LinkedIn."
      : "Follow these steps to download your Messages archive from LinkedIn.";

  return (
    <>
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
    </>
  );
}
