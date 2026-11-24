"use client";

import { useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { useMoveCompany } from "@/components/recruiters/company-actions";
import { columnFor, dropStageFor, type BoardColumnId } from "@/lib/recruiting-board";
import { isRecruiterStage, type RecruiterStage } from "@/lib/recruiter-stages";
import { cn } from "@/lib/utils";

/**
 * Drag a company card to another column to move it. Native HTML drag and drop, so there is no
 * library; it needs a mouse or a pen. The stage select on every card stays as the way to do it
 * from a keyboard or a phone, and a drop shows the same toast with Undo.
 */
const MIME = "application/x-orbit-company";

type Dragged = { key: string; name: string; stage: RecruiterStage };

function readDragged(e: DragEvent): Dragged | null {
  try {
    const raw = JSON.parse(e.dataTransfer.getData(MIME)) as Partial<Dragged>;
    if (typeof raw.key === "string" && typeof raw.name === "string" && typeof raw.stage === "string" && isRecruiterStage(raw.stage)) {
      return { key: raw.key, name: raw.name, stage: raw.stage };
    }
  } catch {
    // not one of ours
  }
  return null;
}

export function DraggableCard({
  companyKey,
  name,
  stage,
  className,
  style,
  children,
}: {
  companyKey: string;
  name: string;
  stage: RecruiterStage;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, JSON.stringify({ key: companyKey, name, stage } satisfies Dragged));
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn("cursor-grab active:cursor-grabbing", dragging && "opacity-50", className)}
      style={style}
    >
      {children}
    </li>
  );
}

export function DropColumn({ column, className, children }: { column: BoardColumnId; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const { move } = useMoveCompany();
  const target = dropStageFor(column);
  if (!target) return <div className={className}>{children}</div>;
  return (
    <div
      className={cn("rounded-xl transition-colors", over && "bg-primary/5 ring-2 ring-primary/30", className)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const card = readDragged(e);
        // Dropped back on its own column: nothing to say.
        if (!card || columnFor(card.stage) === column) return;
        move(card.key, card.name, card.stage, target);
      }}
    >
      {children}
    </div>
  );
}
