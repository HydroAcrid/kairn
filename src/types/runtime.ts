import type { CommandRecord, ContextShownRecord, DiffRecord } from "./context.js";
import type { WatchEventRecord } from "./watch.js";

export type SessionStatus = "active" | "completed" | "abandoned";

export type TaskSession = {
  id: string;
  rootPath: string;
  task: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  filesShown: ContextShownRecord[];
  symbolsShown: ContextShownRecord[];
  commandsRun: CommandRecord[];
  diffsObserved: DiffRecord[];
  watchEvents: WatchEventRecord[];
  risks: string[];
  verificationHints: string[];
};
