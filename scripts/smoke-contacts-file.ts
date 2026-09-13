/**
 * Address-book file parsing — vCard and the Google/Outlook contacts CSVs.
 *
 * The fixtures are written the way each exporter actually writes them, quirks included: Apple's
 * `item1.` groups and `\:` in URLs, 4.0's `PREF=1` and `tel:` URIs, Android's 2.1
 * quoted-printable with soft line breaks, Google's `* ` primary marker and `:::` multi-values,
 * Outlook's honorific "Title" column. Every one of those was a way for a real export to come
 * out blank or wrong, and each gets an assertion so that stays true.
 *
 * Pure tier: no database. The server actions and the engine adapter are thin around
 * `parseContactsFile`; `smoke-import-engine.ts` covers the adapter against PGlite.
 *
 * Run: npx tsx scripts/smoke-contacts-file.ts
 */
import Papa from "papaparse";
import {
  ContactsFileError,
  MAX_CONTACTS_FILE_CHARS,
  MAX_CONTACTS_FILE_ROWS,
  compactContactsFileText,
  parseContactsFile,
  type ContactsFileRow,
} from "../src/lib/contacts-file";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function expectError(label: string, run: () => unknown, pattern: RegExp) {
  try {
    run();
    check(label, false, "did not throw");
  } catch (err) {
    const isOurs = err instanceof ContactsFileError;
    const message = err instanceof Error ? err.message : String(err);
    check(label, isOurs && pattern.test(message), `${isOurs ? "" : "not a ContactsFileError: "}${message}`);
  }
}

function byName(rows: ContactsFileRow[], fullName: string) {
  return rows.find((r) => r.fullName === fullName);
}

function show(value: unknown) {
  return JSON.stringify(value);
}

/** CSV with correct quoting, from header names and sparse rows — hand-counting 30 commas is how fixtures lie. */
function csv(fields: string[], rows: Record<string, string>[]) {
  return Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => r[f] ?? "")) });
}

const FAKE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a";

// --- vCard 3.0 (Apple) --------------------------------------------------------------------
console.log("vCard 3.0, several cards (iCloud-style)");
const V3 = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 17.0//EN",
  "N:Lovelace;Ada;King;Countess;",
  "FN:Ada King Lovelace",
  "ORG:Analytical Engines\\, Ltd.;Research",
  "TITLE:Chief Programmer",
  "item1.EMAIL;type=INTERNET;type=HOME:ada.home@example.com",
  "item2.EMAIL;type=INTERNET;type=WORK;type=pref:ada@engines.example",
  "item2.X-ABLabel:work",
  "TEL;type=CELL;type=VOICE:+44 20 7946 0000",
  "TEL;type=WORK;type=VOICE;type=pref:+44 20 7946 0001",
  "item3.URL;type=pref:http\\://www.linkedin.com/in/ada-lovelace",
  "item3.X-ABLabel:_$!<HomePage>!$_",
  "NOTE:Met at the Difference Engine demo\\nLikes poetry\\; and numbers",
  `PHOTO;ENCODING=b;TYPE=JPEG:${FAKE_JPEG_B64}`,
  ` ${FAKE_JPEG_B64}`,
  ` ${FAKE_JPEG_B64}`,
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Hopper;Grace;;;",
  "FN:Grace Hopper",
  "ORG:US Navy",
  "EMAIL;TYPE=INTERNET:grace@navy.example",
  "X-SOCIALPROFILE;type=linkedin;x-user=ghopper:http://www.linkedin.com/in/ghopper",
  "X-SOCIALPROFILE;type=twitter:https://twitter.com/ghopper",
  "TEL;TYPE=CELL:(555) 010-0000",
  "END:VCARD",
  "",
].join("\n");
{
  const { format, rows, warnings } = parseContactsFile(V3, "contacts.vcf");
  check("detected as vCard", format === "vcard", format);
  check("both cards read", rows.length === 2, show(rows.map((r) => r.fullName)));
  check("no warnings for a clean file", warnings.length === 0, show(warnings));
  const ada = byName(rows, "Ada King Lovelace");
  check("FN wins over the assembled N", Boolean(ada), show(rows.map((r) => r.fullName)));
  check("N gives first/last name", ada?.firstName === "Ada" && ada?.lastName === "Lovelace", show(ada));
  check("escaped comma kept, first ORG component only", ada?.company === "Analytical Engines, Ltd.", ada?.company);
  check("TITLE read", ada?.title === "Chief Programmer", ada?.title);
  check("grouped item2.EMAIL with type=pref wins over the first email", ada?.email === "ada@engines.example", ada?.email);
  check("TEL with type=pref wins over the first phone", ada?.phone === "+44 20 7946 0001", ada?.phone);
  check(
    "grouped URL with Apple's \\: escape becomes a LinkedIn URL",
    ada?.linkedinUrl === "http://www.linkedin.com/in/ada-lovelace",
    ada?.linkedinUrl
  );
  check(
    "NOTE unescapes \\n and \\;",
    ada?.notes === "Met at the Difference Engine demo\nLikes poetry; and numbers",
    show(ada?.notes)
  );
  check(
    "PHOTO is skipped — no base64 in any field",
    rows.every((r) => Object.values(r).every((v) => !v.includes("/9j/"))),
    show(rows)
  );
  const grace = byName(rows, "Grace Hopper");
  check(
    "X-SOCIALPROFILE linkedin.com becomes the LinkedIn URL; twitter ignored",
    grace?.linkedinUrl === "http://www.linkedin.com/in/ghopper",
    grace?.linkedinUrl
  );
  check("unpreferred single email kept", grace?.email === "grace@navy.example", grace?.email);

  const compact = compactContactsFileText(V3);
  check(
    "compaction strips the PHOTO and its folded lines",
    !compact.includes("PHOTO") && !compact.includes(FAKE_JPEG_B64),
    `${compact.length} chars`
  );
  check("compaction keeps everything else", compact.includes("FN:Grace Hopper") && compact.includes("NOTE:Met"));
  check(
    "compacted text parses to identical rows",
    show(parseContactsFile(compact).rows) === show(rows)
  );
}

