// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SEMANTIC_MODEL_ID,
  MAX_SEMANTIC_MODEL_BYTES,
  getSemanticModelManifest,
  semanticModelBytes,
  semanticModelDownloadUrl,
  type SemanticModelFile,
  type SemanticModelManifest
} from "./modelRegistry.js";

export type SemanticModelState = {
  modelId: string;
  modelPath: string;
  status: "unavailable" | "corrupt" | "incompatible" | "ready";
  totalBytes: number;
  manifestSha256?: string;
  license?: string;
  upstreamRepository?: string;
  upstreamRevision?: string;
  error?: string;
};

export type InstalledSemanticModelReceipt = {
  formatVersion: 1;
  installedAt: string;
  manifest: SemanticModelManifest;
  manifestSha256: string;
};

export function getSemanticModelsRoot(homeDir = os.homedir()): string {
  const explicit = process.env.KAIRN_HOME?.trim();
  return explicit
    ? path.join(path.resolve(explicit), "models")
    : path.join(path.resolve(homeDir), ".kairn", "models");
}

export function getSemanticModelPath(modelId = DEFAULT_SEMANTIC_MODEL_ID, homeDir = os.homedir()): string {
  return path.join(getSemanticModelsRoot(homeDir), safeModelDirectoryName(modelId));
}

