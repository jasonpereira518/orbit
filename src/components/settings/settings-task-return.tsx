"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Accept only same-origin app paths, including when a link was edited by hand. */
export function SettingsTaskReturn() {
  const raw = useSearchParams().get("returnTo");
  if (!raw?.startsWith("/") || raw.startsWith("//")) return null;
  let href: string;
  try {
    const target = new URL(raw, "https://orbit.invalid");
    if (target.origin !== "https://orbit.invalid" || target.pathname.startsWith("/settings")) return null;
    href = target.pathname + target.search + target.hash;
  } catch { return null; }
  return <Link href={href} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}><ArrowLeft aria-hidden className="size-4" />Back to your task</Link>;
}
