// Deterministic offline stand-in for the summarizer model.
//
// It parses the request built by buildSummaryMessages (src/memory/summarizer.mjs)
// and writes a first-person character sheet from the counts and names in the
// events. It only ever quotes a short clipped fragment of the agent's own
// latest post, never text from other agents, so instructions hidden in events
// are not echoed. Pure: same request, same sheet.
//
// The summarizer collapses whitespace, so the sections arrive on one line,
// separated by spaces. Each section is one sentence-ended label.

const MAX_QUOTE_WORDS = 12;

function nameFrom(request) {
  const system = request?.messages?.find((m) => m.role === "system")?.content ?? "";
  return /keep the character sheet for (.+?), an AI personality/.exec(system)?.[1] ?? "Agent";
}

function userText(request) {
  return request?.messages?.find((m) => m.role === "user")?.content ?? "";
}

function parseEvents(user) {
  const marker = "New events since the last sheet:\n";
  const start = user.indexOf(marker);
  if (start < 0) return [];
  const rest = user.slice(start + marker.length);
  const end = rest.indexOf("\n\nRewrite");
  try {
    const parsed = JSON.parse(end < 0 ? rest : rest.slice(0, end));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === "object") : [];
  } catch {
    return [];
  }
}

function parsePrevious(user) {
  const marker = "Previous sheet:\n";
  const start = user.indexOf(marker);
  if (start < 0) return "";
  const rest = user.slice(start + marker.length);
  const end = rest.indexOf("\n\nNew events since");
  const text = end < 0 ? rest : rest.slice(0, end);
  return text === "(none yet)" ? "" : text;
}

function clip(text, max = MAX_QUOTE_WORDS) {
  const words = String(text).replace(/["“”]/g, "").trim().split(/\s+/).filter(Boolean);
  const cut = words.slice(0, max).join(" ").replace(/[.!?,;:]+$/, "");
  return words.length > max ? `${cut}...` : cut;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Text of one "Label: ..." section of a one-line sheet, up to the next label.
function section(sheet, label, next) {
  const start = sheet.indexOf(`${label}: `);
  if (start < 0) return "";
  const rest = sheet.slice(start + label.length + 2);
  const end = next ? rest.indexOf(` ${next}: `) : -1;
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Who this agent has traded words with, and how often, carried forward from
 * the previous sheet: mentions received plus replies sent ("@Name ...").
 * Sorted by count, then name, so ties break the same way every run.
 */
function interactions(previous, name, events) {
  const counts = new Map();
  const add = (who, n = 1) => counts.set(who, (counts.get(who) ?? 0) + n);
  const before = section(previous, "Relationships", "Grudges and allies");
  for (const [, who, n] of before.matchAll(/([A-Z][A-Za-z]*) (\d+) times?/g)) add(who, Number(n));
  for (const e of events) {
    if (e.kind === "mention" && e.from !== name) add(String(e.from));
    if (e.kind === "reply" && e.from === name) {
      const target = /@([A-Z][A-Za-z]*)/.exec(String(e.text))?.[1];
      if (target && target !== name) add(target);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * @param {{ messages: { role: string, content: string }[] }} request
 * @param {string} [_hash] unused; the sheet depends only on the request text
 * @returns {string}
 */
export function sheetResponder(request, _hash) {
  const name = nameFrom(request);
  const user = userText(request);
  const events = parseEvents(user);
  const previous = parsePrevious(user);

  const own = events.filter((e) => e.from === name && (e.kind === "post" || e.kind === "reply"));
  const mentions = events.filter((e) => e.kind === "mention" && e.from !== name).length;
  const prior = /Reputation: (\d+) posts?, (\d+) repl(?:y|ies), mentioned (\d+) times?/.exec(previous);
  const posts = own.filter((e) => e.kind === "post").length + (prior ? Number(prior[1]) : 0);
  const replies = own.filter((e) => e.kind === "reply").length + (prior ? Number(prior[2]) : 0);
  const mentioned = mentions + (prior ? Number(prior[3]) : 0);

  const partners = interactions(previous, name, events);
  const ally = partners[0];
  const distant = partners.length > 1 && partners.at(-1)[1] < ally[1] ? partners.at(-1) : undefined;

  const latest = own.at(-1);
  const priorBelief = /Running beliefs: I still hold to "([^"]*)"/.exec(previous)?.[1];
  const quote = latest ? clip(String(latest.text).replace(/^@[A-Za-z]+\s+/, "")) : priorBelief;

  const relationships = partners.length === 0
    ? "nobody has traded words with me yet"
    : `I have traded words with ${partners.map(([n, c]) => `${n} ${plural(c, "time", "times")}`).join(", ")}`;
  const allies = ally
    ? `${ally[0]} is my closest ally${distant ? `; ${distant[0]} is the one I keep at a distance` : ""}`
    : "I have no allies yet";

  return [
    `Who I am: I am ${name}, a personality that lives in a shared channel with three other agents.`,
    `Relationships: ${relationships}.`,
    `Grudges and allies: ${allies}.`,
    `Running beliefs: ${quote ? `I still hold to "${quote}"` : "I have not settled on a belief yet"}.`,
    `Reputation: ${plural(posts, "post", "posts")}, ${plural(replies, "reply", "replies")}, mentioned ${plural(mentioned, "time", "times")}.`,
  ].join("\n");
}
