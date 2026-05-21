import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTextFile } from "../src/retrieval/readSource.js";
import { commandInvocation, commandSpawnInvocation, splitCommandLine } from "../src/utils/command.js";

describe("command utilities", () => {
  it("splits quoted command lines without treating Windows path separators as escapes", () => {
    expect(splitCommandLine("\"C:\\Program Files\\nodejs\\node.exe\" \"dist/cli.js\" --version")).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "dist/cli.js",
      "--version"
    ]);
    expect(commandInvocation("node -e \"console.log(1)\"", ["--root", "repo path"])).toEqual({
      command: "node",
      args: ["-e", "console.log(1)", "--root", "repo path"]
    });
    expect(commandInvocation("C:\\Program Files\\nodejs\\node.exe", ["--version"], {
      exists: (filePath) => filePath === "C:\\Program Files\\nodejs\\node.exe"
    })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--version"]
    });
  });

  it("spawns Windows exe commands directly and cmd shims through cmd.exe", () => {
    const exe = commandSpawnInvocation(commandInvocation("\"C:\\Program Files\\nodejs\\node.exe\"", ["--version"]), {
      platform: "win32",
      exists: (filePath) => filePath === "C:\\Program Files\\nodejs\\node.exe"
    });
    expect(exe).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--version"]
    });

    const shim = commandSpawnInvocation(commandInvocation("codex", ["--version"]), {
      platform: "win32",
      envPath: "C:\\Users\\dev\\AppData\\Roaming\\npm",
      pathext: ".COM;.EXE;.BAT;.CMD",
      comspec: "cmd.exe",
      exists: (filePath) => filePath === "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD"
    });
    expect(shim).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", "\"C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD\" \"--version\""]
    });
  });
});

describe("root-contained file reads", () => {
  it("rejects symlink targets that resolve outside the repo root", () => {
    if (process.platform === "win32") return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = true;\n");
      fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));

      expect(() => readTextFile(root, "link.ts")).toThrow(/escapes root/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
