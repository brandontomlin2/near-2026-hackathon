// Strict parsing of a model reply into a swap proposal (or a skeptic review).
// The reply must be exactly one JSON object and nothing else: no code fence, no prose,
// no extra or missing keys, exact types. Amounts are decimal integer strings without
// leading zeros that fit a u128. Anything else throws a ProposalError with a stable code.

import { isValidAccountId } from "../anchor/anchor.mjs";
import { U128_MAX } from "./pools.mjs";

export const PROPOSAL_KEYS = ["pool_id", "token_in", "token_out", "amount_in", "min_amount_out", "rationale"];
export const VAULT_PROPOSAL_KEYS = PROPOSAL_KEYS.filter((k) => k !== "rationale");
export const REVIEW_KEYS = ["vetoes", "hedge"];
export const MAX_RATIONALE_CHARS = 280;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

export class ProposalError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ProposalError";
    this.code = code;
  }
}

function parseObject(text) {
  if (typeof text !== "string") throw new ProposalError("not_json", "reply is not a string");
  const t = text.trim();
  if (t === "") throw new ProposalError("not_json", "reply is empty");
  if (t.startsWith("```") || t.includes("```")) throw new ProposalError("code_fence", "reply contains a markdown code fence; strict JSON only");
  if (t[0] !== "{" || t[t.length - 1] !== "}") {
    throw new ProposalError(t.includes("{") ? "extra_text" : "not_json", "reply must be exactly one JSON object with no text around it");
  }
  let value;
  try {
    value = JSON.parse(t);
  } catch {
    throw new ProposalError("not_json", "reply is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProposalError("not_object", "reply must be a JSON object");
  return value;
}

function checkKeys(obj, keys, what) {
  for (const k of keys) {
    if (!Object.hasOwn(obj, k)) throw new ProposalError("missing_key", `${what} is missing key ${k}`);
  }
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) throw new ProposalError("extra_key", `${what} has unexpected key ${JSON.stringify(k).slice(0, 40)}`);
  }
}

function checkAmount(value, key) {
  if (typeof value !== "string") throw new ProposalError("bad_type", `${key} must be a decimal string`);
  if (!AMOUNT_RE.test(value)) throw new ProposalError("bad_amount", `${key} must be a decimal integer string without leading zeros`);
  if (BigInt(value) > U128_MAX) throw new ProposalError("bad_amount", `${key} does not fit a u128`);
}

function checkProposalObject(obj, what) {
  checkKeys(obj, PROPOSAL_KEYS, what);
  if (!Number.isSafeInteger(obj.pool_id) || obj.pool_id < 0) throw new ProposalError("bad_type", "pool_id must be a non-negative integer");
  for (const key of ["token_in", "token_out"]) {
    if (typeof obj[key] !== "string") throw new ProposalError("bad_type", `${key} must be a string`);
    if (!isValidAccountId(obj[key])) throw new ProposalError("bad_type", `${key} must be a valid NEAR account id`);
  }
  checkAmount(obj.amount_in, "amount_in");
  checkAmount(obj.min_amount_out, "min_amount_out");
  if (typeof obj.rationale !== "string") throw new ProposalError("bad_type", "rationale must be a string");
  if (obj.rationale.trim() === "" || obj.rationale.length > MAX_RATIONALE_CHARS) {
    throw new ProposalError("bad_type", `rationale must be 1-${MAX_RATIONALE_CHARS} characters`);
  }
  return Object.fromEntries(PROPOSAL_KEYS.map((k) => [k, obj[k]]));
}

/**
 * @param {string} text model reply
 * @returns {{ pool_id: number, token_in: string, token_out: string, amount_in: string, min_amount_out: string, rationale: string }}
 */
export function parseProposal(text) {
  return checkProposalObject(parseObject(text), "proposal");
}

/**
 * A skeptic reply: { "vetoes": [{ "agent": id, "reason": string }], "hedge": proposal | null }.
 * @param {string} text
 * @param {string[]} agentIds ids a veto may name
 */
export function parseReview(text, agentIds) {
  const obj = parseObject(text);
  checkKeys(obj, REVIEW_KEYS, "review");
  if (!Array.isArray(obj.vetoes)) throw new ProposalError("bad_type", "vetoes must be an array");
  const vetoes = obj.vetoes.map((v, i) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ProposalError("bad_type", `vetoes[${i}] must be an object`);
    checkKeys(v, ["agent", "reason"], `vetoes[${i}]`);
    if (typeof v.agent !== "string" || !agentIds.includes(v.agent)) throw new ProposalError("bad_type", `vetoes[${i}].agent must be one of ${agentIds.join(", ")}`);
    if (typeof v.reason !== "string" || v.reason.trim() === "" || v.reason.length > MAX_RATIONALE_CHARS) {
      throw new ProposalError("bad_type", `vetoes[${i}].reason must be 1-${MAX_RATIONALE_CHARS} characters`);
    }
    return { agent: v.agent, reason: v.reason };
  });
  let hedge = null;
  if (obj.hedge !== null) {
    if (typeof obj.hedge !== "object" || Array.isArray(obj.hedge)) throw new ProposalError("bad_type", "hedge must be a proposal object or null");
    hedge = checkProposalObject(obj.hedge, "hedge");
  }
  return { vetoes, hedge };
}

/** The args object execute_swap takes: the proposal without the rationale. */
export function vaultArgs(proposal) {
  return { proposal: Object.fromEntries(VAULT_PROPOSAL_KEYS.map((k) => [k, proposal[k]])) };
}
