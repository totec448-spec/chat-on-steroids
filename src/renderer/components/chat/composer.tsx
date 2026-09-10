import { useEffect, useRef, useState } from 'react';
import type { InputEntry, SessionControlsView } from '../../../preload/index.js';
import type { InputAttachment, InputAutomation } from '../../../shared/input.js';
import type { LocalProject } from '../../../shared/projects.js';
import type { SessionSummary } from '../../../shared/session.js';
import { api, unwrap } from '../../state/app-store.js';
import { useChatModels } from '../../state/chat-models.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Icon } from '../ui/icon.js';
import { Textarea } from '../ui/input.js';
import { TodoList } from './todo-list.js';

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Composer({
  session,
  projects,
  draftProjectId,
  controls,
  onProjectSelected,
  onSent,
  onControlsChanged,
  onDraftChanged,
  onOpenCustomize,
  planBackend,
}: {
  session: SessionSummary | null;
  projects: LocalProject[];
  draftProjectId: string | null;
  controls: SessionControlsView | null;
  onProjectSelected: (id: string | null) => void;
  onSent: (entry: InputEntry, followFreshSession: boolean) => void;
  onControlsChanged: (next?: SessionControlsView) => Promise<void> | void;
  onDraftChanged: () => void;
  onOpenCustomize: () => void;
  planBackend: 'api' | 'chatgpt';
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<InputAttachment[]>([]);
  const [newAutomation, setNewAutomation] = useState<InputAutomation>('off');
  const [delivery, setDelivery] = useState<'auto' | 'after-turn'>('auto');
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<{ objective: string; stages: string[] } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef('');
  const sendPending = useRef(false);
  const taskRequest = useRef<string | null>(null);
  const intentGeneration = useRef(0);
  const chatModels = useChatModels(session);
  const projectId = session?.projectId ?? draftProjectId;
  const project = projects.find((item) => item.id === projectId) ?? null;
  const automation: InputAutomation = session ? controls?.automation ?? 'off' : newAutomation;
  const automationRef = useRef<InputAutomation>(automation);
  automationRef.current = automation;
  const canInject = !!session && controls?.canInject === true && !!controls.activeTurnId;
  const canStop = !!session && !!controls?.activeTurnId && controls.stopPending !== true;

  useEffect(() => {
    textRef.current = '';
    setText('');
    setAttachments([]);
    setPlan(null);
    setStatus('');
    setDelivery('auto');
    if (!session) setNewAutomation('off');
    if (taskRequest.current) void api.cancelTaskRequest(taskRequest.current);
    taskRequest.current = null;
    ++intentGeneration.current;
  }, [session?.id]);

  useEffect(() => {
    if (!canInject && delivery !== 'auto') setDelivery('auto');
  }, [canInject, delivery]);

  async function chooseFiles(): Promise<void> {
    try {
      const next = await unwrap(api.chooseFiles());
      appendAttachments(next);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  function appendAttachments(next: InputAttachment[]): void {
    if (!next.length) return;
    setAttachments((current) => {
      const combined = [...current, ...next];
      if (combined.length > 20 || combined.reduce((sum, file) => sum + file.size, 0) > 512 * 1024 * 1024) {
        setStatus('Attach up to 20 files and 512 MB per message.');
        return current;
      }
      ++intentGeneration.current;
      onDraftChanged();
      return combined;
    });
  }

  async function chooseFolder(): Promise<void> {
    try {
      if (session?.projectId) {
        setStatus(`This conversation is already bound to ${project?.name ?? 'its folder'}. Start a new chat to use a different folder.`);
        return;
      }
      const selected = await unwrap(api.addProject(session?.id ?? null));
      if (!selected) return;
      onProjectSelected(selected.id);
      ++intentGeneration.current;
      onDraftChanged();
      setStatus(session ? `Folder attached to this conversation: ${selected.name}` : `New chat will use ${selected.name}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function setAutomationMode(mode: InputAutomation): Promise<void> {
    automationRef.current = mode;
    ++intentGeneration.current;
    onDraftChanged();
    if (!session) {
      setNewAutomation(mode);
      return;
    }
    if (!controls || controls.blocked) return;
    try {
      const next = await unwrap(api.setSessionAutomation(session.id, mode));
      await onControlsChanged(next);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function stopTurn(): Promise<void> {
    const turnId = controls?.activeTurnId;
    if (!session || !turnId || sendPending.current) return;
    sendPending.current = true;
    setSending(true); setStatus('Stopping current turn…');
    try {
      const next = await unwrap(api.stopSessionTurn(session.id, turnId));
      await onControlsChanged(next);
      setStatus('Stop requested.');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { sendPending.current = false; setSending(false); }
  }

  async function submit(): Promise<void> {
    const body = text.trim();
    if (!body) return;
    if (sendPending.current) return;
    if (!chatModels.selected) {
      setStatus(chatModels.catalog.state === 'pending' ? 'Waiting for ChatGPT model discovery…' : 'Choose a model before sending.');
      if (!chatModels.steps.length) void chatModels.refresh();
      return;
    }
    const planSnapshot = plan;
    if (planSnapshot?.stages.some((stage) => !stage.trim())) {
      setStatus('Every plan stage needs text before it can be sent.');
      return;
    }
    sendPending.current = true;
    setSending(true);
    setStatus('');
    const attachmentSnapshot = attachments;
    const selected = chatModels.selected;
    const originalIntent = intentGeneration.current;
    const requestedAutomation = automation;
    let goalRequestId: string | null = null;
    try {
      let outgoing = planSnapshot?.stages[0]?.trim() ?? body;
      let objective = planSnapshot?.objective;
      if (!session && requestedAutomation !== 'off' && !planSnapshot) {
        const requestId = crypto.randomUUID();
        goalRequestId = requestId;
        taskRequest.current = requestId;
        setStatus(requestedAutomation === 'loop' ? 'Preparing Loop opening…' : 'Preparing Goal opening…');
        const opening = await unwrap(api.draftGoalOpening(body, requestedAutomation, requestId));
        if (taskRequest.current !== requestId || originalIntent !== intentGeneration.current || textRef.current.trim() !== body || automationRef.current !== requestedAutomation) return;
        taskRequest.current = null;
        outgoing = opening.reply;
        objective = body;
      }
      const accepted = await unwrap(api.sendInput({
        id: crypto.randomUUID(),
        sessionId: session?.id ?? null,
        projectId: projectId ?? null,
        text: outgoing,
        mode: delivery,
        afterTurn: delivery === 'after-turn' || undefined,
        dueAt: Date.now(),
        model: selected.model,
        reasoningEffort: selected.effort,
        automation: requestedAutomation,
        attachments: attachmentSnapshot,
        objective,
        stages: planSnapshot?.stages.slice(1).map((stage) => stage.trim()),
      }));
      if (accepted.automation && automationRef.current !== accepted.automation) {
        await unwrap(api.setInputAutomation(accepted.id, automationRef.current));
      }
      const followFreshSession = originalIntent === intentGeneration.current && textRef.current.trim() === body;
      if (followFreshSession) { textRef.current = ''; setText(''); }
      setAttachments((current) => current === attachmentSnapshot ? [] : current);
      setPlan((current) => current === planSnapshot ? null : current);
      setStatus(accepted.mode === 'finish' ? 'Queued for session finish.' : accepted.mode === 'after-turn' ? 'Queued after the current turn.' : accepted.state === 'tool' ? 'Offered to the active turn.' : 'Sent.');
      onSent(accepted, followFreshSession);
      area.current?.focus();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (goalRequestId && taskRequest.current === goalRequestId) taskRequest.current = null;
      sendPending.current = false;
      setSending(false);
    }
  }

  async function createPlan(): Promise<void> {
    const objective = text.trim();
    if (planning && taskRequest.current) {
      const requestId = taskRequest.current;
      taskRequest.current = null;
      ++intentGeneration.current;
      void api.cancelTaskRequest(requestId);
      setPlanning(false); setPlan(null); setStatus('Plan cancelled.');
      return;
    }
    if (!objective) { area.current?.focus(); return; }
    setPlanning(true); setPlan(null); setStatus('Creating plan…');
    const requestId = crypto.randomUUID();
    taskRequest.current = requestId;
    const generation = intentGeneration.current;
    const dispose = api.onTaskProgress((progress) => {
      if (progress.requestId !== requestId || taskRequest.current !== requestId || generation !== intentGeneration.current) return;
      setStatus(progress.error || progress.text || (progress.phase === 'retrying' ? 'Planner is retrying…' : progress.phase === 'preparing' ? 'Preparing plan…' : progress.phase === 'ready' ? 'Plan ready' : 'Writing plan…'));
    });
    try {
      const stages = await unwrap(api.draftTaskPlan(objective, planBackend, requestId));
      if (taskRequest.current !== requestId || generation !== intentGeneration.current || textRef.current.trim() !== objective) return;
      setPlan({ objective, stages }); setStatus('Plan ready. Edit a stage or send the plan.');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally {
      dispose();
      if (taskRequest.current === requestId) {
        taskRequest.current = null;
        setPlanning(false);
      }
    }
  }

  async function onDrop(event: React.DragEvent): Promise<void> {
    event.preventDefault();
    if (!event.dataTransfer.files.length) return;
    try {
      const next = await unwrap(api.dropFiles([...event.dataTransfer.files]));
      appendAttachments(next);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  async function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    if (!event.clipboardData.files.length) return;
    event.preventDefault();
    try { appendAttachments(await unwrap(api.dropFiles([...event.clipboardData.files]))); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  return (
    <div className={`mx-auto w-full max-w-[760px] px-4 ${session ? 'pb-3' : 'pb-5'}`}>
      {!session && <div className="mb-2 flex min-h-7 flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <button type="button" onClick={() => void chooseFolder()} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground">
          <Icon name="i-folder" className="size-3.5" />
          <span>{project?.name ?? 'Select folder'}</span>
        </button>
        {project && <span>·</span>}
        {project && <span className="max-w-[260px] truncate" title={project.path}>{project.path}</span>}
        <span className="ml-auto">New chat</span>
      </div>}

      <form
        id="composer"
        className="overflow-hidden rounded-2xl border border-border bg-background"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void onDrop(event)}
      >
        {!!attachments.length && (
          <div id="composerImages" className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((file) => (
              <div key={file.id} className="group flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-2 text-xs">
                {file.preview ? <img src={file.preview} alt={file.name} className="size-8 rounded object-cover" /> : <Icon name={file.mimeType.startsWith('image/') ? 'i-image' : 'i-file'} className="size-4" />}
                <div className="min-w-0 flex-1"><div className="truncate text-foreground">{file.name}</div><div className="text-muted-foreground">{sizeLabel(file.size)}</div></div>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => { ++intentGeneration.current; onDraftChanged(); setAttachments((current) => current.filter((item) => item.id !== file.id)); }} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Icon name="i-x" className="size-3" /></button>
              </div>
            ))}
          </div>
        )}
        <Textarea
          id="chatInput"
          ref={area}
          value={text}
          onChange={(event) => {
            textRef.current = event.target.value;
            setText(event.target.value);
            ++intentGeneration.current;
            onDraftChanged();
            if (taskRequest.current) { void api.cancelTaskRequest(taskRequest.current); taskRequest.current = null; setPlanning(false); }
            if (plan && event.target.value.trim() !== plan.objective) setPlan(null);
          }}
          onPaste={(event) => void onPaste(event)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && text.trim()) { event.preventDefault(); void submit(); }
          }}
          rows={session ? 1 : 3}
          maxLength={16000}
          placeholder="Plan, build, / for skills, @ for context"
          className={session
            ? 'min-h-[42px] max-h-[128px] border-0 px-4 pt-3 pb-0 text-[14px] shadow-none focus:ring-0'
            : 'min-h-[86px] border-0 px-4 pt-4 pb-1 text-[14px] shadow-none focus:ring-0'}
        />
        <div className={`flex items-center gap-1.5 px-3 ${session ? 'pb-2' : 'pb-3'}`}>
          <DropdownMenu>
            <DropdownMenuTrigger className="grid size-8 place-items-center rounded-full bg-muted text-foreground outline-none hover:bg-accent" aria-label="Add context">
              <Icon name="i-plus" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem id="attachImages" onClick={() => void chooseFiles()}><Icon name="i-image" />Add photos &amp; files</DropdownMenuItem>
              <DropdownMenuItem id="composerFolder" onClick={() => void chooseFolder()}><Icon name="i-folder" />{project ? 'Folder for this chat' : 'Select folder for this chat'}</DropdownMenuItem>
              {session && <><DropdownMenuSeparator /><DropdownMenuItem id="createPlanMenu" disabled={!planning && !text.trim()} onClick={() => void createPlan()}><Icon name="i-steps" />{planning ? 'Cancel plan' : 'Create plan from draft'}</DropdownMenuItem></>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onOpenCustomize}><Icon name="i-gear" />Customize permissions</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger id="modelMenu" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-foreground outline-none hover:bg-accent">
              <span id="composerModelLabel">{chatModels.selected?.label ?? (chatModels.catalog.state === 'pending' ? 'Loading models…' : 'Select model')}</span><Icon name="i-down" className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[360px] w-72 overflow-auto">
              <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground"><span>ChatGPT model &amp; reasoning</span><Button id="refreshComposerModels" variant="ghost" size="icon-sm" onClick={() => void chatModels.refresh()}><Icon name="i-retry" className="size-3.5" /></Button></div>
              <DropdownMenuSeparator />
              {chatModels.steps.map((step) => (
                <DropdownMenuItem key={`${step.model}:${step.effort}`} onClick={() => chatModels.choose(step.model, step.effort)}>
                  <span className="flex-1">{step.modelLabel}</span><span className="text-xs text-muted-foreground">{step.effortLabel}</span>{chatModels.selected?.model === step.model && chatModels.selected.effort === step.effort && <Icon name="i-check" className="size-3.5" />}
                </DropdownMenuItem>
              ))}
              {!chatModels.steps.length && <div id="composerModelStatus" className="px-3 py-3 text-xs text-muted-foreground">{chatModels.catalog.error ?? 'Open ChatGPT and reload models.'}</div>}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger id="composerSettings" className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-foreground outline-none hover:bg-accent">
              {automation === 'off' ? 'Chat' : automation === 'goal' ? 'Goal' : 'Loop'}<Icon name="i-down" className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {(['off', 'goal', 'loop'] as const).map((mode) => <DropdownMenuItem key={mode} disabled={!!session && !!controls?.blocked} onClick={() => void setAutomationMode(mode)}><span className="flex-1 capitalize">{mode === 'off' ? 'Chat' : mode}</span>{automation === mode && <Icon name="i-check" className="size-3.5" />}</DropdownMenuItem>)}
              {session && <><DropdownMenuSeparator /><DropdownMenuItem disabled={!!controls?.blocked || !!controls?.job?.busy} onClick={() => void unwrap(api.compactSession(session.id)).then(onControlsChanged).catch((error) => setStatus(String(error)))}><Icon name="i-copy" />Compact &amp; resume</DropdownMenuItem>{controls?.job?.busy && <DropdownMenuItem onClick={() => void unwrap(api.cancelSessionCompaction(session.id)).then(onControlsChanged).catch((error) => setStatus(String(error)))}><Icon name="i-x" />Cancel compaction</DropdownMenuItem>}</>}
            </DropdownMenuContent>
          </DropdownMenu>

          {canInject && (
            <DropdownMenu>
              <DropdownMenuTrigger className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
                {delivery === 'auto' ? 'Inject now' : controls?.queueAtFinish ? 'At session finish' : 'After this turn'}<Icon name="i-down" className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDelivery('auto')}>Inject now{delivery === 'auto' && <Icon name="i-check" className="ml-auto size-3.5" />}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDelivery('after-turn')}>{controls?.queueAtFinish ? 'Queue at session finish' : 'After this turn'}{delivery === 'after-turn' && <Icon name="i-check" className="ml-auto size-3.5" />}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!canInject && <span className="ml-auto" />}
          <Button
            id="chatSend"
            type={!text.trim() && canStop ? 'button' : 'submit'}
            variant="default"
            size="icon"
            className="rounded-full"
            disabled={sending || (!text.trim() && !canStop)}
            aria-label={!text.trim() && canStop ? 'Stop turn' : 'Send message'}
            onClick={!text.trim() && canStop ? () => void stopTurn() : undefined}
          >
            {!text.trim() && canStop ? <Icon name="i-x" /> : <Icon name="i-up" />}
          </Button>
        </div>
      </form>
      {plan && (
        <div id="taskPlanPreview" className="mt-2">
          <TodoList
            items={plan.stages.map((stage, index) => ({
              id: String(index),
              content: <textarea aria-label={`Edit stage ${index + 1}`} value={stage} maxLength={16000} onChange={(event) => setPlan((current) => current ? { ...current, stages: current.stages.map((item, at) => at === index ? event.target.value : item) } : current)} className="min-h-5 w-full resize-y border-0 bg-transparent p-0 text-xs leading-5 text-foreground outline-none" />,
            }))}
            actions={<button type="button" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => { setPlan(null); setStatus(''); }} aria-label="Cancel plan"><Icon name="i-x" className="size-3.5" /></button>}
          />
        </div>
      )}
      {!session && <div className="mt-2 flex items-center gap-2 px-0.5">
        <Button id="createPlan" size="sm" variant="secondary" onClick={() => void createPlan()} disabled={!planning && !text.trim()}><Icon name="i-steps" className="size-3.5" />{planning ? 'Cancel plan' : 'Plan New Idea'}</Button>
        <Button size="sm" variant="secondary" onClick={() => { void setAutomationMode('goal'); setStatus('Goal mode enabled.'); area.current?.focus(); }}><Icon name="i-bolt" className="size-3.5" />Multitask</Button>
      </div>}
      {status && <p id="composerStatus" role="status" className="px-2 pt-1.5 text-center text-[11px] text-muted-foreground">{status}</p>}
    </div>
  );
}
