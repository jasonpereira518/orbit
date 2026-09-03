import { PGlite } from "@electric-sql/pglite";
import path from "node:path";

async function main() {
  const dataDir = path.join(process.cwd(), ".data", "pglite");
  const client = await PGlite.create({ dataDir });
  await client.waitReady;

  async function columnExists(table: string, column: string) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2
       ) AS exists`,
      [table, column]
    );
    return Boolean(result.rows[0]?.exists);
  }

  for (const col of ["preferred_name", "website"] as const) {
    if (!(await columnExists("contacts", col))) {
      await client.exec(`ALTER TABLE contacts ADD COLUMN ${col} text`);
      console.log("added", col);
    } else {
      console.log("exists", col);
    }
  }

  const cols = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'contacts'
     ORDER BY ordinal_position`
  );
  console.log(cols.rows.map((r) => r.column_name).join(", "));
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
