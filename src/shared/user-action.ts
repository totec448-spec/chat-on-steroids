/**
 * One durable request for a human to perform a local action outside CoS.
 *
 * These records are evidence and coordination only. Nothing in this contract authorizes or
 * executes the command, and a reporter receipt never means CoS verified the claimed outcome.
 */
export interface UserActionRequest {
  id: string;
  createdAt: number;
  command: string;
  shell: string;
  cwd: string;
  purpose: string;
  /** Reporter-supplied description of why the provider did not dispatch the action. */
  reportedProviderReason?: string;
  /** Reporter-supplied local-risk note; never an app-computed risk classification. */
  reportedRiskNote?: string;
  constraints: string[];
  expectedEvidence: string[];
  receipt?: UserActionReceipt;
}

export interface UserActionRequestInput {
  command: string;
  shell: string;
  cwd: string;
  purpose: string;
  reportedProviderReason?: string;
  reportedRiskNote?: string;
  constraints?: string[];
  expectedEvidence?: string[];
}

export type UserActionReceiptOutcome = 'reported_executed' | 'reported_failed' | 'cancelled';

export interface UserActionReceipt {
  outcome: UserActionReceiptOutcome;
  reportedAt: number;
  note?: string;
  evidence: string[];
}

export interface UserActionReceiptInput {
  outcome: UserActionReceiptOutcome;
  note?: string;
  evidence?: string[];
}
