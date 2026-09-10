import type { SettingsPatch } from '../../../preload/index.js';
import type { AppState } from '../../../shared/types.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Icon } from '../ui/icon.js';
import { Input } from '../ui/input.js';
import { Select } from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import { Field, SettingRow, SettingsSection } from './settings-ui.js';

export function ConnectionSection({ appState, draft, update }: { appState: AppState; draft: SettingsPatch; update: (next: SettingsPatch) => void }) {
  const status = appState.status;
  const connected = status.state === 'connected' || status.state === 'offline' || status.state === 'starting-server' || status.state === 'connecting-tunnel';
  return (
    <SettingsSection title="Connection" description="The local services stay in one Electron main process. IPC is only the sandboxed renderer transport; application services call each other directly in-process.">
      <SettingRow title={connected ? 'Connector is running' : 'Connector is stopped'} description={status.detail || 'Connect when you want ChatGPT to reach this computer.'}>
        <Button variant={connected ? 'secondary' : 'default'} onClick={() => void unwrap(connected ? api.disconnect() : api.connect())}><Icon name="i-power" />{connected ? 'Disconnect' : 'Connect'}</Button>
      </SettingRow>
      <SettingRow title="Method" description="OpenAI Secure MCP Tunnel is the normal remote transport.">
        <Select value={draft.tunnel.kind} options={[{ value: 'openai', label: 'OpenAI Secure MCP Tunnel' }, { value: 'cloudflared', label: 'Cloudflare quick tunnel' }, { value: 'manual', label: 'Local only' }]} onValueChange={(kind) => update({ ...draft, tunnel: { ...draft.tunnel, kind } })} ariaLabel="Connection method" />
      </SettingRow>
      <Field label="Core tunnel ID"><Input value={draft.tunnel.tunnelId} onChange={(event) => update({ ...draft, tunnel: { ...draft.tunnel, tunnelId: event.target.value } })} placeholder="tunnel_…" spellCheck={false} /></Field>
      <Field label="Desktop tunnel ID" hint="Optional. Desktop is a separate connector because it has a separate permission boundary."><Input value={draft.tunnel.desktopTunnelId} onChange={(event) => update({ ...draft, tunnel: { ...draft.tunnel, desktopTunnelId: event.target.value } })} placeholder="tunnel_…" spellCheck={false} /></Field>
      <SettingRow title="Tunnel API key" description={appState.hasApiKey ? 'A key is stored securely.' : 'Required by the OpenAI tunnel method.'}>
        <Button size="sm" onClick={() => {
          const value = window.prompt('Tunnel API key');
          if (value !== null) void unwrap(api.setApiKey(value));
        }}><Icon name="i-key" />{appState.hasApiKey ? 'Replace' : 'Add key'}</Button>
      </SettingRow>
      <SettingRow title="Connect automatically" description="Start the configured connector when the app starts."><Switch checked={draft.ui.autoConnect} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, autoConnect: checked } })} /></SettingRow>
      <SettingRow title="Keep running when closed" description="Closing the window keeps the main process and local services available."><Switch checked={draft.ui.minimizeToTray} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, minimizeToTray: checked } })} /></SettingRow>
    </SettingsSection>
  );
}
