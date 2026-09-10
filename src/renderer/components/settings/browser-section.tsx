import { useEffect, useState } from 'react';
import type { SettingsPatch } from '../../../preload/index.js';
import type { BrowserPreferences } from '../../../shared/browser-preferences.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Textarea } from '../ui/input.js';
import { Select } from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import { Field, SettingRow, SettingsSection } from './settings-ui.js';

export function BrowserSection({ draft, update }: { draft: SettingsPatch; update: (next: SettingsPatch) => void }) {
  const [browserPreferences, setBrowserPreferences] = useState<BrowserPreferences | null>(null);
  const [browserStatus, setBrowserStatus] = useState('Not checked');
  const requestBrowserPreferences = async (patch: Partial<BrowserPreferences> = {}) => {
    setBrowserStatus('Waiting for browser confirmation…');
    try {
      const confirmed = await unwrap(api.browserPreferences(patch));
      setBrowserPreferences(confirmed);
      setBrowserStatus('Confirmed by the browser extension.');
    } catch (error) {
      setBrowserPreferences(null);
      setBrowserStatus(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => { void requestBrowserPreferences(); }, []);
  return (
    <>
      <SettingsSection title="Browser & history" description="The companion extension observes ChatGPT and carries explicitly authorized browser actions. It is required for sub-agents and browser-side session delivery.">
        <SettingRow title="Appearance" description="Use the app’s light or dark theme. Typography always uses the operating system’s UI font."><Select value={draft.ui.theme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} onValueChange={(theme) => update({ ...draft, ui: { ...draft.ui, theme } })} ariaLabel="Appearance" /></SettingRow>
        <SettingRow title="ChatGPT browser"><Select value={draft.ui.chatBrowser ?? 'chrome'} options={[{ value: 'chrome', label: 'Google Chrome / Chromium' }, { value: 'edge', label: 'Microsoft Edge' }, { value: 'brave', label: 'Brave' }]} onValueChange={(chatBrowser) => update({ ...draft, ui: { ...draft.ui, chatBrowser } })} ariaLabel="ChatGPT browser" /></SettingRow>
        <SettingRow title="Background chats" description="Keep app-created ChatGPT tabs in the background."><Switch checked={draft.ui.backgroundChats === true} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, backgroundChats: checked } })} /></SettingRow>
        <SettingRow title="Automatic plugin refresh" description="Refresh connector tools after plugin changes."><Switch checked={draft.ui.autoRefreshPlugins === true} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, autoRefreshPlugins: checked } })} /></SettingRow>
        <SettingRow title="Browser only" description="Disable automatic tab opening for maintenance/recovery while keeping explicit actions available."><Switch checked={draft.ui.browserOnly === true} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, browserOnly: checked } })} /></SettingRow>
        <SettingRow title="Privacy screenshots" description="Default screenshots to the active window instead of the full monitor."><Switch checked={draft.ui.privacyScreenshots} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, privacyScreenshots: checked } })} /></SettingRow>
        <SettingRow title="Developer mode" description="Show turn boundaries and recovery events in the local timeline."><Switch checked={draft.ui.developerMode === true} onCheckedChange={(checked) => update({ ...draft, ui: { ...draft.ui, developerMode: checked } })} /></SettingRow>
        <SettingRow title="Overwrite browser composer" description="Browser-owned preference; confirmed by the extension instead of stored in app settings."><Switch checked={browserPreferences?.overwrite ?? false} disabled={!browserPreferences} onCheckedChange={(checked) => void requestBrowserPreferences({ overwrite: checked })} /></SettingRow>
        <SettingRow title="Show durations in browser" description={browserStatus}><Switch checked={browserPreferences?.durations ?? false} disabled={!browserPreferences} onCheckedChange={(checked) => void requestBrowserPreferences({ durations: checked })} /></SettingRow>
        <div className="flex flex-wrap gap-2 p-3"><Button onClick={() => void unwrap(api.openExtensionFolder())}>Open extension folder</Button><Button onClick={() => void unwrap(api.downloadExtension())}>Download extension ZIP</Button><Button variant="destructive" onClick={() => void unwrap(api.unpairExtension())}>Disconnect browser</Button></div>
      </SettingsSection>
      <SettingsSection title="Connector instructions" description="Added to the model-facing connector instructions after the built-in contract.">
        <Field label="Your instructions"><Textarea rows={6} maxLength={4000} value={draft.mcp.instructions} onChange={(event) => update({ ...draft, mcp: { ...draft.mcp, instructions: event.target.value } })} placeholder="Always run the test suite before saying a change works." /></Field>
      </SettingsSection>
    </>
  );
}
