import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import { runCli } from "./cli.ts";

NodeRuntime.runMain(runCli());
