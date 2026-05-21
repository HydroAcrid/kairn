import fs from "node:fs";
import path from "node:path";

export type CommandInvocation = {
  command: string;
  args: string[];
};

export type SpawnCommandInvocation = CommandInvocation;

type SpawnCommandOptions = {
  platform?: NodeJS.Platform | undefined;
  envPath?: string | undefined;
  pathext?: string | undefined;
  cwd?: string | undefined;
  comspec?: string | undefined;
  exists?: ((filePath: string) => boolean) | undefined;
};

type CommandInvocationOptions = {
  exists?: ((filePath: string) => boolean) | undefined;
};

export function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]!;
    const next = commandLine[index + 1];

    if (quote && char === "\\" && next === quote) {
      current += next;
      index += 1;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

export function commandInvocation(commandLine: string, args: string[] = [], options: CommandInvocationOptions = {}): CommandInvocation {
  const trimmed = commandLine.trim();
  if (!trimmed) throw new Error("Command cannot be empty.");
  const exists = options.exists ?? fs.existsSync;
  if (exists(trimmed)) {
    return { command: trimmed, args };
  }

  const parts = splitCommandLine(trimmed);
  const command = parts[0];
  if (!command) throw new Error("Command cannot be empty.");
  return {
    command,
    args: [...parts.slice(1), ...args]
  };
}

export function commandSpawnInvocation(invocation: CommandInvocation, options: SpawnCommandOptions = {}): SpawnCommandInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return invocation;

  const command = resolveWindowsCommand(invocation.command, options) ?? invocation.command;
  const extension = path.win32.extname(command).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command, args: invocation.args };
  }

  return {
    command: options.comspec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", [quoteWindowsCmdArg(command), ...invocation.args.map(quoteWindowsCmdArg)].join(" ")]
  };
}

function resolveWindowsCommand(command: string, options: SpawnCommandOptions): string | undefined {
  const exists = options.exists ?? fs.existsSync;
  const hasPathSeparator = /[\\/]/.test(command);
  const candidates = windowsCommandCandidates(command, options.pathext);

  if (hasPathSeparator || path.win32.isAbsolute(command)) {
    const base = path.win32.isAbsolute(command) ? command : path.win32.resolve(options.cwd ?? process.cwd(), command);
    for (const candidate of windowsCommandCandidates(base, options.pathext)) {
      if (exists(candidate)) return candidate;
    }
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
    return undefined;
  }

  const pathDelimiter = options.platform === "win32" ? ";" : path.delimiter;
  const pathEntries = (options.envPath ?? process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const absolute = path.win32.join(entry, candidate);
      if (exists(absolute)) return absolute;
    }
  }
  return undefined;
}

function windowsCommandCandidates(command: string, pathext = process.env.PATHEXT): string[] {
  if (path.win32.extname(command)) return [command];
  const extensions = (pathext ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`)];
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
