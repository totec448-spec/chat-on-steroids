import type { SettingsPatch } from '../../../preload/index.js';
import type { AppState, Capability } from '../../../shared/types.js';
import { CAPABILITIES, WRITE_CAPABILITIES } from '../../../shared/types.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Icon } from '../ui/icon.js';
import { Switch } from '../ui/switch.js';
import { SettingRow, SettingsSection } from './settings-ui.js';

const labels: Record<Capability, [string, string]> = {
  browse: ['Browse folders', 'List approved folders and files.'],
  search: ['Search files', 'Search text and filenames inside approved folders.'],
  read: ['Read files', 'Open files inside approved folders.'],
  metadata: ['Read metadata', 'Inspect file and folder metadata.'],
  create: ['Create files', 'Create new files inside approved folders.'],
  edit: ['Edit files', 'Change approved files.'],
  move: ['Move files', 'Move or rename approved files.'],
  deleteFile: ['Delete files', 'Delete files inside approved folders.'],
  command: ['Run commands', 'Execute local commands in the conversation workspace.'],
  saveArtifact: ['Save artifacts', 'Write generated artifacts into approved folders.'],
  screen: ['View screen', 'Let Desktop observe the current display.'],
  control: ['Control desktop', 'Let Desktop use mouse and keyboard.'],
  clipboardRead: ['Read clipboard', 'Let Desktop read clipboard content.'],
  clipboardWrite: ['Write clipboard', 'Let Desktop place content on the clipboard.'],
};

export function PermissionsSection({ appState, draft, update }: { appState: AppState; draft: SettingsPatch; update: (next: SettingsPatch) => void }) {
  const setCapability = (key: Capability, checked: boolean) => {
    const capabilities = { ...draft.capabilities, [key]: checked };
    if (draft.readOnly && WRITE_CAPABILITIES.includes(key) && checked) return;
    update({ ...draft, capabilities });
  };
  return (
    <>
      <SettingsSection title="Permissions" description="These are model-facing capabilities. Disabled capabilities are not advertised to ChatGPT.">
        <SettingRow title="Read-only mode" description="Blocks every capability that can change files, run commands, control the desktop, or write the clipboard.">
          <Switch
            checked={draft.readOnly}
            onCheckedChange={(checked) => {
              const capabilities = checked
                ? Object.fromEntries(Object.entries(draft.capabilities).map(([key, value]) => [key, WRITE_CAPABILITIES.includes(key as Capability) ? false : value])) as SettingsPatch['capabilities']
                : draft.capabilities;
              update({ ...draft, readOnly: checked, capabilities });
            }}
          />
        </SettingRow>
        {CAPABILITIES.map((key) => {
          const write = WRITE_CAPABILITIES.includes(key);
          return <SettingRow key={key} title={labels[key][0]} description={labels[key][1]}><Switch checked={draft.capabilities[key]} disabled={draft.readOnly && write} onCheckedChange={(checked) => setCapability(key, checked)} /></SettingRow>;
        })}
      </SettingsSection>
      <SettingsSection title="Approved folders" description="Folders are approved here or directly from a conversation. A conversation can then use its selected folder as its working directory.">
        {appState.config.roots.map((root) => (
          <SettingRow key={root.name} title={`/${root.name}`} description={root.path}>
            <Button variant="destructive" size="sm" onClick={() => void unwrap(api.removeRoot(root.name))}><Icon name="i-trash" className="size-3.5" />Remove</Button>
          </SettingRow>
        ))}
        {!appState.config.roots.length && <div className="px-4 py-5 text-xs text-muted-foreground">No folders approved yet. Select one from the conversation composer when you need filesystem access.</div>}
        <div className="p-3"><Button onClick={() => void unwrap(api.addRoot())}><Icon name="i-folder" />Approve folder</Button></div>
      </SettingsSection>
    </>
  );
}
