import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson, sessionPaths } from "../src/store.mjs";

 test("session state paths are stable and isolated", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-store-"));
	const first = sessionPaths("session/a", root);
	const again = sessionPaths("session/a", root);
	const other = sessionPaths("session/b", root);
	assert.equal(first.directory, again.directory);
	assert.notEqual(first.directory, other.directory);
});

test("atomic state files are private", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jobs-private-"));
	const path = join(root, "nested", "state.json");
	atomicWriteJson(path, { ok: true });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: true });
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(join(root, "nested")).mode & 0o777, 0o700);
});
