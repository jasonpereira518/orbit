import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { inspectOutreachPage } from "../extension/src/outreach/page";
function inspect(html: string, url: string) {
  const { window } = parseHTML(html);
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = window.document;
  globals.location = new URL(url);
  globals.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globals.HTMLInputElement = window.HTMLInputElement;
  globals.HTMLElement = window.HTMLElement;
  window.Element.prototype.getBoundingClientRect = () => ({
    x: 10,
    y: 10,
    width: 100,
    height: 30,
    top: 10,
    left: 10,
    right: 110,
    bottom: 40,
    toJSON() {
      return {};
    },
  });
  return inspectOutreachPage();
}
let state = inspect(
  '<html><body><button aria-label="Google Account: Alex (alex@example.test)">Account</button><div role="dialog"><span email="person@example.test">Person</span><input name="subjectbox" value="Hello"><div role="textbox" contenteditable="true" aria-label="Message Body">Approved body</div><button>Send</button></div></body></html>',
  "https://mail.google.com/mail/u/0/",
);
assert.equal(state.account, "alex@example.test");
assert.equal(state.subject, "Hello");
assert.equal(state.body, "Approved body");
assert.ok(state.send);
assert.ok(state.recipients.includes("person@example.test"));
assert.equal(state.confirmed, false);
state = inspect(
  '<html><body><nav><a href="https://www.linkedin.com/in/alex/">View profile</a></nav><main><h1>Taylor</h1><button>Pending</button></main></body></html>',
  "https://www.linkedin.com/in/taylor/",
);
assert.equal(state.account, "https://www.linkedin.com/in/alex/");
assert.equal(state.pending, true);
assert.equal(state.connected, false);
state = inspect(
  '<html><body><main><h1>Taylor</h1><span class="dist-value">1st</span><button>Message</button></main></body></html>',
  "https://www.linkedin.com/in/taylor/",
);
assert.equal(state.connected, true);
assert.equal(state.account, null);
state = inspect(
  "<html><body>Security verification — verify your identity</body></html>",
  "https://www.linkedin.com/checkpoint/",
);
assert.equal(state.blocked, true);
assert.equal(state.send, null);
state = inspect(
  '<html><body><button aria-label="Account manager for alex@example.test">Account</button><input placeholder="Add a subject" value="A note"><div contenteditable="true" role="textbox" aria-label="Message body">Hello</div><button>Send</button><div>Your message has been sent</div></body></html>',
  "https://outlook.office.com/mail/",
);
assert.equal(state.account, "alex@example.test");
assert.equal(state.confirmed, true);
console.log(
  "Browser fixtures passed: account identity, composer contents, invitation states, confirmation, and site restrictions.",
);
