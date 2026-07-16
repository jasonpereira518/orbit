"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getGraphData } from "@/actions/graph";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;

function ContactNode({ data }: { data: { label: string; company?: string | null; score?: number; dormant?: boolean; kind: string } }) {
  if (data.kind === "user") {
    return (
      <div className="rounded-full bg-[#0f3d3e] px-4 py-3 text-center text-sm font-semibold text-white shadow-lg">
        {data.label}
      </div>
    );
  }

  return (
    <div
      className="min-w-[120px] rounded-xl border bg-white px-3 py-2 text-center shadow-sm"
      style={{
        borderColor: data.dormant ? "#d4d4d4" : "#0f3d3e",
        opacity: data.dormant ? 0.45 : 1,
      }}
    >
      <p className="text-sm font-medium text-[#0f3d3e]">{data.label}</p>
      {data.company && (
        <p className="text-[10px] text-muted-foreground">{data.company}</p>
      )}
      <p className="mt-1 text-[10px] text-[#3d7a6c]">● {data.score}/5</p>
    </div>
  );
}

const nodeTypes = { contact: ContactNode, user: ContactNode };

export function NetworkGraph() {
  const router = useRouter();
  const [data, setData] = useState<GraphPayload | null>(null);
  const [company, setCompany] = useState("all");
  const [tag, setTag] = useState("all");
  const [minScore, setMinScore] = useState("1");

  useEffect(() => {
    getGraphData().then(setData).catch(console.error);
  }, []);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };

    const filtered = data.nodes.filter((n) => {
      if (n.id === "me") return true;
      const d = n.data as {
        company?: string | null;
        score?: number;
        tags?: string[];
      };
      if (company !== "all" && d.company !== company) return false;
      if (tag !== "all" && !(d.tags || []).includes(tag)) return false;
      if ((d.score || 0) < Number(minScore)) return false;
      return true;
    });

    const ids = new Set(filtered.map((n) => n.id));
    return {
      nodes: filtered as Node[],
      edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) as Edge[],
    };
  }, [data, company, tag, minScore]);

  if (!data) {
    return (
      <div className="flex h-[560px] items-center justify-center rounded-2xl border border-border/70 bg-white text-muted-foreground">
        Loading graph…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-2xl border border-border/70 bg-white p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>Company</Label>
          <Select value={company} onValueChange={(v) => setCompany(v || "all")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All companies</SelectItem>
              {data.companies.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Tag</Label>
          <Select value={tag} onValueChange={(v) => setTag(v || "all")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {data.tags.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Min closeness</Label>
          <Select value={minScore} onValueChange={(v) => setMinScore(v || "1")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1+</SelectItem>
              <SelectItem value="2">2+</SelectItem>
              <SelectItem value="3">3+</SelectItem>
              <SelectItem value="4">4+</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="h-[560px] overflow-hidden rounded-2xl border border-border/70 bg-[#f7f8f6]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          onNodeClick={(_, node) => {
            if (node.id !== "me") router.push(`/contacts/${node.id}`);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} color="#e4e7e1" />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
