#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { Command } from "commander";
import { registerBetaCommands } from "./cli/commands/beta.js";
import { registerBenchCommands } from "./cli/commands/bench.js";
import { registerContextCommands } from "./cli/commands/context.js";
import { registerCoreCommands } from "./cli/commands/core.js";
import { registerEvalCommands } from "./cli/commands/eval.js";
import { registerModelCommands } from "./cli/commands/model.js";
import { registerSetupCommands } from "./cli/commands/setup.js";
import { registerWatchCommands } from "./cli/commands/watch.js";
import { getKairnVersion } from "./version.js";

const program = new Command();

program
  .name("kairn")
  .description("Local repository evidence and token-efficiency layer for coding agents.")
  .version(getKairnVersion());

registerCoreCommands(program);
registerSetupCommands(program);
registerContextCommands(program);
registerWatchCommands(program);
registerEvalCommands(program);
registerModelCommands(program);
registerBenchCommands(program);
registerBetaCommands(program);

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kairn: ${message}\n`);
  process.exitCode = 1;
});
