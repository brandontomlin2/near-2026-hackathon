// Offline demo of the attestation consistency check. It builds the hand-made
// fixture report from src/privacy/fixture.mjs and prints the verdict. Nothing
// here comes from a live NEAR AI Cloud TEE, and no network call is made.
// Usage: npm run attest:check [-- --tamper]   (or: node scripts/attest-check.mjs [--tamper])
import { checkAttestation } from "../src/privacy/attestation.mjs";
import { mockAttestation, MOCK_MODEL } from "../src/privacy/fixture.mjs";

const USAGE = "usage: node scripts/attest-check.mjs [--tamper]";
const unknown = process.argv.slice(2).find((arg) => arg !== "--tamper");
if (unknown !== undefined) {
  // A typo such as --tampr must not quietly run the clean check and exit 0.
  console.error(`attest-check: unknown argument ${JSON.stringify(unknown)} (${USAGE})`);
  process.exit(2);
}

const FIXTURE_NOTICE ="Checking the bundled fixture attestation (src/privacy/fixture.mjs), not a live TEE report.";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hello" }] });
const { report, chatSignature } = mockAttestation({ requestBody });
if (process.argv.includes("--tamper")) report.model_attestations[0].signing_address = "0x00";
const result = checkAttestation(report, { requestBody, model: MOCK_MODEL, chatSignature });
console.log(`${FIXTURE_NOTICE}\n`);
for (const c of result.checks) console.log(`${c.status.padEnd(12)} ${c.id}: ${c.detail}`);
console.log(`\n${result.summary}\nNot verified:\n${result.notVerified.map((s) => `  - ${s}`).join("\n")}`);
process.exitCode = result.verdict === "reject" ? 1 : 0;
