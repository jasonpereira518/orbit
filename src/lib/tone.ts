/**
 * Status tones for chips, callouts, dots and inline notes.
 *
 * One map on top of the semantic colour tokens (`--success`, `--warning`, `--info`,
 * `--destructive`, `--primary`), so a "warning" chip looks the same on every page and
 * follows the theme. Before this the app reached for `amber-*` / `emerald-*` / `sky-*`
 * palette classes directly (~240 call sites, plus `dark:` overrides) and no two chips
 * agreed on an alpha.
 *
 * Every text colour here is the token itself, which `globals.css` keeps at >= 4.5:1
 * on `--card` / `--popover` in both themes; the fills are the same hue at a wash.
 */
export type Tone = "neutral" | "success" | "warning" | "info" | "destructive" | "accent";

export type ToneClasses = {
  /** Solid-ish chip: wash fill + token text. */
  chip: string;
  /** Callout box: wash fill + tinted hairline. */
  box: string;
  /** Just the text colour (icons, inline notes). */
  text: string;
  /** Status dot. */
  dot: string;
  /** Tinted hairline on its own. */
  border: string;
};

export const TONE: Record<Tone, ToneClasses> = {
  neutral: {
    chip: "bg-muted text-muted-foreground",
    box: "border-border-subtle bg-surface-inset",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
    border: "border-border-subtle",
  },
  success: {
    chip: "bg-success/10 text-success",
    box: "border-success/30 bg-success/8",
    text: "text-success",
    dot: "bg-success",
    border: "border-success/30",
  },
  warning: {
    chip: "bg-warning/12 text-warning",
    box: "border-warning-border bg-warning-surface",
    text: "text-warning",
    dot: "bg-warning",
    border: "border-warning-border",
  },
  info: {
    chip: "bg-info/10 text-info",
    box: "border-info/30 bg-info/8",
    text: "text-info",
    dot: "bg-info",
    border: "border-info/30",
  },
  destructive: {
    chip: "bg-destructive/10 text-destructive",
    box: "border-destructive/30 bg-destructive/8",
    text: "text-destructive",
    dot: "bg-destructive",
    border: "border-destructive/30",
  },
  accent: {
    chip: "bg-accent text-accent-foreground",
    box: "border-primary/25 bg-primary/6",
    text: "text-primary",
    dot: "bg-primary",
    border: "border-primary/25",
  },
};
