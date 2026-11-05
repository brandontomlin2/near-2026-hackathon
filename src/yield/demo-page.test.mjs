// The yield demo page, rendered from a real runDemo result.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { escapeHtml } from "../viewer/render.mjs";
import { DEFAULT_SNAPSHOT } from "../../scripts/yield-optimizer.mjs";
import { loadSnapshot } from "../yield-optimizer/snapshot.mjs";
import { renderDemoPage } from "./demo-page.mjs";
import { runDemo } from "./demo.mjs";

const NOTICE = "DRY RUN: mock inference, committed fixtures, nothing was signed or sent.";

describe("renderDemoPage", () => {
  let result;
  let html;
  before(async () => {
    result = await runDemo({ rhea: loadSnapshot(DEFAULT_SNAPSHOT), rheaSource: "src/yield-optimizer/fixtures/rhea-testnet-snapshot.json" });
    html = renderDemoPage(result);
  });

  it("is a complete page with the title, the DRY RUN notice and the snapshot line", () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<h1>Yield vault demo \(dry run\)<\/h1>/);
    assert.ok(html.includes(`<p class="dry">${NOTICE}</p>`));
    assert.ok(html.includes(`Ref pools at block ${result.doc.snapshots.ref_pools.block_height}`));
    assert.ok(html.includes(`Rhea snapshot taken ${result.doc.snapshots.rhea.taken_at}`));
    // What the rules did comes first; the per-agent config tables are folded at the end.
    assert.ok(html.indexOf("Agent proposals") < html.indexOf("Rejected by the on-chain rules"));
    assert.ok(html.indexOf("Rejected by the on-chain rules") < html.indexOf("Unsigned calls"));
    assert.ok(html.indexOf("Unsigned calls") < html.indexOf("<details><summary><h2>Vault config</h2>"));
    assert.ok(!/ style=/.test(html), "no inline style attributes (the CSP only allows the hashed <style>)");
  });

  it("shows the vault config: ids, limits and price floors, labelled as placeholders", () => {
    const pa = result.doc.personality_agents;
    assert.ok(html.includes(`<code>${pa.vault_id}</code>`) && html.includes(`<code>${pa.runner_id}</code>`));
    assert.match(html, /placeholder ids, not deployed accounts/);
    const cfg = pa.configs.aloof;
    for (const l of cfg.limits) assert.ok(html.includes(`<td>${l.max_trade}</td><td>${l.daily_cap}</td>`), l.token_id);
    const floor = cfg.allowed_pools[0].min_rate_a_to_b;
    assert.ok(html.includes(`${floor.num}/${floor.den}`));
    assert.ok(html.includes(`<code>${result.doc.planner_vault.vault_id}</code>`));
  });

  it("lists all five agents and the planner's REFUSED candidates", () => {
    for (const id of ["aloof", "chaotic", "social", "skeptic", "yield-optimizer"]) assert.ok(html.includes(`<td class="who">${id}<`), id);
    assert.ok(html.includes("REFUSED ERR_NO_LIMIT: no limit for dai.fixture.testnet"));
    assert.ok(html.includes("REFUSED ERR_POOL_NOT_ALLOWED: pool 99"));
    assert.match(html, /vetoed by skeptic/);
  });

  it("shows every contract message in code, with the vectors file", () => {
    const rs = result.doc.rule_scenarios;
    assert.equal(rs.scenarios.length, 4);
    for (const s of rs.scenarios) assert.ok(html.includes(`<code class="bad">${escapeHtml(s.contract_message)}</code>`), s.id);
    assert.ok(html.includes(rs.source));
    assert.match(html, /spent today 1501/);
    assert.match(html, /vault paused/);
  });

  it("shows each unsigned call and the totals line", () => {
    assert.equal(result.calls.calls.length, 4);
    assert.equal((html.match(/<code>execute_swap<\/code>/g) ?? []).length, 4);
    assert.equal((html.match(/signed: false/g) ?? []).length, 4);
    assert.equal((html.match(/sent: false/g) ?? []).length, 4);
    assert.ok(html.includes("4 unsigned execute_swap calls planned, 0 signed, 0 sent"));
    for (const c of result.calls.calls) assert.ok(html.includes(escapeHtml(JSON.stringify(c.args, null, 2))), c.agent);
  });

  it("has no script and no absolute URL anywhere", () => {
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /\b(?:src|href)=/i);
    assert.match(html, /Content-Security-Policy/);
  });

  it("escapes run values", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const doc = structuredClone(result.doc);
    doc.agents[0].summary = evil;
    doc.agents[1].veto = { by: evil, reason: evil };
    doc.agents[4].candidates[1].rule_check.reason = evil;
    doc.rule_scenarios.scenarios[0].contract_message = evil;
    doc.personality_agents.configs.aloof.limits[0].token_id = evil;
    const out = renderDemoPage({ doc, calls: result.calls });
    assert.ok(!out.includes(evil));
    assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.doesNotMatch(out, /<img/);
  });

  it("is deterministic", () => {
    assert.equal(renderDemoPage(result), html);
  });
});

