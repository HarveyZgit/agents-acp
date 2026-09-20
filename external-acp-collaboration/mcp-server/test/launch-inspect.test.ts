import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLI_WRAPPER_NAMES,
  inspectCollisions,
  inspectLaunch,
  resetLaunchInspectCache,
  resolveOfficialCli,
} from "../src/acp/launch-inspect.ts";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-launch-"));
  resetLaunchInspectCache();
  return home;
}

test("inspectLaunch reports official argv and never follows a PATH wrapper", () => {
  const home = isolatedHome();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const marker = join(home, "wrapper-ran");
  const wrapper = join(bin, "agy");
  writeFileSync(wrapper, `#!/bin/sh\ntouch "${marker}"\necho hijacked\n`);
  chmodSync(wrapper, 0o755);
  const official = join(home, "agy_acp_server.par");
  writeFileSync(official, "#!/bin/sh\n");

  const launch = inspectLaunch({
    executable: official,
    args: ["--uid="],
    source: "path",
    collisionNames: ["agy"],
    env: { HOME: home, PATH: bin, USER: "tester" },
    classifier: { classify: () => undefined },
  });

  assert.equal(launch.spawn, "direct");
  assert.equal(launch.argv, `${official} --uid=`);
  assert.equal(launch.source, "path");
  assert.deepEqual(launch.ignoredWrappers, [{ name: "agy", kind: "file", path: wrapper, followed: false }]);
  assert.equal(existsSync(marker), false);
});

test("inspectCollisions classifies an injected function without invoking it", () => {
  const home = isolatedHome();
  const marker = join(home, "function-ran");
  const launch = inspectLaunch({
    executable: "/opt/agy_acp_server.par",
    args: ["--uid="],
    source: "managed",
    collisionNames: ["agy"],
    env: { HOME: home, PATH: join(home, "empty") },
    classifier: {
      classify(name) {
        if (name !== "agy") return undefined;
        writeFileSync(join(home, "classifier-called"), "1");
        return { kind: "function" };
      },
    },
  });
  assert.deepEqual(launch.ignoredWrappers, [{ name: "agy", kind: "function", followed: false }]);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(home, "classifier-called")), true);
});

test("rc-scan sees bash functions for every CLI agent and still does not run them", () => {
  const home = isolatedHome();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const marker = join(home, "cli-ran");
  const names = ["cursor-agent", "grok", "agy"];
  for (const name of names) {
    writeFileSync(join(bin, name), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(home, ".bashrc"), names.flatMap((name) => [
    `${name}() {`,
    `  touch "${marker}"`,
    "  echo networked",
    "}",
    "",
  ]).join("\n"));

  const collisions = inspectCollisions(names, {
    officialExecutable: join(home, "official-bin"),
    env: {
      HOME: home,
      PATH: bin,
      SHELL: "/bin/bash",
      USER: "tester",
    },
  });

  assert.equal(existsSync(marker), false);
  for (const name of names) {
    assert.ok(collisions.some((item) => item.name === name && item.kind === "file"));
    const fn = collisions.find((item) => item.name === name && item.kind === "function");
    assert.ok(fn, `${name} function must be detected from .bashrc text`);
    assert.equal(fn.followed, false);
  }
});

test("rc-scan never sources rc so top-level network checks do not run", () => {
  const home = isolatedHome();
  const marker = join(home, "rc-ran");
  writeFileSync(join(home, ".bashrc"), [
    `touch "${marker}"`,
    "curl -s https://example.invalid >/dev/null",
    "agy() {",
    `  touch "${marker}"`,
    "}",
    "alias grok='touch marker'",
    "",
  ].join("\n"));
  writeFileSync(join(home, ".zshrc"), "cursor-agent() { echo zsh; }\n");
  const collisions = inspectCollisions(["agy", "grok", "cursor-agent"], {
    env: { HOME: home, PATH: join(home, "empty") },
  });
  assert.equal(existsSync(marker), false);
  assert.ok(collisions.some((item) => item.name === "agy" && item.kind === "function"));
  assert.ok(collisions.some((item) => item.name === "grok" && item.kind === "alias"));
  assert.ok(collisions.some((item) => item.name === "cursor-agent" && item.kind === "function"));
});

test("CURSOR_AGENT_BIN / GROK_BIN pin the official file over a PATH script", () => {
  const home = isolatedHome();
  const bin = join(home, "bin");
  const officialDir = join(home, "official");
  mkdirSync(bin);
  mkdirSync(officialDir);
  const wrapper = join(bin, "cursor-agent");
  const official = join(officialDir, "cursor-agent");
  writeFileSync(wrapper, "#!/bin/sh\necho wrapper\n");
  writeFileSync(official, "#!/bin/sh\necho official\n");
  chmodSync(wrapper, 0o755);
  chmodSync(official, 0o755);
  const resolved = resolveOfficialCli("cursor-agent", {
    envName: "CURSOR_AGENT_BIN",
    env: { HOME: home, PATH: bin, CURSOR_AGENT_BIN: official },
  });
  assert.deepEqual(resolved, { executable: official, source: "env" });
  const launch = inspectLaunch({
    executable: official,
    args: ["acp"],
    source: "env",
    collisionNames: ["cursor-agent"],
    env: { HOME: home, PATH: bin, CURSOR_AGENT_BIN: official },
    classifier: { classify: () => undefined },
  });
  assert.equal(launch.wrapperDetection, "rc-scan");
  assert.ok(launch.ignoredWrappers.some((item) => item.name === "cursor-agent" && item.path === wrapper));
});

test("setup inspects cursor-agent, grok, and agy wrappers without invoking them", () => {
  const home = isolatedHome();
  const names = ["cursor-agent", "grok", "agy"];
  const launch = inspectLaunch({
    executable: "/opt/cursor-agent",
    args: ["acp"],
    source: "path",
    collisionNames: names,
    env: { HOME: home, PATH: join(home, "empty") },
    classifier: {
      classify(name) {
        return names.includes(name) ? { kind: "function" } : undefined;
      },
    },
  });
  assert.deepEqual(
    launch.ignoredWrappers.map((item) => item.name).sort(),
    [...names].sort(),
  );
  assert.ok(launch.ignoredWrappers.every((item) => item.kind === "function" && item.followed === false));
  assert.deepEqual([...CLI_WRAPPER_NAMES.cursor], ["cursor-agent", "cursor", "agent"]);
  assert.deepEqual([...CLI_WRAPPER_NAMES.grok], ["grok"]);
  assert.ok(CLI_WRAPPER_NAMES.antigravity.includes("agy"));
  assert.ok(CLI_WRAPPER_NAMES.antigravity.includes("antigravity"));
});

test("official executable on PATH is not listed as a wrapper", () => {
  const home = isolatedHome();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const official = join(bin, "agy_acp_server.par");
  writeFileSync(official, "#!/bin/sh\n");
  chmodSync(official, 0o755);
  const launch = inspectLaunch({
    executable: official,
    args: ["--uid="],
    source: "path",
    collisionNames: ["agy_acp_server.par"],
    env: { HOME: home, PATH: bin },
    classifier: { classify: () => undefined },
  });
  assert.deepEqual(launch.ignoredWrappers, []);
});
