// Offline demo of the attestation consistency check. It builds the hand-made
// fixture report from src/privacy/fixture.mjs and prints the verdict. Nothing
// here comes from a live NEAR AI Cloud TEE, and no network call is made.
// Usage: npm run attest:check [-- --tamper | --unreadable-quote]
// Exit 0: consistent, binding confirmed. 1: reject. 2: consistent but the quote was too short (truncated hex) to hold report data.
// --unreadable-quote swaps in a 2-byte hex quote. A non-hex quote is a REJECT (exit 1), not exit 2.
import { checkAttestation } from "../src/privacy/attestation.mjs";
import { mockAttestation, MOCK_MODEL, TAMPERED_ADDRESS } from "../src/privacy/fixture.mjs";

const FIXTURE_NOTICE ="Checking the bundled fixture attestation (src/privacy/fixture.mjs), not a live TEE report.";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hello" }] });
const { report, chatSignature } = mockAttestation({ requestBody });
if (process.argv.includes("--tamper")) report.model_attestations[0].signing_address = TAMPERED_ADDRESS;
if (process.argv.includes("--unreadable-quote")) report.model_attestations[0].intel_quote = "abcd";
const result = checkAttestation(report, { requestBody, model: MOCK_MODEL, chatSignature });
console.log(`${FIXTURE_NOTICE}\n`);
for (const c of result.checks) console.log(`${c.status.padEnd(12)} ${c.id}: ${c.detail}`);
console.log(`\n${result.summary}\nNot verified:\n${result.notVerified.map((s) => `  - ${s}`).join("\n")}`);
process.exitCode = result.verdict === "reject" ? 1 : result.unverifiable.length > 0 ? 2 : 0;
