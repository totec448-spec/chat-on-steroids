import { describe, expect, it, vi } from 'vitest';
import { boot, closeDom, text, toolCall, type SessionEvent } from './renderer-timeline.harness.js';
import { chronological, projectTimeline } from '../src/shared/chronology.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), hasTabs: () => false,
  tabs: () => [], newTab: () => null, selectTab: vi.fn(), closeTab: vi.fn()
}) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));
vi.mock('../src/renderer/file-code-editor.js', () => ({
  createProjectDiffViewer: async ({ parent, baseText, currentText }: { parent: HTMLElement; baseText: string; currentText: string }) => {
    const view = parent.ownerDocument.createElement('pre');
    view.textContent = `${baseText}\n---\n${currentText}`;
    parent.append(view);
    return { destroy: () => view.remove(), language: 'TypeScript' };
  }
}));

describe('steer / follow-up continued turn ordering', () => {
  const T0 = 1793454400000;

  function buildSteerEvents(): SessionEvent[] {
    return [
      // 1. Initial user request (Question 1)
      {
        kind: 'user_message',
        seq: 1,
        origin: 1375,
        time: T0,
        source: 'extension',
        messageId: 'question-1',
        turnId: 'question-1',
        message: text('Repetidor Arcano: familiar con idle y proyectiles. ¿Es 8 o 16 bits?')
      },
      // 2. Turn 1 starts (g-turn-5)
      {
        kind: 'turn_start',
        seq: 2,
        origin: 1378,
        time: T0 + 100,
        source: 'extension',
        turnId: 'g-turn-5'
      },
      // 3. Early tool call during Turn 1
      {
        kind: 'tool_call',
        seq: 3,
        origin: 1397,
        time: T0 + 200,
        source: 'mcp',
        turnId: 'g-turn-5',
        call: {
          callId: 'call-plan-1',
          tool: 'update_plan',
          attribution: 'request_id',
          requestId: 'req-1',
          conversationId: 'chat-1',
          attributionMethod: 'request_id',
          args: text('{"step":"Diseño"}'),
          result: text('Plan updated'),
          outcome: 'ok',
          durationMs: 10,
          summary: { kind: 'session', title: 'Actualizó el plan de tareas', tone: 'neutral' }
        }
      },
      // 4. Intermediate trace during Turn 1
      {
        kind: 'assistant_message',
        seq: 4,
        origin: 1398,
        contentSeq: 1401,
        time: T0 + 300,
        source: 'extension',
        turnId: 'g-turn-5',
        messageId: 'assistant:trace-1:working',
        message: text('El familiar base ya está generado...'),
        state: 'streaming',
        final: false
      },
      // 5. User sends a steer/follow-up message while the agent is still running
      {
        kind: 'user_message',
        seq: 5,
        origin: 1406,
        contentSeq: 1406,
        time: T0 + 400,
        source: 'extension',
        messageId: 'question-2',
        inputId: 'input-2',
        authoredText: 'Pero nuestro juego es 8 o 16?',
        message: text('Pero nuestro juego es 8 o 16?')
      },
      // 6. Turn 1 ends with continued: true
      {
        kind: 'turn_end',
        seq: 6,
        origin: 1409,
        time: T0 + 401,
        source: 'extension',
        turnId: 'g-turn-5',
        outcome: 'completed',
        continued: true
      },
      // 7. Turn 2 starts (g-turn-6) for the continued request
      {
        kind: 'turn_start',
        seq: 7,
        origin: 1410,
        time: T0 + 401,
        source: 'extension',
        turnId: 'g-turn-6'
      },
      // 8. Tool call during Turn 2 (Godot tests)
      {
        kind: 'tool_call',
        seq: 8,
        origin: 1442,
        time: T0 + 500,
        source: 'mcp',
        turnId: 'g-turn-6',
        call: {
          callId: 'call-godot',
          tool: 'exec_command',
          attribution: 'request_id',
          requestId: 'req-1',
          conversationId: 'chat-1',
          attributionMethod: 'request_id',
          args: text('{"cmd":"godot --test"}'),
          result: text('Pass: 38 tests'),
          outcome: 'ok',
          durationMs: 150,
          summary: { kind: 'run', title: 'Ejecutó Godot y 38 comprobaciones superadas', tone: 'good' }
        }
      },
      // 9. Intermediate trace during Turn 2
      {
        kind: 'assistant_message',
        seq: 9,
        origin: 1444,
        contentSeq: 1444,
        time: T0 + 600,
        source: 'extension',
        turnId: 'g-turn-6',
        messageId: 'assistant:trace-2:working',
        message: text('El Repetidor ya está integrado y Godot lo está cargando...'),
        state: 'streaming',
        final: false
      },
      // 10. ChatGPT finalizes the single consolidated response in the DOM:
      // Notice: ChatGPT keeps the original turnId 'g-turn-5' and origin 1379,
      // but its final content was authored at the end of Turn 2!
      {
        kind: 'assistant_message',
        seq: 10,
        origin: 1379,
        contentSeq: 1493,
        finalContentSeq: 1493,
        time: T0 + 150,
        finalObservedAt: T0 + 800,
        source: 'extension',
        turnId: 'g-turn-5',
        messageId: 'assistant-consolidated-final',
        message: text('¡Me encanta, Dani! Nuestro juego es de 16 bits. ¡Y tengo novedades: el Repetidor Arcano ya está implementado!'),
        state: 'final',
        final: true
      },
      // 11. Turn 2 ends
      {
        kind: 'turn_end',
        seq: 11,
        origin: 1494,
        time: T0 + 801,
        source: 'extension',
        turnId: 'g-turn-6',
        outcome: 'completed'
      }
    ];
  }

  it('demonstrates the current chronology ordering where the final response precedes the steer question and turn-2 tools', () => {
    const events = buildSteerEvents();
    const ordered = chronological(events);
    const kinds = ordered.map(e => `${e.kind}${e.kind === 'user_message' ? ':' + (e as any).message?.text?.slice(0, 15) : ''}${e.kind === 'assistant_message' && (e as any).final ? ':FINAL' : ''}`);

    // Currently, because the consolidated final assistant message has turnId 'g-turn-5' (origin 1379),
    // it is placed inside Turn 1 before the steer question and before Turn 2's tools:
    const finalAnswerIndex = ordered.findIndex(e => e.kind === 'assistant_message' && (e as any).final === true);
    const steerQuestionIndex = ordered.findIndex(e => e.kind === 'user_message' && (e as any).message?.text?.includes('Pero nuestro juego'));
    const turn2ToolIndex = ordered.findIndex(e => e.kind === 'tool_call' && e.turnId === 'g-turn-6');

    // THIS IS THE BUG:
    // 1. The final answer appears BEFORE the user's steer question that it answers!
    expect(finalAnswerIndex).toBeLessThan(steerQuestionIndex);
    // 2. The final answer appears BEFORE the tools executed in Turn 2!
    expect(finalAnswerIndex).toBeLessThan(turn2ToolIndex);
    // 3. The tools executed in Turn 2 appear AT THE VERY BOTTOM (after the final answer):
    expect(turn2ToolIndex).toBeGreaterThan(finalAnswerIndex);
  });

  it('demonstrates the bug rendered in the Electron timeline DOM', async () => {
    const events = buildSteerEvents();
    const { w } = await boot(events);

    const timeline = w.document.getElementById('timeline')!;
    const renderedNodes = [...timeline.children];

    // Find the rendered DOM elements
    const steerQuestionEl = renderedNodes.find(el => el.classList.contains('ev-user_message') && el.textContent?.includes('Pero nuestro juego'));
    const finalAnswerEl = renderedNodes.find(el => el.classList.contains('ev-assistant_message') && el.textContent?.includes('el Repetidor Arcano ya está implementado'));
    const turn2ToolEl = renderedNodes.find(el => el.classList.contains('tool-group') || (el.classList.contains('ev-tool_call') && el.textContent?.includes('Godot')));

    expect(steerQuestionEl).toBeDefined();
    expect(finalAnswerEl).toBeDefined();
    expect(turn2ToolEl).toBeDefined();

    const finalAnswerPos = renderedNodes.indexOf(finalAnswerEl!);
    const steerQuestionPos = renderedNodes.indexOf(steerQuestionEl!);
    const turn2ToolPos = renderedNodes.indexOf(turn2ToolEl!);

    // IN THE RENDERED DOM:
    // Final consolidated answer is rendered ABOVE the user's follow-up question:
    expect(finalAnswerPos).toBeLessThan(steerQuestionPos);
    // Final consolidated answer is rendered ABOVE Turn 2's tools:
    expect(finalAnswerPos).toBeLessThan(turn2ToolPos);
    // Turn 2's working tools are rendered at the bottom:
    expect(turn2ToolPos).toBeGreaterThan(finalAnswerPos);
  });
});
