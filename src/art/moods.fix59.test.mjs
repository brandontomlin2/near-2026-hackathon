import { test } from "node:test";
import assert from "node:assert/strict";
import { assertMood } from "./moods.mjs";

function rejects(value) {
  assert.throws(
    () => assertMood(value),
    (err) => err instanceof Error && !(err instanceof TypeError) && /unknown mood/.test(err.message),
  );
}

test("assertMood: null-prototype object gives the unknown-mood Error, not a TypeError", () => {
  rejects(Object.create(null));
});

test("assertMood: object whose toString throws gives the unknown-mood Error", () => {
  rejects({ toString() { throw new Error("boom"); } });
});

test("assertMood: revoked proxy gives the unknown-mood Error", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  rejects(proxy);
});

test("assertMood: label format for strings, numbers and symbols is unchanged", () => {
  assert.throws(() => assertMood("nope"), { message: "unknown mood: nope" });
  assert.throws(() => assertMood(42), { message: "unknown mood: 42" });
  assert.throws(() => assertMood(Symbol("hype")), { message: "unknown mood: Symbol(hype)" });
});
