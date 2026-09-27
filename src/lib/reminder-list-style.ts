/**
 * The icons and colours a reminder list can wear, chosen in its right-click editor and
 * stored as keys (`reminder_lists.icon` / `.color`, schema v67). Keys, not class names or
 * icon names, so a stored value can't inject a class and a renamed icon never orphans rows.
 *
 * Every class below is written out in full: Tailwind compiles only the class strings it
 * finds in source, so a class assembled at runtime from a colour name would never exist.
 */
import {
  BookOpen,
  Briefcase,
  CalendarDays,
  Code,
  Coffee,
  Flag,
  GraduationCap,
  Handshake,
  Heart,
  House,
  Inbox,
  Lightbulb,
  List,
  Plane,
  Rocket,
  Star,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";

export const LIST_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  list: { icon: List, label: "List" },
  inbox: { icon: Inbox, label: "Tray" },
  briefcase: { icon: Briefcase, label: "Work" },
  users: { icon: Users, label: "People" },
  handshake: { icon: Handshake, label: "Intros" },
  rocket: { icon: Rocket, label: "Launch" },
  target: { icon: Target, label: "Goal" },
  star: { icon: Star, label: "Star" },
  heart: { icon: Heart, label: "Personal" },
  coffee: { icon: Coffee, label: "Coffee" },
  graduation: { icon: GraduationCap, label: "School" },
  house: { icon: House, label: "Home" },
  plane: { icon: Plane, label: "Travel" },
  lightbulb: { icon: Lightbulb, label: "Ideas" },
  flag: { icon: Flag, label: "Milestone" },
  calendar: { icon: CalendarDays, label: "Events" },
  book: { icon: BookOpen, label: "Reading" },
  code: { icon: Code, label: "Code" },
};

/** `dot` for swatches; `text` tints the icon (and is readable in both themes). */
export const LIST_COLORS: Record<string, { label: string; dot: string; text: string }> = {
  teal: { label: "Teal", dot: "bg-teal-500", text: "text-teal-700 dark:text-teal-300" },
  sky: { label: "Sky", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-300" },
  indigo: { label: "Indigo", dot: "bg-indigo-500", text: "text-indigo-700 dark:text-indigo-300" },
  violet: { label: "Violet", dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-300" },
  rose: { label: "Rose", dot: "bg-rose-500", text: "text-rose-700 dark:text-rose-300" },
  orange: { label: "Orange", dot: "bg-orange-500", text: "text-orange-700 dark:text-orange-300" },
  amber: { label: "Amber", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
  emerald: { label: "Emerald", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
};

export function isListIcon(v: unknown): v is string {
  return typeof v === "string" && Object.hasOwn(LIST_ICONS, v);
}

export function isListColor(v: unknown): v is string {
  return typeof v === "string" && Object.hasOwn(LIST_COLORS, v);
}

/** The icon to draw: the chosen one, else the Inbox tray or the plain list glyph. */
export function listIcon(list: { icon: string | null; isInbox: boolean }): LucideIcon {
  if (isListIcon(list.icon)) return LIST_ICONS[list.icon].icon;
  return list.isInbox ? Inbox : List;
}

/** The icon's tint class, or null for untinted. */
export function listColorClass(color: string | null): string | null {
  return isListColor(color) ? LIST_COLORS[color].text : null;
}
