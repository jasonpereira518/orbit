"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const SEARCH_DEBOUNCE_MS = 250;

export function ContactsFilters({
  initialQ,
  initialCompany,
  initialMinScore,
  initialFollowUp,
}: {
  initialQ: string;
  initialCompany: string;
  initialMinScore: string;
  initialFollowUp?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [company, setCompany] = useState(initialCompany);
  const [minScore, setMinScore] = useState(initialMinScore || "any");
  const [followUp, setFollowUp] = useState(initialFollowUp || "");
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    setQ(initialQ);
    setCompany(initialCompany);
    setMinScore(initialMinScore || "any");
    setFollowUp(initialFollowUp || "");
  }, [initialQ, initialCompany, initialMinScore, initialFollowUp]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  function apply(next?: {
    q?: string;
    company?: string;
    minScore?: string;
    followUp?: string;
  }) {
    const params = new URLSearchParams();
    const qq = (next?.q ?? q).trim();
    const cc = (next?.company ?? company).trim();
    const ms = next?.minScore ?? minScore;
    const fu = next?.followUp ?? followUp;
    if (qq) params.set("q", qq);
    if (cc) params.set("company", cc);
    if (ms && ms !== "any") params.set("minScore", ms);
    if (fu === "due") params.set("followUp", "due");
    const qs = params.toString();
    const href = qs ? `/contacts?${qs}` : "/contacts";
    router.replace(href);
    // Clearing search (or any filter nav) should always refetch the list.
    router.refresh();
  }

  function scheduleApply(next: { q?: string; company?: string }) {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);

    const nextQ = next.q !== undefined ? next.q.trim() : undefined;
    const nextCompany =
      next.company !== undefined ? next.company.trim() : undefined;
    // Empty search/company should immediately restore the full list.
    const clearing =
      (next.q !== undefined && nextQ === "") ||
      (next.company !== undefined && nextCompany === "");

    if (clearing) {
      apply({
        ...(next.q !== undefined ? { q: "" } : {}),
        ...(next.company !== undefined ? { company: "" } : {}),
      });
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      apply(next);
    }, SEARCH_DEBOUNCE_MS);
  }

  return (
    <div className="space-y-3">
      {followUp === "due" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            Showing contacts with due follow-ups
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setFollowUp("");
              apply({ followUp: "" });
            }}
          >
            Clear filter
          </Button>
        </div>
      )}
      <div className="grid gap-3 rounded-2xl border border-border/70 bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            placeholder="Name, company, notes…"
            value={q}
            onChange={(e) => {
              const value = e.target.value;
              setQ(value);
              scheduleApply({ q: value });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company">Company</Label>
          <Input
            id="company"
            placeholder="Exact company"
            value={company}
            onChange={(e) => {
              const value = e.target.value;
              setCompany(value);
              scheduleApply({ company: value });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Min closeness</Label>
          <Select
            value={minScore}
            onValueChange={(v) => {
              const val = v || "any";
              setMinScore(val);
              apply({ minScore: val });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="2">2+</SelectItem>
              <SelectItem value="3">3+</SelectItem>
              <SelectItem value="4">4+</SelectItem>
              <SelectItem value="5">5</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
