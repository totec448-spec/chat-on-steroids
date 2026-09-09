/** One completion policy for browser and tool delivery; authored user text stays unchanged. */
export function finishInstruction(leadMinutes?: number): string {
  return `Work through the whole requested task, including corrections. Use session_finish only when the requested implementation is complete and about ${leadMinutes === 3 ? 3 : 5} minutes of final verification remain. New instructions extend the work; they do not require another finish call. Do not use this tool for progress updates or to collect queued tasks.`;
}
