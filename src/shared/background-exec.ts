/** One app-spawned exec_command child that is still running in the local process manager. */
export interface RunningExecProcess {
  processId: number;
  /** App-lifetime generation that fences a recycled numeric process id at action time. */
  incarnation: number;
  command: string;
  startedAt: number;
  tty: boolean;
}
