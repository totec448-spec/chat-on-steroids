/**
 * `ExecToolCallOutput` (`codex-rs/protocol/src/exec_output.rs`) and the model-facing formatter
 * `format_exec_output_for_model` (`codex-rs/core/src/tools/mod.rs`).
 *
 * This is the shape every exec-style tool result takes before the model sees it, and it is what
 * `apply_patch` reports through as well: Codex runs the patch as an exec call, so its success and
 * failure bodies both arrive in this format.
 */

import { countLines, truncateText, type TruncationPolicy } from './truncate.js';

/** `StreamOutput<String>`. */
export interface StreamOutput {
  text: string;
  truncatedAfterLines: number | null;
}

export function newStreamOutput(text: string): StreamOutput {
  return { text, truncatedAfterLines: null };
}

/** `ExecToolCallOutput`. */
export interface ExecToolCallOutput {
  exitCode: number;
  stdout: StreamOutput;
  stderr: StreamOutput;
  aggregatedOutput: StreamOutput;
  /** Wall time in milliseconds; Codex carries a `Duration`. */
  durationMs: number;
  timedOut: boolean;
}

/** `build_content_with_timeout`: prepends a timeout notice when the command was killed. */
export function buildContentWithTimeout(output: ExecToolCallOutput): string {
  if (output.timedOut) {
    return `command timed out after ${Math.trunc(output.durationMs)} milliseconds\n${output.aggregatedOutput.text}`;
  }
  return output.aggregatedOutput.text;
}

/**
 * `format_exec_output_for_model`: the combined output with exit code and duration metadata,
 * truncated to the policy's budget.
 *
 * `Total output lines` appears only when truncation actually dropped lines, so an untruncated
 * result is three sections rather than four.
 */
export function formatExecOutputForModel(output: ExecToolCallOutput, policy: TruncationPolicy): string {
  // Round to 1 decimal place. Rust computes this in f32 and prints the shortest round-tripping
  // form, which for a value already snapped to a tenth is the same text a JS number produces.
  const durationSeconds = Math.round((output.durationMs / 1000) * 10) / 10;

  const content = buildContentWithTimeout(output);
  const totalLines = countLines(content);
  const formattedOutput = truncateText(content, policy);

  const sections: string[] = [];
  sections.push(`Exit code: ${output.exitCode}`);
  sections.push(`Wall time: ${durationSeconds} seconds`);
  if (totalLines !== countLines(formattedOutput)) {
    sections.push(`Total output lines: ${totalLines}`);
  }
  sections.push('Output:');
  sections.push(formattedOutput);

  return sections.join('\n');
}
