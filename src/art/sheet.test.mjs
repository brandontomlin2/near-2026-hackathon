import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSheet } from "./sheet.mjs";
import { STYLES } from "./styles/index.mjs";
import { definedIds } from "./styles/contract.mjs";

for (const style of Object.values(STYLES)) {
  test(`sheet ${style.name}: unique ids, no dangling refs, one tile per agent x mood`, () => {
    const svg = renderSheet(style);
    const ids = definedIds(svg);
    assert.equal(new Set(ids).size, ids.length, "duplicate id in sheet");
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(m[1]), `dangling url(#${m[1]})`);
    assert.equal((svg.match(/<svg[ >]/g) ?? []).length, 1 + 4 * style.moods.length);
    assert.equal((svg.match(/<\/svg>/g) ?? []).length, 1 + 4 * style.moods.length);
  });
}
