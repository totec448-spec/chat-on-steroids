import type { SettingsPatch } from '../../../preload/index.js';
import type { AppState } from '../../../shared/types.js';
import { DEFAULT_GOAL_LOOP_SYSTEM_PROMPT, DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, DEFAULT_GOAL_SYSTEM_PROMPT } from '../../../shared/goal.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Input, Textarea } from '../ui/input.js';
import { Select } from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import { Field, SettingRow, SettingsSection } from './settings-ui.js';

export function AutomationSection({ appState, draft, update }: { appState: AppState; draft: SettingsPatch; update: (next: SettingsPatch) => void }) {
  return (
    <>
      <SettingsSection title="Agents & automation" description="Worker concurrency, recovery, Goal and Loop. Browser-opening authority stays explicit; restoring app state alone does not open stale worker chats.">
        <SettingRow title="Sub-agent workers" description="Maximum worker chats active at once."><Input className="w-20" type="number" min={1} max={8} value={draft.multiAgent.maxWorkers} onChange={(event) => update({ ...draft, multiAgent: { ...draft.multiAgent, maxWorkers: Number(event.target.value) || 1 } })} /></SettingRow>
        <SettingRow title="Enable sub-agents" description="Allow the agents tool to create and coordinate worker conversations."><Switch checked={draft.multiAgent.enabled} onCheckedChange={(checked) => update({ ...draft, multiAgent: { ...draft.multiAgent, enabled: checked } })} /></SettingRow>
        <SettingRow title="Allow unattributed calls" description="Permit self-contained calls when browser evidence cannot prove which chat sent them."><Switch checked={draft.multiAgent.allowUnattributedCalls} onCheckedChange={(checked) => update({ ...draft, multiAgent: { ...draft.multiAgent, allowUnattributedCalls: checked } })} /></SettingRow>
        <SettingRow title="Recover other chats’ tabs" description="Recover missing work tabs. Goal and Loop recover independently when needed."><Switch checked={draft.multiAgent.recoverAgentTabs} onCheckedChange={(checked) => update({ ...draft, multiAgent: { ...draft.multiAgent, recoverAgentTabs: checked } })} /></SettingRow>
        <SettingRow title="Automatic compact & resume" description="Move a long-running chat into a fresh conversation at the configured context threshold."><Switch checked={draft.compaction.auto} onCheckedChange={(checked) => update({ ...draft, compaction: { ...draft.compaction, auto: checked } })} /></SettingRow>
        <SettingRow title="Compaction threshold" description="Estimated context tokens for automatic compaction."><Input className="w-28" type="number" min={10000} max={4000000} step={10000} value={draft.compaction.autoTokens} onChange={(event) => update({ ...draft, compaction: { ...draft.compaction, autoTokens: Number(event.target.value) || 10000 } })} /></SettingRow>
        <SettingRow title="Keep recordings" description="0 keeps everything."><div className="flex items-center gap-2"><Input className="w-20" type="number" min={0} max={3650} value={draft.sessions.retainDays} onChange={(event) => update({ ...draft, sessions: { ...draft.sessions, retainDays: Number(event.target.value) || 0 } })} /><span className="text-xs text-muted-foreground">days</span></div></SettingRow>
        <SettingRow title="Session finish" description="Allow the tool that keeps Astra turns open for your next instruction."><Switch checked={draft.ui.finishTool === true} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, finishTool: checked } })} /></SettingRow>
      </SettingsSection>

      <SettingsSection title="Goal & Loop model" description="Choose where automatic continuation messages are generated.">
        <SettingRow title="Goal response source"><Select value={draft.goal.backend ?? 'api'} options={[{ value: 'api', label: 'API provider' }, { value: 'chatgpt', label: 'Separate ChatGPT chat' }, { value: 'templates', label: 'Offline templates' }]} onValueChange={(backend) => update({ ...draft, goal: { ...draft.goal, backend } })} ariaLabel="Goal response source" /></SettingRow>
        <SettingRow title="Loop response source"><Select value={draft.goal.loopBackend ?? 'api'} options={[{ value: 'api', label: 'API provider' }, { value: 'chatgpt', label: 'Separate ChatGPT chat' }]} onValueChange={(loopBackend) => update({ ...draft, goal: { ...draft.goal, loopBackend } })} ariaLabel="Loop response source" /></SettingRow>
        <SettingRow title="Provider"><Select value={draft.goal.provider.kind} options={[{ value: 'openrouter', label: 'OpenRouter' }, { value: 'custom', label: 'Custom OpenAI-compatible' }]} onValueChange={(kind) => update({ ...draft, goal: { ...draft.goal, provider: { ...draft.goal.provider, kind } } })} ariaLabel="Provider" /></SettingRow>
        {draft.goal.provider.kind === 'custom' && <Field label="Endpoint base URL"><Input value={draft.goal.provider.baseUrl} onChange={(event) => update({ ...draft, goal: { ...draft.goal, provider: { ...draft.goal.provider, baseUrl: event.target.value } } })} placeholder="http://localhost:11434/v1" /></Field>}
        <Field label="Model"><Input value={draft.goal.model} onChange={(event) => update({ ...draft, goal: { ...draft.goal, model: event.target.value } })} /></Field>
        <SettingRow title="Reasoning"><Select value={draft.goal.reasoning} options={[{ value: 'default', label: 'Default' }, { value: 'minimal', label: 'Minimal' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} onValueChange={(reasoning) => update({ ...draft, goal: { ...draft.goal, reasoning } })} ariaLabel="Reasoning" /></SettingRow>
        <SettingRow title="API credential" description={appState.hasGoalKey ? 'A provider key is stored securely.' : 'No provider key is stored. Keyless local custom endpoints may not need one.'}><Button size="sm" onClick={() => { const value = window.prompt('Goal/API provider key'); if (value !== null) void unwrap(api.setGoalKey(value)); }}>{appState.hasGoalKey ? 'Replace key' : 'Add key'}</Button></SettingRow>
      </SettingsSection>

      <SettingsSection title="Continuation prompts" description="Editable instructions used by Goal and Loop.">
        <Field label="Goal prompt, no task"><Textarea rows={7} value={draft.goal.prompt} onChange={(event) => update({ ...draft, goal: { ...draft.goal, prompt: event.target.value } })} /><Button size="sm" variant="ghost" onClick={() => update({ ...draft, goal: { ...draft.goal, prompt: DEFAULT_GOAL_SYSTEM_PROMPT } })}>Restore default</Button></Field>
        <Field label="Goal prompt, with a task"><Textarea rows={7} value={draft.goal.objectivePrompt} onChange={(event) => update({ ...draft, goal: { ...draft.goal, objectivePrompt: event.target.value } })} /><Button size="sm" variant="ghost" onClick={() => update({ ...draft, goal: { ...draft.goal, objectivePrompt: DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT } })}>Restore default</Button></Field>
        <Field label="Loop prompt"><Textarea rows={7} value={draft.goal.loopPrompt} onChange={(event) => update({ ...draft, goal: { ...draft.goal, loopPrompt: event.target.value } })} /><Button size="sm" variant="ghost" onClick={() => update({ ...draft, goal: { ...draft.goal, loopPrompt: DEFAULT_GOAL_LOOP_SYSTEM_PROMPT } })}>Restore default</Button></Field>
      </SettingsSection>
    </>
  );
}
