// Read-only audit of local recorder timing. Outputs no prompts, tool arguments or results.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Pass the local sessions directory');
const pro6 = s => /^(?:gpt-?6-pro|gpt-?6-astra|astra)$/i.test(String(s?.model || '').replace(/\s+/g, '-')) ||
  /^(?:gpt-?6(?:\.0)?|6)$/.test(String(s?.model || '').toLowerCase()) && s?.reasoningEffort === 'pro';
const metas = [];
for (const dir of await fs.readdir(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  try { const meta = JSON.parse(await fs.readFile(path.join(root, dir.name, 'meta.json'), 'utf8')); metas.push({ ...meta, folder: dir.name }); } catch {}
}
const selected = metas.filter(m => pro6(m.selectedModel)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
const reports = [];
for (const [index, meta] of selected.entries()) {
  const events = [];
  let damaged = 0;
  const lines = readline.createInterface({ input: createReadStream(path.join(root, meta.folder, 'events.jsonl')), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const e = JSON.parse(line);
      events.push({ kind: e.kind, source: e.source, time: e.time, seq: e.seq, turn: e.turnId, outcome: e.outcome,
        request: e.call?.requestId, duration: e.call?.durationMs || 0, final: e.final,
        messageId: e.messageId, model: e.call?.model, modelEffort: e.call?.reasoningEffort });
    } catch { damaged++; }
  }
  const canonical = [];
  try {
    for (const name of await fs.readdir(path.join(root, meta.folder, 'messages'))) {
      const m = JSON.parse(await fs.readFile(path.join(root, meta.folder, 'messages', name), 'utf8'));
      canonical.push({ kind: m.kind, time: m.time, seq: m.seq, turn: m.turnId, final: m.final, messageId: m.messageId });
    }
  } catch {}
  const messageIds = new Set(canonical.map(m => m.messageId).filter(Boolean));
  const rows = [...events.filter(e => !messageIds.has(e.messageId)), ...canonical].filter(e => Number.isFinite(e.time));
  const users = [...new Set(rows.filter(e => e.kind === 'user_message').map(e => e.time))].sort((a,b) => a-b);
  const calls = rows.filter(e => e.kind === 'tool_call' && e.turn).sort((a,b) => a.time-b.time);
  const turns = new Map();
  for (const call of calls) { if (!turns.has(call.turn)) turns.set(call.turn, []); turns.get(call.turn).push(call); }
  const gaps = [];
  for (const [turn, calls] of turns) {
    const points = [...calls.map(e => ({ ...e, end: e.time + Math.max(0, e.duration) })),
      ...rows.filter(e => e.turn === turn && ['assistant_message', 'page_tool'].includes(e.kind)).map(e => ({ ...e, end: e.time }))]
      .sort((a,b) => a.time-b.time);
    let previous = null;
    for (const point of points) {
      if (previous && point.time > previous.end && !users.some(t => t > previous.end && t <= point.time)) {
        // Unscoped canonical interim rows still disprove silence in this same
        // user-message segment. They cannot establish turn ownership on their own.
        const interims = rows.filter(e => e.kind === 'assistant_message' && !e.turn && e.time > previous.end && e.time < point.time)
          .sort((a,b) => a.time-b.time);
        let before = previous;
        for (const after of [...interims, point]) {
          const gapMs = after.time - before.end;
          if (gapMs >= 60_000) gaps.push({ gapMs, from: new Date(before.end).toISOString(), to: new Date(after.time).toISOString(),
            before: before.kind, after: after.kind, sameRequest: !!before.request && before.request === after.request,
            terminalInGap: rows.some(e => e.kind === 'turn_end' && e.turn === turn && e.time > before.end && e.time < after.time) });
          before = { ...after, end: after.end ?? after.time };
        }
      }
      if (!previous || point.end >= previous.end) previous = point;
    }
  }
  gaps.sort((a,b) => b.gapMs-a.gapMs);
  reports.push({ chat: index + 1, date: new Date(meta.startedAt).toISOString(), model: meta.selectedModel.model,
    calls: calls.length, turns: turns.size, canonicalMessages: canonical.length, unscopedAssistantMessages: canonical.filter(e=>e.kind==='assistant_message'&&!e.turn).length,
    damaged, gapsOverTenMinutes: gaps.filter(g=>g.gapMs>=600_000).length, longest: gaps.slice(0,5) });
}
const longest = reports.flatMap(r => r.longest.map(g => ({chat:r.chat,...g}))).sort((a,b)=>b.gapMs-a.gapMs)[0];
const result = { requestedChats: 20, availableExactPro6Chats: selected.length, totalLocalSessions: metas.length,
  caveat: 'Current model metadata; canonical messages retain latest revisions, so these are conservative observed gaps, not proof of uninterrupted capture. No gap crosses a recorded new user message. Running tool duration and app-owned progress/repair rows are excluded.',
  longest, safetyLimitMs: Math.max(600_000, (longest?.gapMs || 0) + 60_000), reports };
console.log(JSON.stringify(result, null, 2));
