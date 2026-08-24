// SPDX-License-Identifier: Apache-2.0

export function graphReason(type: string, targetIsFromFile: boolean): string {
  if (type === "imports") return targetIsFromFile ? "imports target" : "imported by target";
  if (type === "imported_by") return targetIsFromFile ? "imported by target" : "imports target";
  if (type === "tested_by") return targetIsFromFile ? "test for target" : "tested source";
  if (type === "test_for") return targetIsFromFile ? "tested source" : "test for target";
  if (type === "parent_route") return targetIsFromFile ? "parent route" : "route segment file";
  if (type === "definition") return targetIsFromFile ? "definition target" : "defined from target";
  if (type === "reference") return targetIsFromFile ? "references target" : "referenced by target";
  if (type === "type_reference") return targetIsFromFile ? "type reference target" : "type referenced by target";
  if (type === "module_installation") return targetIsFromFile ? "installed module" : "module installer";
  if (type === "implementation") return targetIsFromFile ? "implementation target" : "implemented by target";
  if (type === "call") return targetIsFromFile ? "calls target" : "called by target";
  if (type === "shared_call_target") return "shares a unique local call target";
  return type;
}

export function mergeReasonText(left: string | undefined, right: string): string {
  return [...new Set([...(left?.split("; ") ?? []), right])].filter(Boolean).join("; ");
}
