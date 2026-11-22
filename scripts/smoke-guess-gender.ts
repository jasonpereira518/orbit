/**
 * Which silhouette a contact with no photo gets: the man, the woman, or the neutral one.
 *
 * The rule is "only when very sure". A name listed as one gender and nothing else, or a title
 * that says it, earns a man or a woman; everything else — unisex names, names that flip
 * across cultures, names the lists have never seen — gets the neutral silhouette. A wrong
 * guess drawn onto someone's contact is worse than a neutral one.
 *
 * Pure.
 *
 * Run: npx tsx scripts/smoke-guess-gender.ts
 */
import { genderAvatarSrc, guessGenderFromFirstName as guess } from "../src/lib/guess-gender";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}
const is = (expected: string, first: string | null, full?: string | null) => {
  const got = guess(first, full);
  check(`${JSON.stringify(first)}${full ? ` / ${JSON.stringify(full)}` : ""} → ${expected}`, got === expected, `got ${got}`);
};

console.log("Sure: a man or a woman");
for (const n of ["John", "Daniel", "Joshua", "Ryan", "Max"]) is("male", n);
for (const n of ["Sarah", "Rachel", "Sophie", "Victoria", "Carmen"]) is("female", n);
is("male", "john"); // case does not matter
is("female", "  Sarah "); // nor does padding

console.log("\nNot sure: unisex, or a name that flips across cultures");
for (const n of ["Alex", "Jay", "Jesse", "Cameron", "Dylan", "Austin", "Sam", "Chris", "Logan"]) is("unknown", n);
for (const n of ["Taylor", "Sydney", "Robin", "Whitney", "Kim", "Kelly", "Leslie", "Dana", "Jackie", "Harper", "Ashley"]) is("unknown", n);
// Italian Andrea, French Jean and Catalan Joan are men; the English-language ones are women.
for (const n of ["Andrea", "Jean", "Joan"]) is("unknown", n);
for (const n of ["Jordan", "Morgan", "Casey", "Riley", "Quinn"]) is("unknown", n);

console.log("\nNot sure: names the lists have never seen");
for (const n of ["Shohruz", "Abdullahi", "Sameer", "Pratham", "Priya", "Mikhail", "Yuki", "Wei"]) is("unknown", n);
is("unknown", null);
is("unknown", "");
is("unknown", "田中");

console.log("\nAccents are folded, not stripped");
is("female", "Zoë");
is("female", "Renée");
is("male", "José");
is("unknown", "René"); // the male French name, and not Renée

console.log("\nHyphenated names need every part to agree");
is("female", "Mary-Jane");
is("female", "Anne-Marie");
is("unknown", "Jean-Pierre"); // Jean is unisex, so the whole name is not sure

console.log("\nTitles");
is("male", null, "Mr. Chen");
is("female", null, "Ms. Chen");
is("female", null, "Mrs. Okafor");
is("female", null, "Miss Lopez");
is("female", null, "Dr. Elena Vasquez"); // a neutral title is skipped, the first name is read
is("male", null, "Prof. Alan Turing");

console.log("\nInitials and surnames are never read as a first name");
is("unknown", "J.", "J. Smith");
is("unknown", null, "J. Rose"); // Rose is a woman's name and also this person's surname
is("unknown", null, "Dr. Rose");
is("female", null, "Rose"); // alone, there is nothing but the one name
is("male", "John", "Rose Smith"); // the first name wins over the full name

console.log("\nThe image follows");
check("a man gets the man silhouette", genderAvatarSrc(guess("John")) === "/avatars/man.png");
check("a woman gets the woman silhouette", genderAvatarSrc(guess("Sarah")) === "/avatars/woman.png");
check("anyone else gets the neutral one", genderAvatarSrc(guess("Taylor")) === "/avatars/default.png");

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-guess-gender: all checks passed");
process.exit(0);
