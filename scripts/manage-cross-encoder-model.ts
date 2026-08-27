#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import {
  JINA_TINY_CROSS_ENCODER,
  defaultCrossEncoderModelPath,
  installCrossEncoderModel,
  verifyCrossEncoderModelFiles,
  verifyCrossEncoderRuntime
} from "../src/bench/crossEncoderReranker.js";

const args = process.argv.slice(2).filter((value) => value !== "--");
const command = args[0] ?? "status";
const modelPathIndex = args.indexOf("--model-path");
const modelPath = modelPathIndex >= 0 ? args[modelPathIndex + 1] : undefined;
if (modelPathIndex >= 0 && !modelPath) throw new Error("--model-path requires a value");

if (command === "install") {
  const state = await installCrossEncoderModel({ ...(modelPath ? { modelPath } : {}) });
  console.log(JSON.stringify({ manifest: JINA_TINY_CROSS_ENCODER, state }, null, 2));
} else if (command === "verify") {
  const state = verifyCrossEncoderModelFiles(modelPath ?? defaultCrossEncoderModelPath());
  if (state.status !== "ready") {
    console.error(JSON.stringify({ manifest: JINA_TINY_CROSS_ENCODER, state }, null, 2));
    process.exitCode = 1;
  } else {
    const runtime = await verifyCrossEncoderRuntime({ ...(modelPath ? { modelPath } : {}) });
    console.log(JSON.stringify({ manifest: JINA_TINY_CROSS_ENCODER, state, runtime }, null, 2));
    if (!runtime.passed) process.exitCode = 1;
  }
} else if (command === "status") {
  const state = verifyCrossEncoderModelFiles(modelPath ?? defaultCrossEncoderModelPath());
  console.log(JSON.stringify({ manifest: JINA_TINY_CROSS_ENCODER, state }, null, 2));
  if (state.status !== "ready") process.exitCode = 1;
} else {
  throw new Error(`Unknown cross-encoder model command "${command}". Use status, install, or verify.`);
}
