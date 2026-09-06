/** Added to every normal Astra user-message delivery; authored text stays unchanged. */
export function finishInstruction(leadMinutes?: number): string {
  return `Use the session_finish tool ${leadMinutes === 3 ? 3 : 5} minutes before you finish the task.`;
}

/** Transport-only reminder; the stored native message remains the user's own text. */
export function finishInputInstruction(leadMinutes?: number): string {
  return `The user just sent this instruction. Work on it and verify the whole request is complete. ${finishInstruction(leadMinutes)} Repeat this check and early finish call for every new user instruction.`;
}
