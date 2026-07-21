import Image from "next/image";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: 28,
  md: 32,
  lg: 40,
  xl: 64,
  hero: 96,
} as const;

export function OrbitLogo({
  size = "md",
  className,
  priority,
}: {
  size?: keyof typeof SIZES;
  className?: string;
  priority?: boolean;
}) {
  const px = SIZES[size];
  return (
    <Image
      src="/orbit-logo.png"
      alt="Orbit"
      width={px}
      height={px}
      priority={priority}
      className={cn("shrink-0 rounded-full", className)}
    />
  );
}
