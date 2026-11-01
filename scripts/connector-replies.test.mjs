import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../skills/connector-replies/scripts/prepare_gmail_reply.py", import.meta.url));
const available = spawnSync("python3", ["-c", "import email,html,json"]).status === 0;
const parent = { id: "gmail-parent", thread_id: "gmail-thread", payload: { headers: [
  { name: "Message-ID", value: "<parent@example.test>" },
  { name: "Subject", value: "Existing subject" },
  { name: "From", value: "Sender <sender@example.test>" },
  { name: "To", value: "Me <me@example.test>" }
], body: { content: "PRIVATE ORIGINAL MUST NOT BE COPIED\n> old quotation" } } };
const input = () => ({ link_id: "synthetic-link", account_email: "me@example.test", parent: structuredClone(parent), body_text: "Hello,\n\nThe value is < 5 & > 1.\nUnicode: café." });
const run = data => spawnSync("python3", [script], { input: JSON.stringify(data), encoding: "utf8" });

test("reply builder uses Gmail message ID and clean escaped MIME without copying history", { skip: !available }, () => {
  const result = run(input()); assert.equal(result.status, 0, result.stderr);
  const prepared = JSON.parse(result.stdout);
  assert.equal(prepared.arguments.reply_message_id, "gmail-parent");
  assert.equal(prepared.arguments.subject, "Existing subject");
  assert.equal(prepared.arguments.to, "sender@example.test");
  assert.equal(prepared.arguments.reply_to, undefined);
  assert.equal(prepared.verification.expected_thread_id, "gmail-thread");
  assert.equal(prepared.arguments.payload.parts[0].body.content, input().body_text);
  assert.match(prepared.arguments.payload.parts[1].body.content, /&lt; 5 &amp; &gt; 1/);
  assert.doesNotMatch(result.stdout, /PRIVATE ORIGINAL|old quotation/);
});
test("first-message ID equality is valid, and a follow-up to own sent mail targets its recipient", { skip: !available }, () => {
  const data = input(); data.parent.thread_id = data.parent.id;
  data.parent.payload.headers.find(h => h.name === "From").value = "me@example.test";
  data.parent.payload.headers.find(h => h.name === "To").value = "Recipient <recipient@example.test>";
  const result = run(data); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).arguments.to, "recipient@example.test");
});
test("reply-to routing is separate from threading and malformed anchors fail before any action", { skip: !available }, () => {
  const data = input(); data.parent.payload.headers.push({ name: "Reply-To", value: "replies@example.test" });
  assert.equal(JSON.parse(run(data).stdout).arguments.to, "replies@example.test");
  data.parent.id = "<parent@example.test>";
  assert.notEqual(run(data).status, 0);
  data.parent.id = "gmail-parent";
  data.parent.payload.headers.find(h => h.name === "Subject").value = "subject\r\nBcc: unwanted@example.test";
  assert.notEqual(run(data).status, 0);
});

test("explicit self-replies and empty subjects preserve the requested destination", { skip: !available }, () => {
  const data = input(); data.to = "me@example.test";
  data.parent.payload.headers = data.parent.payload.headers.filter(h => h.name !== "Subject");
  const result = run(data); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).arguments.to, "me@example.test");
  assert.equal(JSON.parse(result.stdout).arguments.subject, "");
  data.body_text = null;
  assert.notEqual(run(data).status, 0);
});

test("native draft verification catches wrong threads, recipients and quote-chain regression", { skip: !available }, () => {
  const prepared = JSON.parse(run(input()).stdout);
  const draft = { id: "synthetic-draft-message", thread_id: prepared.verification.expected_thread_id, label_ids: ["DRAFT"], payload: {
    ...structuredClone(prepared.arguments.payload), headers: [
      { name: "In-Reply-To", value: "<parent@example.test>" }, { name: "References", value: "<older@example.test> <parent@example.test>" },
      { name: "To", value: "sender@example.test" }, { name: "Subject", value: "Re: Existing subject" }
    ]
  } };
  const verify = value => spawnSync("python3", [script, "verify"], { input: JSON.stringify({ prepared, draft: value }), encoding: "utf8" });
  assert.equal(verify(draft).status, 0);
  for (const mutate of [
    copy => { copy.thread_id = "wrong-thread"; },
    copy => { copy.payload.parts[0].body.content += "\n> unsolicited original history"; },
    copy => { copy.payload.headers.find(h => h.name === "To").value = "other@example.test"; },
    copy => { copy.payload.headers = copy.payload.headers.filter(h => h.name !== "References"); },
    copy => { copy.payload.parts = copy.payload.parts.filter(p => p.mime_type !== "text/html"); }
  ]) {
    const copy = structuredClone(draft); mutate(copy);
    assert.notEqual(verify(copy).status, 0);
  }
});
