import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function createFixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-fixture-"));

  write(root, ".gitignore", "ignored.txt\nnode_modules/\n");
  write(
    root,
    "package.json",
    JSON.stringify(
      {
        scripts: {
          test: "vitest run",
          typecheck: "tsc --noEmit"
        }
      },
      null,
      2
    )
  );
  write(
    root,
    "src/app.ts",
    [
      "import { formatUser } from './user';",
      "",
      "export function renderDashboard(name: string) {",
      "  return formatUser(name);",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/user.ts",
    [
      "export function formatUser(name: string) {",
      "  return `Hello ${name}`;",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/widgets.ts",
    [
      "export function DashboardMetrics() {",
      "  return 'metrics';",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/app.test.ts",
    [
      "import { renderDashboard } from './app';",
      "",
      "test('renderDashboard', () => {",
      "  expect(renderDashboard('Kevin')).toContain('Kevin');",
      "});",
      ""
    ].join("\n")
  );
  write(
    root,
    "app/dashboard/page.tsx",
    [
      "import { DashboardCard } from './DashboardCard';",
      "",
      "export default function Page() {",
      "  return <DashboardCard />;",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "app/dashboard/DashboardCard.tsx",
    [
      "export const DashboardCard = () => {",
      "  return <section />;",
      "};",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/app/private/jobs/JobsApplicationsTable.tsx",
    [
      "export function JobsApplicationsTable() {",
      "  const mobileDetailAppId = 'selected';",
      "  const mobileFiltersOpen = true;",
      "  return <section data-mobile={mobileFiltersOpen}>{mobileDetailAppId}</section>;",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/app/private/jobs/JobsDashboardTabs.tsx",
    [
      "export function JobsDashboardTabs() {",
      "  const mobileBottomTabs = ['applications', 'review', 'analytics', 'tools'];",
      "  return <nav>{mobileBottomTabs.join(',')}</nav>;",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/app/private/jobs/JobsApplicationsTable.test.tsx",
    [
      "import { JobsApplicationsTable } from './JobsApplicationsTable';",
      "",
      "test('JobsApplicationsTable mobile layout', () => {",
      "  expect(JobsApplicationsTable).toBeTruthy();",
      "});",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/lib/jobs/parser.ts",
    [
      "export function parseJobEmailRules(message: string) {",
      "  return message.includes('gmail') && !message.includes('rental application');",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/lib/jobs/repository.ts",
    [
      "export function getJobDashboardData(ownerEmail: string) {",
      "  return { ownerEmail };",
      "}",
      ""
    ].join("\n")
  );
  write(
    root,
    "src/lib/jobs/types.ts",
    [
      "export const JOB_STATUSES = ['applied', 'rejected'] as const;",
      "export type JobStatus = (typeof JOB_STATUSES)[number];",
      ""
    ].join("\n")
  );
  write(root, "ignored.txt", "ignored");

  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Kairn Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Kairn Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });

  fs.appendFileSync(path.join(root, "src/app.ts"), "\nexport const changed = true;\n");

  return root;
}

function write(root: string, filePath: string, content: string): void {
  const absolute = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
