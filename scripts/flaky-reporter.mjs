import { appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Names every test that failed and then passed on its CI retry.
 *
 * CI retries a failed test once (COS_TEST_RETRY), so a timing flake no longer turns a PR red. The
 * retry must not hide it either: each one becomes a warning on the run and a line in its summary.
 */
export default class FlakyReporter {
  constructor({ output = line => console.log(line), summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
    this.output = output;
    this.summary = summary;
    this.flaky = [];
  }

  onTestCaseResult(testCase) {
    if (!testCase.diagnostic()?.flaky) return;
    this.flaky.push(`${path.relative(process.cwd(), testCase.module.moduleId).split(path.sep).join('/')} > ${testCase.fullName}`);
  }

  onTestRunEnd() {
    if (!this.flaky.length) return;
    for (const name of this.flaky) this.output(`::warning title=Flaky test::${name} failed once and passed on retry`);
    if (this.summary) {
      appendFileSync(this.summary, `### Flaky tests\n\nThese failed once and passed on retry:\n\n${this.flaky.map(name => `- ${name}`).join('\n')}\n`);
    }
  }
}
