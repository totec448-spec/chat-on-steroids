import { describe, expect, it, vi } from 'vitest';
import { boot, text, type SessionEvent } from './renderer-timeline.harness.js';
import { chronological } from '../src/shared/chronology.js';

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
        seq: 1378,
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
        seq: 1409,
        time: T0 + 401,
        source: 'extension',
        turnId: 'g-turn-5',
        outcome: 'completed',
        continued: true
      },
      // 7. Turn 2 starts (g-turn-6) for the continued request
      {
        kind: 'turn_start',
        seq: 1410,
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
        seq: 1494,
        time: T0 + 801,
        source: 'extension',
        turnId: 'g-turn-6',
        outcome: 'completed'
      }
    ];
  }

  it('orders the steer follow-up question and continued turn responses chronologically', () => {
    const events = buildSteerEvents();
    const ordered = chronological(events);

    const initialQuestionIndex = ordered.findIndex(e => e.kind === 'user_message' && (e as any).message?.text?.includes('Repetidor Arcano: familiar'));
    const turn1ToolIndex = ordered.findIndex(e => e.kind === 'tool_call' && e.turnId === 'g-turn-5');
    const turn1EndIndex = ordered.findIndex(e => e.kind === 'turn_end' && e.turnId === 'g-turn-5');
    const steerQuestionIndex = ordered.findIndex(e => e.kind === 'user_message' && (e as any).message?.text?.includes('Pero nuestro juego'));
    const turn2StartIndex = ordered.findIndex(e => e.kind === 'turn_start' && e.turnId === 'g-turn-6');
    const turn2ToolIndex = ordered.findIndex(e => e.kind === 'tool_call' && e.turnId === 'g-turn-6');
    const finalAnswerIndex = ordered.findIndex(e => e.kind === 'assistant_message' && (e as any).final === true);
    const turn2EndIndex = ordered.findIndex(e => e.kind === 'turn_end' && e.turnId === 'g-turn-6');

    // 1. Initial question starts Turn 1:
    expect(initialQuestionIndex).toBeLessThan(turn1ToolIndex);
    expect(turn1ToolIndex).toBeLessThan(turn1EndIndex);

    // 2. Steer follow-up question appears AFTER Turn 1 and BEFORE Turn 2:
    expect(steerQuestionIndex).toBeGreaterThan(turn1EndIndex);
    expect(steerQuestionIndex).toBeLessThan(turn2StartIndex);

    // 3. Turn 2 tools appear AFTER the user steer message and Turn 2 start:
    expect(turn2ToolIndex).toBeGreaterThan(turn2StartIndex);

    // 4. Final consolidated assistant response appears AFTER Turn 2 tools (closing the turn):
    expect(finalAnswerIndex).toBeGreaterThan(turn2ToolIndex);

    // 5. Final response appears before Turn 2 end:
    expect(finalAnswerIndex).toBeLessThan(turn2EndIndex);
  });

  it('renders correctly in the Electron timeline DOM with steer question and tools above the final response', async () => {
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

    const steerQuestionPos = renderedNodes.indexOf(steerQuestionEl!);
    const turn2ToolPos = renderedNodes.indexOf(turn2ToolEl!);
    const finalAnswerPos = renderedNodes.indexOf(finalAnswerEl!);

    // IN THE RENDERED DOM:
    // 1. Steer question appears before Turn 2 tools:
    expect(steerQuestionPos).toBeLessThan(turn2ToolPos);
    // 2. Turn 2's tools appear before the final consolidated response:
    expect(turn2ToolPos).toBeLessThan(finalAnswerPos);
    // 3. Final consolidated answer is rendered at the bottom of Turn 2:
    expect(finalAnswerPos).toBeGreaterThan(steerQuestionPos);
    expect(finalAnswerPos).toBeGreaterThan(turn2ToolPos);
  });

  it('keeps the closing rank for a final assistant message completed before a continued turn end', () => {
    const events: SessionEvent[] = [
      // 1. Initial user request
      {
        kind: 'user_message',
        seq: 1,
        origin: 1375,
        time: T0,
        source: 'extension',
        messageId: 'question-1',
        turnId: 'question-1',
        message: text('Crea el familiar base')
      },
      // 2. Turn 1 starts
      {
        kind: 'turn_start',
        seq: 1378,
        time: T0 + 100,
        source: 'extension',
        turnId: 'g-turn-5'
      },
      // 3. Tool call during Turn 1
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
          summary: { kind: 'session', title: 'Actualizó el plan', tone: 'neutral' }
        }
      },
      // 4. Assistant message that completed Turn 1 BEFORE the steer message was sent
      {
        kind: 'assistant_message',
        seq: 4,
        origin: 1398,
        contentSeq: 1401,
        time: T0 + 250,
        source: 'extension',
        turnId: 'g-turn-5',
        messageId: 'assistant:turn1-final',
        message: text('El familiar base ya está terminado y guardado.'),
        state: 'final',
        final: true
      },
      // 5. User sends a steer/follow-up message afterwards
      {
        kind: 'user_message',
        seq: 5,
        origin: 1406,
        contentSeq: 1406,
        time: T0 + 300,
        source: 'extension',
        messageId: 'question-2',
        message: text('Ahora haz que dispare rayos.')
      },
      // 6. Turn 1 ends with continued: true (after the completed final message: 1401 <= 1409)
      {
        kind: 'turn_end',
        seq: 1409,
        time: T0 + 301,
        source: 'extension',
        turnId: 'g-turn-5',
        outcome: 'completed',
        continued: true
      },
      // 7. Turn 2 starts
      {
        kind: 'turn_start',
        seq: 1410,
        time: T0 + 302,
        source: 'extension',
        turnId: 'g-turn-6'
      },
      // 8. Turn 2 tool call
      {
        kind: 'tool_call',
        seq: 8,
        origin: 1412,
        time: T0 + 350,
        source: 'mcp',
        turnId: 'g-turn-6',
        call: {
          callId: 'call-code-2',
          tool: 'exec_command',
          attribution: 'request_id',
          requestId: 'req-2',
          conversationId: 'chat-1',
          attributionMethod: 'request_id',
          args: text('{"cmd":"add_ray"}'),
          result: text('Ray added'),
          outcome: 'ok',
          durationMs: 50,
          summary: { kind: 'run', title: 'Añadió rayos', tone: 'good' }
        }
      },
      // 9. Turn 2 final assistant message
      {
        kind: 'assistant_message',
        seq: 9,
        origin: 1440,
        contentSeq: 1470,
        time: T0 + 400,
        source: 'extension',
        turnId: 'g-turn-6',
        messageId: 'assistant:turn2-final',
        message: text('Rayos implementados.'),
        state: 'final',
        final: true
      },
      // 10. Turn 2 ends
      {
        kind: 'turn_end',
        seq: 1494,
        time: T0 + 401,
        source: 'extension',
        turnId: 'g-turn-6',
        outcome: 'completed'
      }
    ];

    const ordered = chronological(events);
    const turn1ToolIndex = ordered.findIndex(e => e.kind === 'tool_call' && e.turnId === 'g-turn-5');
    const turn1FinalIndex = ordered.findIndex(e => e.kind === 'assistant_message' && (e as any).messageId === 'assistant:turn1-final');
    const turn1EndIndex = ordered.findIndex(e => e.kind === 'turn_end' && e.turnId === 'g-turn-5');
    const steerQuestionIndex = ordered.findIndex(e => e.kind === 'user_message' && (e as any).messageId === 'question-2');
    const turn2ToolIndex = ordered.findIndex(e => e.kind === 'tool_call' && e.turnId === 'g-turn-6');
    const turn2FinalIndex = ordered.findIndex(e => e.kind === 'assistant_message' && (e as any).messageId === 'assistant:turn2-final');

    // Turn 1 final message retains closing rank: sorts after Turn 1 tool and closes Turn 1 before its turn_end:
    expect(turn1ToolIndex).toBeLessThan(turn1FinalIndex);
    expect(turn1FinalIndex).toBeLessThan(turn1EndIndex);

    // Follow-up steer message sits cleanly between Turn 1 and Turn 2:
    expect(turn1EndIndex).toBeLessThan(steerQuestionIndex);
    expect(steerQuestionIndex).toBeLessThan(turn2ToolIndex);

    // Turn 2 final closes Turn 2 after Turn 2 tools:
    expect(turn2ToolIndex).toBeLessThan(turn2FinalIndex);
  });

  it('uses positionOf to select the closing final in non-continued turns when a final is remounted or replayed', () => {
    const events: SessionEvent[] = [
      {
        kind: 'turn_start',
        seq: 50,
        time: T0,
        source: 'extension',
        turnId: 'normal-turn-1'
      },
      {
        kind: 'assistant_message',
        seq: 2,
        origin: 100,
        contentSeq: 300,
        time: T0 + 10,
        source: 'extension',
        turnId: 'normal-turn-1',
        messageId: 'initial-final',
        message: text('Respuesta inicial'),
        state: 'final',
        final: true
      },
      {
        kind: 'assistant_message',
        seq: 3,
        origin: 200,
        contentSeq: 250,
        time: T0 + 20,
        source: 'extension',
        turnId: 'normal-turn-1',
        messageId: 'remounted-final',
        message: text('Respuesta remontada'),
        state: 'final',
        final: true
      },
      {
        kind: 'turn_end',
        seq: 250,
        time: T0 + 30,
        source: 'extension',
        turnId: 'normal-turn-1',
        outcome: 'completed'
      }
    ];

    const ordered = chronological(events);
    const initialFinalIndex = ordered.findIndex(e => (e as any).messageId === 'initial-final');
    const remountedFinalIndex = ordered.findIndex(e => (e as any).messageId === 'remounted-final');
    const turnEndIndex = ordered.findIndex(e => e.kind === 'turn_end');

    // In non-continued turns, positionOf selects the remounted message (origin 200 > 100)
    // as the closing message (rank 0.5), placing it after the initial final:
    expect(initialFinalIndex).toBeLessThan(remountedFinalIndex);
    expect(remountedFinalIndex).toBeLessThan(turnEndIndex);
  });
});
