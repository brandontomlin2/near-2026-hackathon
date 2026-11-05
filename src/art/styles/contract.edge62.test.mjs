// Mutation checks for runStyleContract: every rule the shared contract enforces
// must reject a style that breaks it, with a message that names the problem, and
// must accept benign variations. Each variant wraps the real sticker style with
// one defect and runs the contract in a child process (so its tests stay out of ours).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const contractUrl = pathToFileURL(fileURLToPath(new URL("./contract.mjs", import.meta.url))).href;
const stickerUrl = pathToFileURL(fileURLToPath(new URL("./sticker.mjs", import.meta.url))).href;

// `render` is the body of render(t, o) (it may use `real`, `t`, `o`); `style` overrides module fields.
const VARIANTS = {
  faithful: { render: "return real.render(t, o);", pattern: "well-formed|unknown mood|invalid traits|slot|data-ring|module shape|deterministic" },
  oversize: { render: 'return real.render(t, o).replace("</svg>\\n", "<!--" + "x".repeat(40000) + "--></svg>\\n");', pattern: "well-formed" },
  script: { render: 'return real.render(t, o).replace("</svg>\\n", "<script></script></svg>\\n");', pattern: "well-formed" },
  href: { render: 'return real.render(t, o).replace("</svg>\\n", "<a href=\\"x\\"></a></svg>\\n");', pattern: "well-formed" },
  remoteUrl: { render: 'return real.render(t, o).replace("</svg>\\n", "<!-- https://evil.example --></svg>\\n");', pattern: "well-formed" },
  threeDecimals: { render: 'return real.render(t, o).replace("</svg>\\n", "<rect x=\\"1.2345\\"/></svg>\\n");', pattern: "well-formed" },
  undefinedText: { render: 'return real.render(t, o).replace("</svg>\\n", "<!-- undefined --></svg>\\n");', pattern: "well-formed" },
  duplicateId: { render: 'return real.render(t, o).replace("</svg>\\n", "<g id=\\"rings\\"></g></svg>\\n");', pattern: "well-formed" },
  unprefixedId: { render: 'return real.render(t, o).replace("</svg>\\n", "<rect id=\\"loose\\"/></svg>\\n");', pattern: "well-formed" },
  danglingUrl: { render: 'return real.render(t, o).replace("</svg>\\n", "<rect fill=\\"url(#nope)\\"/></svg>\\n");', pattern: "well-formed" },
  missingLayer: { render: 'return real.render(t, o).replace("<g id=\\"rings\\">", "<g id=\\"ringz\\">");', pattern: "well-formed" },
  unbalancedG: { render: 'return real.render(t, o).replace("</svg>\\n", "<g></svg>\\n");', pattern: "well-formed" },
  carriageReturn: { render: 'return real.render(t, o).replace("</svg>\\n", "\\r</svg>\\n");', pattern: "well-formed" },
  noTrailingNewline: { render: "return real.render(t, o).trimEnd();", pattern: "well-formed" },
  secondSvg: { render: 'return real.render(t, o).replace("</svg>\\n", "<svg></svg></svg>\\n");', pattern: "well-formed" },
  wrongTier: { render: 'return real.render(t, o).replace(/data-tier="[a-z]+"/, "data-tier=\\"mythic\\"");', pattern: "rarity tier" },
  wrongMoodAttr: { render: 'return real.render(t, o).replace(/data-mood="[a-z]+"/, "data-mood=\\"x\\"");', pattern: "rarity tier" },
  nonDeterministic: { render: "globalThis.n = (globalThis.n ?? 0) + 1; return real.render(t, o).replace(\"</svg>\\n\", `<!--${globalThis.n}--></svg>\\n`);", pattern: "deterministic" },
  ignoresMood: { render: 'return real.render(t, { mood: "neutral" });', pattern: "unknown mood|distinct face" },
  sameFaceForAllMoods: { render: 'return real.render(t, o).replace(/<g id="face">[\\s\\S]*$/, "<g id=\\"face\\"></g>\\n</svg>\\n");', pattern: "distinct face" },
  ignoresRole: { render: 'return real.render({ ...t, role: "scout" }, o);', pattern: "slot role" },
  ignoresDepth: { render: "return real.render({ ...t, memory_depth: 5 }, o);", pattern: "data-ring" },
  swallowsInvalidTraits: { render: "try { return real.render(t, o); } catch { return real.render(AGENTS[0].traits); }", pattern: "invalid traits|unknown mood" },
  goldenDrift: { render: 'return real.render(t, o).replace("</svg>\\n", "<!-- drift --></svg>\\n");', pattern: "golden" },
  badName: { render: "return real.render(t, o);", style: 'name: "Bad_Name"', pattern: "module shape" },
  shortDescription: { render: "return real.render(t, o);", style: 'description: "too short"', pattern: "module shape" },
  nonStringTitle: { render: "return real.render(t, o);", style: "title: 42", pattern: "module shape" },
  renderNotFunction: { render: "return real.render(t, o);", style: 'render: "nope"', pattern: "module shape" },
};

