// The benchmark routes sit outside every route group, so they bring the full sheet themselves
// (the root layout loads none; see src/app/site.css). Exists only in ORBIT_BENCH=1 builds.
import "../globals.css";

export default function BenchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
