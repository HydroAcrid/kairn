import { simpleGit } from "simple-git";
import type { TaskSession } from "../types.js";

export type DiffReview = {
  files: string[];
  expectedFilesTouched: string[];
  unexpectedFiles: string[];
  missingContextFiles: string[];
  summary: string;
};

export async function reviewGitDiff(rootPath: string, session: TaskSession): Promise<DiffReview> {
  const git = simpleGit(rootPath);
  const diff = await git.diff(["--name-only"]);
  const files: string[] = diff
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean);
  const shownFiles = new Set(session.filesShown.map((record) => record.filePath).filter(Boolean));
  const expectedFilesTouched = files.filter((file) => shownFiles.has(file));
  const unexpectedFiles = files.filter((file) => !shownFiles.has(file));
  const missingContextFiles = unexpectedFiles.filter((file) => !isGeneratedOrLockfile(file));

  const summary = [
    "# Diff Review",
    "",
    `Changed files: ${files.length}`,
    `Previously shown changed files: ${expectedFilesTouched.length}`,
    `Changed files not shown by Kairn: ${unexpectedFiles.length}`,
    "",
    "## Changed Files",
    files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "No working tree diff detected.",
    "",
    "## Missing Context Candidates",
    missingContextFiles.length > 0
      ? missingContextFiles.map((file) => `- ${file}`).join("\n")
      : "No missing context candidates detected."
  ].join("\n");

  return {
    files,
    expectedFilesTouched,
    unexpectedFiles,
    missingContextFiles,
    summary
  };
}

function isGeneratedOrLockfile(filePath: string): boolean {
  return (
    filePath.endsWith("pnpm-lock.yaml") ||
    filePath.endsWith("package-lock.json") ||
    filePath.endsWith("yarn.lock") ||
    filePath.includes("/dist/") ||
    filePath.includes("/build/")
  );
}
