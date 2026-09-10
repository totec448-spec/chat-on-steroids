import { useEffect, useMemo, useState } from 'react';
import type { SettingsPatch } from '../../../preload/index.js';
import type { AppState } from '../../../shared/types.js';
import { api, applyAppState, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Icon } from '../ui/icon.js';
import { ScrollArea } from '../ui/scroll-area.js';
import { AutomationSection } from './automation-section.js';
import { BrowserSection } from './browser-section.js';
import { ConnectionSection } from './connection-section.js';
import { PermissionsSection } from './permissions-section.js';
import { settingsFromState } from '../../state/settings.js';

export function CustomizePage({ appState }: { appState: AppState }) {
  const authoritative = useMemo(() => settingsFromState(appState), [appState.config]);
  const [draft, setDraft] = useState<SettingsPatch>(authoritative);
  const [base, setBase] = useState<SettingsPatch>(authoritative);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [section, setSection] = useState<'permissions' | 'connection' | 'automation' | 'browser'>('permissions');

  useEffect(() => {
    if (dirty || saving) return;
    setDraft(authoritative); setBase(authoritative);
  }, [authoritative, dirty, saving]);

  const update = (next: SettingsPatch) => { setDraft(next); setDirty(true); setStatus(''); };
  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await unwrap(api.saveSettings(draft, base));
      applyAppState(next);
      const synced = settingsFromState(next);
      setDraft(synced); setBase(synced); setDirty(false); setStatus('Saved');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  const tabs = [
    ['permissions', 'Permissions', 'i-lock'], ['connection', 'Connection', 'i-globe'], ['automation', 'Agents & automation', 'i-bolt'], ['browser', 'Browser & history', 'i-monitor'],
  ] as const;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 bg-background" data-panel="customize">
      <aside className="hidden w-56 shrink-0 border-r border-border p-3 lg:block">
        <div className="mb-3 px-2 text-xs font-semibold text-foreground">Customize</div>
        <nav className="space-y-0.5">{tabs.map(([id, label, icon]) => <button key={id} type="button" onClick={() => setSection(id)} className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${section === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}><Icon name={icon} className="size-3.5" />{label}</button>)}</nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-5"><h1 className="text-sm font-semibold">Customize</h1><div className="ml-auto flex items-center gap-2"><span className="text-xs text-muted-foreground" role="status">{status}</span>{dirty && <Button variant="ghost" size="sm" onClick={() => { setDraft(base); setDirty(false); }}>Discard</Button>}<Button variant="default" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</Button></div></header>
        <ScrollArea className="flex-1"><div className="mx-auto w-full max-w-3xl px-6 pb-12 pt-2">
          {section === 'permissions' && <PermissionsSection appState={appState} draft={draft} update={update} />}
          {section === 'connection' && <ConnectionSection appState={appState} draft={draft} update={update} />}
          {section === 'automation' && <AutomationSection appState={appState} draft={draft} update={update} />}
          {section === 'browser' && <BrowserSection draft={draft} update={update} />}
        </div></ScrollArea>
      </div>
    </section>
  );
}
