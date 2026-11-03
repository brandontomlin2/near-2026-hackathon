// Deterministic offline stand-in for the summarizer model.
//
// It parses the request built by buildSummaryMessages (src/memory/summarizer.mjs)
// and writes a first-person character sheet from the counts and names in the
// events. It only ever quotes a short clipped fragment of the agent's own
// latest post, never text from other agents, so instructions hidden in events
// are not echoed. Pure: same request, same sheet.
//
// The responder writes one section per line; the summarizer collapses
// whitespace, so the stored sheet is one line with "Label: ..." sections.
// Allies and grudges come from the tone of each exchange (warm or tense
// words), so they agree with what a reader sees in the channel.

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

// Tone of one exchange, read from the words used. Tense wins over warm.
const TENSE = /\b(nope|no|doubtful|not me|show me|source\?|dare|joke|bets against|flip the table|panics|do not add up|will not|unproven|gap)\b/i;
const WARM = /\b(glad|friends|happy to help|good point|warmly|connect|agree|together|whole group|hear from everyone)\b/i;
const toneOf = (text) => (TENSE.test(text) ? "tense" : WARM.test(text) ? "warm" : "neutral");

/**
 * Who this agent has traded words with: how often, and how many of those
 * exchanges were warm or tense. Counts carry forward from the previous sheet;
 * new ones come from mentions received and replies sent ("@Name ..."). Sorted
 * by count, then name, so ties break the same way every run.
 * @returns {[string, { total: number, warm: number, tense: number }][]}
 */
function interactions(previous, name, events) {
  const counts = new Map();
  const add = (who, total, warm, tense) => {
    const c = counts.get(who) ?? { total: 0, warm: 0, tense: 0 };
    counts.set(who, { total: c.total + total, warm: c.warm + warm, tense: c.tense + tense });
  };
  const addTone = (who, text) => {
    const tone = toneOf(String(text));
    add(who, 1, tone === "warm" ? 1 : 0, tone === "tense" ? 1 : 0);
  };
  const before = section(previous, "Relationships", "Grudges and allies");
  for (const [, who, n, warm, tense] of before.matchAll(/([A-Z][A-Za-z]*) (\d+) times? \((\d+) warm, (\d+) tense\)/g)) {
    add(who, Number(n), Number(warm), Number(tense));
  }
  for (const e of events) {
    if (e.kind === "mention" && e.from !== name) addTone(String(e.from), e.text);
    if (e.kind === "reply" && e.from === name) {
      const target = /@([A-Z][A-Za-z]*)/.exec(String(e.text))?.[1];
      if (target && target !== name) addTone(target, e.text);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
}

// The partner with the largest lead of `more` over `less`, if any has a lead.
function strongest(partners, more, less) {
  let best;
  for (const [who, c] of partners) {
    const lead = c[more] - c[less];
    if (lead > 0 && (!best || lead > best[1])) best = [who, lead];
  }
  return best?.[0];
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
  const ally = strongest(partners, "warm", "tense");
  const grudge = strongest(partners, "tense", "warm");

  const latest = own.at(-1);
  const priorBelief = /Running beliefs: I still hold to "([^"]*)"/.exec(previous)?.[1];
  const quote = latest ? clip(String(latest.text).replace(/^@[A-Za-z]+\s+/, "")) : priorBelief;

  const relationships = partners.length === 0
    ? "nobody has traded words with me yet"
    : `I have traded words with ${partners
      .map(([n, c]) => `${n} ${plural(c.total, "time", "times")} (${c.warm} warm, ${c.tense} tense)`)
      .join(", ")}`;
  const allies = [
    ally ? `${ally} is my ally` : "I have no ally yet",
    grudge ? `I hold a grudge against ${grudge}` : "I hold no grudges yet",
  ].join("; ");

  return [
    `Who I am: I am ${name}, a personality that lives in a shared channel with three other agents.`,
    `Relationships: ${relationships}.`,
    `Grudges and allies: ${allies}.`,
    `Running beliefs: ${quote ? `I still hold to "${quote}"` : "I have not settled on a belief yet"}.`,
    `Reputation: ${plural(posts, "post", "posts")}, ${plural(replies, "reply", "replies")}, mentioned ${plural(mentioned, "time", "times")}.`,
  ].join("\n");
}
