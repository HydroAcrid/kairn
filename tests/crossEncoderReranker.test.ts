// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  crossEncoderManifestSha256,
  crossEncoderModelDownloadUrl,
  normalizeCrossEncoderScore,
  verifyCrossEncoderModelFiles,
  type CrossEncoderModelManifest
} from "../src/bench/crossEncoderReranker.js";

describe("cross-encoder benchmark runtime", () => {
  it("verifies content-addressed local model files and detects corruption", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-cross-encoder-"));
    try {
      const content = Buffer.from("safe deterministic model fixture", "utf8");
      const manifest = fixtureManifest(content);
      fs.mkdirSync(path.join(root, "onnx"), { recursive: true });
      fs.writeFileSync(path.join(root, "onnx", "model.onnx"), content);
      expect(verifyCrossEncoderModelFiles(root, manifest)).toMatchObject({
        status: "ready",
        totalBytes: content.length
      });
      fs.appendFileSync(path.join(root, "onnx", "model.onnx"), "corrupt");
      expect(verifyCrossEncoderModelFiles(root, manifest)).toMatchObject({ status: "corrupt" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds downloads to an immutable revision and stable manifest hash", () => {
    const content = Buffer.from("fixture", "utf8");
    const manifest = fixtureManifest(content);
    expect(crossEncoderModelDownloadUrl(manifest.files[0]!, manifest)).toBe(
      "https://huggingface.co/example/model/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model.onnx"
    );
    expect(crossEncoderManifestSha256(manifest)).toMatch(/^[0-9a-f]{64}$/);
    expect(crossEncoderManifestSha256(manifest)).toBe(crossEncoderManifestSha256({ ...manifest }));
  });

  it("normalizes extreme logits without overflow", () => {
    expect(normalizeCrossEncoderScore(0)).toBe(0.5);
    expect(normalizeCrossEncoderScore(1000)).toBe(1);
    expect(normalizeCrossEncoderScore(-1000)).toBe(0);
    expect(normalizeCrossEncoderScore(3)).toBeGreaterThan(normalizeCrossEncoderScore(-3));
  });
});

function fixtureManifest(content: Buffer): CrossEncoderModelManifest {
  return {
    formatVersion: 1,
    modelId: "fixture",
    upstreamRepository: "example/model",
    upstreamRevision: "0123456789abcdef0123456789abcdef01234567",
    license: "Apache-2.0",
    maxTokens: 16,
    queryTokenBudget: 4,
    documentTokenBudget: 8,
    runtime: {
      library: "kairn-onnx-wasm-cross-encoder-v1",
      modelFilePath: "onnx/model.onnx",
      outputName: "logits"
    },
    files: [{
      remotePath: "onnx/model.onnx",
      localPath: "onnx/model.onnx",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex")
    }]
  };
}
