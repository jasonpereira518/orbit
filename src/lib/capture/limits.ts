/**
 * The most text capture keeps from one input. Import-free so the Drive client can share it:
 * a Drive doc is read through capture's own parse, so it gets capture's own ceiling.
 */
export const CAPTURE_INPUT_MAX_CHARS = 100_000;
