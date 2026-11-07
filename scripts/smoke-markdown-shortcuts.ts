/**
 * The capture notes box's markdown: Cmd+B / Cmd+I wrap and unwrap, Enter continues a list
 * (and an empty item ends it), Tab / Shift+Tab indent list lines, the highlight layer's
 * tokenizer finds the right ranges, and its runs compose with `@mention` marks. Also the
 * capture-history excerpt dropping markers. Pure tier.
 */
import { checker } from "./smoke/check";
import {
  continueList,
  indentList,
  segmentMarks,
  toggleLinePrefix,
  toggleWrap,
  tokenizeMarkdown,
  type TextEdit,
} from "../src/components/composer/markdown-shortcuts";
import { captureExcerpt } from "../src/lib/note-batches";

const t = checker();

function apply(value: string, edit: TextEdit | null) {
  if (!edit) return null;
  const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
  return { next, sel: [edit.selectionStart, edit.selectionEnd] as const };
}
function eq(label: string, got: unknown, want: unknown) {
  t.check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
}

// Wrap / unwrap ------------------------------------------------------------------------
eq("bold wraps the selection", apply("met Sarah today", toggleWrap("met Sarah today", 4, 9, "**")), {
  next: "met **Sarah** today",
  sel: [6, 11],
});
eq("bold unwraps when markers sit outside the selection", apply("met **Sarah** today", toggleWrap("met **Sarah** today", 6, 11, "**")), {
  next: "met Sarah today",
  sel: [4, 9],
});
eq("bold unwraps a selection that includes its markers", apply("met **Sarah** today", toggleWrap("met **Sarah** today", 4, 13, "**")), {
  next: "met Sarah today",
  sel: [4, 9],
});
eq("empty selection drops an empty pair with the caret inside", apply("a ", toggleWrap("a ", 2, 2, "**")), {
  next: "a ****",
  sel: [4, 4],
});
eq("trailing space stays outside the markers", apply("met Sarah today", toggleWrap("met Sarah today", 4, 10, "**"))?.next, "met **Sarah** today");
eq("leading space stays outside too", apply("met Sarah today", toggleWrap("met Sarah today", 3, 9, "_"))?.next, "met _Sarah_ today");
eq("newline-only selection wraps nothing across lines", apply("a\nb", toggleWrap("a\nb", 1, 2, "**"))?.next, "a\n****b");
eq("italic wraps with underscores", apply("so cool", toggleWrap("so cool", 3, 7, "_")), { next: "so _cool_", sel: [4, 8] });
eq("italic unwraps underscores", apply("so _cool_", toggleWrap("so _cool_", 4, 8, "_")), { next: "so cool", sel: [3, 7] });
eq("italic unwraps a single-star italic", apply("so *cool*", toggleWrap("so *cool*", 4, 8, "_")), { next: "so cool", sel: [3, 7] });
eq("italic does not eat one star of a bold", apply("**cool**", toggleWrap("**cool**", 2, 6, "_"))?.next, "**_cool_**");

// List continuation ----------------------------------------------------------------------
eq("bullet continues", apply("- one", continueList("- one", 5)), { next: "- one\n- ", sel: [8, 8] });
eq("star bullet keeps its marker and indent", apply("  * one", continueList("  * one", 7))?.next, "  * one\n  * ");
eq("numbered list increments", apply("1. one", continueList("1. one", 6)), { next: "1. one\n2. ", sel: [10, 10] });
eq("paren numbering keeps its delimiter", apply("9) nine", continueList("9) nine", 7))?.next, "9) nine\n10) ");
eq("empty item exits the list", apply("- one\n- ", continueList("- one\n- ", 8)), { next: "- one\n", sel: [6, 6] });
eq("empty numbered item exits", apply("1. a\n2. ", continueList("1. a\n2. ", 8))?.next, "1. a\n");
eq("Enter mid-item splits it into the next item", apply("- onetwo", continueList("- onetwo", 5))?.next, "- one\n- two");
t.check("plain line is not a list", continueList("hello", 5) === null);
t.check("caret inside the marker is left alone", continueList("- one", 1) === null);

