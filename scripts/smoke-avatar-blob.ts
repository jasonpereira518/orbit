/**
 * Avatar Blob writes are unguessable and deletes are best-effort, through an injected client.
 * Run: npx tsx scripts/smoke-avatar-blob.ts
 */
import {
  deleteAvatarBlobs,
  deleteReplacedAvatar,
  isAvatarBlobUrl,
  putAvatarBlob,
  setAvatarBlobClientForTests,
  type AvatarBlobClient,
} from "../src/lib/avatar-blob";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const BLOB = (name: string) => `https://abc123.public.blob.vercel-storage.com/avatars/${name}.jpg`;
const puts: Array<{ pathname: string; options: Record<string, unknown> }> = [];
const dels: string[][] = [];
let failDel = false;
const fake: AvatarBlobClient = {
  put: async (pathname, _body, options) => {
    puts.push({ pathname, options });
    return { url: BLOB(`c1-Xy7Rq2`) };
  },
  del: async (urls) => {
    if (failDel) throw new Error("blob outage");
    dels.push(urls);
  },
};

async function main() {
  setAvatarBlobClientForTests(fake);
  try {
    console.log("put");
    const url = await putAvatarBlob("c1", Buffer.from([1, 2, 3]), "image/jpeg");
    check("returns the URL Blob gave back", url === BLOB("c1-Xy7Rq2"));
    check("asks for a random suffix", puts[0]?.options.addRandomSuffix === true, JSON.stringify(puts[0]));
    check("under avatars/<contactId>", puts[0]?.pathname === "avatars/c1.jpg");

    console.log("\nisAvatarBlobUrl");
    check("a store avatar URL", isAvatarBlobUrl(BLOB("x")));
    check("not a data URI", !isAvatarBlobUrl("data:image/jpeg;base64,AAAA"));
    check("not another Blob path", !isAvatarBlobUrl("https://abc.public.blob.vercel-storage.com/capture/x.jpg"));
    check("not a lookalike host", !isAvatarBlobUrl("https://evil.example/avatars/x.jpg?.public.blob.vercel-storage.com"));
    check("not null", !isAvatarBlobUrl(null));

    console.log("\ndelete");
    const n = await deleteAvatarBlobs([BLOB("a"), "data:image/png;base64,AA", null, BLOB("a"), BLOB("b")]);
    check("deletes only Blob avatar URLs, once each", n === 2 && dels.length === 1 && dels[0].length === 2, JSON.stringify(dels));
    dels.length = 0;
    check("nothing to delete makes no call", (await deleteAvatarBlobs(["data:image/png;base64,AA"])) === 0 && dels.length === 0);
    failDel = true;
    check("an outage is swallowed", (await deleteAvatarBlobs([BLOB("c")])) === 0);
    failDel = false;

    console.log("\nreplacement");
    await deleteReplacedAvatar(BLOB("old"), BLOB("new"));
    check("a replaced photo's blob is deleted", dels.at(-1)?.[0] === BLOB("old"));
    const before = dels.length;
    await deleteReplacedAvatar(BLOB("same"), BLOB("same"));
    await deleteReplacedAvatar(null, BLOB("new"));
    check("an unchanged or first photo deletes nothing", dels.length === before);
  } finally {
    setAvatarBlobClientForTests(null);
  }
  if (failures > 0) process.exit(1);
  console.log("\nAll avatar-blob checks passed.");
  process.exit(0);
}

void main();
