import { useEffect, useMemo, useRef, useState } from 'react';
import type { InputEntry, SessionControlsView } from '../../../preload/index.js';
import type { SessionSummary } from '../../../shared/session.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/card.js';
import { Icon } from '../ui/icon.js';
import { Textarea } from '../ui/input.js';

function queueLabel(row: InputEntry): string {
  if (row.state === 'browser') return 'Sending in ChatGPT';
  if (row.state === 'tool') return 'Offered to active turn';
  if (row.mode === 'finish' && row.afterTurn === true) return 'After this turn';
  if (row.mode === 'finish') return 'At session finish';
  if (row.mode === 'after-turn') return 'After this turn';
  return 'Queued';
}

function QueueRow({
  row,
  canMoveUp,
  canMoveDown,
  allowAfterTurn,
  onMove,
  onRefresh,
}: {
  row: InputEntry;
  canMoveUp: boolean;
  canMoveDown: boolean;
  allowAfterTurn: boolean;
  onMove: (id: string, direction: -1 | 1) => Promise<void>;
  onRefresh: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editable = row.state === 'queued' && (row.mode === 'after-turn' || row.mode === 'finish');
  const cancellable = row.state === 'queued' || row.state === 'browser';

  useEffect(() => {
    if (!editing) setDraft(row.text);
  }, [editing, row.text]);

  async function save(afterTurn = row.afterTurn): Promise<void> {
    if (!editable || saving || !draft.trim()) return;
    setSaving(true); setError('');
    try {
      const changed = await unwrap(api.editQueuedInput(row.id, draft, afterTurn));
      if (!changed) throw new Error('This queued message changed before it could be edited.');
      setEditing(false);
      await onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }

  return (
    <div className="group border-b border-border/70 px-3 py-2.5 last:border-0" data-input-id={row.id}>
      {editing ? (
        <div className="grid gap-2">
          <Textarea value={draft} rows={2} maxLength={16000} onChange={(event) => setDraft(event.target.value)} aria-label="Edit queued message" />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setEditing(false); setDraft(row.text); setError(''); }}>Cancel</Button>
            <Button size="sm" variant="default" disabled={saving || !draft.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Icon name={row.state === 'tool' ? 'i-bolt' : 'i-clock'} className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[12px] leading-5 text-foreground">{row.text}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge>{queueLabel(row)}</Badge>
              {row.automation && row.automation !== 'off' && <Badge>{row.automation}</Badge>}
              {row.error && <span className="text-[11px] text-destructive">{row.error}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
            {editable && <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit queued message"><Icon name="i-pencil" className="size-3" /></Button>}
            {editable && <Button size="icon-sm" variant="ghost" disabled={!canMoveUp} onClick={() => void onMove(row.id, -1)} aria-label="Move queued message up"><Icon name="i-up" className="size-3" /></Button>}
            {editable && <Button size="icon-sm" variant="ghost" disabled={!canMoveDown} onClick={() => void onMove(row.id, 1)} aria-label="Move queued message down"><Icon name="i-down" className="size-3" /></Button>}
            {allowAfterTurn && row.mode === 'finish' && editable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void save(row.afterTurn === true ? false : true)}
                aria-pressed={row.afterTurn === true}
                title="Allow this finish task to run after the next completed turn"
              >After turn</Button>
            )}
            {cancellable && <Button size="icon-sm" variant="ghost" onClick={() => void unwrap(api.cancelInput(row.id)).then(onRefresh).catch((cause) => setError(String(cause)))} aria-label="Cancel queued message"><Icon name="i-x" className="size-3" /></Button>}
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

export function TaskDock({
  session,
  controls,
  rows,
  pausedHelpers,
  loading,
  error,
  onRefresh,
  onControlsChanged,
}: {
  session: SessionSummary | null;
  controls: SessionControlsView | null;
  rows: InputEntry[];
  pausedHelpers: Array<{ id: string; sourceSessionId: string }>;
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void> | void;
  onControlsChanged: (next?: SessionControlsView) => Promise<void> | void;
}) {
  const [objective, setObjective] = useState('');
  const [objectiveDirty, setObjectiveDirty] = useState(false);
  const [savingObjective, setSavingObjective] = useState(false);
  const [localError, setLocalError] = useState('');
  const objectiveOwner = useRef<string | null>(null);
  const objectiveRef = useRef('');

  useEffect(() => {
    if (!session?.id || !controls) {
      objectiveOwner.current = null;
      setObjective('');
      objectiveRef.current = '';
      setObjectiveDirty(false);
      return;
    }
    if (objectiveOwner.current !== session.id) {
      objectiveOwner.current = session.id;
      setObjective(controls.objective);
      objectiveRef.current = controls.objective;
      setObjectiveDirty(false);
      return;
    }
    // Unrelated session pushes must not erase an unsaved task draft.
    if (!objectiveDirty && !savingObjective) {
      setObjective(controls.objective);
      objectiveRef.current = controls.objective;
    }
  }, [controls, objectiveDirty, savingObjective, session?.id]);

  const queued = useMemo(() => rows.filter((row) => row.state === 'queued' && (row.mode === 'finish' || row.mode === 'after-turn')), [rows]);
  const visible = Boolean(session && (rows.length || pausedHelpers.length || controls?.automation !== 'off' || controls?.job?.busy || controls?.finishWaiting || controls?.goalDraft || controls?.finishGoalDraft || error || localError));
  if (!visible) return null;

  async function move(id: string, direction: -1 | 1): Promise<void> {
    if (!session) return;
    const ids = queued.map((row) => row.id);
    const index = ids.indexOf(id), nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    [ids[index], ids[nextIndex]] = [ids[nextIndex]!, ids[index]!];
    setLocalError('');
    try {
      const changed = await unwrap(api.reorderQueuedInputs(session.id, ids));
      if (!changed) throw new Error('The queue changed before it could be reordered.');
      await onRefresh();
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function saveObjective(): Promise<void> {
    if (!session || !controls || controls.automation === 'off' || !objective.trim() || savingObjective) return;
    const owner = session.id, draft = objective;
    setSavingObjective(true); setLocalError('');
    try {
      const next = await unwrap(api.setSessionObjective(owner, draft, controls.automation));
      if (objectiveOwner.current === owner && objectiveRef.current === draft) setObjectiveDirty(false);
      await onControlsChanged(next);
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (objectiveOwner.current === owner) setSavingObjective(false); }
  }

  const draftView = controls?.finishGoalDraft ?? controls?.goalDraft;
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-2" data-testid="task-dock">
      <div className="overflow-hidden rounded-xl border border-border bg-card/70">
        {controls?.automation !== 'off' && (
          <div className="border-b border-border/70 px-3 py-3">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="i-bolt" className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">{controls?.automation === 'loop' ? 'Loop' : 'Goal'}</span>
              {controls?.blocked && <Badge>{controls.blocked === 'worker' ? 'Managed by prime' : 'Blocked'}</Badge>}
              <Button className="ml-auto" size="sm" variant="ghost" disabled={!!controls?.blocked} onClick={() => void unwrap(api.setSessionAutomation(session!.id, 'off')).then(onControlsChanged).catch((cause) => setLocalError(String(cause)))}>Pause</Button>
            </div>
            <Textarea
              rows={2}
              value={objective}
              disabled={!!controls?.blocked}
              placeholder={controls?.automation === 'loop' ? 'What should each continuation focus on?' : 'What should this chat achieve?'}
              onChange={(event) => { objectiveRef.current = event.target.value; setObjective(event.target.value); setObjectiveDirty(true); setLocalError(''); }}
              aria-label="Conversation objective"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="default" disabled={!objectiveDirty || !objective.trim() || savingObjective || !!controls?.blocked} onClick={() => void saveObjective()}>{savingObjective ? 'Saving…' : objectiveDirty ? 'Save task' : 'Saved'}</Button>
            </div>
          </div>
        )}

        {draftView && (
          <div className="flex items-start gap-2 border-b border-border/70 px-3 py-2.5 text-xs text-muted-foreground" aria-busy={draftView.stage !== 'ready' && draftView.stage !== 'failed'}>
            <Icon name="i-pulse" className="mt-0.5 size-3.5" />
            <div className="min-w-0 flex-1"><div>{draftView.text || 'Preparing continuation…'}</div>{draftView.error && <div className="mt-1 text-destructive">{draftView.error}</div>}</div>
          </div>
        )}

        {controls?.job?.busy && (
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5 text-xs text-muted-foreground">
            <Icon name="i-copy" className="size-3.5" /><span className="flex-1">Compact &amp; Resume is {controls.job.stage.replaceAll('-', ' ')}.</span>
            <Button size="sm" variant="ghost" onClick={() => void unwrap(api.cancelSessionCompaction(session!.id)).then(onControlsChanged).catch((cause) => setLocalError(String(cause)))}>Cancel</Button>
          </div>
        )}

        {rows.map((row) => {
          const index = queued.findIndex((entry) => entry.id === row.id);
          return <QueueRow key={row.id} row={row} canMoveUp={index > 0} canMoveDown={index >= 0 && index < queued.length - 1} allowAfterTurn={controls?.queueAtFinish === true} onMove={move} onRefresh={onRefresh} />;
        })}

        {pausedHelpers.map((helper) => (
          <div key={helper.id} className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5 text-xs last:border-0">
            <Icon name="i-retry" className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-muted-foreground">A helper paused before completing. Its old ChatGPT tab may still be running.</span>
            <Button size="sm" variant="ghost" onClick={() => void unwrap(api.retryHelper(helper.id, helper.sourceSessionId)).then(onRefresh).catch((cause) => setLocalError(String(cause)))}>Retry</Button>
          </div>
        ))}

        {controls?.finishWaiting && controls.activeTurnId && !rows.some((row) => row.mode === 'finish' && row.state === 'queued') && (
          <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
            <Icon name="i-clock" className="size-3.5" /><span className="flex-1">This session is waiting for its next finish task.</span>
            <Button size="sm" variant="ghost" onClick={() => void unwrap(api.generateFinishGoal(session!.id, controls.activeTurnId!)).then(() => onRefresh()).catch((cause) => setLocalError(String(cause)))}>Generate Goal</Button>
          </div>
        )}

        {loading && !rows.length && <div className="px-3 py-2 text-[11px] text-muted-foreground">Refreshing queued work…</div>}
        {(error || localError) && <div className="px-3 py-2 text-[11px] text-destructive">{localError || error}</div>}
      </div>
    </div>
  );
}