// --- vCard 4.0 ----------------------------------------------------------------------------
console.log("vCard 4.0, folded lines, PREF=n, tel: URIs");
const V4 = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Alan Turing",
  "N:Turing;Alan;Mathison;;",
  "EMAIL;TYPE=work;PREF=2:alan@bletchley.example",
  "EMAIL;PREF=1:alan.turing@example.org",
  'TEL;VALUE=uri;TYPE="voice,work":tel:+1-555-555-0199',
  'TEL;VALUE=uri;TYPE="voice,cell";PREF=1:tel:+1-555-555-0100',
  "ORG:Bletchley Park;Hut 8",
  `PHOTO:data:image/jpeg;base64,${FAKE_JPEG_B64}`,
  ` ${FAKE_JPEG_B64}`,
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "N:Johnson;Katherine;;;",
  "FN:Katherine Johns",
  " on",
  "TITLE:Research mathemat",
  "\tician",
  "URL:https://example.org/kj",
  "END:VCARD",
].join("\r\n");
{
  const { rows } = parseContactsFile(V4);
  check("both 4.0 cards read (CRLF endings)", rows.length === 2, show(rows.map((r) => r.fullName)));
  const alan = byName(rows, "Alan Turing");
  check("PREF=1 beats PREF=2 listed first", alan?.email === "alan.turing@example.org", alan?.email);
  check("tel: URI prefix stripped, PREF=1 phone chosen", alan?.phone === "+1-555-555-0100", alan?.phone);
  check("quoted TYPE list parsed without eating the value", alan?.company === "Bletchley Park", alan?.company);
  check("data: URI PHOTO skipped", Boolean(alan) && !show(alan).includes("base64"), show(alan));
  const kj = byName(rows, "Katherine Johnson");
  check("space-folded FN unfolds", Boolean(kj), show(rows.map((r) => r.fullName)));
  check("tab-folded TITLE unfolds", kj?.title === "Research mathematician", kj?.title);
  check("a non-LinkedIn URL is not a LinkedIn URL", kj?.linkedinUrl === "", kj?.linkedinUrl);
}

