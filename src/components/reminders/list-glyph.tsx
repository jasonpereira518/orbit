import { createElement } from "react";
import { listColorClass, listIcon } from "@/lib/reminder-list-style";
import { cn } from "@/lib/utils";

/**
 * A reminder list's icon in its colour. `createElement` rather than a local `<Icon />`
 * binding: the icon is chosen per list at render time, and a component bound during render
 * is what React's static-components rule (rightly) refuses.
 */
export function ListGlyph({
  list,
  className,
  tinted = true,
}: {
  list: { icon: string | null; color: string | null; isInbox: boolean };
  className?: string;
  /** False to draw it untinted (e.g. a preview that tints its own container). */
  tinted?: boolean;
}) {
  return createElement(listIcon(list), {
    className: cn("size-4", tinted && listColorClass(list.color), className),
    "aria-hidden": true,
  });
}
