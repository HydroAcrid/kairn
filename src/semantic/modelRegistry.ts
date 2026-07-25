// SPDX-License-Identifier: Apache-2.0

export type SemanticModelFile = {
  remotePath: string;
  localPath: string;
  bytes: number;
  sha256: string;
};

export type SemanticModelManifest = {
  formatVersion: 1;
  modelId: string;
  upstreamRepository: string;
  upstreamRevision: string;
  license: string;
  dimensions: number;
  maxTokens: number;
  pooling: "mean" | "cls";
  normalize: true;
  queryPrefix: string;
  documentPrefix: string;
  documentSchemaVersion: "semantic-documents-v4" | "semantic-documents-v5";
  runtime: {
    library: "kairn-onnx-wasm-v1";
    modelFilePath: "onnx/model.onnx";
  };
  files: SemanticModelFile[];
};

export const DEFAULT_SEMANTIC_MODEL_ID = "jina-code-v2-q8";
export const FALLBACK_SEMANTIC_MODEL_ID = "bge-small-en-v15";
export const MAX_SEMANTIC_MODEL_BYTES = 200 * 1024 * 1024;

const JINA_CODE: SemanticModelManifest = {
  formatVersion: 1,
  modelId: DEFAULT_SEMANTIC_MODEL_ID,
  upstreamRepository: "jinaai/jina-embeddings-v2-base-code",
  upstreamRevision: "516f4baf13dec4ddddda8631e019b5737c8bc250",
  license: "Apache-2.0",
  dimensions: 768,
  maxTokens: 512,
  pooling: "mean",
  normalize: true,
  queryPrefix: "",
  documentPrefix: "",
  documentSchemaVersion: "semantic-documents-v5",
  runtime: {
    library: "kairn-onnx-wasm-v1",
    modelFilePath: "onnx/model.onnx"
  },
  files: [
    {
      remotePath: "config.json",
      localPath: "config.json",
      bytes: 1_216,
      sha256: "e426aa684c7f9a95c5f020aa855faf93a24f065f5fad0c9e17b124670cabdea6"
    },
    {
      remotePath: "special_tokens_map.json",
      localPath: "special_tokens_map.json",
      bytes: 280,
      sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f"
    },
    {
      remotePath: "tokenizer.json",
      localPath: "tokenizer.json",
      bytes: 2_561_316,
      sha256: "b01c78a902aa4facb2f47f95449f48e2f7bbfea5d2472ee2f6ce92323c6f86e5"
    },
    {
      remotePath: "tokenizer_config.json",
      localPath: "tokenizer_config.json",
      bytes: 493,
      sha256: "f477aeb15ff9f78d3c1ddf2361d2b0b8b20cf55220f839f29a37f3a18efddd89"
    },
    {
      remotePath: "vocab.json",
      localPath: "vocab.json",
      bytes: 970_639,
      sha256: "799ccbde8e1dfeda7cad79a81e5d6dfd4037f118e169185183885ec28119849c"
    },
    {
      remotePath: "onnx/model_quantized.onnx",
      // Transformers.js treats the already-quantized graph as the canonical
      // local model. No runtime remote-code path or alternate weights exist.
      localPath: "onnx/model.onnx",
      bytes: 161_895_621,
      sha256: "ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d"
    }
  ]
};

const BGE_SMALL: SemanticModelManifest = {
  formatVersion: 1,
  modelId: FALLBACK_SEMANTIC_MODEL_ID,
  upstreamRepository: "BAAI/bge-small-en-v1.5",
  upstreamRevision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
  license: "MIT",
  dimensions: 384,
  maxTokens: 512,
  pooling: "cls",
  normalize: true,
  queryPrefix: "Represent this sentence for searching relevant passages: ",
  documentPrefix: "",
  documentSchemaVersion: "semantic-documents-v5",
  runtime: {
    library: "kairn-onnx-wasm-v1",
    modelFilePath: "onnx/model.onnx"
  },
  files: [
    {
      remotePath: "config.json",
      localPath: "config.json",
      bytes: 743,
      sha256: "094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750"
    },
    {
      remotePath: "special_tokens_map.json",
      localPath: "special_tokens_map.json",
      bytes: 125,
      sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"
    },
    {
      remotePath: "tokenizer.json",
      localPath: "tokenizer.json",
      bytes: 711_396,
      sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"
    },
    {
      remotePath: "tokenizer_config.json",
      localPath: "tokenizer_config.json",
      bytes: 366,
      sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"
    },
    {
      remotePath: "vocab.txt",
      localPath: "vocab.txt",
      bytes: 231_508,
      sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"
    },
    {
      remotePath: "onnx/model.onnx",
      localPath: "onnx/model.onnx",
      bytes: 133_093_490,
      sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35"
    }
  ]
};

export const SEMANTIC_MODEL_MANIFESTS = Object.freeze([JINA_CODE, BGE_SMALL]);

export function getSemanticModelManifest(modelId = DEFAULT_SEMANTIC_MODEL_ID): SemanticModelManifest {
  const manifest = SEMANTIC_MODEL_MANIFESTS.find((candidate) => candidate.modelId === modelId);
  if (!manifest) {
    throw new Error(
      `Unknown Kairn semantic model "${modelId}". Available models: ${SEMANTIC_MODEL_MANIFESTS.map((candidate) => candidate.modelId).join(", ")}.`
    );
  }
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > MAX_SEMANTIC_MODEL_BYTES) {
    throw new Error(`Kairn semantic model ${modelId} exceeds the 200MB release gate.`);
  }
  return manifest;
}

export function semanticModelDownloadUrl(
  manifest: SemanticModelManifest,
  file: SemanticModelFile
): string {
  return `https://huggingface.co/${manifest.upstreamRepository}/resolve/${manifest.upstreamRevision}/${file.remotePath}`;
}

export function semanticModelBytes(manifest: SemanticModelManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}
