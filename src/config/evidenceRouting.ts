import fs from "node:fs";
import type { EvidenceRoutingConfig } from "../types.js";
import { getKairnPaths } from "./paths.js";

export const DEFAULT_EVIDENCE_ROUTING_CONFIG: EvidenceRoutingConfig = {
  mode: "off"
};

export function loadEvidenceRoutingConfig(rootPath: string): EvidenceRoutingConfig {
  const { configPath } = getKairnPaths(rootPath);
  if (!fs.existsSync(configPath)) return DEFAULT_EVIDENCE_ROUTING_CONFIG;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      routing?: {
        evidence?: {
          mode?: unknown;
        };
      };
    };
    return {
      mode: parsed.routing?.evidence?.mode === "shadow" ? "shadow" : "off"
    };
  } catch {
    return DEFAULT_EVIDENCE_ROUTING_CONFIG;
  }
}