export function getSemanticModelState(input?: {
  modelId?: string;
  modelPath?: string;
  homeDir?: string;
  verifyHashes?: boolean;
}): SemanticModelState {
  const requestedModelId = input?.modelId ?? DEFAULT_SEMANTIC_MODEL_ID;
  const modelPath = input?.modelPath
    ? validateLocalModelPath(input.modelPath)
    : getSemanticModelPath(requestedModelId, input?.homeDir);
  if (!fs.existsSync(modelPath)) {
    return {
      modelId: requestedModelId,
      modelPath,
      status: "unavailable",
      totalBytes: 0,
      error: "The local semantic model is not installed."
    };
  }

  try {
    const receipt = readInstalledSemanticModel(modelPath);
    if (receipt.manifest.modelId !== requestedModelId) {
      throw new Error(
        `Installed model is incompatible: id ${receipt.manifest.modelId} does not match requested model ${requestedModelId}.`
      );
    }
    let pinnedManifestSha256: string;
    try {
      pinnedManifestSha256 = semanticModelManifestSha256(
        getSemanticModelManifest(receipt.manifest.modelId)
      );
    } catch {
      throw new Error(
        `Installed model ${receipt.manifest.modelId} is incompatible with this Kairn release.`
      );
    }
    if (receipt.manifestSha256 !== pinnedManifestSha256) {
      throw new Error(
        `Installed model ${receipt.manifest.modelId} is incompatible with Kairn's pinned artifact manifest.`
      );
    }
    verifyInstalledFiles(modelPath, receipt.manifest, Boolean(input?.verifyHashes));
    return {
      modelId: receipt.manifest.modelId,
      modelPath,
      status: "ready",
      totalBytes: semanticModelBytes(receipt.manifest),
      manifestSha256: receipt.manifestSha256,
      license: receipt.manifest.license,
      upstreamRepository: receipt.manifest.upstreamRepository,
      upstreamRevision: receipt.manifest.upstreamRevision
    };
  } catch (error) {
    return {
      modelId: requestedModelId,
      modelPath,
      status: isCompatibilityError(error) ? "incompatible" : "corrupt",
      totalBytes: directorySize(modelPath),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function installSemanticModel(input?: {
  modelId?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: {
    modelId: string;
    file: string;
    downloadedBytes: number;
    totalBytes: number;
  }) => void;
}): Promise<SemanticModelState> {
  const manifest = getSemanticModelManifest(input?.modelId);
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("This Node runtime does not provide fetch; Node 20.19 or newer is required.");
  const modelsRoot = getSemanticModelsRoot(input?.homeDir);
  const targetPath = getSemanticModelPath(manifest.modelId, input?.homeDir);
  const existing = getSemanticModelState({
    modelId: manifest.modelId,
    modelPath: targetPath,
    verifyHashes: true
  });
  if (existing.status === "ready") return existing;

  fs.mkdirSync(modelsRoot, { recursive: true });
  const otherCacheBytes = Math.max(0, directorySize(modelsRoot) - directorySize(targetPath));
  const aggregateBytes = semanticModelBytes(manifest);
  if (otherCacheBytes + aggregateBytes > MAX_SEMANTIC_MODEL_BYTES) {
    throw new Error(
      `Installing ${manifest.modelId} would exceed Kairn's 200MB semantic model cache limit. ` +
      "Remove another installed or partial model before continuing."
    );
  }
  const stagePath = path.join(modelsRoot, `.${safeModelDirectoryName(manifest.modelId)}.partial-${randomUUID()}`);
  fs.mkdirSync(stagePath, { recursive: false });
  let completedBytes = 0;

  try {
    for (const file of manifest.files) {
      const destination = resolveModelFile(stagePath, file.localPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await downloadModelFile({
        fetchImpl,
        url: semanticModelDownloadUrl(manifest, file),
        destination,
        file,
        onChunk: (fileBytes) => {
          input?.onProgress?.({
            modelId: manifest.modelId,
            file: file.localPath,
            downloadedBytes: completedBytes + fileBytes,
            totalBytes: aggregateBytes
          });
        }
      });
      completedBytes += file.bytes;
    }

    const receipt: InstalledSemanticModelReceipt = {
      formatVersion: 1,
      installedAt: new Date().toISOString(),
      manifest,
      manifestSha256: semanticModelManifestSha256(manifest)
    };
    fs.writeFileSync(
      path.join(stagePath, "kairn-model.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    readInstalledSemanticModel(stagePath);
    verifyInstalledFiles(stagePath, manifest, true);
    replaceInstalledModel({ modelsRoot, targetPath, stagePath });
    return getSemanticModelState({
      modelId: manifest.modelId,
      modelPath: targetPath,
      verifyHashes: true
    });
  } catch (error) {
    removeDirectoryWithin(modelsRoot, stagePath);
    throw error;
  }
}

export function verifySemanticModel(input?: {
  modelId?: string;
  modelPath?: string;
  homeDir?: string;
}): SemanticModelState {
  return getSemanticModelState({ ...input, verifyHashes: true });
}

export function removeSemanticModel(input?: {
  modelId?: string;
  homeDir?: string;
}): SemanticModelState {
  const modelId = input?.modelId ?? DEFAULT_SEMANTIC_MODEL_ID;
  const modelsRoot = getSemanticModelsRoot(input?.homeDir);
  const modelPath = getSemanticModelPath(modelId, input?.homeDir);
  if (fs.existsSync(modelPath)) removeDirectoryWithin(modelsRoot, modelPath);
  return getSemanticModelState({ modelId, modelPath });
}

export function readInstalledSemanticModel(modelPath: string): InstalledSemanticModelReceipt {
  const receiptPath = path.join(validateLocalModelPath(modelPath), "kairn-model.json");
  if (!fs.existsSync(receiptPath)) throw new Error("Missing kairn-model.json receipt.");
  const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Partial<InstalledSemanticModelReceipt>;
  if (parsed.formatVersion !== 1 || !parsed.manifest || typeof parsed.manifestSha256 !== "string") {
    throw new Error("Unsupported Kairn semantic model receipt.");
  }
  validateManifest(parsed.manifest);
  if (semanticModelManifestSha256(parsed.manifest) !== parsed.manifestSha256) {
    throw new Error("The semantic model manifest checksum does not match its receipt.");
  }
  return parsed as InstalledSemanticModelReceipt;
}

export function validateLocalModelPath(modelPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(modelPath)) {
    throw new Error("Kairn semantic modelPath must be a local filesystem path.");
  }
  return path.resolve(modelPath);
}

function validateManifest(manifest: SemanticModelManifest): void {
  if (
    manifest.formatVersion !== 1 ||
    !manifest.modelId ||
    !manifest.upstreamRepository ||
    !/^[0-9a-f]{40}$/i.test(manifest.upstreamRevision) ||
    !Number.isInteger(manifest.dimensions) ||
    manifest.dimensions <= 0 ||
    manifest.documentSchemaVersion !== "semantic-documents-v4" ||
    manifest.runtime.library !== "kairn-onnx-wasm-v1" ||
    manifest.runtime.modelFilePath !== "onnx/model.onnx" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("The semantic model manifest is incompatible with this Kairn runtime.");
  }
  if (semanticModelBytes(manifest) > 200 * 1024 * 1024) {
    throw new Error("The semantic model exceeds Kairn's 200MB release gate.");
  }
  for (const file of manifest.files) {
    if (
      !file.remotePath ||
      !file.localPath ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[0-9a-f]{64}$/i.test(file.sha256)
    ) {
      throw new Error("The semantic model file manifest is invalid.");
    }
    resolveModelFile(
      path.join(path.parse(process.cwd()).root, "kairn-model-manifest-validation"),
      file.localPath
    );
  }
}

function verifyInstalledFiles(
  modelPath: string,
  manifest: SemanticModelManifest,
  verifyHashes: boolean
): void {
  for (const file of manifest.files) {
    const localPath = resolveModelFile(modelPath, file.localPath);
    const stat = fs.statSync(localPath);
    if (!stat.isFile() || stat.size !== file.bytes) {
      throw new Error(`Semantic model file ${file.localPath} has the wrong size.`);
    }
    if (verifyHashes && sha256File(localPath) !== file.sha256) {
      throw new Error(`Semantic model file ${file.localPath} failed checksum verification.`);
    }
  }
}

async function downloadModelFile(input: {
  fetchImpl: typeof fetch;
  url: string;
  destination: string;
  file: SemanticModelFile;
  onChunk: (downloadedBytes: number) => void;
}): Promise<void> {
  const response = await input.fetchImpl(input.url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "usekairn/0.2 semantic-model-installer" }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Semantic model download failed (${response.status}) for ${input.file.remotePath}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? input.file.bytes);
  if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== input.file.bytes) {
    throw new Error(`Semantic model download size changed for ${input.file.remotePath}.`);
  }

  const hash = createHash("sha256");
  const stream = fs.createWriteStream(input.destination, { flags: "wx" });
  let downloadedBytes = 0;
  try {
    for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(rawChunk);
      hash.update(chunk);
      downloadedBytes += chunk.length;
      if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once("drain", resolve));
      input.onChunk(downloadedBytes);
      if (downloadedBytes > input.file.bytes) {
        throw new Error(`Semantic model download exceeded the pinned size for ${input.file.remotePath}.`);
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(resolve);
      stream.once("error", reject);
    });
  } catch (error) {
    stream.destroy();
    throw error;
  }
  if (downloadedBytes !== input.file.bytes || hash.digest("hex") !== input.file.sha256) {
    throw new Error(`Semantic model download failed checksum verification for ${input.file.remotePath}.`);
  }
}