// --- vCard 2.1 quoted-printable (Android) ---------------------------------------------------
console.log("vCard 2.1, quoted-printable with soft breaks and UTF-8 accents");
const V21 = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Garc=C3=ADa;Jos=C3=A9;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Garc=C3=ADa M=C3=A1rquez de la Pe=C3=B1a y =",
  "Hern=C3=A1ndez",
  "TEL;HOME:+34910000000",
  "TEL;CELL;PREF:+34600000000",
  "EMAIL;INTERNET:jose@example.es",
  "EMAIL;INTERNET;PREF:jose.garcia@example.es",
  "ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Compa=C3=B1=C3=ADa Ib=C3=A9rica;Ventas",
  "TITLE;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Jefe de dise=F1o",
  "NOTE;ENCODING=QUOTED-PRINTABLE:L=C3=ADnea uno=0D=0A=",
  "L=C3=ADnea dos",
  `PHOTO;ENCODING=BASE64;JPEG:${FAKE_JPEG_B64}`,
  `  ${FAKE_JPEG_B64}`,
  FAKE_JPEG_B64, // some 2.1 writers don't indent base64 continuations at all
  "",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N:;;;;",
  "FN;QUOTED-PRINTABLE:Bj=C3=B6rk",
  "END:VCARD",
].join("\r\n");
{
  const { rows } = parseContactsFile(V21);
  check("both 2.1 cards read", rows.length === 2, show(rows.map((r) => r.fullName)));
  const jose = rows[0];
  check(
    "QP soft break joins the FN across lines, UTF-8 accents decoded",
    jose?.fullName === "José García Márquez de la Peña y Hernández",
    show(jose?.fullName)
  );
  check("QP N decoded into first/last", jose?.firstName === "José" && jose?.lastName === "García", show(jose));
  check("QP ORG decoded, first component", jose?.company === "Compañía Ibérica", show(jose?.company));
  check("CHARSET=ISO-8859-1 honoured for QP", jose?.title === "Jefe de diseño", show(jose?.title));
  check("bare 2.1 PREF param picks the email", jose?.email === "jose.garcia@example.es", jose?.email);
  check("bare 2.1 PREF param picks the phone", jose?.phone === "+34600000000", jose?.phone);
  check("multi-line QP NOTE decoded", jose?.notes === "Línea uno\r\nLínea dos", show(jose?.notes));
  check(
    "2.1 base64 PHOTO (indented, unindented, blank-line terminated) skipped",
    !show(rows).includes("/9j/"),
    show(rows)
  );
  check("bare ;QUOTED-PRINTABLE param recognised", rows[1]?.fullName === "Björk", show(rows[1]));
  check(
    "compacted 2.1 text parses to identical rows",
    show(parseContactsFile(compactContactsFileText(V21)).rows) === show(rows)
  );
}

// --- Name fallbacks ------------------------------------------------------------------------
console.log("Name fallbacks: FN -> N -> email local part -> skipped");
{
  const text = [
    "BEGIN:VCARD", "VERSION:3.0", "N:Curie;Marie;Salomea;;", "EMAIL:marie@radium.example", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:", "N:;;;;", "EMAIL:r.franklin@kings.example", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "TEL:+15550100", "ORG:Nobody Inc", "END:VCARD",
  ].join("\n");
  const { rows, warnings } = parseContactsFile(text);
  check("N assembled when FN is missing", rows[0]?.fullName === "Marie Salomea Curie", rows[0]?.fullName);
  check("email local part when FN and N are empty", rows[1]?.fullName === "r.franklin", rows[1]?.fullName);
  check("a card with no name and no email is skipped", rows.length === 2, show(rows.map((r) => r.fullName)));
  check("…and the skip is reported", warnings.some((w) => /1 contact had no name/.test(w)), show(warnings));

  expectError(
    "a file where no card has a name or email is refused",
    () => parseContactsFile("BEGIN:VCARD\nVERSION:3.0\nTEL:+15550100\nEND:VCARD\n"),
    /None of the 1 contact/
  );
}

