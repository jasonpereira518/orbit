"use client";

import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown } from "lucide-react";

export type FaqItem = { q: string; a: ReactNode };

/**
 * FAQ disclosures laid out as two independent stacks rather than a two-column
 * grid.
 *
 * In a grid, both cells of a row share its height, so opening an item on the
 * left shoves the right-hand item down with it. Splitting the list into two
 * self-contained columns keeps each side's growth to itself — opening an item
 * only moves the questions beneath it, in its own column.
 */
export function FaqList({ items }: { items: readonly FaqItem[] }) {
  const baseId = useId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const reduced = useReducedMotion();

  // Split in halves rather than alternating, so each column still reads top to
  // bottom and the single-column layout below lg keeps the authored order.
  const half = Math.ceil(items.length / 2);
  const columns = [items.slice(0, half), items.slice(half)];

  const transition = reduced
    ? { duration: 0 }
    : { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
      {columns.map((column, columnIndex) => (
        <div key={columnIndex} className="grid content-start gap-3">
          {column.map((item, index) => {
            const key = `${baseId}-${columnIndex}-${index}`;
            const isOpen = Boolean(open[key]);
            return (
              <div key={item.q} className="landing-glass rounded-2xl">
                <h3>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`${key}-panel`}
                    id={`${key}-trigger`}
                    onClick={() =>
                      setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
                    }
                    className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left text-[15px] text-[#e8f3f1]"
                  >
                    {item.q}
                    <motion.span
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 text-[#6d807c]"
                      animate={{ rotate: isOpen ? 180 : 0 }}
                      transition={transition}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </motion.span>
                  </button>
                </h3>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="panel"
                      id={`${key}-panel`}
                      role="region"
                      aria-labelledby={`${key}-trigger`}
                      // Height drives the layout, so the questions below this
                      // one travel with it instead of jumping.
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={transition}
                      className="overflow-hidden"
                    >
                      <div className="doc-prose border-t border-[#e8f3f1]/[0.07] px-5 pb-4 pt-3 text-sm">
                        <p>{item.a}</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