function replaceInstalledModel(input: {
  modelsRoot: string;
  targetPath: string;
  stagePath: string;
}): void {
  const backupPath = `${input.targetPath}.backup-${randomUUID()}`;
  const hadTarget = fs.existsSync(input.targetPath);
  if (hadTarget) fs.renameSync(input.targetPath, backupPath);
  try {
    fs.renameSync(input.stagePath, input.targetPath);
    if (hadTarget) removeDirectoryWithin(input.modelsRoot, backupPath);
  } catch (error) {
    if (!fs.existsSync(input.targetPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, input.targetPath);
    }
    throw error;
  }
}

function resolveModelFile(modelPath: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Semantic model files must use relative paths.");
  }
  const root = path.resolve(modelPath);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Semantic model file path escapes the model directory.");
  }
  return resolved;
}

function removeDirectoryWithin(modelsRoot: string, targetPath: string): void {
  const root = path.resolve(modelsRoot);
  const target = path.resolve(targetPath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to remove a path outside the Kairn model cache.");
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function safeModelDirectoryName(modelId: string): string {
  const normalized = modelId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") throw new Error("Invalid semantic model id.");
  return normalized;
}

export function semanticModelManifestSha256(manifest: SemanticModelManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function directorySize(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
    const entryPath = path.join(directory, entry.name);
    return sum + (entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size);
  }, 0);
}

function isCompatibilityError(error: unknown): boolean {
  return error instanceof Error && /incompatible|unsupported/i.test(error.message);
}
