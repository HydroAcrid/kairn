import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("npm binary distribution", () => {
  it("validates the public launcher and platform package metadata", () => {
    const output = execFileSync("node", ["scripts/release/validate-npm-packages.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(output).toContain("validation passed");
  });

  it("launcher delegates to a binary without downloading code", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-launcher-"));
    const fakeBinary = path.join(temp, "kairn");
    fs.writeFileSync(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  channel: process.env.KAIRN_INSTALL_CHANNEL,",
        "  target: process.env.KAIRN_BUILD_TARGET,",
        "  platformPackage: process.env.KAIRN_PLATFORM_PACKAGE,",
        "  launcherPackage: process.env.KAIRN_LAUNCHER_PACKAGE",
        "}));"
      ].join("\n")
    );
    fs.chmodSync(fakeBinary, 0o755);

    const result = execFileSync("node", ["packages/npm/kairn/bin/kairn.cjs", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, KAIRN_BINARY_PATH: fakeBinary }
    });
    const parsed = JSON.parse(result) as {
      args: string[];
      channel: string;
      target: string;
      platformPackage: string;
      launcherPackage: string;
    };

    expect(parsed.args).toEqual(["--version"]);
    expect(parsed.channel).toBe("npm-beta");
    expect(parsed.target).toBe(`${process.platform}-${process.arch}`);
    expect(parsed.platformPackage).toBe("KAIRN_BINARY_PATH");
    expect(parsed.launcherPackage).toBe("usekairn@0.1.2");
  });

  it("stages platform packages with checksums and validates them before pack", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-platform-"));
    const fakeBinary = path.join(temp, "kairn");
    const fakeAssets = path.join(temp, "assets");
    fs.writeFileSync(fakeBinary, "#!/usr/bin/env node\nconsole.log('0.1.2');\n");
    fs.chmodSync(fakeBinary, 0o755);
    fs.mkdirSync(path.join(fakeAssets, "better-sqlite3"), { recursive: true });
    fs.mkdirSync(path.join(fakeAssets, "web-tree-sitter"), { recursive: true });
    fs.mkdirSync(path.join(fakeAssets, "tree-sitter-wasms", "out"), { recursive: true });
    fs.writeFileSync(path.join(fakeAssets, "better-sqlite3", "better_sqlite3.node"), "sqlite");
    fs.writeFileSync(path.join(fakeAssets, "web-tree-sitter", "web-tree-sitter.wasm"), "core");
    fs.writeFileSync(path.join(fakeAssets, "tree-sitter-wasms", "out", "tree-sitter-typescript.wasm"), "grammar");

    execFileSync(
      "node",
      [
        "scripts/release/stage-platform-package.mjs",
        "--target",
        "linux-x64",
        "--binary",
        fakeBinary,
        "--assets",
        fakeAssets,
        "--out-dir",
        temp
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const stageDir = path.join(temp, "kairn-linux-x64");
    const stagedBinary = path.join(stageDir, "bin", "kairn");
    const checksums = fs.readFileSync(path.join(stageDir, "checksums.txt"), "utf8");
    const sha = crypto.createHash("sha256").update(fs.readFileSync(stagedBinary)).digest("hex");

    expect(checksums).toContain(sha);
    expect(checksums).toContain("bin/assets/better-sqlite3/better_sqlite3.node");
    expect(fs.existsSync(path.join(stageDir, "bin", "assets", "web-tree-sitter", "web-tree-sitter.wasm"))).toBe(true);
    const output = execFileSync("node", [path.resolve("scripts/release/validate-platform-package.mjs")], {
      cwd: stageDir,
      encoding: "utf8"
    });
    expect(output).toContain("validation passed");
    const packOutput = execFileSync("npm", ["pack", "--dry-run", stageDir], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(packOutput).toContain("usekairn-linux-x64-0.1.2.tgz");
  });

  it("rejects cross-target pkg binary builds because native assets are target-specific", () => {
    const impossibleTarget = process.platform === "linux" ? "darwin-arm64" : "linux-x64";
    const result = spawnSync("node", ["scripts/release/build-platform-binary.mjs", "--target", impossibleTarget], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        KAIRN_RELEASE_BINARY_PATH: "",
        KAIRN_BINARY_BUILD_COMMAND: ""
      }
    });

    const crossResult = spawnSync("node", ["scripts/release/build-pkg-binary.mjs", "--target", impossibleTarget], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(crossResult.status).not.toBe(0);
    expect(crossResult.stderr).toContain("must be built on matching host");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be built on matching host");
  });
});
