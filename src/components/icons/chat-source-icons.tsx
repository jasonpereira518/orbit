import type { ComponentType } from "react";

type IconProps = { className?: string };

/** A round speech bubble with a handset: reads as WhatsApp at 16px. */
export function WhatsAppIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.5-4.3A8.5 8.5 0 1 1 20.5 11.6Z" />
      <path d="M9 8.6c.2-.4.6-.5.9-.4l.8.2.6 1.6-.7.8a5.7 5.7 0 0 0 2.7 2.7l.8-.7 1.6.6.2.8c.1.3 0 .7-.4.9-.8.4-2.5.3-4.3-1.3S8.6 9.4 9 8.6Z" />
    </svg>
  );
}

/** A rounded bubble with a tail: the iMessage shape, single color. */
export function IMessageIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4c4.7 0 8.5 3 8.5 6.8s-3.8 6.8-8.5 6.8c-.9 0-1.8-.1-2.6-.3L5 19.5l1-3.4C4.4 14.9 3.5 13 3.5 10.8 3.5 7 7.3 4 12 4Z" />
    </svg>
  );
}

const ICONS: Record<string, ComponentType<IconProps>> = { whatsapp: WhatsAppIcon, imessage: IMessageIcon };
const LABELS: Record<string, "WhatsApp" | "iMessage"> = { whatsapp: "WhatsApp", imessage: "iMessage" };

export function chatSourceIcon(source: string | null | undefined): ComponentType<IconProps> | null {
  return (source && ICONS[source]) || null;
}

export function chatSourceLabel(source: string | null | undefined): "WhatsApp" | "iMessage" | null {
  return (source && LABELS[source]) || null;
}
