import fs from "node:fs";
import path from "node:path";
import { resolveRoot } from "../utils/paths.js";

export type KairnPaths = {
  rootPath: string;
  kairnDir: string;
  configPath: string;
  databasePath: string;
};

export function getKairnPaths(root?: string): KairnPaths {
  const rootPath = resolveRoot(root);
  const kairnDir = path.join(rootPath, ".kairn");

  return {
    rootPath,
    kairnDir,
    configPath: path.join(kairnDir, "config.json"),
    databasePath: path.join(kairnDir, "kairn.sqlite")
  };
}

export function ensureKairnDir(root?: string): KairnPaths {
  const paths = getKairnPaths(root);
  fs.mkdirSync(paths.kairnDir, { recursive: true });

  const gitignorePath = path.join(paths.kairnDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      [
        "*.sqlite",
        "*.sqlite-*",
        "cache/",
        "tmp/",
        "traces/",
        "!config.json",
        "!.gitignore",
        ""
      ].join("\n")
    );
  }

  if (!fs.existsSync(paths.configPath)) {
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify(
        {
          version: 1,
          rootPath: paths.rootPath,
          createdBy: "kairn",
          indexing: {
            maxStateMb: 250,
            hardMaxStateMb: 1000,
            maxGraphEdges: 250000,
            maxSemanticChunks: 7500,
            maxHotFiles: 3000
          },
          routing: {
            evidence: {
              mode: "off"
            }
          }
        },
        null,
        2
      )
    );
  }

  return paths;
}