// --- Within-file dedupe --------------------------------------------------------------------
console.log("Within-file dedupe");
{
  const text = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Ada Lovelace", "EMAIL:ADA@engines.example", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Ada Lovelace", "EMAIL:ada@engines.example", "TITLE:Programmer", "TEL:+44 20 7946 0000", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Bob Smith", "TEL:(555) 010-0001", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:bob smith", "TEL:555.010.0001", "ORG:Acme", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Bob Smith", "TEL:(555) 010-9999", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Carol Office", "EMAIL:info@acme.example", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Dan Office", "EMAIL:info@acme.example", "END:VCARD",
  ].join("\n");
  const { rows, warnings } = parseContactsFile(text);
  const names = rows.map((r) => r.fullName);
  check("same email (any case) collapses to one row", names.filter((n) => n === "Ada Lovelace").length === 1, show(names));
  const ada = byName(rows, "Ada Lovelace");
  check("the kept row is filled in from the duplicate", ada?.title === "Programmer" && ada?.phone === "+44 20 7946 0000", show(ada));
  const bobs = rows.filter((r) => r.fullName.toLowerCase() === "bob smith");
  check("same name + same phone digits collapses; a different phone does not", bobs.length === 2, show(bobs));
  check("…and the collapsed Bob gained the company", bobs.some((b) => b.company === "Acme"), show(bobs));
  check(
    "a shared role address (info@) is not an identity — two people stay two",
    Boolean(byName(rows, "Carol Office")) && Boolean(byName(rows, "Dan Office")),
    show(names)
  );
  check("the merge is reported", warnings.some((w) => /Combined 2 duplicate entries/.test(w)), show(warnings));
}

// --- Google CSV (current export) -------------------------------------------------------------
console.log("Google Contacts CSV, current headers");
const GOOGLE_NEW_FIELDS = [
  "First Name", "Middle Name", "Last Name", "Phonetic First Name", "Phonetic Middle Name",
  "Phonetic Last Name", "Name Prefix", "Name Suffix", "Nickname", "File As",
  "Organization Name", "Organization Title", "Organization Department", "Birthday", "Notes",
  "Photo", "Labels", "E-mail 1 - Label", "E-mail 1 - Value", "E-mail 2 - Label",
  "E-mail 2 - Value", "Phone 1 - Label", "Phone 1 - Value", "Phone 2 - Label", "Phone 2 - Value",
  "Website 1 - Label", "Website 1 - Value",
];
{
  const text = csv(GOOGLE_NEW_FIELDS, [
    {
      "First Name": "Ada", "Last Name": "Lovelace", "Name Prefix": "Countess",
      "Organization Name": "Analytical Engines", "Organization Title": "Programmer",
      Notes: "Met at the demo, 1843", Labels: "* myContacts",
      "E-mail 1 - Label": "Home", "E-mail 1 - Value": "ada.home@example.com",
      "E-mail 2 - Label": "* Work", "E-mail 2 - Value": "ada@engines.example",
      "Phone 1 - Label": "Mobile", "Phone 1 - Value": "+44 20 7946 0000",
      "Website 1 - Label": "Profile", "Website 1 - Value": "www.linkedin.com/in/ada-lovelace",
    },
    {
      "First Name": "Grace", "Middle Name": "Brewster", "Last Name": "Hopper",
      "Organization Name": "US Navy", "Organization Title": "Rear Admiral",
      "E-mail 1 - Label": "* Other", "E-mail 1 - Value": "grace@navy.example ::: grace2@navy.example",
      "Phone 1 - Label": "Work", "Phone 1 - Value": "+1 555 010 0000 ::: +1 555 010 0001",
    },
    { "Organization Name": "Just A Company" },
  ]);
  const { format, rows, warnings } = parseContactsFile(text, "contacts.csv");
  check("detected as Google CSV", format === "google_csv", format);
  const ada = byName(rows, "Ada Lovelace");
  check("First + Last assembled (prefix left out)", Boolean(ada), show(rows.map((r) => r.fullName)));
  check("`* ` label marks the primary email", ada?.email === "ada@engines.example", ada?.email);
  check("Organization Name / Title mapped", ada?.company === "Analytical Engines" && ada?.title === "Programmer", show(ada));
  check("Notes mapped", ada?.notes === "Met at the demo, 1843", ada?.notes);
  check(
    "Website with a linkedin.com value becomes the LinkedIn URL, scheme added",
    ada?.linkedinUrl === "https://www.linkedin.com/in/ada-lovelace",
    ada?.linkedinUrl
  );
  const grace = byName(rows, "Grace Brewster Hopper");
  check("middle name included in the assembled name", Boolean(grace), show(rows.map((r) => r.fullName)));
  check("`:::` multi-value email takes the first", grace?.email === "grace@navy.example", grace?.email);
  check("`:::` multi-value phone takes the first", grace?.phone === "+1 555 010 0000", grace?.phone);
  check("a company-only row (no person, no email) is skipped", rows.length === 2, show(rows.map((r) => r.fullName)));
  check("…and reported", warnings.some((w) => /1 contact had no name/.test(w)), show(warnings));
}

