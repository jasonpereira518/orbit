"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ContactsFilters({
  initialQ,
  initialCompany,
  initialMinScore,
}: {
  initialQ: string;
  initialCompany: string;
  initialMinScore: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [company, setCompany] = useState(initialCompany);
  const [minScore, setMinScore] = useState(initialMinScore || "any");

  function apply(next?: { q?: string; company?: string; minScore?: string }) {
    const params = new URLSearchParams();
    const qq = next?.q ?? q;
    const cc = next?.company ?? company;
    const ms = next?.minScore ?? minScore;
    if (qq) params.set("q", qq);
    if (cc) params.set("company", cc);
    if (ms && ms !== "any") params.set("minScore", ms);
    router.push(`/contacts?${params.toString()}`);
  }

  return (
    <div className="grid gap-3 rounded-2xl border border-border/70 bg-card p-4 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor="q">Search</Label>
        <Input
          id="q"
          placeholder="Name, company, notes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="company">Company</Label>
        <Input
          id="company"
          placeholder="Exact company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
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
  );
}
