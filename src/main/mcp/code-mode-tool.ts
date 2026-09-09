import { currentCall, type CallContext } from './call-context.js';
import { guard, fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { codeModeSchema, runCodeMode, type CodeModeTool } from './code-mode-runtime.js';
import { toolDeclaration } from './tool-declarations.js';

/** Contract checked against OpenAI Codex 634ebc1865c6ac840ed3ba118f040d527bf4b55d,
 * code-mode-protocol/src/description.rs and core/src/tools/code_mode/execute_spec.rs.
 * MCP requires an object argument; it cannot advertise Codex's freeform grammar/namespace. */
export const codeModeDeclaration = () => toolDeclaration('exec', () => ({
  title: 'Run JavaScript',
  description: 'Run JavaScript to compose this connector’s tools. MCP arguments: {code: "raw JavaScript"}; the host chooses the outer namespace (Codex calls this functions.exec). Inside code, use await tools.<tool_name>(args), await Promise.all([...]), text(value), and image(dataUrlOrMcpImageContent). tools return their normal MCP result objects, including content and isError. Only explicit text/image output reaches the model; intermediate results stay in the runtime and local tool recording. ALL_TOOLS lists {name,description}; use the individual tools’ schemas for arguments. Fresh isolated JavaScript runtime, top-level await, no Node, filesystem, network, console or imports. Requires exact companion chat/session identity. Limits: 64k source characters, 32 MiB JS memory, 2s active JS time, 60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images, 12 MiB emitted payload. Await every call. Termination stops JavaScript/new calls, not actions already dispatched. Individual tools remain available. session_finish and agents action=finish must be direct calls. No recursive exec, pragma, wait/yield or persistent globals. See the connector instructions for examples.',
  inputSchema: codeModeSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}));

/** Preserve an upstream tool named exec; code mode must never replace its direct contract. */
export function canAddCodeMode(tools: ReadonlyArray<{ name: string }>): boolean {
  return tools.length > 0 && !tools.some(tool => tool.name === 'exec');
}

export function codeModeHandler(
  getTools: () => CodeModeTool[], invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>
): (args: { code: string }) => Promise<ToolResult> {
  return ({ code }) => guard('exec', async () => {
    const parent = currentCall();
    if (!parent?.caller.requestId || !parent.caller.conversationId || !parent.caller.sessionId) {
      return fail('CALLER_IDENTITY_REQUIRED: code mode needs this request’s exact companion chat/session proof. No JavaScript or nested tool ran. Individual tools remain available.');
    }
    return runCodeMode(code, getTools().filter(tool => tool.name !== 'exec'), (name, args) => invoke(name, args, parent));
  });
}

export function registerCodeMode(
  reg: SurfaceRegistrar, invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>
): void {
  if (!canAddCodeMode(reg.descriptions())) return;
  reg.register('exec', codeModeDeclaration(), codeModeHandler(() => reg.descriptions(), invoke));
}

export const CODE_MODE_INSTRUCTIONS = `Code mode: use exec with a code string for bounded tool composition and filtering. Inside JavaScript, call tools by their existing names and arguments. Results are normal MCP objects; inspect content, structuredContent and isError. Only text(...) and image(...) emit data to the model. Given requests you define using this connector's listed tool schemas:
const results = await Promise.all(requests.map(({name, args}) => tools[name](args)));
text(results.map((result, index) => ({index, isError: result.isError ?? false, content: result.content})));
Keep independent calls parallel only when their operations do not conflict; await mutations before dependent work. Use image(result.content.find(item => item.type === "image")) to forward a native image explicitly. A script without text/image returns no intermediate data. All nested calls still run under live permissions and this chat’s identity and are individually recorded. New user instructions and worker inbox messages arrive with the outer result, outside filtering. Call finish/lifecycle signals directly. Use individual tools for simple calls, native file arguments, or when a result needs fresh model judgment. No persistent script state or code-mode wait tool; long-running tools retain their existing continuation contracts.`;
