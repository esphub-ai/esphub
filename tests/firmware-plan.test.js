import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { boardPlans, profiles } from "../scripts/firmware-plan.mjs";

test("board CI discovers a new directory and selects only affected tasks", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "esphub-board-plan-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const put = (path, data) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), data);
  };
  const addBoard = (id) => {
    const dir = "firmware/boards/" + id;
    put(dir + "/board.json", JSON.stringify({ chip: "esp32s3" }));
    put(
      dir + "/ci.json",
      JSON.stringify({ launcher: {}, micropython: {}, setup: {} }),
    );
    for (const kind of ["launcher", "micropython", "setup"])
      put(dir + "/" + kind + "/action.yml", "runs: { using: composite }");
  };
  const snapshot = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "-qm",
      "fixture",
    );
    return profiles(git("rev-parse", "HEAD"), cwd);
  };
  const options = { version: "1.1.9" };
  const select = (before, after) => {
    const releases = Object.fromEntries(
      Object.entries(before).map(([board, profile]) => [
        board,
        Object.fromEntries(
          Object.entries(profile.tasks).map(([kind, task]) => [
            kind,
            {
              fingerprint: task.fingerprint,
              tag: kind + "-v1.0.1",
              version: "1.0.1",
            },
          ]),
        ),
      ]),
    );
    const plans = boardPlans(before, after, releases, options);
    return Object.fromEntries(
      plans.map((p) => [p.board, p.jobs.map((j) => j.kind)]),
    );
  };
  git("init", "-q");
  addBoard("paper-color");
  addBoard("stopwatch");
  let before = snapshot();
  put("firmware/boards/stopwatch/launcher/board.c", "void board_init(void) {}");
  let after = snapshot();
  assert.deepEqual(select(before, after), { stopwatch: ["launcher", "setup"] });
  before = after;
  put(
    "firmware/boards/stopwatch/micropython/profile.json",
    '{"target":"upstream"}',
  );
  after = snapshot();
  assert.deepEqual(select(before, after), {
    stopwatch: ["micropython", "setup"],
  });
  before = after;
  put("firmware/boards/stopwatch/setup/action.yml", "new packaging recipe");
  after = snapshot();
  assert.deepEqual(select(before, after), { stopwatch: ["setup"] });
  before = after;
  const advDir = "firmware/boards/cardputer-adv";
  cpSync(new URL("../" + advDir, import.meta.url), join(cwd, advDir), {
    recursive: true,
  });
  after = snapshot();
  assert.deepEqual(select(before, after), {
    "cardputer-adv": ["launcher", "micropython", "setup"],
  });
  before = after;
  appendFileSync(
    join(cwd, advDir, "micropython/manifest.py"),
    "\n# test keyboard driver change\n",
  );
  after = snapshot();
  assert.deepEqual(select(before, after), {
    "cardputer-adv": ["micropython", "setup"],
  });
  before = after;
  put("firmware/components/okou_agent/src/sdk.c", "shared");
  after = snapshot();
  assert.deepEqual(
    Object.values(select(before, after)),
    Array(3).fill(["launcher", "micropython", "setup"]),
  );
  before = after;
  put("firmware/ble.defaults", "CONFIG_BT_ENABLED=y");
  after = snapshot();
  assert.deepEqual(
    Object.values(select(before, after)),
    Array(3).fill(["launcher", "micropython", "setup"]),
  );
  before = after;
  put("services/web/src/app.js", "website");
  put("firmware/boards/stopwatch/README.md", "guide");
  after = snapshot();
  assert.deepEqual(select(before, after), {});
  const released = Object.fromEntries(
    Object.entries(after).map(([name, p]) => [name, p.tasks]),
  );
  assert.deepEqual(
    boardPlans({}, after, released, { ...options, manual: true }),
    [],
  );
});
