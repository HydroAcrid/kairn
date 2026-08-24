// SPDX-License-Identifier: Apache-2.0

export type LanguageAdapterCapability =
  | "symbols"
  | "definitions"
  | "references"
  | "call_graph"
  | "tests"
  | "failures";

export type LanguageAdapterStatus = "stub" | "active";

export type LanguageAdapter = {
  id: string;
  languages: string[];
  fileExtensions: string[];
  capabilities: LanguageAdapterCapability[];
  status: LanguageAdapterStatus;
  notes?: string | undefined;
};