// Indent / outdent -----------------------------------------------------------------------
eq("Tab indents a list line, caret follows", apply("- a", indentList("- a", 3, 3, false)), { next: "  - a", sel: [5, 5] });
eq("Shift+Tab outdents", apply("  - a", indentList("  - a", 5, 5, true)), { next: "- a", sel: [3, 3] });
eq("indent covers every selected list line, skips prose", apply("- a\nprose\n- b", indentList("- a\nprose\n- b", 0, 13, false))?.next, "  - a\nprose\n  - b");
eq("Tab under a numbered item indents 3", apply("1. a\n2. b", indentList("1. a\n2. b", 9, 9, false))?.next, "1. a\n   2. b");
eq("a bullet under a numbered item indents 3", apply("1. a\n- b", indentList("1. a\n- b", 8, 8, false))?.next, "1. a\n   - b");
eq("bullets under bullets keep 2", apply("- a\n- b", indentList("- a\n- b", 7, 7, false))?.next, "- a\n  - b");
eq("Shift+Tab under a numbered item comes back to its parent", apply("1. a\n   2. b", indentList("1. a\n   2. b", 12, 12, true))?.next, "1. a\n2. b");
t.check("Tab on prose is not claimed (focus can leave)", indentList("prose", 2, 2, false) === null);
t.check("outdent at column 0 is a no-op", indentList("- a", 3, 3, true) === null);

// Toolbar line prefixes ----------------------------------------------------------------
eq("bullet toggles on", apply("a\nb", toggleLinePrefix("a\nb", 0, 3, "bullet"))?.next, "- a\n- b");
eq("bullet toggles off", apply("- a\n- b", toggleLinePrefix("- a\n- b", 0, 7, "bullet"))?.next, "a\nb");
eq("numbered replaces bullets and counts", apply("- a\n- b", toggleLinePrefix("- a\n- b", 0, 7, "numbered"))?.next, "1. a\n2. b");
eq("bullets skip blank lines", apply("a\n\nb", toggleLinePrefix("a\n\nb", 0, 4, "bullet"))?.next, "- a\n\n- b");
eq("loose list toggles off", apply("- a\n\n- b", toggleLinePrefix("- a\n\n- b", 0, 8, "bullet"))?.next, "a\n\nb");
eq("numbering skips blank lines", apply("a\n\nb", toggleLinePrefix("a\n\nb", 0, 4, "numbered"))?.next, "1. a\n\n2. b");
eq("bullet on an empty line still inserts", apply("", toggleLinePrefix("", 0, 0, "bullet"))?.next, "- ");
eq("heading on the caret line, caret follows", apply("x\nTitle", toggleLinePrefix("x\nTitle", 4, 4, "heading")), { next: "x\n# Title", sel: [6, 6] });
eq("heading toggles off", apply("# Title", toggleLinePrefix("# Title", 3, 3, "heading")), { next: "Title", sel: [1, 1] });

// Tokenizer ------------------------------------------------------------------------------
const kinds = (value: string) => tokenizeMarkdown(value).map((r) => `${r.kind}:${value.slice(r.start, r.end)}`);
eq("bold", kinds("a **b c** d"), ["marker:**", "bold:b c", "marker:**"]);
eq("italic both spellings", kinds("*x* and _y_"), ["marker:*", "italic:x", "marker:*", "marker:_", "italic:y", "marker:_"]);
eq("heading line", kinds("## Big day"), ["marker:##", "heading:Big day"]);
eq("bullet and numbered markers", kinds("- a\n12. b"), ["marker:-", "marker:12."]);
eq("star bullet is a marker, not an italic", kinds("* item *em*"), ["marker:*", "marker:*", "italic:em", "marker:*"]);
eq("code span hides stars", kinds("`a*b*c`"), ["marker:`", "code:a*b*c", "marker:`"]);
eq("snake_case and 2*3*4 are not italic", kinds("snake_case_name 2*3*4"), []);
eq("bold is not read as italic", kinds("**b**").filter((k) => k.startsWith("italic")), []);

// Composing with @mentions -----------------------------------------------------------------
{
  const value = "met **@Sarah Chen** at AWS";
  const mention = { start: value.indexOf("@"), end: value.indexOf("@") + "@Sarah Chen".length, kind: "mention" as const };
  const segs = segmentMarks(value.length, [...tokenizeMarkdown(value), mention]);
  t.check("runs tile the whole value", segs.map((s) => value.slice(s.start, s.end)).join("") === value);
  t.check("runs never overlap", segs.every((s, i) => i === 0 || segs[i - 1]!.end === s.start));
  const atMention = segs.find((s) => s.start === mention.start);
  eq("mention inside bold carries both kinds", atMention?.kinds.sort(), ["bold", "mention"]);
  t.check("plain value is one run", JSON.stringify(segmentMarks(3, [])) === JSON.stringify([{ start: 0, end: 3, kinds: [] }]));
}

// Read side ------------------------------------------------------------------------------
eq("capture excerpt drops markdown markers", captureExcerpt("# AWS\n- Met **Sarah**"), "AWS Met Sarah");

t.done("markdown shortcuts smoke");
