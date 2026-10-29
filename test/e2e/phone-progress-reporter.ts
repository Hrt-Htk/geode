// Publishes the lock holder's run progress (project, specs done/total) to the
// phone-lock sidecar, so queued waiters and `deno task phone:status` can show
// an ETA (#508). Registered globally in playwright.config.ts (Playwright has no
// per-project reporter option) but no-ops for any run that doesn't hold the
// phone lock: `updateProgress` only writes when this process owns the sidecar.

import type { FullConfig, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { updateProgress } from "./phone-lock";

class PhoneProgressReporter implements Reporter {
  private project = "";
  private total = 0;
  private done = 0;

  onBegin(_config: FullConfig, suite: Suite): void {
    const tests = suite.allTests();
    if (tests.length === 0) return;
    // Playwright doesn't populate TestCase.project() for reporters, so the
    // project name comes from the internal _projectId field.
    this.project = (tests[0] as { _projectId?: string })._projectId ?? "";
    this.total = tests.length;
    updateProgress({ project: this.project, done: 0, total: this.total });
  }

  onTestEnd(_test: TestCase, _result: TestResult): void {
    this.done += 1;
    updateProgress({ project: this.project, done: this.done, total: this.total });
  }
}

export default PhoneProgressReporter;
