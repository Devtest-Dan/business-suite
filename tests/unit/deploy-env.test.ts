import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The deploy scripts' compose() wrapper: what is in /opt/business-suite/.env
 * is what the containers get, even when the caller's environment has the same
 * names. cloud-init exports its settings before running install.sh, and docker
 * compose lets the environment override --env-file, so on 0.1.1's first test
 * install the app got the published example setup code instead of the random
 * one install.sh had made and written to .env.
 *
 * Each script's env_unsets() and compose() are cut out and run in bash with a
 * stand-in `docker` that prints what it was given.
 */

const bash = spawnSync("bash", ["--version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "suite-deploy-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The text of a shell function: a one-line `name() { ...; }` or up to the closing `}` line. */
function cut(script: string, name: string): string {
  const lines = readFileSync(join(__dirname, "../../deploy", script), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`${name}() not found in deploy/${script}`);
  if (lines[start].trimEnd().endsWith("}")) return lines[start];
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

function run(script: string, args: string): string {
  writeFileSync(join(dir, ".env"), "SUITE_SETUP_CODE=random-code-from-env\nSUITE_TZ=Asia/Kolkata\nSUITE_VERSION=0.1.1\n");
  const docker = join(dir, "docker");
  writeFileSync(docker, '#!/usr/bin/env bash\necho "code=${SUITE_SETUP_CODE-unset} tz=${SUITE_TZ-unset} version=${SUITE_VERSION-unset} other=${OTHER-unset}"\n');
  chmodSync(docker, 0o755);
  const program = [
    `ENV_FILE='${dir.replace(/\\/g, "/")}/.env'`,
    "SUITE_HOME=/nowhere",
    `get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }`,
    cut(script, "env_unsets"),
    cut(script, "compose"),
    `compose ${args}`,
  ].join("\n");
  const out = spawnSync("bash", ["-c", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      // What cloud-init's `set -a; . business-suite-install.env` leaves behind.
      SUITE_SETUP_CODE: "choose-a-code-only-you-know",
      SUITE_TZ: "America/New_York",
      SUITE_VERSION: "9.9.9",
      OTHER: "kept",
    },
  });
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout.trim();
}

describe.skipIf(!bash)("deploy scripts: .env wins over the caller's environment", () => {
  it("install.sh", () => {
    expect(run("install.sh", "up -d")).toBe("code=unset tz=unset version=unset other=kept");
  });
  it("suite.sh", () => {
    expect(run("suite.sh", "ps")).toBe("code=unset tz=unset version=unset other=kept");
  });
  it("lib.sh (update and restore): SUITE_VERSION is the one asked for", () => {
    expect(run("lib.sh", "ps")).toBe("code=unset tz=unset version=0.1.1 other=kept");
    expect(run("lib.sh", "-v 0.1.0 ps")).toBe("code=unset tz=unset version=0.1.0 other=kept");
  });
});