// --- Google CSV (older export) ---------------------------------------------------------------
console.log("Google Contacts CSV, older headers");
{
  const fields = [
    "Name", "Given Name", "Additional Name", "Family Name", "Yomi Name", "Name Prefix",
    "Name Suffix", "Nickname", "Birthday", "Notes", "Group Membership", "E-mail 1 - Type",
    "E-mail 1 - Value", "E-mail 2 - Type", "E-mail 2 - Value", "Phone 1 - Type", "Phone 1 - Value",
    "Organization 1 - Type", "Organization 1 - Name", "Organization 1 - Title",
    "Organization 1 - Department", "Website 1 - Type", "Website 1 - Value",
  ];
  const text = csv(fields, [
    {
      Name: "Alan M. Turing", "Given Name": "Alan", "Family Name": "Turing",
      "Group Membership": "* My Contacts", "E-mail 1 - Type": "Home", "E-mail 1 - Value": "alan@home.example",
      "E-mail 2 - Type": "* Work", "E-mail 2 - Value": "alan@bletchley.example",
      "Phone 1 - Type": "Mobile", "Phone 1 - Value": "+1 555 555 0100",
      "Organization 1 - Name": "Bletchley Park", "Organization 1 - Title": "Cryptanalyst",
    },
    { "Given Name": "Joan", "Family Name": "Clarke", "E-mail 1 - Value": "joan@bletchley.example" },
  ]);
  const { format, rows } = parseContactsFile(text);
  check("detected as Google CSV", format === "google_csv", format);
  const alan = rows[0];
  check("explicit Name column wins over Given/Family", alan?.fullName === "Alan M. Turing", show(alan));
  check("Given/Family still fill first/last", alan?.firstName === "Alan" && alan?.lastName === "Turing", show(alan));
  check("`- Type` label with `*` marks the primary", alan?.email === "alan@bletchley.example", alan?.email);
  check(
    "Organization 1 - Name / Title mapped",
    alan?.company === "Bletchley Park" && alan?.title === "Cryptanalyst",
    show(alan)
  );
  check("Given + Family assembled without a Name column", rows[1]?.fullName === "Joan Clarke", show(rows[1]));
}

// --- Outlook CSV ---------------------------------------------------------------------------
console.log("Outlook CSV");
{
  const fields = [
    "First Name", "Middle Name", "Last Name", "Title", "Suffix", "Nickname", "E-mail Address",
    "E-mail 2 Address", "Home Phone", "Business Phone", "Mobile Phone", "Primary Phone",
    "Company", "Department", "Job Title", "Notes", "Web Page",
  ];
  const text = csv(fields, [
    {
      "First Name": "Charles", "Last Name": "Drew", Title: "Dr.", "E-mail Address": "cdrew@hospital.example",
      "Business Phone": "+1 555 0102", "Mobile Phone": "+1 555 0101", Company: "Freedmen's Hospital",
      "Job Title": "Surgeon", "Web Page": "https://www.linkedin.com/in/charles-drew",
    },
    {
      "First Name": "Mary", "Last Name": "Jackson", "E-mail 2 Address": "mary@nasa.example",
      "Primary Phone": "+1 555 0200", "Mobile Phone": "+1 555 0201",
    },
  ]);
  const { format, rows } = parseContactsFile(text);
  check("detected as Outlook CSV", format === "outlook_csv", format);
  const drew = rows[0];
  check("Job Title is the title — the honorific Title column is not", drew?.title === "Surgeon", drew?.title);
  check("Company mapped", drew?.company === "Freedmen's Hospital", drew?.company);
  check("Mobile Phone preferred over Business Phone", drew?.phone === "+1 555 0101", drew?.phone);
  check("Web Page LinkedIn URL mapped", drew?.linkedinUrl === "https://www.linkedin.com/in/charles-drew", drew?.linkedinUrl);
  const mary = rows[1];
  check("Primary Phone preferred over Mobile Phone", mary?.phone === "+1 555 0200", mary?.phone);
  check("E-mail 2 Address used when E-mail Address is blank", mary?.email === "mary@nasa.example", mary?.email);
}

