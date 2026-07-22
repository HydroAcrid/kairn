import { describe, expect, it } from "vitest";
import { extractFailureFiles } from "../src/watch/failureParser.js";

describe("failure file extraction across languages", () => {
  const knownFiles = [
    "pkg/service.py",
    "src/app.ts",
    "pkg/worker.go",
    "src/main/java/com/acme/Service.java",
    "src/parser.cpp",
    "include/parser.hpp"
  ];

  it("extracts Python, TypeScript, Go, Java, and C++ diagnostic references", () => {
    const output = [
      '  File "/repo/pkg/service.py", line 42, in handle',
      "src/app.ts(4,2): error TS2322: Type mismatch",
      "./pkg/worker.go:12:3: undefined: dispatch",
      "at com.acme.Service.run(Service.java:88)",
      "/repo/src/parser.cpp:18:7: error: expected ';'",
      "/repo/include/parser.hpp:9:2: note: instantiated here"
    ].join("\n");

    expect(extractFailureFiles({ output, rootPath: "/repo", knownFiles })).toEqual(knownFiles.slice().sort());
  });

  it("does not guess when a basename is ambiguous", () => {
    expect(extractFailureFiles({
      output: "at com.acme.Service.run(Service.java:88)",
      rootPath: "/repo",
      knownFiles: ["src/a/Service.java", "src/b/Service.java"]
    })).toEqual([]);
  });
});
