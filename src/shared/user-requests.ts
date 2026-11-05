import { z } from 'zod';

/**
 * A step ChatGPT hands to the person (#1695): a command they run themselves, in their own
 * terminal. The app records it, shows it and tells ChatGPT the person's answer. It never runs it.
 */
export const USER_REQUEST_LIMITS = Object.freeze({
  /** UTF-8 bytes; the whole command is shown, never cut. */
  commandBytes: 8 * 1024,
  purpose: 300,
  constraints: 300,
  expected: 10,
  expectedPath: 500,
  /** Open requests per chat. */
  open: 20,
  /** Kept per chat, answered ones included; the oldest answered go first. */
  kept: 60
});

export const userRequestInputSchema = z.object({
  command: z.string().min(1).describe('The exact command for the person to run, as they should paste it. Shown in full; at most 8 KB.'),
  workdir: z.string().optional().describe('The folder to run it in: an approved folder or a folder inside one. Defaults to the chat\'s working folder.'),
  purpose: z.string().trim().min(1).max(USER_REQUEST_LIMITS.purpose).describe('One line: why this step is needed and why the person has to run it.'),
  expected: z.array(z.string().trim().min(1).max(USER_REQUEST_LIMITS.expectedPath)).max(USER_REQUEST_LIMITS.expected).optional()
    .describe('Files the step should create or change, relative to the folder. The app reports whether they exist, with size and time; it reads nothing else.'),
  constraints: z.string().trim().max(USER_REQUEST_LIMITS.constraints).optional().describe('Anything the person must know, such as "run once" or "takes about 2 hours".')
}).strict();
export type UserRequestInput = z.infer<typeof userRequestInputSchema>;

export const userRequestStatusInputSchema = z.object({
  id: z.string().regex(/^ur_[a-z0-9]{12}$/).describe('The id ask_user_to_run returned.')
}).strict();

export const USER_REQUEST_ID = /\bur_[a-z0-9]{12}\b/;

export type UserRequestState = 'open' | 'done' | 'skipped';

const expectedFileSchema = z.object({
  /** As ChatGPT wrote it, shown to the person. */
  path: z.string().min(1).max(USER_REQUEST_LIMITS.expectedPath),
  /** Native path inside an approved folder; absent when it could not be placed there. */
  real: z.string().min(1).max(4096).optional()
}).strict();

export const userRequestSchema = z.object({
  id: z.string().regex(/^ur_[a-z0-9]{12}$/),
  command: z.string().min(1).max(USER_REQUEST_LIMITS.commandBytes),
  /** The folder in the form the person types: a native path, or the server and its path. */
  folder: z.string().min(1).max(4096),
  /** A server (SSH) folder: the app cannot look for its files. */
  remote: z.boolean(),
  purpose: z.string().min(1).max(USER_REQUEST_LIMITS.purpose),
  expected: z.array(expectedFileSchema).max(USER_REQUEST_LIMITS.expected),
  constraints: z.string().max(USER_REQUEST_LIMITS.constraints).optional(),
  state: z.enum(['open', 'done', 'skipped']),
  createdAt: z.number().finite().nonnegative(),
  answeredAt: z.number().finite().nonnegative().optional(),
  /** The ChatGPT chat that asked; a later chat of the same session (Compact & Resume) may check it. */
  conversationId: z.string().min(1).max(200)
}).strict();
export type UserRequest = z.infer<typeof userRequestSchema>;

export const userRequestsFileSchema = z.object({ version: z.literal(1), requests: z.array(userRequestSchema).max(USER_REQUEST_LIMITS.kept) }).strict();

/** What the app found for one expected file, read when asked; nothing inside the file is read. */
export interface UserRequestFound {
  path: string;
  state: 'found' | 'missing' | 'unchecked';
  size?: number;
  modifiedAt?: number;
}

/**
 * A request as the app window shows it. A sub-agent's open step also shows in its main chat's list
 * (#1695), with the session it belongs to and that chat's title.
 */
export interface UserRequestView extends UserRequest {
  found: UserRequestFound[];
  from?: { sessionId: string; title: string };
}

/** Two requests are the same when the person would run the same thing in the same place. */
export function sameUserRequest(a: Pick<UserRequest, 'command' | 'folder'>, b: Pick<UserRequest, 'command' | 'folder'>): boolean {
  return a.command.trim() === b.command.trim() && a.folder === b.folder;
}
