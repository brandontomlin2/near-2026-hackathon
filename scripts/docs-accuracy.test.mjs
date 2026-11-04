// Guards the recording/posting docs: every `npm run <script>` they mention
// must exist in package.json, every scripts/ file they name must exist, and
// each X post draft must carry both tags and fit in 280 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const DOCS = [
  'docs/demo-script.md',
  'docs/demo-video.md',
  'docs/x-post.md',
  'docs/submission-checklist.md',
  'docs/judge-checklist.md',
];
const scripts = JSON.parse(read('package.json')).scripts;

test('every npm run <script> in the five docs exists in package.json', () => {
  for (const doc of DOCS) {
    const names = [...read(doc).matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1]);
    for (const name of names) {
      assert.ok(name in scripts, `${doc}: "npm run ${name}" is not a package.json script`);
    }
  }
});

test('every scripts/ file named in the five docs exists', () => {
  for (const doc of DOCS) {
    const paths = [...read(doc).matchAll(/\bscripts\/[\w.-]+\.(?:mjs|sh)\b/g)].map((m) => m[0]);
    for (const p of paths) {
      assert.ok(existsSync(join(root, p)), `${doc}: ${p} does not exist`);
    }
  }
});

// How X counts: URLs are 23, most Latin text is 1, emoji and other
// characters outside these ranges are 2.
function xLength(text) {
  const withLinks = text.replace(/https?:\/\/\S+|<REPO_URL>/g, 'x'.repeat(23));
  let n = 0;
  for (const ch of withLinks) {
    const c = ch.codePointAt(0);
    const light =
      c <= 0x10ff ||
      (c >= 0x2000 && c <= 0x200d) ||
      (c >= 0x2010 && c <= 0x201f) ||
      (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

test('xLength counts links as 23 and emoji as 2', () => {
  assert.equal(xLength('<REPO_URL>'), 23);
  assert.equal(xLength('a🚀'), 3);
});

test('x-post.md drafts have @NEARProtocol and #NEARHackathon and fit in 280', () => {
  const drafts = [...read('docs/x-post.md').matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(drafts.length >= 1, 'no fenced drafts found');
  for (const [i, d] of drafts.entries()) {
    assert.ok(d.includes('@NEARProtocol'), `draft ${i + 1} lacks @NEARProtocol`);
    assert.ok(d.includes('#NEARHackathon'), `draft ${i + 1} lacks #NEARHackathon`);
    assert.ok(/built at NEAR HACKATHON/i.test(d), `draft ${i + 1} does not say it was built at NEAR HACKATHON`);
    const len = xLength(d);
    assert.ok(len <= 280, `draft ${i + 1} is ${len} characters, over 280`);
  }
});

test('x-post.md draft counts quoted in the prose match the drafts', () => {
  const doc = read('docs/x-post.md');
  const drafts = [...doc.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const m = doc.match(/draft 1 is (\d+), draft 2 is (\d+), draft 3 is (\d+)/);
  assert.ok(m, 'x-post.md does not quote the draft lengths');
  assert.deepEqual([1, 2, 3].map((i) => Number(m[i])), drafts.map(xLength));
});
