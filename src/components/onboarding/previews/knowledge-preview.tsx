"use client";

import { motion } from "motion/react";
import { MessageSquare, NotebookPen, Sparkles, Users } from "lucide-react";
import type { PreviewProps } from "@/components/onboarding/tour-config";

const stats = [
  { icon: Users, label: "People", value: "42" },
  { icon: MessageSquare, label: "Messages", value: "310" },
  { icon: NotebookPen, label: "Notes", value: "18" },
];

const entries = [
  {
    icon: Sparkles,
    kind: "AI summary",
    text: "Sarah Chen leads partnerships at OpenAI, focused on developer platforms.",
  },
  {
    icon: MessageSquare,
    kind: "LinkedIn message",
    text: "“Let's grab coffee next time you're in SF” — Marcus Lee",
  },
];

export function KnowledgePreview({ reducedMotion }: PreviewProps) {
  return (
    <div className="space-y-1.5 p-1">
      <p className="font-[family-name:var(--font-display)] text-lg text-primary">
        Knowledge
      </p>
      <div data-tour-hotspot="stats" className="grid grid-cols-3 gap-1.5">
        {stats.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.div
              key={s.label}
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reducedMotion ? 0 : 0.08 * i }}
              className="rounded-xl border border-border/60 bg-background/60 p-1.5"
            >
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="font-[family-name:var(--font-display)] text-base text-primary">
                {s.value}
              </p>
              <p className="text-[10px] text-muted-foreground">{s.label}</p>
            </motion.div>
          );
        })}
      </div>

      <ul className="space-y-1">
        {entries.map((e, i) => {
          const Icon = e.icon;
          return (
            <motion.li
              key={e.kind + i}
              data-tour-hotspot={i === 0 ? "entry" : undefined}
              initial={reducedMotion ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: reducedMotion ? 0 : 0.3 + 0.1 * i }}
              className="flex items-start gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-1.5"
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {e.kind}
                </p>
                <p className="text-xs text-foreground">{e.text}</p>
              </div>
            </motion.li>
          );
        })}
      </ul>

      <motion.p
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reducedMotion ? 0 : 0.5 }}
        className="px-1 text-[11px] text-muted-foreground"
      >
        Ask about any of this in{" "}
        <span className="font-medium text-primary">Chat</span> or ⌘K.
      </motion.p>
    </div>
  );
}
