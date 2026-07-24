// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import type { SemanticRetrieverConfig } from "../types.js";
import { ensureKairnDir, getKairnPaths } from "./paths.js";
import { DEFAULT_SEMANTIC_MODEL_ID } from "../semantic/modelRegistry.js";
import { validateLocalModelPath } from "../semantic/modelManager.js";

export const DEFAULT_SEMANTIC_RETRIEVER_CONFIG: SemanticRetrieverConfig = {
  mode: "shadow",
  modelId: DEFAULT_SEMANTIC_MODEL_ID
};

export function resolveSemanticRetrieverConfig(
  rootPath: string,
  override?: SemanticRetrieverConfig
): SemanticRetrieverConfig {
  const stored = loadStoredConfig(rootPath);
  const mode = process.env.KAIRN_CANDIDATE_MODE?.trim() || override?.mode || stored.mode || "shadow";
  const modelId =
    process.env.KAIRN_SEMANTIC_MODEL?.trim() ||
    override?.modelId ||
    stored.modelId ||
    DEFAULT_SEMANTIC_MODEL_ID;
  const modelPath =
    process.env.KAIRN_SEMANTIC_MODEL_PATH?.trim() ||
    override?.modelPath ||
    stored.modelPath;
  if (!(["legacy", "shadow", "semantic"] as const).includes(mode as SemanticRetrieverConfig["mode"])) {
    throw new Error(`Invalid Kairn candidate generator mode: ${mode}.`);
  }
  return {
    mode: mode as SemanticRetrieverConfig["mode"],
    modelId,
    ...(modelPath ? { modelPath: validateLocalModelPath(modelPath) } : {})
  };
}

export function writeSemanticRetrieverConfig(
  rootPath: string,
  semantic: SemanticRetrieverConfig
): SemanticRetrieverConfig {
  const paths = ensureKairnDir(rootPath);
  const parsed = fs.existsSync(paths.configPath)
    ? JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as Record<string, unknown>
    : {};
  const normalized = resolveSemanticRetrieverConfig(rootPath, semantic);
  fs.writeFileSync(
    paths.configPath,
    `${JSON.stringify({ ...parsed, semantic: normalized }, null, 2)}\n`,
    "utf8"
  );
  return normalized;
}

function loadStoredConfig(rootPath: string): Partial<SemanticRetrieverConfig> {
  const { configPath } = getKairnPaths(rootPath);
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      semantic?: Partial<SemanticRetrieverConfig>;
    };
    return parsed.semantic ?? {};
  } catch {
    return {};
  }
}