// --- Generic CSV ---------------------------------------------------------------------------
console.log("Plain hand-made CSV");
{
  const { format, rows } = parseContactsFile("Name,Email,Phone,Title\nJane Roe,jane@roe.example,555-0100,Editor\n");
  check("detected as generic CSV", format === "csv", format);
  check("Name/Email/Phone/Title mapped", show(rows[0]) === show({
    fullName: "Jane Roe", firstName: "", lastName: "", company: "", title: "Editor",
    email: "jane@roe.example", phone: "555-0100", linkedinUrl: "", notes: "",
  }), show(rows[0]));
  check("compaction leaves a CSV untouched", compactContactsFileText("a,b\n1,2") === "a,b\n1,2");
}

// --- Wrong file, garbage, limits ----------------------------------------------------------
console.log("Refusals and limits");
{
  const linkedIn = [
    "Notes:",
    '"When exporting your connection data, you may notice that some of the email addresses are missing."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Jane,Doe,https://www.linkedin.com/in/jane-doe,,Acme,Engineer,15 Jan 2024",
  ].join("\n");
  expectError(
    "a LinkedIn Connections export is sent to the LinkedIn card",
    () => parseContactsFile(linkedIn, "Connections.csv"),
    /LinkedIn Connections export.*LinkedIn connections card/
  );
  expectError(
    "a LinkedIn Messages export is sent to the Messages tab",
    () =>
      parseContactsFile(
        "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT\nc1,Jane,Jane,,Me,2024-01-01,,hi\n"
      ),
    /Messages tab/
  );
  expectError("an empty file", () => parseContactsFile("  \n\n"), /empty/);
  expectError(
    "prose is not a contacts file",
    () => parseContactsFile("lorem ipsum dolor sit amet\nconsectetur adipiscing elit\n"),
    /Couldn’t find name or email columns/
  );
  expectError(
    "binary-looking junk is not a contacts file",
    () => parseContactsFile("%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog >>\n"),
    /Couldn’t find name or email columns/
  );
  expectError(
    "a .vcf with no vCards in it says so",
    () => parseContactsFile("just some text\n", "contacts.vcf"),
    /doesn’t contain any vCards/
  );
  expectError(
    "a vCard stream with no complete card",
    () => parseContactsFile("BEGIN:VCARD\nVERSION:3.0\nFN:Cut Off\n"),
    /No contacts found/
  );
  expectError(
    "text over the upload limit is refused",
    () => parseContactsFile("Name,Email\n" + "x".repeat(MAX_CONTACTS_FILE_CHARS)),
    /too big/
  );

  const many = Array.from(
    { length: MAX_CONTACTS_FILE_ROWS + 5 },
    (_, i) => `BEGIN:VCARD\nVERSION:3.0\nFN:Person ${i}\nEMAIL:p${i}@example.com\nEND:VCARD`
  ).join("\n");
  const capped = parseContactsFile(many);
  check("rows are capped at MAX_CONTACTS_FILE_ROWS", capped.rows.length === MAX_CONTACTS_FILE_ROWS, String(capped.rows.length));
  check("…keeping the first ones, in file order", capped.rows[0]?.fullName === "Person 0", capped.rows[0]?.fullName);
  check("…with a warning saying so", capped.warnings.some((w) => /Only the first 10,000 of 10,005/.test(w)), show(capped.warnings));

  const garbled = parseContactsFile("Name,Email\nJos\uFFFD Garc\uFFFDa,jose@example.es\n");
  check(
    "replacement characters trigger the re-export-as-UTF-8 warning",
    garbled.warnings.some((w) => /decoded correctly/.test(w)),
    show(garbled.warnings)
  );
}

if (failures > 0) {
  console.error(`\n${failures} contacts-file check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("\ncontacts-file smoke tests passed");
