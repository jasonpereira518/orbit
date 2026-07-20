/** Canonical pgvector dimension (OpenAI text-embedding-3-small). Shorter vectors are zero-padded. */
export const PGVECTOR_DIM = 1536;

export function padEmbedding(values: number[]): number[] {
  if (values.length === PGVECTOR_DIM) return values;
  if (values.length > PGVECTOR_DIM) return values.slice(0, PGVECTOR_DIM);
  return [...values, ...Array(PGVECTOR_DIM - values.length).fill(0)];
}

/** Postgres vector literal, e.g. `[0.1,0.2,...]`. */
export function formatVectorLiteral(values: number[]): string {
  return `[${padEmbedding(values).join(",")}]`;
}
