// SPDX-License-Identifier: Apache-2.0

import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import {
  getSemanticModelState,
  installSemanticModel,
  removeSemanticModel,
  verifySemanticModel
} from "../../semantic/modelManager.js";
import {
  DEFAULT_SEMANTIC_MODEL_ID,
  getSemanticModelManifest,
  semanticModelBytes
} from "../../semantic/modelRegistry.js";
import { verifyLocalEmbeddingModel } from "../../semantic/modelRuntime.js";
import { printJson } from "../output.js";

export function registerModelCommands(program: Command): void {
  const model = program
    .command("model")
    .description("Manage Kairn's pinned local semantic models.");

  model
    .command("status")
    .description("Show local semantic model availability without downloading anything.")
    .option("--model <id>", "model id", DEFAULT_SEMANTIC_MODEL_ID)
    .option("--home <path>", "home directory override")
    .option("--json", "print JSON output")
    .action((options: { model: string; home?: string; json?: boolean }) => {
      const state = getSemanticModelState({
        modelId: options.model,
        ...(options.home ? { homeDir: options.home } : {})
      });
      if (options.json) printJson(state);
      else process.stdout.write(formatModelState(state));
    });

  model
    .command("install")
    .description("Download and verify one immutable local semantic model.")
    .option("--model <id>", "model id", DEFAULT_SEMANTIC_MODEL_ID)
    .option("--home <path>", "home directory override")
    .option("--yes", "confirm the pinned model download")
    .option("--json", "print JSON output")
    .action(async (options: {
      model: string;
      home?: string;
      yes?: boolean;
      json?: boolean;
    }) => {
      const manifest = getSemanticModelManifest(options.model);
      let approved = Boolean(options.yes);
      if (!approved) {
        if (!process.stdin.isTTY) {
          throw new Error("kairn model install requires confirmation. Re-run with --yes.");
        }
        approved = await confirm({
          message: `Download ${manifest.modelId} (${formatBytes(semanticModelBytes(manifest))}, ${manifest.license}) for local CPU inference?`,
          default: true
        });
      }
      if (!approved) {
        process.stdout.write("Kairn semantic model installation cancelled.\n");
        return;
      }
      let lastPrintedPercent = -1;
      const state = await installSemanticModel({
        modelId: options.model,
        ...(options.home ? { homeDir: options.home } : {}),
        ...(!options.json
          ? {
              onProgress: (progress: { downloadedBytes: number; totalBytes: number }) => {
                const percent = Math.floor((progress.downloadedBytes / progress.totalBytes) * 100);
                if (percent >= lastPrintedPercent + 5 || percent === 100) {
                  lastPrintedPercent = percent;
                  process.stderr.write(`Kairn model download: ${percent}%\n`);
                }
              }
            }
          : {})
      });
      if (options.json) printJson(state);
      else process.stdout.write(formatModelState(state));
    });

  model
    .command("verify")
    .description("Verify all pinned model file sizes and SHA-256 checksums.")
    .option("--model <id>", "model id", DEFAULT_SEMANTIC_MODEL_ID)
    .option("--home <path>", "home directory override")
    .option("--json", "print JSON output")
    .action(async (options: { model: string; home?: string; json?: boolean }) => {
      const state = verifySemanticModel({
        modelId: options.model,
        ...(options.home ? { homeDir: options.home } : {})
      });
      const runtime = state.status === "ready"
        ? await verifyLocalEmbeddingModel({
            modelId: options.model,
            modelPath: state.modelPath,
            ...(options.home ? { homeDir: options.home } : {})
          })
        : undefined;
      if (options.json) printJson({ ...state, ...(runtime ? { runtime } : {}) });
      else {
        process.stdout.write([
          formatModelState(state).trimEnd(),
          runtime
            ? [
                `Runtime: ${runtime.passed ? "passed" : "failed"}`,
                `Dimensions: ${runtime.dimensions}`,
                `Cold initialization: ${runtime.coldInitializationMs} ms`,
                `Verification inference: ${runtime.batchInferenceMs} ms`,
                `Maximum repeat delta: ${runtime.maximumDeterminismDelta}`
              ].join("\n")
            : "",
          ""
        ].filter(Boolean).join("\n"));
      }
      if (state.status !== "ready" || runtime?.passed === false) process.exitCode = 1;
    });

  model
    .command("remove")
    .description("Remove one Kairn model from the shared local cache.")
    .option("--model <id>", "model id", DEFAULT_SEMANTIC_MODEL_ID)
    .option("--home <path>", "home directory override")
    .option("--yes", "confirm model removal")
    .option("--json", "print JSON output")
    .action(async (options: {
      model: string;
      home?: string;
      yes?: boolean;
      json?: boolean;
    }) => {
      let approved = Boolean(options.yes);
      if (!approved) {
        if (!process.stdin.isTTY) {
          throw new Error("kairn model remove requires confirmation. Re-run with --yes.");
        }
        approved = await confirm({
          message: `Remove local semantic model ${options.model}? Repository indexes will remain but become stale.`,
          default: false
        });
      }
      if (!approved) {
        process.stdout.write("Kairn semantic model removal cancelled.\n");
        return;
      }
      const state = removeSemanticModel({
        modelId: options.model,
        ...(options.home ? { homeDir: options.home } : {})
      });
      if (options.json) printJson(state);
      else process.stdout.write(formatModelState(state));
    });
}

function formatModelState(state: ReturnType<typeof getSemanticModelState>): string {
  return [
    `Model: ${state.modelId}`,
    `Status: ${state.status}`,
    `Path: ${state.modelPath}`,
    `Size: ${formatBytes(state.totalBytes)}`,
    state.license ? `License: ${state.license}` : "",
    state.upstreamRepository
      ? `Source: ${state.upstreamRepository}@${state.upstreamRevision}`
      : "",
    state.error ? `Detail: ${state.error}` : "",
    ""
  ].filter(Boolean).join("\n");
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
