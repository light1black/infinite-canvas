import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCorsOrigin } from "./cors-policy.js";

test("CORS policy accepts health/preflight without credentials", () => {
    assert.deepEqual(evaluateCorsOrigin(undefined, [], false), { allowed: true, origins: [] });
    assert.deepEqual(evaluateCorsOrigin("http://localhost:3000", [], false, true), { allowed: true, origins: [] });
});

test("CORS policy records a token-authorized origin without network access", () => {
    assert.deepEqual(evaluateCorsOrigin("http://localhost:3000", [], true), { allowed: true, origins: ["http://localhost:3000"] });
    assert.deepEqual(evaluateCorsOrigin("http://localhost:3000", ["http://localhost:3000"], false), { allowed: true, origins: ["http://localhost:3000"] });
});

test("CORS policy rejects an unknown origin without a valid token", () => {
    assert.deepEqual(evaluateCorsOrigin("https://untrusted.invalid", [], false), { allowed: false, origins: [] });
});
