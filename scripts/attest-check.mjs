// Offline demo: build the synthetic attestation for a request and print the verdict.
// Usage: node scripts/attest-check.mjs [--tamper]
// Suggested package.json line: "attest:check": "node scripts/attest-check.mjs"
import { checkAttestation } from "../src/privacy/attestation.mjs";
import { mockAttestation, MOCK_MODEL } from "../src/privacy/fixture.mjs";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hello" }] });
const { report, chatSignature } = mockAttestation({ requestBody });
if (process.argv.includes("--tamper")) report.model_attestations[0].signing_address = "0x00";
const result = checkAttestation(report, { requestBody, model: MOCK_MODEL, chatSignature });
for (const c of result.checks) console.log(`${c.status.padEnd(12)} ${c.id}: ${c.detail}`);
console.log(`\n${result.summary}\nNot verified:\n${result.notVerified.map((s) => `  - ${s}`).join("\n")}`);
process.exitCode = result.verdict === "reject" ? 1 : 0;
