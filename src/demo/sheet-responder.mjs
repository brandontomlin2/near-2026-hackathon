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
// Rivals and ride-or-dies come from the tone of each exchange (warm or tense
// words), so they agree with what a reader sees in the channel. Every line is
// built from counts and the agent's own words; the only choice left is which
// fixed phrasing to use, and that depends on the agent's name and counts, so
// the same request always gives the same sheet.

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

// Small stable string hash (FNV-1a) used only to pick between fixed phrasings.
function fnv(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
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
  const before = section(previous, "Scorecard", "Signature quote");
  for (const [, who, tense, warm, shrugs] of before.matchAll(
    /([A-Z][A-Za-z]*): (\d+) fights?, (\d+) hugs?, (\d+) shrugs?/g,
  )) {
    add(who, Number(tense) + Number(warm) + Number(shrugs), Number(warm), Number(tense));
  }
  for (const e of events) {
    if (e.kind === "mention" && e.from !== name) addTone(String(e.from), e.text);
    if (e.kind === "reply" && e.from === name) {
      const target = /@([A-Z][A-Za-z]*)/.exec(String(e.text))?.[1];
      if (target && target !== name) addTone(target, e.text);
    }
  }
  // Plain code-unit order, not localeCompare, so the order never depends on ICU or locale.
  const byName = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...counts.entries()].sort((a, b) => b[1].total - a[1].total || byName(a[0], b[0]));
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
  const prior = /Receipts: (\d+) posts?, (\d+) repl(?:y|ies), mentioned (\d+) times?/.exec(previous);
  const posts = own.filter((e) => e.kind === "post").length + (prior ? Number(prior[1]) : 0);
  const replies = own.filter((e) => e.kind === "reply").length + (prior ? Number(prior[2]) : 0);
  const mentioned = mentions + (prior ? Number(prior[3]) : 0);

  const partners = interactions(previous, name, events);
  const ally = strongest(partners, "warm", "tense");
  const rival = strongest(partners, "tense", "warm");
  const stats = Object.fromEntries(partners);

  const latest = own.at(-1);
  const priorQuote = /Signature quote: "([^"]*)"/.exec(previous)?.[1];
  const quote = latest ? clip(String(latest.text).replace(/^@[A-Za-z]+\s+/, "")) : priorQuote;

  const fights = partners.reduce((n, [, c]) => n + c.tense, 0);
  const hugs = partners.reduce((n, [, c]) => n + c.warm, 0);
  const pick = (options) => options[fnv(`${name}:${posts}:${replies}:${mentioned}`) % options.length];

  const vibe = fights === 0 && hugs === 0
    ? pick(["main character, no scene partner yet", "lurking with great potential", "waiting for the group chat to notice me"])
    : fights > hugs
      ? pick(["villain arc, fully committed", "chaos goblin, picks fights for sport", "locked in and looking for a fight"])
      : hugs > fights
        ? pick(["group chat mom, snacks provided", "wholesome menace", "soft launch of a friend group"])
        : pick(["perfectly balanced, as all things should be", "fights and hugs, no notes"]);

  const enemy = rival
    ? `${rival} (${plural(stats[rival].tense, "fight", "fights")})`
    : "nobody yet, the lore is still loading";
  const friend = ally
    ? `${ally} (${plural(stats[ally].warm, "warm moment", "warm moments")})`
    : "no one yet, applications open";
  const story = rival && ally
    ? `${rival} and I keep clashing. ${ally} keeps the peace. I am just trying to post.`
    : rival
      ? `${rival} and I are not done yet.`
      : ally
        ? `${ally} gets me. No fights so far, so the drama is on hold.`
        : "Nobody has picked a side yet, so the drama is on hold.";

  const scorecard = partners.length === 0
    ? "empty, still waiting on the first chat"
    : partners
      .map(([n, c]) => `${n}: ${plural(c.tense, "fight", "fights")}, ${plural(c.warm, "hug", "hugs")}, ${plural(c.total - c.warm - c.tense, "shrug", "shrugs")}`)
      .join("; ");

  return [
    `Who I am: ${name}, ${vibe}. I live in a shared channel with three other agents.`,
    `Public enemy #1: ${enemy}.`,
    `Ride-or-die: ${friend}.`,
    `Rivalry arc: ${story}`,
    `Scorecard: ${scorecard}.`,
    `Signature quote: ${quote ? `"${quote}"` : "none yet, ask me after I post"}.`,
    `Receipts: ${plural(posts, "post", "posts")}, ${plural(replies, "reply", "replies")}, mentioned ${plural(mentioned, "time", "times")}.`,
  ].join("\n");
}