const agentsUrl = pathToFileURL(fileURLToPath(new URL("../../traits/agents.mjs", import.meta.url))).href;
const results = {};

function run(name, v) {
  const dir = mkdtempSync(join(tmpdir(), "edge62-contract-"));
  const file = join(dir, "wrapped.test.mjs");
  writeFileSync(
    file,
    `import { runStyleContract } from ${JSON.stringify(contractUrl)};
import { style as real } from ${JSON.stringify(stickerUrl)};
import { AGENTS } from ${JSON.stringify(agentsUrl)};
const style = { ...real, render(t, o) { ${v.render} }${v.style ? `, ${v.style}` : ""} };
runStyleContract(style);
`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT" && k !== "UPDATE_GOLDEN"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${v.pattern}`, file], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", (status) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      results[name] = { status, out };
      resolve();
    });
  });
}

before(async () => {
  await Promise.all(Object.entries(VARIANTS).map(([name, v]) => run(name, v)));
}, { timeout: 300000 });

const failedTests = (out) => [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);

test("a faithful wrapper of a real style passes every rule", () => {
  assert.equal(results.faithful.status, 0, results.faithful.out);
  assert.equal(failedTests(results.faithful.out).length, 0);
});

// [variant, expected failing test name fragment, message fragment shown in the failure]
const REJECTED = [
  ["oversize", "well-formed", "bytes"],
  ["script", "well-formed", null],
  ["href", "well-formed", null],
  ["remoteUrl", "well-formed", null],
  ["threeDecimals", "well-formed", null],
  ["undefinedText", "well-formed", null],
  ["duplicateId", "well-formed", "duplicate id"],
  ["unprefixedId", "well-formed", "lacks prefix"],
  ["danglingUrl", "well-formed", "dangling url(#nope)"],
  ["missingLayer", "well-formed", "layer rings"],
  ["unbalancedG", "well-formed", null],
  ["carriageReturn", "well-formed", null],
  ["noTrailingNewline", "well-formed", null],
  ["secondSvg", "well-formed", null],
  ["wrongTier", "rarity tier", null],
  ["wrongMoodAttr", "rarity tier", null],
  ["nonDeterministic", "deterministic", null],
  ["ignoresMood", "unknown mood", null],
  ["sameFaceForAllMoods", "distinct face", null],
  ["ignoresRole", "slot role", null],
  ["swallowsInvalidTraits", "invalid traits", null],
  ["ignoresDepth", "data-ring", null],
  ["goldenDrift", "golden", null],
  ["badName", "module shape", null],
  ["shortDescription", "module shape", null],
  ["nonStringTitle", "module shape", null],
  ["renderNotFunction", "module shape", null],
];

for (const [variant, testName, message] of REJECTED) {
  test(`rejects ${variant}: the "${testName}" check fails${message ? ` naming "${message}"` : ""}`, () => {
    const r = results[variant];
    assert.notEqual(r.status, 0, r.out);
    assert.ok(failedTests(r.out).some((n) => n.includes(testName)), `expected a failing "${testName}" test:\n${r.out}`);
    if (message) assert.ok(r.out.includes(message), `expected "${message}" in:\n${r.out}`);
  });
}

test("a violation only fails the checks it breaks: oversize does not fail unrelated structural tests", () => {
  const failed = failedTests(results.oversize.out);
  assert.ok(failed.length >= 1);
  assert.ok(failed.every((n) => n.includes("well-formed")), failed.join("\n"));
});
