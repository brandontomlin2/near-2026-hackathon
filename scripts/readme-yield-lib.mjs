// Shared README extraction for the yield:demo tests. No dependencies.
//
// README format this relies on (see "Offline demo: `npm run yield:demo`" under
// "## Yield Optimizer"): numbered steps, each one line or one line plus indented
// "   - " sub-bullets that numberedSteps folds into it. In a step, the first
// backtick span is the command (or, for "Open", the file); every backtick span
// after the word "See" is a quoted output line. In the "Judge quick path" the
// quoted spans are every span after the first. Quotes are compared trimmed.
import { spawnSync } from "node:child_process";

const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

/** Text of the `## <title>` section (up to the next `## `), or "". */
export function section(readme, title) {
  const m = readme.match(new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1] : "";
}

/**
 * Numbered steps: [{ n, text }]. A step is its first line plus any directly following
 * indented continuation lines (2+ spaces, e.g. "   - sub-bullet"); each continuation has its
 * indent and leading "- " removed and is joined to the step text with one space. A line that
 * is not indented ends the step.
 */
export function numberedSteps(text) {
  return [...text.matchAll(/^(\d+)\. (.*(?:\n {2,}\S.*)*)$/gm)].map((m) => ({
    n: Number(m[1]),
    text: m[2].split("\n").map((l, i) => (i === 0 ? l : l.trim().replace(/^- /, ""))).join(" "),
  }));
}

/** The "Offline demo" subsection of "## Yield Optimizer": steps with command, kind and quotes. */
export function parseYieldDemo(readme) {
  const yieldSection = section(readme, "Yield Optimizer");
  const sub = yieldSection.match(/^### Offline demo[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
  const steps = numberedSteps(sub).map(({ n, text }) => {
    const [head, ...rest] = text.split(/ See /);
    const [command] = spans(head);
    const quotes = spans(rest.join(" See "));
    const kind = /^npm run yield:demo(\s|$)/.test(command ?? "") ? "run" : "file";
    return { n, command, kind, quotes };
  });
  return { text: sub, steps };
}

/** The "Judge quick path" step that runs `npm run yield:demo`: its command and quoted lines. */
export function parseQuickYieldStep(readme) {
  const quick = section(readme, "Judge quick path");
  for (const { text } of numberedSteps(quick)) {
    const [command, ...quotes] = spans(text);
    if (/^npm run yield:demo(\s|$)/.test(command ?? "")) return { command, quotes };
  }
  return null;
}

/** Counts quoted in the "## Yield Optimizer" section: cargo tests, the node test command and its pass count. */
export function parseYieldCounts(readme) {
  const y = section(readme, "Yield Optimizer");
  const cargo = y.match(/test result: ok\. (\d+) passed; 0 failed/);
  const nodeStep = numberedSteps(y).find((s) => /^Run `node --test /.test(s.text));
  const pass = nodeStep?.text.match(/`# pass (\d+)`/);
  return {
    cargoPassed: cargo ? Number(cargo[1]) : null,
    nodeCommand: nodeStep ? spans(nodeStep.text)[0] : null,
    nodePass: pass ? Number(pass[1]) : null,
  };
}

/** Map `npm run yield:demo [-- args]` to argv for `node scripts/yield-demo.mjs`. */
export function demoArgs(command) {
  const rest = command.replace(/^npm run yield:demo/, "").trim().replace(/^--\s*/, "");
  return rest ? rest.split(/\s+/) : [];
}

/** Lines of output, trimmed, for full-line comparison. */
export function trimmedLines(out) {
  return out.split(/\r?\n/).map((l) => l.trim());
}

/** Run a shell command with a timeout; returns { status, stdout, stderr, timedOut }. */
export function sh(command, { cwd, env, timeoutMs = 120_000 }) {
  const r = spawnSync("bash", ["-c", command], { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}
