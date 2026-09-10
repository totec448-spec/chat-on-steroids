import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginCatalogEntry, PluginConfigPatch, PluginSnapshot, PluginSource, PluginView } from '../../../shared/plugins.js';
import type { AppState } from '../../../shared/types.js';
import { api, applyAppState, unwrap } from '../../state/app-store.js';
import { settingsFromState } from '../../state/settings.js';
import { Badge, Card } from '../ui/card.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Icon } from '../ui/icon.js';
import { Input } from '../ui/input.js';
import { Select } from '../ui/select.js';
import { Switch } from '../ui/switch.js';

const artwork = import.meta.glob('../../plugin-icons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
function iconUrl(id: string): string { return artwork[`../../plugin-icons/${id}.svg`] ?? artwork['../../plugin-icons/custom.svg'] ?? ''; }

function PluginIcon({ id, className = '' }: { id: string; className?: string }) {
  return <img src={iconUrl(id)} alt="" className={`size-10 shrink-0 rounded-xl object-contain ${className}`} />;
}

function statusLabel(plugin: PluginView): string {
  if (plugin.status === 'error') return 'Needs attention';
  if (plugin.status === 'needs-auth') return 'Sign in needed';
  if (plugin.status === 'authenticating') return 'Signing in…';
  if (plugin.status === 'ready') return plugin.tools.length ? 'Ready' : 'Connected · no tools';
  if (plugin.status === 'connecting') return 'Connecting…';
  if (plugin.status === 'disabled') return 'Disabled';
  return 'Installed';
}

function PluginTools({ plugin, mutate }: { plugin: PluginView; mutate: (work: ReturnType<typeof api.pluginsSnapshot>, notify?: boolean) => Promise<void> }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {plugin.tools.map((tool) => (
        <label key={tool.name} className="flex min-h-14 items-center gap-3 border-b border-border px-4 py-3 last:border-0">
          <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{tool.name}</div><div className="mt-0.5 text-xs leading-5 text-muted-foreground">{tool.description || tool.exposedName}{tool.enabled && tool.published === false ? ` · ${tool.exposureError ?? 'Not currently published in ChatGPT'}` : ''}</div></div>
          <Switch checked={tool.enabled} disabled={!plugin.enabled} onCheckedChange={(checked) => void mutate(api.pluginsSetToolEnabled(plugin.id, tool.name, checked))} />
        </label>
      ))}
      {!plugin.tools.length && <div className="px-4 py-8 text-center text-xs text-muted-foreground">No tools discovered yet.</div>}
    </div>
  );
}

