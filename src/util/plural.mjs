// One place for "count + noun" text, so a count of 1 never reads "1 rounds".

/** "1 round", "2 rounds", "0 rounds". Pass `many` for irregular plurals ("summary", "summaries"). */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}
