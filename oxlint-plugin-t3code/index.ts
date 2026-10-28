import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noLowValueComments from "./rules/no-low-value-comments.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noPollingLoopInTests from "./rules/no-polling-loop-in-tests.ts";
import noRealTimeWaitInTests from "./rules/no-real-time-wait-in-tests.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noTestTimeoutOrUnreasonedSkip from "./rules/no-test-timeout-or-unreasoned-skip.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import noWallClockInTests from "./rules/no-wall-clock-in-tests.ts";
import preferCatchTags from "./rules/prefer-catch-tags.ts";
import preferEffectFn from "./rules/prefer-effect-fn.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-low-value-comments": noLowValueComments,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-polling-loop-in-tests": noPollingLoopInTests,
    "no-real-time-wait-in-tests": noRealTimeWaitInTests,
    "no-test-in-loop": noTestInLoop,
    "no-test-timeout-or-unreasoned-skip": noTestTimeoutOrUnreasonedSkip,
    "no-unscoped-has": noUnscopedHas,
    "no-wall-clock-in-tests": noWallClockInTests,
    "prefer-catch-tags": preferCatchTags,
    "prefer-effect-fn": preferEffectFn,
    "require-suppression-reason": requireSuppressionReason,
  },
});
