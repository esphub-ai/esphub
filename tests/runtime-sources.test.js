import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Release naming, repository layout and source links belong to the firmware publisher,
// which records them in Neon. The Hub runtime must not depend on GitHub.
test("the Hub runtime has no knowledge of GitHub", () => {
  const files = ["services/api/src", "shared"].flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name)));
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /github/i, file);
  }
});