function ConfigurePlugin({ plugin, recipe, open, onOpenChange, mutate }: { plugin: PluginView; recipe?: PluginCatalogEntry; open: boolean; onOpenChange: (open: boolean) => void; mutate: (work: ReturnType<typeof api.pluginsSnapshot>, notify?: boolean) => Promise<void> }) {
  const fields = plugin.fields ?? recipe?.fields ?? [];
  const [name, setName] = useState(plugin.name);
  const [config, setConfig] = useState<Record<string, string>>(() => ({ ...plugin.config }));
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [sourceText, setSourceText] = useState(JSON.stringify(plugin.source, null, 2));
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setName(plugin.name); setConfig({ ...plugin.config }); setCredentials({}); setSourceText(JSON.stringify(plugin.source, null, 2)); setError(''); } }, [open, plugin]);
  async function save(): Promise<void> {
    try {
      const source = JSON.parse(sourceText) as PluginSource;
      const patch: PluginConfigPatch = { name, config, credentials: Object.fromEntries(Object.entries(credentials).filter(([, value]) => value)) };
      if (JSON.stringify(source) !== JSON.stringify(plugin.source)) patch.source = source;
      await mutate(api.pluginsConfigure(plugin.id, patch)); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
      <div className="flex items-start gap-4 border-b border-border px-5 py-4"><PluginIcon id={recipe?.icon ?? plugin.catalogId ?? 'custom'} /><div className="min-w-0 flex-1"><DialogTitle className="text-base font-semibold">Configure {plugin.name}</DialogTitle><DialogDescription className="mt-1 text-xs text-muted-foreground">Credentials remain in secure storage. Leave a secret blank to keep its current value.</DialogDescription></div><DialogClose className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"><Icon name="i-x" /></DialogClose></div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-5"><div className="grid gap-4">
        <label className="grid gap-1.5 text-xs"><span className="font-medium">Display name</span><Input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {fields.map((field) => <label key={field.key} className="grid gap-1.5 text-xs"><span className="font-medium">{field.label}</span><Input type={field.secret ? 'password' : 'text'} value={field.secret ? credentials[field.key] ?? '' : config[field.key] ?? ''} placeholder={field.secret && plugin.credentialKeys.includes(field.key) ? 'Saved · leave blank to keep' : field.placeholder} onChange={(event) => field.secret ? setCredentials((current) => ({ ...current, [field.key]: event.target.value })) : setConfig((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}
        {Object.entries(plugin.config).filter(([key]) => !fields.some((field) => field.key === key)).map(([key, value]) => <label key={key} className="grid gap-1.5 text-xs"><span className="font-medium">{key}</span><Input value={config[key] ?? value} onChange={(event) => setConfig((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
        <label className="grid gap-1.5 text-xs"><span className="font-medium">Server configuration</span><textarea className="min-h-32 rounded-md border border-input bg-background p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring/15" value={sourceText} onChange={(event) => setSourceText(event.target.value)} spellCheck={false} /></label>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div></div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3"><DialogClose className="h-8 rounded-md px-3 text-xs hover:bg-accent">Cancel</DialogClose><Button variant="default" onClick={() => void save()}>Save & reconnect</Button></div>
    </DialogContent></Dialog>
  );
}

function InstallRecipe({ recipe, open, onOpenChange, install }: { recipe: PluginCatalogEntry | null; open: boolean; onOpenChange: (open: boolean) => void; install: (request: Parameters<typeof api.pluginsInstall>[0]) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({}); const [error, setError] = useState('');
  useEffect(() => { if (open) { setValues({}); setError(''); } }, [open, recipe?.id]);
  if (!recipe) return null;
  async function submit(): Promise<void> {
    for (const field of recipe!.fields) if (field.required && !(values[field.key] ?? '').trim()) { setError(`${field.label} is required.`); return; }
    const config: Record<string, string> = {}, credentials: Record<string, string> = {};
    for (const field of recipe!.fields) (field.secret ? credentials : config)[field.key] = values[field.key] ?? '';
    try { await install({ catalogId: recipe!.id, config, credentials }); onOpenChange(false); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><div className="flex items-start gap-4 border-b border-border px-5 py-4"><PluginIcon id={recipe.icon} /><div className="min-w-0 flex-1"><DialogTitle className="text-base font-semibold">Set up {recipe.name}</DialogTitle><DialogDescription className="mt-1 text-xs leading-5 text-muted-foreground">{recipe.description}</DialogDescription></div><DialogClose className="rounded-md p-1.5 hover:bg-accent"><Icon name="i-x" /></DialogClose></div><div className="max-h-[70vh] overflow-y-auto px-5 py-5"><div className="grid gap-4">{recipe.tools?.length ? <div><div className="mb-2 text-xs font-medium">Tool preview</div><div className="flex flex-wrap gap-1.5">{recipe.tools.map((tool) => <Badge key={tool}>{tool}</Badge>)}</div></div> : null}{recipe.instructions.length ? <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-muted-foreground">{recipe.instructions.map((step) => <li key={step}>{step}</li>)}</ol> : null}{recipe.fields.map((field) => <label key={field.key} className="grid gap-1.5 text-xs"><span className="font-medium">{field.label}{field.required ? ' *' : ''}</span><Input type={field.secret ? 'password' : 'text'} value={values[field.key] ?? ''} placeholder={field.placeholder} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}<p className="text-xs leading-5 text-muted-foreground">License: {recipe.license}. Local integrations run as your OS user; install only code you trust.</p>{error && <p className="text-xs text-destructive">{error}</p>}</div></div><div className="flex justify-end gap-2 border-t border-border px-5 py-3"><Button onClick={() => void api.openLink(recipe.homepage)}>Project & setup guide</Button><Button variant="default" onClick={() => void submit()}>{recipe.source.kind === 'remote' ? 'Add connection' : 'Install & connect'}</Button></div></DialogContent></Dialog>;
}

function CustomPluginDialog({ open, onOpenChange, install }: { open: boolean; onOpenChange: (open: boolean) => void; install: (request: Parameters<typeof api.pluginsInstall>[0]) => Promise<void> }) {
  const [name, setName] = useState('My MCP server'); const [kind, setKind] = useState<PluginSource['kind']>('remote'); const [location, setLocation] = useState(''); const [version, setVersion] = useState(''); const [args, setArgs] = useState('[]'); const [key, setKey] = useState(''); const [secret, setSecret] = useState(''); const [error, setError] = useState('');
  async function submit(): Promise<void> { try { const parsed = JSON.parse(args) as unknown; if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('Arguments must be a JSON array of strings.'); if (!location.trim()) throw new Error('Enter the server location.'); const source: PluginSource = { kind, args: parsed }; if (kind === 'remote' || kind === 'github') source.url = location.trim(); else if (kind === 'mcpb') source.path = location.trim(); else if (kind === 'command') source.command = location.trim(); else { source.package = location.trim(); if (version.trim()) source.version = version.trim(); } await install({ name, source, credentials: key.trim() && secret ? { [key.trim()]: secret } : {} }); onOpenChange(false); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><div className="border-b border-border px-5 py-4"><DialogTitle className="text-base font-semibold">Connect an MCP server</DialogTitle><DialogDescription className="mt-1 text-xs text-muted-foreground">Local servers run outside the approved-folder sandbox. Review the code before installing it.</DialogDescription></div><div className="grid max-h-[70vh] gap-4 overflow-y-auto px-5 py-5"><label className="grid gap-1.5 text-xs"><span className="font-medium">Display name</span><Input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="grid gap-1.5 text-xs"><span className="font-medium">Server type</span><Select value={kind} options={[{ value: 'remote', label: 'Remote Streamable HTTP' }, { value: 'npm', label: 'npm package' }, { value: 'python', label: 'Python package (uv)' }, { value: 'command', label: 'Custom executable' }, { value: 'github', label: 'GitHub repository' }, { value: 'mcpb', label: 'MCPB bundle' }]} onValueChange={setKind} ariaLabel="Server type" /></label><label className="grid gap-1.5 text-xs"><span className="font-medium">Package, executable, URL or bundle path</span><Input value={location} onChange={(event) => setLocation(event.target.value)} /></label>{(kind === 'npm' || kind === 'python') && <label className="grid gap-1.5 text-xs"><span className="font-medium">Version</span><Input value={version} onChange={(event) => setVersion(event.target.value)} /></label>}<label className="grid gap-1.5 text-xs"><span className="font-medium">Arguments (JSON array)</span><Input value={args} onChange={(event) => setArgs(event.target.value)} spellCheck={false} /></label><label className="grid gap-1.5 text-xs"><span className="font-medium">Credential name (optional)</span><Input value={key} onChange={(event) => setKey(event.target.value)} /></label><label className="grid gap-1.5 text-xs"><span className="font-medium">Credential value</span><Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} /></label>{error && <p className="text-xs text-destructive">{error}</p>}</div><div className="flex justify-end gap-2 border-t border-border px-5 py-3"><DialogClose className="h-8 rounded-md px-3 text-xs hover:bg-accent">Cancel</DialogClose><Button variant="default" onClick={() => void submit()}>Install & connect</Button></div></DialogContent></Dialog>;
}

export function PluginsPage({ appState }: { appState: AppState }) {
  const [snapshot, setSnapshot] = useState<PluginSnapshot>({ plugins: [], catalog: [], schemaRevision: 0 }); const [query, setQuery] = useState(''); const [selected, setSelected] = useState<PluginView | null>(null); const [configure, setConfigure] = useState<PluginView | null>(null); const [recipe, setRecipe] = useState<PluginCatalogEntry | null>(null); const [custom, setCustom] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const [setupOpen, setSetupOpen] = useState(false); const [setupTunnelId, setSetupTunnelId] = useState(''); const [setupBase, setSetupBase] = useState<ReturnType<typeof settingsFromState> | null>(null); const [setupError, setSetupError] = useState('');
  const refresh = useCallback(async () => { try { setSnapshot(await unwrap(api.pluginsSnapshot())); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } }, []);
  useEffect(() => { void refresh(); return api.onPluginsChanged(setSnapshot); }, [refresh]);
  const mutate = useCallback(async (work: ReturnType<typeof api.pluginsSnapshot>, notify = true) => { setBusy(true); try { setSnapshot(await unwrap(work)); if (notify) setMessage('Saved. Refresh the Plugins connector in ChatGPT to publish changed tools.'); } finally { setBusy(false); } }, []);
  const install = useCallback(async (request: Parameters<typeof api.pluginsInstall>[0]) => mutate(api.pluginsInstall(request)), [mutate]);
  const available = useMemo(() => snapshot.catalog.filter((candidate) => !snapshot.plugins.some((plugin) => plugin.catalogId === candidate.id || (plugin.source.kind === candidate.source.kind && (((candidate.source.kind === 'npm' || candidate.source.kind === 'python') && plugin.source.package === candidate.source.package) || (candidate.source.kind === 'remote' && plugin.source.url === candidate.source.url))))), [snapshot]);
  const needle = query.trim().toLowerCase(); const installed = snapshot.plugins.filter((plugin) => `${plugin.name} ${snapshot.catalog.find((item) => item.id === plugin.catalogId)?.description ?? ''}`.toLowerCase().includes(needle)); const catalog = available.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(needle));
  const pluginSurface = appState.status.surfaces.find((surface) => surface.id === 'plugins');
  const openSetup = () => { const base = settingsFromState(appState); setSetupBase(base); setSetupTunnelId(base.tunnel.pluginsTunnelId ?? ''); setSetupError(''); setSetupOpen(true); };
  const saveSetup = async () => {
    if (!setupBase || busy) return;
    setBusy(true); setSetupError('');
    try {
      const patch = structuredClone(setupBase);
      patch.tunnel.pluginsTunnelId = setupTunnelId.trim();
      applyAppState(await unwrap(api.saveSettings(patch, setupBase)));
      applyAppState(await unwrap(api.connect()));
      setSetupOpen(false); setMessage('Plugin connector saved. Refresh Chat On Steroids Plugins in ChatGPT after plugin changes.');
    } catch (cause) { setSetupError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-panel="plugins"><header className="flex h-12 items-center gap-3 border-b border-border px-5"><div><h1 className="text-sm font-semibold">Plugins</h1></div><label className="relative ml-auto w-64"><Icon name="i-search" className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input id="pluginsSearch" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 pl-8" placeholder="Search plugins" /></label><Button id="pluginsRefresh" size="icon-sm" variant="ghost" onClick={() => void refresh()}><Icon name="i-retry" className="size-3.5" /></Button></header><div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-5xl px-6 py-8">
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"><div className="min-w-0 flex-1"><div className="text-[13px] font-medium">Chat On Steroids Plugins</div><div className="mt-0.5 text-xs text-muted-foreground">{pluginSurface?.state === 'live' ? pluginSurface.lastRequestAt ? 'Connected to ChatGPT' : 'Connector online · waiting for ChatGPT' : appState.config.tunnel.pluginsTunnelId ? 'Plugins connector offline' : 'Set up the shared plugin connector once in ChatGPT before first use.'}</div></div><Badge>{pluginSurface?.tools.length ?? 0} tools</Badge><Button size="sm" onClick={openSetup}>Plugin setup</Button><Button size="sm" onClick={() => void api.openLink('https://chatgpt.com/#settings/Plugins')}>Open ChatGPT plugins</Button></div>
    <p className="mt-2 text-xs text-muted-foreground">After installing, updating, or changing enabled plugins, refresh Chat On Steroids Plugins in ChatGPT.</p>
    <div className="mt-8 flex items-center"><div><h2 className="text-base font-semibold">Installed</h2><p className="mt-1 text-xs text-muted-foreground">{snapshot.plugins.length} installed</p></div><Button id="pluginsAdd" variant="default" className="ml-auto" onClick={() => setCustom(true)}><Icon name="i-plus" />Add MCP server</Button></div>
    <div id="pluginsInstalled" className="mt-4 grid gap-3 md:grid-cols-2">{installed.map((plugin) => { const found = snapshot.catalog.find((item) => item.id === plugin.catalogId); return <Card key={plugin.id} className="relative overflow-hidden"><button type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent/40" onClick={() => setSelected(plugin)}><PluginIcon id={found?.icon ?? plugin.catalogId ?? 'custom'} /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{plugin.name}</div><div className="mt-1 flex items-center gap-2"><Badge className={plugin.status === 'error' ? 'text-destructive' : ''}>{statusLabel(plugin)}</Badge><span className="text-[11px] text-muted-foreground">{plugin.tools.filter((tool) => tool.enabled).length} tools enabled</span></div></div></button><DropdownMenu><DropdownMenuTrigger className="absolute right-2 top-2 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label={`Actions for ${plugin.name}`}>•••</DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void mutate(api.pluginsSetEnabled(plugin.id, !plugin.enabled))}>{plugin.enabled ? 'Disable' : 'Enable'}</DropdownMenuItem><DropdownMenuItem onClick={() => setConfigure(plugin)}>Configure</DropdownMenuItem><DropdownMenuItem onClick={() => void mutate(api.pluginsRestart(plugin.id))}>Restart</DropdownMenuItem><DropdownMenuItem onClick={() => void mutate(api.pluginsUpdate(plugin.id))}>Update</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onClick={() => { if (window.confirm(`Uninstall ${plugin.name}? This deletes its Chat On Steroids-managed data and credentials.`)) void mutate(api.pluginsUninstall(plugin.id)); }}>Uninstall</DropdownMenuItem></DropdownMenuContent></DropdownMenu>{plugin.error && <div className="border-t border-border px-4 py-2 text-xs text-destructive">{plugin.error}</div>}</Card>; })}{!installed.length && <div className="col-span-full rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">{needle ? 'No installed plugins match your search.' : 'No plugins installed yet.'}</div>}</div>
    <div className="mt-9"><h2 className="text-base font-semibold">Explore plugins</h2><p className="mt-1 text-xs text-muted-foreground">Reviewed integrations and independent MCP servers.</p></div><div id="pluginsExplore" className="mt-4 grid gap-3 md:grid-cols-2">{catalog.map((item) => <button key={item.id} type="button" onClick={() => setRecipe(item)} className="flex items-center gap-3 rounded-xl border border-border p-4 text-left hover:bg-accent"><PluginIcon id={item.icon} /><div className="min-w-0"><div className="text-[13px] font-semibold">{item.name}</div><div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</div></div></button>)}{!catalog.length && <div className="col-span-full py-5 text-xs text-muted-foreground">{needle ? 'No matching plugins available.' : 'All catalog plugins are installed.'}</div>}</div>
    <div className="mt-8 flex items-center gap-2 border-t border-border pt-5 text-xs text-muted-foreground"><button className="hover:text-foreground" type="button" onClick={() => void unwrap(api.openLegalNotices())}>Third-party licenses</button><span>·</span><span>Local plugins run as your OS user, not inside the file sandbox.</span></div>{message && <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p>}{busy && <div className="fixed inset-x-0 bottom-0 h-0.5 bg-foreground/70" />}
  </div></div>
  <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>{selected && <DialogContent><div className="flex items-start gap-4 border-b border-border px-5 py-4"><PluginIcon id={snapshot.catalog.find((item) => item.id === selected.catalogId)?.icon ?? selected.catalogId ?? 'custom'} /><div className="min-w-0 flex-1"><DialogTitle className="text-base font-semibold">{selected.name}</DialogTitle><DialogDescription className="mt-1 text-xs text-muted-foreground">{snapshot.catalog.find((item) => item.id === selected.catalogId)?.description ?? 'MCP integration'}</DialogDescription></div><DialogClose className="rounded-md p-1.5 hover:bg-accent"><Icon name="i-x" /></DialogClose></div><div className="max-h-[70vh] overflow-y-auto px-5 py-5">{(selected.status === 'needs-auth' || selected.status === 'authenticating') && <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3 text-xs"><span className="flex-1">{selected.status === 'authenticating' ? 'Finish signing in through your browser.' : `Sign in to ${selected.name} to connect your account.`}</span><Button size="sm" variant="default" onClick={() => void mutate(selected.status === 'authenticating' ? api.pluginsCancelAuthentication(selected.id) : api.pluginsAuthenticate(selected.id), false)}>{selected.status === 'authenticating' ? 'Cancel sign-in' : 'Sign in'}</Button></div>}<div className="mb-3 flex items-center"><h3 className="text-sm font-semibold">Tools</h3><span className="ml-auto text-xs text-muted-foreground">{selected.tools.filter((tool) => tool.enabled).length}/{selected.tools.length} enabled</span></div><PluginTools plugin={selected} mutate={mutate} /><div className="mt-5 flex flex-wrap gap-2"><Button variant="default" onClick={() => { setConfigure(selected); setSelected(null); }}>Configure</Button><Button onClick={() => void mutate(api.pluginsRestart(selected.id))}>Restart</Button>{selected.homepage && <Button onClick={() => void api.openLink(selected.homepage!)}>Open upstream project</Button>}</div></div></DialogContent>}</Dialog>
  {configure && <ConfigurePlugin plugin={configure} recipe={snapshot.catalog.find((item) => item.id === configure.catalogId)} open onOpenChange={(open) => !open && setConfigure(null)} mutate={mutate} />}
  <InstallRecipe recipe={recipe} open={!!recipe} onOpenChange={(open) => !open && setRecipe(null)} install={install} />
  <CustomPluginDialog open={custom} onOpenChange={setCustom} install={install} />
  <Dialog open={setupOpen} onOpenChange={(open) => { setSetupOpen(open); if (!open) setSetupBase(null); }}><DialogContent><div className="border-b border-border px-5 py-4"><DialogTitle className="text-base font-semibold">Plugin setup</DialogTitle><DialogDescription className="mt-1 text-xs leading-5 text-muted-foreground">Keep the plugin connector separate from the core connector, then add Chat On Steroids Plugins in ChatGPT.</DialogDescription></div><div className="grid gap-4 px-5 py-5"><label className="grid gap-1.5 text-xs"><span className="font-medium">Plugin tunnel ID</span><Input id="pluginsTunnelId" value={setupTunnelId} onChange={(event) => setSetupTunnelId(event.target.value)} placeholder="Your plugin tunnel ID" /></label><p className="text-xs leading-5 text-muted-foreground">After saving, open ChatGPT Plugins and refresh the connector whenever installed or enabled tools change.</p>{setupError && <p className="text-xs text-destructive">{setupError}</p>}</div><div className="flex justify-end gap-2 border-t border-border px-5 py-3"><Button onClick={() => void api.openLink('https://chatgpt.com/#settings/Plugins')}>Open ChatGPT plugins</Button><DialogClose className="h-8 rounded-md px-3 text-xs hover:bg-accent">Cancel</DialogClose><Button variant="default" disabled={busy} onClick={() => void saveSetup()}>{busy ? 'Saving…' : 'Save & connect'}</Button></div></DialogContent></Dialog>
  </section>;
}
