import { listImports } from "@/actions/imports";
import { ImportForm } from "@/components/imports/import-form";

export default async function ImportsPage() {
  const history = await listImports();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Imports
        </h1>
        <p className="mt-1 text-muted-foreground">
          Bring in LinkedIn connections. Duplicates are detected before and during import.
        </p>
      </div>
      <ImportForm history={history} />
    </div>
  );
}
