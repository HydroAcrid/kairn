// SPDX-License-Identifier: Apache-2.0

import type {
  BenchmarkAssistanceMode,
  BenchmarkContextBehavior,
  BenchmarkKairnApplicability,
  BenchmarkLiveRisk,
  BenchmarkOfficialEvaluation,
  BenchmarkOfficialTaskClass
} from "../types.js";

export function classifySweAtlasQnaTask(input: {
  prompt: string;
  category?: string | undefined;
  expectedFiles: string[];
  contextBehavior: BenchmarkContextBehavior;
}): BenchmarkOfficialEvaluation {
  const text = `${input.prompt}\n${input.category ?? ""}`;
  const runtimeReasons = runtimeProceduralReasons(text);
  if (runtimeReasons.length >= 2) {
    return {
      source: "swe_atlas_qna",
      taskClass: "runtime_procedural",
      evaluator: "runtime_procedural_answer",
      kairnApplicability: input.expectedFiles.length > 0 ? "partial" : "weak",
      kairnMetricEligible: false,
      liveRisk: "high",
      reasons: runtimeReasons,
      recommendedModes: ["baseline", "real_mcp_first"]
    };
  }

  const taskClass = qnaTaskClassFromBehavior(input.contextBehavior, input.expectedFiles);
  const kairnApplicability = qnaApplicability(taskClass, input.expectedFiles);
  return {
    source: "swe_atlas_qna",
    taskClass,
    evaluator: "source_grounded_answer",
    kairnApplicability,
    kairnMetricEligible: kairnApplicability === "strong" || kairnApplicability === "partial",
    liveRisk: taskClass === "multi_file_debug" || taskClass === "failure_first_debug" ? "medium" : "low",
    reasons: qnaReasons(taskClass, input.expectedFiles),
    recommendedModes: ["baseline", "kairn_codex_session", "real_mcp_first"]
  };
}

export function classifySweBenchProTask(input: {
  problemStatement: string;
  requirements?: string | null | undefined;
  interfaceText?: string | null | undefined;
  patchFiles: string[];
  selectedTests: string[];
  contextBehavior: BenchmarkContextBehavior;
  hasOfficialSetup: boolean;
}): BenchmarkOfficialEvaluation {
  const text = [input.problemStatement, input.requirements ?? "", input.interfaceText ?? "", input.selectedTests.join("\n")].join("\n");
  const taskClass = patchTaskClassFromBehavior(input.contextBehavior, input.patchFiles);
  const kairnApplicability: BenchmarkKairnApplicability = input.patchFiles.length > 0 ? "strong" : "weak";
  const liveRisk: BenchmarkLiveRisk =
    input.hasOfficialSetup || /docker|service|server|database|migration|browser|e2e|integration/i.test(text)
      ? "medium"
      : "low";
  return {
    source: "swe_bench_pro",
    taskClass,
    evaluator: "patch_verification",
    kairnApplicability,
    kairnMetricEligible: kairnApplicability === "strong",
    liveRisk,
    reasons: [
      input.patchFiles.length > 0
        ? `golden patch touches ${input.patchFiles.length} production source file(s)`
        : "golden patch has no extractable production source file",
      input.selectedTests.length > 0 ? "selected tests are available for verification setup" : "selected tests unavailable or not parseable",
      input.hasOfficialSetup ? "official before_repo_set_cmd is available" : "no official setup command in row"
    ],
    recommendedModes: ["baseline", "kairn_codex_session", "real_mcp_first"]
  };
}

function qnaTaskClassFromBehavior(
  behavior: BenchmarkContextBehavior,
  expectedFiles: string[]
): BenchmarkOfficialTaskClass {
  if (expectedFiles.length === 0 || behavior === "weak_signal") return "weak_signal";
  if (behavior === "multi_file_debug") return "multi_file_debug";
  if (behavior === "failure_first") return "failure_first_debug";
  if (behavior === "cheap_single_source") return "cheap_single_source";
  if (behavior === "source_rescue") return "source_rescue";
  return "source_grounded_explanation";
}

function patchTaskClassFromBehavior(
  behavior: BenchmarkContextBehavior,
  patchFiles: string[]
): BenchmarkOfficialTaskClass {
  if (patchFiles.length === 0 || behavior === "weak_signal") return "weak_signal";
  if (behavior === "multi_file_debug") return "multi_file_debug";
  if (behavior === "failure_first") return "failure_first_debug";
  if (behavior === "cheap_single_source") return "cheap_single_source";
  if (behavior === "source_rescue") return "source_rescue";
  return "patch_verification";
}

function qnaApplicability(taskClass: BenchmarkOfficialTaskClass, expectedFiles: string[]): BenchmarkKairnApplicability {
  if (expectedFiles.length === 0 || taskClass === "weak_signal") return "weak";
  if (taskClass === "runtime_procedural") return "partial";
  return "strong";
}

function qnaReasons(taskClass: BenchmarkOfficialTaskClass, expectedFiles: string[]): string[] {
  if (expectedFiles.length === 0) {
    return ["reference answer has no extractable production source files"];
  }
  if (taskClass === "multi_file_debug") {
    return [`reference answer cites ${expectedFiles.length} source files`, "question appears to span multiple source surfaces"];
  }
  if (taskClass === "cheap_single_source") {
    return ["question names or strongly implies one source surface; abstention or a tiny guardrail should be sufficient"];
  }
  if (taskClass === "source_rescue") {
    return ["question is source-grounded but does not directly name the expected file"];
  }
  if (taskClass === "failure_first_debug") {
    return ["question contains failure/debug signals and should use failure-first context if output exists"];
  }
  return ["question can be evaluated by source-grounded answer quality"];
}

function runtimeProceduralReasons(text: string): string[] {
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\bruntime environment\b|\bwhen running\b|\bactually loaded\b/, "requires observing runtime environment"],
    [/\bstart(?:s|up)?\b|\blaunched?\b|\brun(?:ning)?\b.*\bserver\b|\bserver\b.*\brun(?:ning)?\b/, "requires starting or running a service"],
    [/\blog(?:s|ging)?\b|\bhealth endpoint\b|\bwrite attempts?\b|\bpermission changes?\b|\binaccessible\b/, "requires runtime logs or failure observation"],
    [/\btemporary scripts?\b|\bcommands?\b|\bexecute\b|\bintrospect\b|\bprobe\b/, "requires procedural commands or temporary probes"],
    [/\bwhat .*display\b|\bwelcome message\b|\bversion information\b|\bhow many .*available\b|\bdefault configuration\b/, "asks for environment-dependent observed values"],
    [/\bsocket implementation\b|\bnetworking socket\b|\bprotocol layers?\b.*\bloaded\b/, "asks for runtime configuration rather than static source only"]
  ];
  for (const [pattern, reason] of checks) {
    if (pattern.test(lower) && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}
