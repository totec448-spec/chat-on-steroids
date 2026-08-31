# Chat On Steroids — Architekturplan für den offenen GitHub-Issue-Pass

Stand: 2026-08-31, nach erneutem GitHub-/Worktree-/PR-Audit  
Audit-Snapshot des Arbeitsbaums: `rebuild/2.0.3-from-2.0.2` @ `73156d6`  
Prinzip: **Quality >> Quantity**

> Dieser Plan ist als direkte Arbeitsanweisung für Claude Code/Codex gedacht. Er soll nicht
> dreizehn voneinander unabhängige Hotfixes erzeugen. Wo mehrere Issues dieselbe falsche Zuständigkeit,
> denselben doppelten Zustand oder dieselbe fehlende Invariante offenlegen, wird zuerst die
> zugrunde liegende Architektur korrigiert und danach werden die einzelnen Issues dagegen
> geschlossen.

---

## 0. Harte Regeln für die Umsetzung

1. **AGENTS.md vollständig lesen und befolgen.**
2. **Vorhandene fremde Änderungen niemals resetten, checkouten, cleanen, überschreiben oder
   stillschweigend neu formatieren.** Der Repo-Baum kann parallel verändert werden.
3. **Keine Fallback-Stacks als Standardlösung.** Erst den frühesten falschen State-/Identity-
   Übergang finden. Ein neuer Timer ist nur erlaubt, wenn er eine reale externe Lease modelliert,
   nicht als Ersatz für fehlende Zuständigkeit.
4. **Eine Autorität pro Fakt.** UI, Recovery, Modell-Hinweise und Tests dürfen Projektionen derselben
   Autorität sein; sie dürfen denselben Zustand nicht unabhängig neu erraten.
5. **Delete / collapse before add.** Wenn ein neuer gemeinsamer State eine alte Watchdog-/Retry-
   Logik überflüssig macht, diese im selben Batch entfernen.
6. **Keine Tool-Surface-Aufblähung.** Core/Desktop bleiben kleine, klar getrennte Sicherheitsflächen.
7. **Reproduzierbare Regression vor oder zusammen mit dem Fix.** Tests müssen den gemeldeten
   Fehlerpfad modellieren, nicht bloß eine neue Helper-Funktion isoliert testen.
8. **Browser-Live-Tests nur vom Prime.** Worker/Sub-Agenten dürfen Repo, Tests, Git/PR-History und
   Logs analysieren, aber nicht parallel dieselben ChatGPT-Tabs bedienen.
9. **Issue erst schließen, wenn der Zustand unterschieden wird:**
   - nur im aktuellen Worktree vorhanden,
   - lokal verhaltensäquivalent zu einem Upstream-Commit, aber mit anderer Git-Topologie,
   - in einem offenen PR vorhanden,
   - in `main` gemerged,
   - in einem Release ausgeliefert,
   - live/gegen Regression verifiziert.
10. **Commit-Hash ist kein Verhaltensbeweis.** Vor Cherry-pick/Rebase/Merge immer `git cherry`,
    `git range-diff` oder einen gezielten Diff gegen `origin/main` benutzen. Dieser Branch enthält
    bereits mehrere verhaltensäquivalente Änderungen unter anderen Hashes.
11. **Jeder Architektur-Batch führt ein Authority-/Deletion-Ledger.** Für jeden neuen State, Timer,
    Lease oder Recovery-Path muss stehen, welchen alten Owner/Timer/Path er ersetzt. Wenn nichts
    ersetzt wird, ist die Default-Annahme: der Change fügt eine zweite Wahrheit hinzu und ist zu
    hinterfragen.
12. **Reliability-Release nicht mit Portability erzwingen.** Firefox oder ein breiter Desktop-
    Refactor dürfen einen 2.0.3-Reliability-Cut nicht blockieren, nur weil sie ebenfalls offen sind.
    Ein bereits vollständig validierter Port kann mitgehen; unvollständige Plattformarbeit bekommt
    ihren eigenen Release-Gate statt den Reliability-Pass zu verwässern.

---

## 1. Verifizierter Ausgangszustand

### 1.1 GitHub-Wahrheit: offene vs. inzwischen geschlossene Issues

Der neueste `gh issue list --state open`-Audit ergibt **13 offene Issues**. Wichtig: #40 wurde
**während dieses Audits** am 2026-08-31 gegen 01:10 CEST neu eröffnet; der Issue-Snapshot ist also
bewusst zeitgestempelte Evidenz und muss vor Implementation erneut gelesen werden:

`#2, #21, #22, #23, #26, #27, #29, #30, #31, #34, #35, #36, #40`.

Seit dem ersten Plan-Snapshot wurden zwei Issues abgeschlossen:

- **#24 CLOSED / COMPLETED** — PR #37 ist in `origin/main` gemerged (`35f14df4`).
- **#25 CLOSED / COMPLETED** — PR #38 ist in `origin/main` gemerged (`f8f8c84c`).

Diese beiden bleiben weiter unten nur als **historische Architektur-/Release-Evidenz** stehen. Sie
sind keine Implementation-TODOs mehr und dürfen nicht versehentlich wieder in den aktiven Batch
zurückgezogen werden.

### 1.2 Aktueller Checkout

Der gemeinsam benutzte Checkout ist inzwischen von `origin/main` weiter divergiert. Zum erneuten
Audit gilt:

```text
rebuild/2.0.3-from-2.0.2...origin/main [ahead 14, behind 6]
73156d6 Keep a long goal where its reader scrolled it
9c53248 Let a goal opening outlive the app's own model deadline
fff2d7d Read a Project conversation route wherever a chat is named
bae42d0 Recognise Project conversation routes as conversations
69a2560 Scope the public-history privacy gate to the checked-out line
```

`origin/main` enthält inzwischen die Merges für #24, #25 und #33. Der lokale Branch enthält Teile
derselben Verhaltensänderungen bereits unter anderen Hashes. **`behind 6` bedeutet deshalb nicht
„sechs fehlende Produktfixes“.** Vor jeder Integration muss Verhalten statt Hash gezählt werden.

Der Worktree ist außerdem aktuell **geteilt und dirty**; neben dieser untracked Plan-Datei liegen
beim letzten Status-Snapshot fremde Änderungen in `docs/chatgpt-turn-signals.md`,
`extension/chatgpt-dom.js`, `src/main/bridge.ts`, `src/renderer/chat.ts`, `test/bridge.test.ts`,
`test/content-script.test.ts` und `test/renderer-layout.test.ts`. Die letzten beiden Renderer-Pfade
sind sogar **während dieses Audits neu dirty geworden** — konkreter Beweis, dass der Shared Tree
weiterlebt. Diese Änderungen gehören nicht diesem Plan-Edit und dürfen weder bereinigt noch
überschrieben werden.

PR #39 ist weiterhin offen und nicht Teil dieses HEAD. PR #19 / Merge `03acfba` ist Ancestor.

Darum gilt für jeden Implementierungsbatch: **vorher `git status`, `git log -8`, `git log
HEAD..origin/main`, `git cherry origin/main HEAD` und die relevanten offenen PR-Diffs lesen**. Erst
danach darf entschieden werden, ob gemerged, selektiv übernommen oder überhaupt nichts getan wird.

### 1.3 Bereits lokal verifizierte Tests

Auf dem aktuellen Baum liefen während dieses Audits erfolgreich:

```text
test/public-history-privacy.test.ts + test/packaging.test.ts   26/26
test/tunnel.test.ts                                           26 passed, 1 skipped
test/content-script.test.ts                                  287/287
test/bridge.test.ts                                          154/154
test/mcp.test.ts                                             154/154
```

Zusätzlich hat der Platform-Worker gemeinsam
`mcp/platform/connection/tunnel/browser/extension` ausgeführt: **300 passed, 1 skipped**. Weitere
gezielte Worker-Regressions für stale-turn/resume-shadow, auto-compaction, Project routes,
Draft-Preserve und exited-unread waren ebenfalls grün.

Wichtig trotz geschlossenem #24: Der **neue Scope der Privacy-Prüfung funktioniert**, aber der aktuelle reale
HEAD-Verlauf enthält weiterhin ältere unsafe author identities in `9e27c0f` und `03acfba`. Ein
vollständiger Public-History-Check darf deshalb weiterhin legitim scheitern. Das ist ein separater
Release-History-Blocker und nicht der alte #24-Fehler „unrelated ref poisons a clean branch“.

### 1.4 Release- und PR-Snapshot

- Letztes veröffentlichtes Release ist weiterhin **v2.0.2**. Ein Fix in `main` ist daher noch kein
  Beweis, dass ein v2.0.2-Reporter ihn besitzt.
- Issue-relevante offene PRs sind vor allem **#17** (#2), **#28** (#29) und **#39** (#21).
- Weitere offene Feature-PRs dürfen nicht still in den Reliability-Release gezogen werden. Vor dem
  Cut wird ihre Dateiüberlappung gegen die Issue-Batches geprüft; Konflikte werden isoliert statt
  durch einen großen Sammel-Merge gelöst.

Diese grünen Suites beweisen nicht, dass jedes Issue geschlossen ist; sie belegen nur, dass die
aktuell vorhandenen Änderungen ihre bestehenden Regressionen nicht brechen.

---

## 2. Executive Issue Matrix

| Issue | Aktueller Befund | PR/Commit-Evidenz | Entscheidung |
|---|---|---|---|
| #2 Power Agent tools | Nicht im aktuellen Baum; bestehende Primitive decken fast alles ab | PR #17 offen; Architektur widerspricht dem kleinen Surface-Budget | **Als architecture-superseded schließen; PR #17 nicht mergen. `web_fetch` nur als neues, separat begründetes Issue.** |
| #21 Auto-compaction / self-compaction | Teilweise behoben; absolute 10m-Expiry existiert noch **zweimal** (Continuation + PrimeTransfer) | send checkpoints + marker reconciliation vorhanden; PR #39 offen | **Continuation-WAL zur einzigen A→B-Autorität machen; side-effect-aware Expiry statt globalem Heartbeat/TTL; broker transfer lease löschen.** |
| #22 Firefox | Nicht implementiert; Port legt zusätzlich den heutigen global-singleton Browser-Pairing-Fehler offen | kein passender Merge | **Eine WebExtension-Codebasis + genau eine explizit gepaarte Companion-Installation/Profile als Browser-Custody-Owner; Manifest/runtime delta + signierter XPI-Releasepfad.** |
| #23 Tunnel supervisor | **Lokal implementiert und deterministisch getestet; Live-Tunnel-Akzeptanz bleibt offen** | `src/main/tunnel/index.ts`, `src/main/diagnostics.ts`, `test/tunnel-lifecycle.test.ts`; `b5b6239` nur als historische Referenz | **Ein `ClientRun` ist Process- und Health-Generation; compare-and-retire besitzt genau einen Restart, Stop-Barriere verhindert Overlap, unknown bleibt unknown.** |
| #24 verify/history + AppImage flake | **CLOSED** | PR #37 in `origin/main`; lokale verhaltensäquivalente Änderung vorhanden | **Keine Produktarbeit mehr. Public-history-Blocker als separaten Release-Fakt behandeln.** |
| #25 Project chats | **CLOSED** | PR #38 in `origin/main`; lokale verhaltensäquivalente Route-Fixes vorhanden | **Keine zweite Route-Implementation bauen; zentrale Parser-Lektion beibehalten.** |
| #26 resume-shadow loop in v2.0.2 | Code-Fix bereits gemerged | PR #19 / `03acfba` | **Release verifizieren; danach den hot-poll Compatibility-Repair aus `/activity` löschen/auf bounded startup verschieben.** |
| #27 10+ min generating stall | 2-min inactivity recovery vorhanden; 2026-08-31 zeigt ein separates klassifiziertes Transport-Error-Recovery-Loch im dirty Worktree | `0cd95f1`, `838f55c` + aktuelle uncommitted bridge/DOM regressions | **Eine one-shot browser-recovery authority behalten; error- und inactivity-evidence nur als zwei Trigger dafür. Erst nach Integration/live acceptance schließen.** |
| #29 macOS Desktop boundary | Umfangreiche validierte Mac-Vertical-Slice existiert in CLEAN PR #28 | Electron → Worker → N-API → Swift dylib; arm64 live/CI evidence | **Vertical slice nicht mit spekulativem Vorab-Refactor blockieren; erst sicher mergen, danach kleinsten echten Driver-Seam aus zwei Backends extrahieren.** |
| #30 autosaved New Chat draft blocks bootstrap | Safe failure/surfacing schon vorhanden; Opt-in fehlt | `insertPrompt()` + `runCommand()` + worker failure report | **Nur persistenten fresh-bootstrap Replace-Opt-in ergänzen; preserve default unverändert.** |
| #31 persistent/self-verifying Secure Tunnel | Persistence größtenteils schon fertig | config/safe storage/per-surface request+tool timestamps + monotonic surface exposure | **Fingerprint der tatsächlich ausgelieferten `tools/list`-Shape pro Surface; #23-health nur projizieren; capability-bearing lokale URLs aus generischen Renderer-Facts entfernen.** |
| #34 stale hidden worker output | **Lokal implementiert und getestet; Browser-Live-Akzeptanz bleibt offen** | lokaler Commit `324648d`; 382 Extension/Content-Tests | **Ein Scheduler entscheidet nach Arbeit; hidden generating/active läuft schnell, exact final delivery bleibt bis zum Feed-ACK live.** |
| #35 explain waits/blocks | Noch kein einheitliches Modell | Zustände existieren verteilt; `.clf-stage` vorhanden | **Eine read-only Runtime-/Obligations-Projektion in bestehender Stage-UI; keine LLM-Statusmeldungen.** |
| #36 unread background exec results | **Lokal implementiert und getestet; Modell-Live-Akzeptanz bleibt offen** | lokaler Commit `5463f17`; 157 UnifiedExec/MCP-Tests | **LRU-Eviction gelöscht: Capacity ist Admission; exact-chat unread obligation begrenzt neue Starts und bleibt über `write_stdin` drainbar.** |
| #40 Chrome Memory Saver suspends agent tabs | Neu offen; Background kennt Tab-Identity, aber projiziert aktive Execution nicht in Chrome discard policy; `onUpdated` ignoriert `discarded`/`frozen` | `extension/background.js` + Chrome `tabs.autoDiscardable`/`discarded`/`frozen` APIs | **Eine read-only browser-live-required Projektion; bestehende 30s maintenance cadence reconciled `autoDiscardable=false` nur für tatsächlich execution-relevante Tabs. Discard ≠ Freeze: keine erfundene Freeze-API/Heartbeat.** |

### 2.1 Lokaler Implementierungsstand dieses Passes

Dieser Pass implementiert bewusst nur drei Issues mit klarer Root-Cause und deterministischer
lokaler Proof-Fläche: #36, #34 und #23. Er installiert, paketiert, pusht und schließt keine Issues.

- **#36:** Der globale UnifiedExec-Cap entfernt keine result-bearing Session mehr. Admission wird
  global und pro exakter Conversation verweigert, während `write_stdin` zum Drain offen bleibt.
- **#34:** Der bestehende Activity-Poller ist work-state-driven statt visibility-first. Eine
  canonical final assistant revision bleibt eine kleine exact-delivery obligation, bis dieselbe
  Message-ID plus finaler Text aus dem app-eigenen Feed zurückkommt.
- **#23:** Alle mutable OpenAI-Tunnel-Fakten gehören jetzt einem `ClientRun`. Nur der Gewinner von
  `current === run` darf retiren/restarten; die alte Process-Tree-Barriere endet vor dem Backoff,
  und eine unbestätigte Beendigung startet bewusst keinen zweiten Tree. Metrics-Ausfall und ein
  fehlender `last_success` bleiben `connecting/unknown`; ein frischer Poll entfernt zusätzlich
  einen sticky historischen Diagnostics-Fehler.

Nicht implementiert wurden insbesondere #21, #22, #29, #30, #31, #35 und #40: ihre Architektur-
oder Produktentscheidungen sind größer als dieser Reliability-Pass oder brauchen Browser-/Plattform-
Live-Evidenz. Die bereits im Checkpoint vorhandenen #27-/Goal-/Tool-activity-Änderungen wurden als
vorhanden erkannt und nicht als zweite Parallel-Implementation neu gebaut.

---

## 3. Gemeinsame Architektur statt 13 Einzelfixes

### 3.1 Cluster A — Turn-Liveness, Outstanding Obligations und Browser-Custody strikt trennen (#27, #34, #35, #36, #40)

Der wichtigste Reduktionspunkt aus dem adversarial Worker-Review ist: **„Turn lebt“ und „es gibt
noch Arbeit/Obligations“ sind zwei verschiedene Fakten.** Sie dürfen nicht in eine neue gemeinsame
Lifecycle-State-Machine verschmolzen werden.

#### A. Turn-Liveness bleibt bei der bestehenden Authority

```text
recorder open-turn proof
  + activeUntil[conversation]
  + echte ChatGPT/browser/tool progress evidence
  = stale-turn recovery eligibility
```

Nur echte Fortschritts-Evidenz verlängert diesen Grant. Insbesondere **nicht**:

- ein bloß existierender Background-Prozess;
- ein queued `agent_message`;
- ein Worker, der irgendwo aktiv ist;
- ein UI-Status, der „waiting“ sagt.

Sonst würde eine vergessene Background-Session genau den kaputten Prime-Turn für immer vor der
one-shot Reload-Recovery schützen.

Ebenso **nicht autoritativ** ist ein Renderer-only „working“-Badge. Der aktuell parallel dirty
`src/renderer/chat.ts` experimentiert mit `PRIME_WORKING_MS` aus `SessionSummary.updatedAt`; das ist
legitime Display-Heuristik, aber darf weder #27 Turn-Liveness, #35 konkrete Block-Gründe noch #40
Browser-Protection treiben. Presentation clocks bleiben Presentation clocks.

#### B. Outstanding Obligations werden **einmal** read-only zusammengesetzt

Nicht `conversationRuntimeView()` für #35 **und** `browserProtectedConversations()` für #40 als zwei
separate Scans über Recorder/Broker/Exec/Commands implementieren. Beide fragen dieselben Facts nur
für andere Projektionen ab. Eine pure App-layer Authority, sinngemäß:

```ts
type RuntimeObligation = {
  kind: 'open-turn' | 'tool' | 'exec-running' | 'exec-unread' |
        'worker-execution' | 'worker-wake' | 'continuation' |
        'goal' | 'compact' | 'browser-command' | 'browser-recovery';
  conversationId: string;
  since?: number;
  requiresBrowser: boolean;
  blocksExecAdmission?: boolean;
};

conversationObligations(id): RuntimeObligation[]
```

komponiert nur vorhandene Owner:

- recorder open-turn proof;
- continuation marker/checkpoint;
- laufender MCP/tool handler, soweit der Caller exakt bekannt ist;
- UnifiedExec `running` / `exitedUnread` für genau diese Conversation;
- Worker execution/wake aus dem Broker;
- Goal / Compact job;
- queued/handed browser command/recovery.

Diese Liste **besitzt und persistiert nichts**. Verbraucher filtern/formatieren sie:

1. #35 wählt deterministisch den höchsten belegten Statusgrund + `since` für `.clf-stage`;
2. #40 filtert `requiresBrowser===true` und mappt erst in der Extension Conversation→exact Tab;
3. #36 kann `exec-running`/`exec-unread` count/projection wiederverwenden; **die Admission-Entscheidung
   selbst bleibt beim UnifiedExec manager/ownership owner**, nicht bei der UI-Liste;
4. Activity response kann konkrete user-visible Waiting-/Blocked-Evidenz zeigen.

#27 benutzt dagegen weiterhin nur die bestehende Turn-Liveness für Recovery. #34 ist ein lokales
Scheduling-Problem: hidden **idle** darf langsam sein; hidden **working** oder ein Chat mit einer
exakt noch nicht round-tripped terminalen Assistant-Revision nicht.

**Nicht tun:** `pendingReason` persistieren, Background-Prozess-Existenz als Activity-Heartbeat
missbrauchen, einen zweiten stale-turn timer bauen oder Status als Transcript-Messages erzeugen.

#### C. Browser-Live-Custody ist eine dritte, ebenfalls abgeleitete Frage (#40)

„Dieser Chat arbeitet“ und „Chrome darf seinen Renderer automatisch wegwerfen“ sind nicht dieselbe
Authority. Der App-Layer weiß, **welche Conversation gerade einen lebenden Browser-Dokumentpfad
braucht**; nur die Extension weiß, **welcher konkrete Tab diese Conversation hält und welchen
Lifecycle-State Chrome meldet**.

Deshalb **keinen zweiten app-seitigen Scan**. `browserProtectedConversations` ist nur:

```text
distinct conversationId from conversationObligations(*)
where requiresBrowser == true
```

Die obligation composition setzt `requiresBrowser` für semantisch echte Browser-Bedürfnisse, z. B.
offener Recorder-Turn (damit auch Lone Chat), bound Worker execution/wake, Browser-command/recovery,
Continuation/Compact/Goal-Phasen, die konkret ein lebendes ChatGPT-Dokument brauchen. Ein Prime-/
Worker-**Role-Label allein** reicht nicht. Sleeping/finished/failed History erzeugt keine Browser-
Obligation. Ein `detached` Worker kann weiter semantische Arbeit besitzen, erzeugt aber erst wieder
einen physikalischen Pin, wenn exakt dieser Chat als `tabConversations`-Mapping auftaucht.

Wichtig: `activeUntil` ist **nicht** die Pin-Authority. Genau bei einer suspendierten Seite läuft
dieser Stale-Turn-Grant mangels Fortschritts-Evidenz ab. Würde davon auch `autoDiscardable` abhängen,
würden wir den Schutz in dem Moment entfernen, in dem Chrome ihn am dringendsten braucht.
Dasselbe gilt für `PRIME_WORKING_MS`/`summary.updatedAt`: eine Renderer-Anzeige darf keine Browser-
Side-Effect-Authority werden.

Die Extension reconciled diese gewünschte Conversation-Menge gegen ihre vorhandene
`tabConversations`/Chrome-Tab-Authority. Sie braucht **keinen zweiten semantischen protected-tabs
state**, aber sie braucht ein kleines browser-session-lokales **Side-Effect-Ownership-Journal** für
die Tabs, deren `autoDiscardable`-Wert CoS selbst geändert hat. Nur so kann CoS später exakt seine
eigene Mutation rückgängig machen, ohne einen bereits vorher vom User/Browser/anderen Tool auf
`false` gesetzten Wert blind auf `true` zu überschreiben.

### 3.2 Cluster B — Continuation-WAL ist die einzige Transfer-Autorität (#21, #26)

Der aktuelle Code hat bereits die richtige durable Primitive: eine Continuation-WAL plus
`sourceSend`/`destinationSend`-Checkpoints und die stabilen Marker
`[[CLF-HANDOFF:<token>]]` / `[[CLF-RESUME:<token>]]`. Gleichzeitig hält der Broker noch eine zweite
`PrimeTransfer`-Lease mit eigenem `TRANSFER_TTL_MS`. Zwei 10-Minuten-Lebenszeiten entscheiden damit
über denselben A→B-Transfer. Das ist die tiefere Architekturverletzung.

Die neue Invariante lautet:

> **Nur die Continuation-WAL entscheidet, ob A→B offen, replaybar, extern dispatched, committed
> oder explizit abgebrochen ist. Broker-/Workspace-/Goal-Zustand sind nach dem durable rebind nur
> Projektionen dieses Fakts.**

Expiry wird **checkpoint-aware**, nicht durch einen pauschalen Heartbeat verlängert:

- `not-attempted` / `attempted-unresolved`: Es ist bewiesen, dass nichts an ChatGPT dispatched
  wurde. Hier darf eine bounded Abandonment-Frist existieren.
- `dispatched-unresolved`: Ein externer Side Effect kann existieren. Nie automatisch replayen und
  nicht allein wegen Wall-Clock semantisch verwerfen; nur Marker-Reconciliation oder explizites
  Cancel beendet die Ambiguität.
- `sent` + gebundene `sourceMessageId`: ChatGPT hat die konkrete Generation serverseitig. Kein
  lokaler 10-Minuten-Timer darf diese Wahrheit ungültig machen. Abschluss = exakt dieser Turn wird
  als Handoff erfasst oder der User cancelt.
- Für die Destination gelten dieselben Regeln: nach Dispatch kein blindes Replay/Expiry.
- `openedAt` bleibt Diagnostik/Audit-Zeit, aber ist keine globale Kill-Switch-Uhr mehr.

**Konkrete Delete-Opportunity:** `PrimeTransfer`, `TRANSFER_TTL_MS`, begin/cancel/freeze/thaw/commit
transfer lifecycle und `swarmTransferActive()` aus dem Broker entfernen. Vor dem durable Rebind
fail-closed prüfen, dass B nicht Worker/anderem Prime gehört; nach dem Rebind genau eine idempotente
Prime-Projektion A→B aus dem committed Continuation-Fakt durchführen. Restart-Recovery liest dieselbe
WAL statt eine volatile Transfer-Lease neu zu erfinden.

PR #39 bleibt wertvolle Failure-/Regression-Evidenz, aber sein regelmäßiger `compactToken`-/`touchedAt`
Heartbeat ist **nicht** die Zielarchitektur. Ein content-seitiger Guard „dieser Chat reconciled gerade
seinen eigenen HANDOFF-Marker, also niemals auto-compacten“ ist sinnvoll als syntaktische
Defense-in-depth; er ersetzt nicht die app-seitige Authority.

### 3.3 Cluster C — Tunnel health + persistent setup (#23, #31)

#23 ist die Runtime-State-Maschine, #31 ist ihre Benutzerprojektion. Sie sollen **nicht** zwei
separate Health-Modelle bekommen.

Eine Tunnel-Process-Generation besitzt:

- child identity;
- health endpoint;
- first-poll grace;
- last successful control-plane poll;
- current outage complaint run;
- exactly one restart decision path.

Die Setup-UI zeigt nur eine Projektion davon plus per-surface MCP evidence. „Schema reviewed“ wird
nicht aus Permissions oder einem Tool Call geraten: maßgeblich ist der Fingerprint der **tatsächlich
von diesem Endpoint ausgelieferten `tools/list`-Shape**, beobachtet bei einem echten externen
ChatGPT-Discovery-Request. Self-diagnostics dürfen diesen Beweis nicht fälschen.

### 3.4 Cluster D — Portability boundaries (#22, #29)

Firefox und macOS sind zwei verschiedene Ports und dürfen nicht in eine generische
"PlatformFramework"-Abstraktion gepresst werden.

- Firefox braucht eine **WebExtension runtime/manifest boundary**.
- Browser automation braucht für Chrome/Firefox eine **single selected companion installation** als
  Custody-Grenze; „Browser-Familie“ allein ist keine Identity.
- macOS braucht eine **Desktop native driver boundary**.

Beide Grenzen sollen erst die tatsächlich unterschiedlichen Teile einschließen, nicht gemeinsame
Policy, Ownership, Security oder MCP-Schemas duplizieren.

### 3.5 Cluster E — Bootstrap identity + composer policy (#30; #25 als abgeschlossene Lektion)

#25 hat gezeigt, warum Conversation-Identity zentral geparst werden muss. #30 zeigt, warum Composer-
Mutation eine explizite Policy braucht. Beides gehört in den bestehenden Browser-bootstrap path,
aber nicht in denselben State.

- Route identity: `conversationFromPath()` ist die kanonische Regel.
- Draft mutation: eine explizite `preserve`/`replace-fresh-bootstrap` Policy, nur nach gültiger
  command lease + fresh-chat fence.

---

## 4. Empfohlene Ausführungsreihenfolge

### Batch 0 — Repository-Wahrheit herstellen, ohne fremde Arbeit zu zerstören

1. Dirty Worktree inventarisieren und unangetastet lassen.
2. `origin/main` gegen den lokalen Branch per `git cherry`/`range-diff` reconciliieren; #24/#25 als
   bereits CLOSED markieren, nicht erneut implementieren.
3. Offene PRs #17/#28/#39 gegen die geplanten Dateien diffen; keine fremde Feature-Branch-Historie
   blind in den Reliability-Branch ziehen.
4. #2 / PR #17 architecture-superseded entscheiden; wenn Maintainer zustimmt, ohne Produktcode
   schließen.

### Batch 1 — Reliability hot path

1. #21: Continuation als sole transaction, duplicate `PrimeTransfer`-Lease löschen, checkpoint-aware
   abandonment + recursive-auto-compact regression.
2. #36: Background-exec obligations; zuerst verlustfreie Capacity-Semantik, dann per-conversation
   Admission/Reminder.
3. #40: browser-live-required projection + targeted Chrome discard protection; keine neue
   Heartbeat-/Tab-Persistence-Schicht.
4. #35: darauf aufbauende read-only mutable wait/status projection; bekannte browser `frozen`-
   Evidence darf dort truthful als blocked/needs-user auftauchen.
5. #34: hidden working/final-delivery cadence korrigieren, ohne einen zweiten Poll-Clock zu bauen.
6. #27 gegen diese Architektur **und die aktuelle Transport-Error-Recovery** revalidieren; nur
   schließen, wenn der ursprüngliche Stall live
   entweder recovered oder als konkreter dependency state sichtbar wird.
7. #26 bleibt release-gated: keine neue Transfer-Logik; nach 2.0.3-Live-Verifikation den legacy
   resume-shadow hot-poll repair bounded machen/entfernen.

### Batch 2 — Tunnel correctness + setup

1. #23 Restart-/health state machine zuerst.
2. #31 UI/setup projection danach auf dieselbe autoritative Runtime setzen.

### Batch 3 — Bootstrap und Portability

1. #30 explicit draft policy.
2. #29 CLEAN Mac vertical slice reviewen/akzeptieren; **danach**, mit zwei realen Backends als
   Evidenz, nur die kleinste echte Driver-Grenze extrahieren.
3. #22 Firefox portability layer als eigenständigen Plattform-Gate; nicht unter 2.0.3-Zeitdruck
   halb-validiert ausliefern.

### Batch 4 — Release-/Close-Pass

Nach den Implementierungsbatches alle Issue-Labels/PR-Verweise aktualisieren, Prime-only Live-
Acceptance dokumentieren und nur die tatsächlich ausgelieferten/abgelehnten Issues schließen.

---

# 5. Issue-by-Issue Implementierungsplan

## #24 — Local verify scans unrelated refs / AppImage suite timeout

### Befund

**Im aktuellen Baum bereits gefixt und lokal verifiziert.**

PR #37 / Commit `69a2560` ändert:

- Public-history scan von allen refs auf die checked-out `HEAD`-Linie;
- annotierte relevante Tags werden nur berücksichtigt, wenn sie von `HEAD` erreichbar sind;
- Packaging-Test lädt nicht mehr unnötig den schweren AppImage dependency graph.

Lokale Regressionen: 26/26 grün.

### Status / keine weitere Issue-Arbeit

PR #37 ist inzwischen in `origin/main` gemerged und #24 ist **CLOSED / COMPLETED**. Diese Sektion
bleibt nur als Nachweis dafür, warum der Fix architektonisch richtig war. Nicht rebasen, nicht erneut
cherry-picken und nicht als offenen Batch behandeln. Vor Release lediglich prüfen, dass keine neuere
Änderung wieder `git rev-list --all` als Privacy-Autorität eingeführt hat.

### Separater Release-History-Blocker

Der neue Testscope deckt #24 korrekt ab, aber `verify-public-history` kann auf diesem konkreten HEAD
weiterhin **legitim** wegen unsafe author identity in echten HEAD-Ancestors (`9e27c0f`, `03acfba`)
scheitern. Das nicht als #24-Regression behandeln und die Prüfung nicht lockern. Stattdessen den
Release-History-Fall separat nach den Repo-/Release-Regeln bereinigen. Keine spontane History-
Rewrite-Aktion im Issue-Fix.

### Nicht tun

- Kein höheres Vitest-Timeout.
- Kein ignore für beliebige refs.
- Keine Privacy-Prüfung abschwächen, die `HEAD` tatsächlich erreichen kann.

---

## #25 — Project chats

### Befund

**Im aktuellen Baum behoben.** Der ursprüngliche Fehler war nicht MCP ownership selbst, sondern
Conversation-Identity: mehrere Parser akzeptierten nur `/c/<id>`, Project-Chats laufen aber unter
`/g/<project>/c/<id>`.

Relevante Änderungen:

- `bae42d0` / PR #38 führt `CLF_DOM.conversationFromPath()` ein und ersetzt root-only parsing.
- `fff2d7d` zieht die Project-route-Erkennung auch dort durch, wo ein bereits benannter Chat für
  Bootstrap/Revival gelesen wird.
- `/share/c/...` bleibt absichtlich ausgeschlossen.

`test/content-script.test.ts` ist im Audit 287/287 grün.

### Status / keine zweite Route-Implementation

PR #38 ist inzwischen in `origin/main` gemerged und #25 ist **CLOSED / COMPLETED**. Der lokale Branch
enthält verhaltensäquivalente Änderungen bereits unter anderen Hashes. Vor dem Release nur noch:

1. Mit `rg` sicherstellen, dass es **keine weitere unabhängige `^/c/` Conversation-ID-Regex** in
   content/background/bootstrap code gibt.
2. Live Prime-only smoke:
   - normale `/c/<id>` chat;
   - Project `/g/<project>/c/<id>` chat;
   - frischer worker/resume in Project;
   - `/share/c/<id>` wird nicht gebunden.

### Definition of done

Popup hat in Project chat eine echte app session; MCP caller identity ist proven; worker revive und
resume target fences akzeptieren denselben Project conversation id.

---

## #26 — repeated resume-shadow repair loop in released v2.0.2

### Befund

**Quellcode-Fix bereits in `main`/aktuellem Baum vorhanden; Release v2.0.2 enthält ihn nicht.**

PR #19 / Merge `03acfba` macht resume-shadow repair idempotenter und verhindert wiederholte
Repair-Meldungen auf jedem Activity-Poll. Die aktuellen bridge regressions für den Repair-Pfad sind
grün.

### Aktion

Kein neuer Bugfix für den gemeldeten Loop.

1. Nächstes Release bauen.
2. Auf macOS mit einem Zustand testen, der vorher vom v2.0.2-Bug betroffen war.
3. Activity polling mindestens mehrere Zyklen laufen lassen.
4. Beweisen: genau eine notwendige Repair-Aktion / kein wiederholter Repair-loop.
5. Erst nach ausgeliefertem Release #26 schließen.

### Danach Architektur-Schuld löschen

Der Compatibility-Repair wird aktuell noch aus dem heißen `/activity`-Polling-Pfad aufgerufen.
Sobald eine Release-Version mit dem eigentlichen Fix im Feld ist, diesen Presentation-Poll als
Repair-Owner entfernen. Falls genau ein Compatibility-Fenster nötig bleibt, **ein bounded startup /
attachment reconciliation pass** statt „bei jedem Activity-Poll nochmal prüfen“ verwenden. Danach
die hot-path-Aufrufe und ihre Tests löschen.

---

## #21 — Auto-compaction verpasst oversized session und compacted den eigenen handoff

### Befund

**Zwei Teilprobleme.**

#### Teil A: Auto-compaction sprang zu spät/nicht an

Der aktuelle Baum hat die frühere edge-after-turn Semantik bereits zu einer level+mid-turn Regel
umgebaut:

- `autoCompactionReady(summary)` ist nur noch `contextTokens >= threshold`;
- `bridge.ts::chatIsWorking()` liefert die live-Hälfte;
- `content.js::maybeAutoCompact()` verlangt eine laufende Generation, nicht einen gerade beendeten
  Turn.

Commit `7c37688` hat die alte one-shot/edge-Semantik materiell entfernt: readiness ist heute ein
Level, und gezielte Tests halten sie auch über interrupted/reopened turns. Damit ist die konkrete
„Schwelle einmal verpasst, danach für immer weg“-Klasse beseitigt. Der ursprüngliche 730k-Live-
Trace wurde in diesem Audit nicht erneut mit Browserinstrumentierung reproduziert; außerdem kann
#34 hidden polling noch verzögern. Status daher: **stark verbessert / Regression abgedeckt, finale
Live-Acceptance noch offen**, nicht „blind vollständig bewiesen“.

#### Teil B: Handoff compacted sich nach ~10min selbst

Noch offen im aktuellen Baum: Continuation expiry basiert auf einer festen Lifetime, während die
Handoff-Generation real länger leben kann. Fällt der app-side busy job weg, sieht
`maybeAutoCompact()` weiterhin einen großen aktiven Turn.

PR #39 diagnostiziert diesen zweiten Fehler korrekt und beweist mit Regressionen, dass eine lange
Handoff-Generation die feste 10-Minuten-Grenze überschreiten kann. Sein konkreter Fix verlängert die
Continuation jedoch über `compactToken`-/`touchedAt`-Heartbeat. Der heutige Baum besitzt bereits die
stärkere Information: durable send checkpoints plus die gebundene Source-Handoff-Message mit
`[[CLF-HANDOFF:<token>]]`. Gleichzeitig besitzt `agents.ts` noch eine **zweite** 10-Minuten-
`PrimeTransfer`-Lease. Diese Doppelzuständigkeit muss weg, nicht synchronisiert werden.

### Architekturentscheidung

**Nicht noch eine bessere Lease bauen. Die Durable-WAL soll die einzige Transfer-Autorität sein und
Expiry muss danach unterscheiden, ob ein externer Side Effect sicher ausgeschlossen oder möglich
ist.**

Bevorzugte Invariante:

```text
source/destination send checkpoint proves whether replay/abandon is safe

not-attempted | attempted-unresolved
  => nothing was dispatched; bounded abandonment is safe

dispatched-unresolved
  => ChatGPT may have accepted the click; never replay or wall-clock-abort the semantic attempt

sent(messageId)
  => exact server-authored message exists; reconcile that message until terminal/cancel

committed | aborted
  => terminal
```

`openedAt` bleibt Historie. Es gibt **keine globale Expiry-Uhr**, die einen bereits möglichen oder
bewiesenen externen Request nach zehn Minuten für nicht existent erklären darf.

### Umsetzung

Dateien:

- `src/main/session/continuation.ts`
- `src/main/agents.ts`
- `src/main/bridge.ts`
- `extension/content.js`
- `test/continuation.test.ts`
- `test/agents.test.ts`
- `test/bridge.test.ts`
- `test/content-script.test.ts`

Schritte:

1. PR #39 als Diagnose/Testreferenz lesen, aber nicht seinen Poll-Heartbeat als neue Authority
   übernehmen.
2. `PrimeTransfer`, `TRANSFER_TTL_MS`, begin/cancel/freeze/thaw/commit transfer lifecycle und
   `swarmTransferActive()` entfernen. Die Continuation-WAL ist der sole transaction owner.
3. Vor dem durable Rebind mit einer kleinen read-only Broker-Predicate fail-closed prüfen, dass das
   Destination-Chat nicht Worker/anderem Prime gehört. Kein Transfer-State wird dafür angelegt.
4. Nach dem durable `rebindSession` genau eine idempotente Broker-Projektion des Prime A→B aus dem
   committed Continuation-Fakt durchführen; dieselbe Projektion muss Restart-Recovery wiederholen
   können, ohne eine neue Lease zu minten.
   **Diese committed projection muss auch `moveExecConversationOwners(A, B)` enthalten.** Der Helper
   existiert bereits, hat im aktuellen Produktcode aber keinen Caller. Ohne ihn werden Background-
   Exec-Sessions aus A nach erfolgreichem Resume in B unpollbar und verschwinden gleichzeitig aus
   #36s caller-scoped obligation view.
5. `sweep()`/Restore/Claim so umstellen, dass nur checkpoints ohne möglichen externen Side Effect
   automatisch abandoned werden dürfen. `dispatched-unresolved` und `sent` enden ausschließlich über
   exact marker evidence oder explizites Cancel. **Restore darf records nicht vor der State-Prüfung
   pauschal wegen `openedAt > 2*TTL` wegwerfen.** `committing`, `dispatched-unresolved` und `sent`
   müssen zuerst ihre authoritative reconciliation bekommen; terminal GC bekommt, falls nötig,
   eine separate terminal timestamp statt die alte open-lifetime-Uhr zu missbrauchen.
   **Geschlossene Regression #32 mitnehmen:** `bridge.ts::commandDeadlineDelay()` koppelt einen
   claimed Resume heute noch an `continuation.openedAt + CONTINUATION_TTL_MS`. Wenn #21 die globale
   semantische Continuation-TTL entfernt, darf dieser Bridge-Timer nicht heimlich dieselbe 10-Minuten-
   Abort-Authority behalten. Vor Dispatch bleibt ein bounded delivery deadline korrekt; nach
   durable claim/dispatch richtet sich Deliverability/Ending nach dem Continuation-Checkpoint, nicht
   nach Wall-Clock. Danach den semantisch überflüssigen `CONTINUATION_TTL_MS`-Import im Bridge-Pfad
   entfernen.
6. `maybeAutoCompact()` muss explizit erkennen: der aktuell offene Turn ist die gebundene HANDOFF-
   Source-Message. Dann darf er unabhängig von einer eventuell bereits abgelaufenen `job.busy`-
   Projektion nicht self-compacted werden.
7. Source-/Destination-Binder bleiben idempotent auf exakt derselben `messageId`; falsche Token oder
   andere Messages dürfen niemals den transaction state fortschreiben.
8. Nach erfolgreichem Cut alte Transfer-Reconstruction-/rollback-Tests löschen statt beide
   Mechanismen testweise weiter zu konservieren.

### Regressionen

- oversized active ordinary turn => exactly one auto compact.
- interrupted threshold crossing => späterer active turn darf erneut triggern.
- source handoff > 10min nach `sent(messageId)` => keine wall-clock expiry, kein self-compact.
- crash/reload nach `attempted-unresolved` => exakt ein anderer Document-Owner darf den noch sicher
  ungesendeten Prompt übernehmen.
- crash/reload nach `dispatched-unresolved` => **kein** Replay; Marker oder explizites Cancel muss
  entscheiden.
- app restart nach `sent(messageId)` => WAL + stable marker reconciliieren ohne neue Transfer-Lease.
- claimed/dispatched Resume bleibt **>90s und >alte 10min** owned/reconcilable; kein späteres #32-
  Orphaning durch `commandDeadlineDelay()`.
- pre-dispatch Command, der nie einen externen Side Effect erzeugte, bleibt bounded und darf nach
  seinem Delivery-Window sauber fehlschlagen.
- wrong token / wrong source message / different message id => keine Transition.
- committed A→B + app restart vor Broker-Projektion => projection repair idempotent nach B.
- background exec in A + committed resume A→B => A darf nicht mehr pollen, B darf denselben
  `session_id` pollen/drainen; Restart zwischen rebind und projection repariert dieselbe Ownership.
- destination B ist worker-/other-prime-owned => Rebind fail-closed, A bleibt Authority.
- app projiziert stale `autoCompactReady=true`, während die markierte Handoff-Message offen ist =>
  weiterhin exactly one compaction.
- terminaler alter Handoff-Marker blockiert einen späteren legitimen Auto-Compact nicht.
- completed/aborted continuation => nie revivebar.

### Nicht tun

- TTL einfach auf 30 oder 60 Minuten erhöhen.
- Zweiten watchdog für handoff generation hinzufügen.
- `touchedAt` auf jedem `/activity`-Poll zur neuen semantischen Lebensuhr machen.
- `compactCapture`/`compactToken` nur für diesen Fix als parallele Identitätsquelle neu einführen.
- Auto-compaction global während irgendeiner Continuation abschalten; nur exact ownership zählt.
- Broker-Transfer-TTL und Continuation-TTL „aufeinander abstimmen“; zwei Uhren bleiben zwei
  Autoritäten.

---

## #34 — Background worker tabs show stale partial output

### Reproduzierbarer Codegrund

`extension/content.js::scheduleActivityPull()` entscheidet derzeit sinngemäß:

```text
drafting -> live cadence
hidden   -> 30s
generating -> live cadence
active -> active cadence
idle -> idle cadence
```

Damit gewinnt `document.visibilityState === hidden` sogar über `generating`. Das widerspricht dem
eigentlichen Zweck der Throttling-Regel: hidden **idle** darf langsam sein, hidden **working** nicht.

### Minimaler sauberer Fix

Cadence nach Arbeitszustand priorisieren:

```text
drafting / exact terminal-delivery obligation -> LIVE_ACTIVITY_MS
visible generating                            -> LIVE_ACTIVITY_MS
hidden generating / other active work         -> ACTIVITY_MS (start here; prove if faster is needed)
hidden idle                                    -> HIDDEN_ACTIVITY_MS
visible idle                                   -> IDLE_ACTIVITY_MS
```

Nicht einfach `hidden` entfernen. Es bleibt eine gute Strom-/CPU-Optimierung für wirklich idle tabs.

### Umsetzung

1. In `scheduleActivityPull` die Priorität ändern.
2. **`finalizing` nicht als frei gesetztes Flag einführen.** Die terminale Kante ist genau das
   gemeldete Loch: `generating` kann bereits false sein, während Overwrite noch eine ältere Revision
   zeigt. Stattdessen eine abgeleitete terminal-delivery obligation benutzen:
   - Fiber/DOM kennt die finale stabile `{messageId, text/revision}`;
   - die App-/Activity-Projektion hat genau diese Revision noch nicht zurückbestätigt;
   - bis zur Gleichheit bleibt live cadence; danach ist die obligation weg.
3. Wenn derselbe Fiber-`messageId` lokal bereits einen längeren finalen Text beweist als die stale
   App-Revision, darf die UI die native finale Prosa sofort zeigen statt eine bekannte alte Revision
   darüber zu halten; danach weiter pollen, bis die App konvergiert.
4. `nativeBusy`, `job.busy`, `pendingTools` nur dort für active cadence benutzen, wo der Feed real
   sichtbare Konvergenz liefert. Ein existierender Prozess ist kein final-delivery proof.
5. Keine neue timer family und kein persistiertes `finalizing`.

**#40-Crosscheck:** `hidden generating => 750ms forever` ist kein Qualitätsziel. Chrome Energy
Saver friert gerade hidden, CPU-intensive Seiten; aggressiver Periodic Work kann die Eligibility
verschlechtern. Für hidden generation daher zuerst bestehende Fiber/DOM-Ereignisse als unmittelbare
Pull-Trigger nutzen und `ACTIVITY_MS` als Safety-Cadence testen. `LIVE_ACTIVITY_MS` ist für die kurze
exact terminal-delivery obligation gerechtfertigt, bis die App exakt dieselbe finale Revision
zurückliefert. Nur wenn Live-Acceptance beweist, dass 2s nicht reicht, enger werden.

Zusätzlicher Scheduler-Race aus dem zweiten Review: `scheduleActivityPull()` armed den nächsten Pull
erst **nach** `await pullActivity()`, während `pullActivity()` anschließend lange Side Effects wie
`maybeAutoCompact()/startCompact()` abwarten kann. Ein aktiver Tab kann dadurch trotz korrekter
Cadence-Auswahl zig Sekunden ohne neuen Pull bleiben. Fetch/apply und Side-Effect-Dispatch deshalb
trennen: nach dem autoritativen Activity-Snapshot `pulling` freigeben + nächsten Pull armen; Compact-
/Goal-Aktionen danach außerhalb des Poll-Clocks starten. Weiterhin **eine** Timer-Familie.

Falls ein Prime-only Chromium-Live-Test danach beweist, dass Chrome auch den verkürzten
`setTimeout` in hidden tabs so stark throttelt, dass aktive Arbeit weiterhin nicht konvergiert,
**erst dann** die Scheduling-Custody für aktive/finalisierende Pulls in den Extension-Service-Worker
verschieben. Auch dann nur ein Clock-Owner; keinen zweiten parallelen Polling-Loop im Content-Script
stehen lassen. Ohne diesen Live-Beweis bleibt die reine Prioritätskorrektur der bevorzugte kleine
Fix.

### Regression

`test/content-script.test.ts` mit fake timer / direktem pull:

1. tab hidden + overwrite on;
2. Activity feed liefert frühen Assistant-Snapshot;
3. native/fiber final answer erscheint während hidden;
4. generation terminalisiert;
5. kein `visibilitychange`;
6. overlay konvergiert innerhalb live/active cadence auf finalen Text;
7. hidden idle bleibt 30s cadence.
8. ein bewusst unresolved `startCompact()` nach einem erfolgreichen Activity-Snapshot verhindert
   nicht, dass der nächste live Pull bereits ge-armed ist.

### Live acceptance

Prime-only: worker im Hintergrund fertig laufen lassen, ohne Tab zu fokussieren; parent/overlay muss
den vollständigen finalen Text sehen.

---

## #40 — Prevent Chrome Memory Saver from suspending active Prime/Worker tabs

### Verifizierter Root Cause

Neu während dieses Audits eröffnet. Der aktuelle Browser-Lifecycle-Code hat bereits eine starke
Tab-/Document-Identity, aber **keine Policy-Projektion dafür, welche dieser Tabs gerade für laufende
Execution unverzichtbar sind**:

- `extension/background.js::chrome.tabs.onUpdated` reagiert heute nur auf `status=loading` und URL-
  Wechsel weg von ChatGPT;
- `changeInfo.discarded` und `changeInfo.frozen` werden ignoriert;
- `tabConversations` + document ownership leben korrekt in `storage.session` über MV3-worker sleeps;
- der eine vorhandene `RETRY_ALARM`/`maintain()`-Loop läuft bereits alle 30s, solange ChatGPT-Tabs
  gehalten werden. **Keinen zweiten Keepalive-/Memory-Saver-Timer hinzufügen.**

Chrome unterscheidet zwei externe Browserzustände, die der Fix ebenfalls unterscheiden muss:

1. `autoDiscardable` / `discarded`: Chrome kann einen Hintergrund-Tab aus Memory unloaden. Die
   Extension darf `autoDiscardable:false` setzen.
2. `frozen`: seit Chrome 132 beobachtbar; die Seite bleibt im Speicher, aber Event Handler, Timer
   und Promise-Fortsetzungen laufen nicht. `tabs.update()` hat **keine** `frozen:false`-Mutation.

Darum ist `autoDiscardable:false` eine saubere **Discard-Protection**, aber kein erfundener Freeze-
Opt-out. Kein Heartbeat kann eine eingefrorene Seite „am Leben halten“, weil genau dessen Timer dann
nicht laufen.

### Zielarchitektur: semantic need in app, physical tab custody in extension

App-seitig eine pure Projection, z. B.:

```ts
browserProtectedConversations(): string[]
```

aus bestehenden Authorities zusammensetzen:

- jede Conversation mit einem formal offenen Recorder-Turn — damit gilt die Architektur auch für
  einen normalen langen Lone-Chat, nicht nur für Swarms;
- active Prime eines aktiven Run;
- bound Worker mit execution obligation (`active`, `waking`, auch `detached` als semantischer
  Wunsch: falls derselbe Chat gerade wieder als Tab auftaucht, wird er sofort geschützt; `detached`
  allein erzeugt **keinen** neuen Tab);
- sleeping/finished/failed History ausdrücklich nicht.

Diese Liste im **bestehenden `/status` maintenance exchange** ausliefern. Content-Script oder Seite
dürfen ihren Agent-Status nicht selbst behaupten. Der heutige Exchange ist nur GET/app→browser; für
`frozen`-Evidence wird er zu **einem bidirektionalen full-snapshot reconcile** erweitert statt einen
zweiten Kanal/Poller zu bauen:

1. Background queried unmittelbar vor dem pass seine exact ChatGPT tabs.
2. Ein authentifizierter `POST /status` (GET für kompatible Leser beibehalten) trägt einen bounded
   Snapshot wie `{conversationId, discarded?, frozen?}` — nur für exact `tabConversations`.
3. Bridge ersetzt damit **ephemeral** die browser-availability projection; keine WAL/Transcript-
   Persistenz, kein per-event boolean merge, das stale true/false sammeln könnte.
4. Dieselbe Antwort liefert `browserProtectedConversations` + bestehende repair/monitoring data.
5. `onUpdated(discarded/frozen)` stößt denselben serialisierten maintenance owner sofort/zeitnah an;
   es entsteht kein neuer timer family.

Background-seitig:

1. `maintain()` mappt nur exact `tabConversations` auf die gewünschte Conversation-Menge.
2. Wenn ein exact Chat-Tab geschützt werden soll und `tab.autoDiscardable === true`:
   - vor der Mutation `{tabId, conversationId, previousAutoDiscardable:true}` in einem kleinen
     `storage.session` effect journal durable schreiben;
   - erst danach `chrome.tabs.update(tabId, {autoDiscardable:false})`;
   - nach await erneut prüfen, dass Tab + Conversation noch dieselbe sind, bevor weitere Side
     Effects folgen.
3. Wenn `autoDiscardable` bereits `false` war, **nichts besitzen/merken und später nichts auf true
   zurücksetzen**. Das kann User-/Browser-/andere Policy gewesen sein.
4. Wenn die semantische Protection endet, der Tab ChatGPT verlässt oder der Benutzer CoS explizit
   disconnected:
   - nur journal-owned Mutationen auf den gespeicherten prior value zurückstellen;
   - Journal-Eintrag erst nach erfolgreicher Restore-Mutation löschen.
5. MV3 service-worker restart lädt dieses effect journal + `tabConversations` aus derselben Browser-
   Session und reconciled weiter. Numeric tab IDs werden **nicht** app-seitig persistiert.
6. Ein transient unerreichbarer App-Status ist kein Beweis, dass Protection endete: dann aktuelle
   Tab-Policy stehen lassen und beim nächsten bestehenden maintenance pass erneut reconciliieren.
7. Jeder Journal-Eintrag enthält neben `tabId` auch die exact Conversation, deren Mutation er
   schuldete. Vor **jeder** apply/restore-Mutation `tabs.get` + `conversationForTab` erneut prüfen;
   ein navigierter oder wiederverwendeter numeric tab id darf niemals fremde Tab-Policy erben.
8. `tabs.onRemoved`: Tab existiert nicht mehr, also journal-owned row löschen, **ohne** einen Restore
   gegen einen nicht existierenden Tab zu versuchen.

Das effect journal ist kein zweiter Owner für „wer arbeitet“; es beantwortet nur „welche Browser-
Mutation schuldet CoS noch zurück?“.

### Discard/freeze events sind keine Conversation-Terminals

`onUpdated(changeInfo.discarded/frozen)` wird lifecycle-aware:

- `discarded=true` oder `frozen=true` darf **niemals** `markTerminal()`, `releaseTab()` oder
  `/closed` auslösen;
- exact conversation ownership bleibt erhalten;
- Chrome <132 / Browser ohne `frozen`-Feld wird per Feature Detection normal weiter unterstützt;
- der bestehende stale-turn / `queueBrowserRecovery()`-Pfad bleibt die **einzige Reload-Authority**,
  wenn ein formal offener Turn nachweislich keine Browser-Evidenz mehr liefert. Kein zweiter
  „Memory Saver reload loop“.

Für `frozen=true` zusätzlich eine kleine **ephemere browser-availability observation** an den
App-/Runtime-View liefern (im bestehenden maintenance/lifecycle exchange, kein neuer Poller). Diese
Observation darf:

- #35 truthful `Chrome suspended this active tab` / `needs_user` oder `blocked` zeigen;
- Diagnostics erklären, warum Browser-Korrelation gerade fehlt;

aber sie darf **nicht**:

- Turn-Liveness verlängern;
- Agent ownership ändern;
- automatisch den Tab fokussieren (`active:true` würde dem User Fokus stehlen);
- einen periodischen Reload- oder Keepalive-Loop starten.

Wenn die bestehende one-shot recovery einen frozen/discarded Tab über denselben exact-chat path
reloaden kann, das Prime-only gegen die aktuelle Chrome-Version verifizieren. Falls ein frozen Tab
danach weiterhin frozen bleibt, ehrlich `needs_user: activate the tab` surfacen statt einen zweiten
Recovery-Mechanismus zu erfinden. Eine dokumentierte Chrome-Site-Exception kann als User-Workaround
für Memory Saver angeboten werden, ist aber keine App-Authority und kein verlässlicher allgemeiner
Freeze-API-Ersatz.

### Regressionen

`test/extension.test.ts` / `test/bridge.test.ts`:

- open ordinary non-swarm turn => exact mapped tab protected;
- active Prime + active/waking worker => exact mapped tabs protected;
- sleeping/finished/failed unrelated chats => unverändert;
- `activeUntil` expires while recorder turn remains open => protection bleibt; stale-turn recovery
  und discard policy sind zwei getrennte Facts;
- preexisting `autoDiscardable=false` => CoS setzt/owned nichts und restauriert später **nicht** true;
- owned true→false mutation => journal persistiert vor update; release restores true then deletes;
- effect-boundary cut A: journal persistiert, worker stirbt **vor** `tabs.update(false)` => next
  reconcile prüft exact tab/conversation/desired state und wendet höchstens dieselbe Mutation an;
- cut B: `tabs.update(false)` erfolgreich, worker stirbt direkt danach => journal beweist CoS-
  Ownership und erlaubt später genau den prior restore;
- cut C: restore `tabs.update(prior)` erfolgreich, worker stirbt **vor** journal delete => next
  reconcile erkennt current tab/conversation/desired state und konvergiert idempotent, ohne einen
  falschen reused/navigated Tab zu mutieren;
- navigation von protected ChatGPT-Tab zu anderer Site => prior value restauriert, bevor Ownership
  wegfällt;
- tab removal => journal row dropped without restore attempt;
- transient `/status` outage => keine speculative unpin;
- `discarded=true` / `frozen=true` => kein close/terminal/release;
- Chrome<132 event shape ohne `frozen` => kein Fehler;
- frozen observation erscheint in Runtime-/Diagnostics-Projection, aber setzt weder `activeUntil`
  noch neue reload timers;
- existing stale-turn repair bleibt at-most-once, auch wenn frozen/discarded evidence gleichzeitig
  eintrifft.

### Prime-only Live Acceptance

1. `chrome://discards`: active CoS execution tab zeigt/behält `autoDiscardable=false`; unrelated
   ChatGPT tab bleibt normal discardable.
2. Worker/Prime beendet die relevante execution obligation => nur CoS-owned protection wird
   freigegeben.
3. Urgent Discard eines geschützten Testtabs als adversarial/manual Override: keine Ownership-
   Löschung; bestehende reload/rebind architecture stellt denselben Chat wieder her.
4. Chrome 132+ frozen test / Energy Saver: event wird erkannt und truthful surfaced; kein Focus-
   Steal und kein Reload-Storm.
5. Gleichzeitig #34 prüfen: hidden final output konvergiert, ohne dass CoS durch unnötig aggressive
   Dauerpolling-CPU selbst Freeze-Eligibility erhöht.
6. Full browser restart: `storage.session`-Journal ist erwartbar weg; app/broker truth schützt
   wieder nur die nach Restart tatsächlich aktiven exact chats, idle/unrelated Tabs bleiben normal.

### Nicht tun

- `setInterval`/audio/WebSocket-Keepalive nur um Memory Saver „auszutricksen“.
- alle `chatgpt.com` Tabs dauerhaft non-discardable machen.
- site-wide Chrome Performance Settings ohne explizite User-Entscheidung verändern.
- `frozen=false` imaginieren oder Tab automatisch foregrounden.
- `discarded` als echten Tab-Close interpretieren.
- auf release blind `autoDiscardable:true` setzen.

---

## #36 — Background exec results accumulate unread

### Befund

Die **beabsichtigte** Datenintegritäts-Invariante ist richtig: ein nach dem initialen
`exec_command` retained Resultat muss bis zum terminalen `write_stdin` erhalten bleiben. Der
aktuelle Manager verletzt diese Invariante aber am globalen Capacity-Cap: `ensureProcessCapacity()`
kann einen exited LRU über `releaseProcessId()` löschen, obwohl sein Resultat noch unread ist.

Der aktuelle Baum hat außerdem bereits model-facing Recovery-Hinweise (`backgroundExecRecoveryNotices`)
und Regressionen, die einen unread result später erneut anbieten. Es fehlt aber ein **bounded
admission rule**, die verhindert, dass ein Chat unbegrenzt weitere Background-Prozesse startet,
obwohl mehrere fertige Resultate nicht gelesen wurden.

Der Worker-Audit hat zusätzlich einen härteren Fehler gefunden: `ensureProcessCapacity()` kann beim
globalen 64-Session-Cap einen exited LRU auswählen und über `releaseProcessId()` löschen. Ein nach
dem ersten `exec_command` **retained exited** Prozess ist aber genau das unread Resultat, das noch von
`write_stdin` konsumiert werden muss. Unter genügend Launches kann die heutige Capacity-Policy also
den Output löschen, den `exitedUnread` eigentlich ausdrücklich schützen soll.

### Architekturentscheidung

Keine neue Queue. Die Autorität bleibt:

```text
UnifiedExec manager state
  + exact conversation ownership registry
  = BackgroundExecObligations(conversation)
```

Eine kleine pure Projektion liefert:

```ts
{
  running: string[];
  exitedUnread: string[];
}
```

Diese Query soll als **eine** Ownership-Projektion, z. B.
`backgroundExecStateForConversation(conversationId)`, an vier Stellen wiederverwendet werden:

1. model-facing reminder;
2. pre-spawn admission gate für **neue** `exec_command` background sessions;
3. #35 wait/status surface.

Der **globale** Manager braucht für Capacity keine Conversation-Ownership: jede exited Row, die nach
dem initialen Call noch im Manager steht, ist per Definition result-bearing/unread. Ownership wird
erst für caller-scoped Reminder/Admission/Status benötigt.

### Umsetzung

Dateien wahrscheinlich:

- `src/main/codex/ownership.ts`
- `src/main/mcp/kernel.ts`
- UnifiedExec manager nur falls eine non-destructive query fehlt
- `test/mcp.test.ts`
- #35 UI/bridge files im späteren Batch

Schritte:

1. Existing `exitedUnread(processIdsOwnedBy(conversationId))` nicht duplizieren; zu einer einzigen
   ownership-scoped obligation query machen.
2. **Capacity-Safety zuerst:** exited-LRU-Eviction vollständig löschen. Bei 64 reservierten Sessions
   wird die 65. Reservation verweigert; keine vorhandene Session wird als Nebenwirkung gelöscht.
   Danach ungenutztes `lastUsed`-/Capacity-`interactionLock.tryLock`-Gerüst entfernen, sofern es nur
   für die gelöschte Eviction existierte.
3. Conservative per-chat completed-unread threshold als benannte Policy-Konstante definieren. `4`
   ist eine sinnvolle Start-Hypothese aus externer Reproduktion, aber keine Architekturwahrheit;
   gegen normale parallele Fan-out-Workloads testen und dokumentieren.
4. Wenn threshold erreicht: **jeden neuen `exec_command`, der eine Session minten kann, vor Spawn
   verweigern.** Die aktuelle API kann vor dem Spawn nicht wissen, ob der Command innerhalb des
   Yield-Fensters foreground fertig wird oder eine retained Session zurückgibt. Keine neue
   „no-retain“-API nur zur Umgehung des Gates bauen.
5. Fehler nennt ausschließlich session ids des proven caller conversations und sagt explizit,
   diese mit `write_stdin` zu drainen.
6. `write_stdin` bleibt immer erlaubt, damit der Zustand lösbar ist.
7. Tool descriptions für `exec_command`/`write_stdin` klar machen: **jede zurückgegebene
   `session_id` ist eine Obligation bis zur terminalen Antwort**; bei transientem Wait-Fehler denselben
   ID erneut pollen, nicht neue Arbeit starten.
8. Running sessions zählen nicht als unread.
9. `write_stdin` bleibt unabhängig vom Gate immer erlaubt und ist der primäre Weg, Capacity wieder
   freizugeben.
10. Transient `write_stdin` failure soll denselben session id als retry obligation nennen.

### Regressionen

- 0..threshold-1 unread => neue background session erlaubt + reminder.
- threshold unread => kein child spawn.
- drain one => admission wieder offen.
- anderer conversation owner => weder ids sichtbar noch blockiert.
- running != unread.
- output bleibt bis consume erhalten.
- globaler process capacity cap => unread exited row wird **nie** als LRU gelöscht; wenn alle
  Kandidaten Obligations sind, neuer Spawn wird verweigert.

---

## #35 — Proactively explain when main chat is waiting/blocked

### Befund

Die Daten existieren, aber verteilt. Das Issue darf nicht dazu führen, dass ein LLM periodisch
"still working" schreibt oder dass content.js einen zweiten Orchestrator bekommt.

### Ziel

Keine neue Progress-State-Machine. Stattdessen die in Cluster 3.1 definierte **read-only
`conversationRuntimeView(id)` / obligations projection** im App-Layer, die nur Fakten benennt, die
CoS wirklich kennt. Turn-Liveness/Recovery bleibt separat bei `activeUntil` + recorder.

Priorität der Gründe sollte deterministisch sein, z. B.:

1. `needs_user` — expliziter, nicht automatisch lösbarer Zustand;
2. `retrying` — bekannte backoff/recovery action;
3. `blocked` — completed-unread exec threshold / continuation durable barrier;
4. `waiting` — outstanding worker(s) / running background process;
5. `working` — assistant turn actively progresses;
6. unknown nur wenn es einen offenen Turn gibt, aber keine konkretere dependency.

### Worker status

Nicht behaupten, der Parent sei "blocked on worker 2", nur weil Worker 2 aktiv ist. Eine echte
blocked-on-worker Aussage braucht eine Orchestrator-Evidenz, dass der Prime gerade auf Worker-
Resultate wartet. Falls diese Evidenz heute nicht existiert, UI text bescheidener halten:

`2 of 3 workers still running` statt `Prime is blocked on Worker 2`.

### External/GitHub status

Keinen generischen GitHub-CI-Tracker in CoS erfinden. Nur wenn ein externer Status über einen
bereits autoritativen Tool/exec state bekannt ist, darf er konkret benannt werden. Sonst
`Waiting for the current external operation…`.

### UI

Bestehende `.clf-stage` / `stageView()`-Fläche wiederverwenden. Sie zeigt heute Compact-job, sonst
Goal; diese Projection dort als weitere abgeleitete View einordnen statt einen neuen Panel-State
einzuführen. Eine Zeile, mutable, nicht model-visible.

Show policy:

- sofort bei meaningful retry/needs-user transitions;
- nach kurzer quiet threshold (ca. 2–5s) für normale waits;
- beim nächsten echten Assistant-/tool progress sofort ausblenden/ersetzen;
- elapsed time darf low-cadence neu gerendert werden, ohne neue Statusobjekte zu schreiben.

### Tests

- one/multiple worker activity;
- worker failure;
- background exec running;
- background exec completed-unread threshold;
- continuation awaiting durable boundary;
- browser recovery queued/retrying;
- unknown open turn;
- progress clears status.

Konkrete voraussichtliche Dateien: `src/main/bridge.ts` für die Composition, `src/main/codex/ownership.ts`
für den Exec-Teil, `src/main/multi-agent/agents.ts` oder den existierenden Broker nur falls eine
read-only Worker-Projektion fehlt, und `extension/content.js::stageView()` für Rendering. Keine
write-path Änderungen im Broker nur für UI.

### Delete opportunity

Nach Einführung der Projektion prüfen, ob der alte page-local 10-minute "No visible progress"-
Text noch einen einzigartigen Nutzen hat. Wenn dieselbe Situation bereits durch app-owned stale-turn
recovery + truthful progress status abgedeckt ist, den redundanten Diagnosepfad entfernen statt drei
Warnmechanismen parallel zu behalten.

---

## #27 — Turn remains generating 10+ min after tool result

### Befund

Das gemeldete v2.0.2-Root-Verhalten ist im lokalen Branch **materiell verbessert**, aber nach dem
2026-08-31-Live-Audit noch nicht closable:

- `CHAT_ACTIVE_MS = 2min` führt pro Conversation einen activity grant;
- assistant text/native activity/errors/attributed calls verlängern ihn;
- ein offener Turn, dessen Grant ausläuft, bekommt genau eine receipt-tracked browser recovery;
- ein formal beendeter Turn wird explizit nicht reloaded;
- Repair-Trigger konvergieren in `queueBrowserRecovery()` statt je eigene reload paths zu haben.

Das ist die richtige Basis. Einen weiteren 10-Minuten-Recovery-Timer hinzuzufügen wäre Regression.

Zusätzlich hat ein neuer Live-Fall eine getrennte Evidenzklasse sichtbar gemacht: ChatGPT kann einen
sichtbaren Transport-Fehler (`role=alert`, z. B. delivery timeout) zeigen, während der Turn formal
offen bleibt. Die aktuelle dirty Worktree-Änderung klassifiziert nur erkannte Transport-Banner und
reicht sie mit dem live `turnId` an **dieselbe** `queueBrowserRecovery()`-Authority weiter. Das ist
architektonisch richtig, aber noch uncommitted/unreleased. #27 deshalb nicht als „nur Acceptance“
abhaken, bevor dieser Pfad integriert und live verifiziert ist.

Wichtig: Ein bloß laufender Background-Prozess oder queued Agent-Message darf `activeUntil` **nicht**
verlängern. Das ist keine ChatGPT-Fortschritts-Evidenz. Wenn ein echter Tool-Result/attributed call
ankommt, verlängert dieser Call den Grant ohnehin über die bestehende Autorität.

### Noch zu klären

Der ursprüngliche Trigger hing mit long-running/background exec zusammen. Darum #27 erst nach #36
und #35 abschließen:

1. Wenn process noch läuft: Status muss truthful `waiting on background exec` zeigen und activity
   darf nur durch echte progress evidence verlängert werden; die Prozess-Existenz selbst ist kein
   Liveness-Heartbeat.
2. Wenn process exited-unread ist: #36 muss den drain erzwingen/anzeigen.
3. Wenn weder process noch page/model activity Fortschritt liefert und Turn formal offen bleibt:
   bestehende 2-min one-shot recovery muss greifen.
4. Wenn ein **klassifizierter** sichtbarer Transportfehler den offenen Turn beendet/strandet, darf
   er dieselbe one-shot recovery sofort triggern. Ein beliebiger Alert darf das ausdrücklich nicht.

### Regression matrix

- async/background exec running > 2min mit legitimer owner activity;
- exec exits und wird read;
- exec exits unread;
- tool call fertig, page bleibt ohne weitere evidence offen;
- formal turn_end kurz vor expiry;
- user Stop;
- reload recovery succeeds;
- reload recovery does not restore join => keine reload storm.
- classified transport alert + live turn id => genau eine recovery;
- unerkannter/unspezifischer alert => keine recovery;
- transport error + inactivity expiry gleichzeitig => weiterhin nur ein receipt/reload owner.

### Close-Kriterium

Issue #27 schließen, wenn obige Matrix zeigt, dass jeder Zustand entweder:

- nachweislich weiterarbeitet und sichtbar erklärt wird,
- completed-unread drain verlangt,
- oder einmal deterministisch recovered wird.

Danach #27 schließen. Die aktuelle Transport-Error-Lücke ist ein zulässiger kleiner Code-Fix, aber
sie darf nur einen neuen **Trigger** auf die bestehende Recovery-Authority setzen, keinen zweiten
Watchdog/Reload-Pfad erzeugen.

---

## #23 — Tunnel supervisor false-offline / double-retry

### Befund im aktuellen Code

Einige gemeldete Punkte sind bereits besser als v2.0.2:

- bare `context deadline exceeded` steht nicht mehr als generischer `UNREACHABLE` classifier;
- es gibt `UNREACHABLE_CONFIRM_MS` und poll-success evidence;
- poll health / client health werden strukturiert gelesen.

Aber die spezifische echte Control-Plane-Warnung `poll timed out` wird vom aktuellen
`UNREACHABLE`-Regex ebenfalls nicht sauber erfasst (`poll failed` ist vorhanden, `poll timed out`
nicht). Die Lösung ist **die spezifische Phrase ergänzen**, nicht wieder bare
`context deadline exceeded` als Outage-Signal zuzulassen.

Mindestens ein zentraler Race ist aber im aktuellen Code weiterhin direkt sichtbar:

```text
watch detects unready
  -> await stopTree(child)
     -> child 'exit' handler can call retry()
  -> caller calls retry() again
```

Dasselbe Muster kann beim readiness timeout auftreten. Weitere im aktuellen Source bestätigte
Probleme:

- Startup kann nach einem fresh health refresh trotzdem über eine ältere `RECOVERY_QUIET`-
  Complaint heuristisch offline projizieren;
- fehlende/kaputte Metrics bzw. fehlendes `last_success` werden zu stark geraten statt als unknown
  behandelt;
- `lastHandshake` kann über eine Client-Generation hinweg weiterleben;
- recovered outage reason/timestamp bleibt stale;
- der Offline-Pfad kann neue Health-Snapshots unterdrücken, sodass die UI im alten Health-Bild
  einfriert;
- async watcher callbacks haben nach Awaits nicht überall eine eindeutige current-run/stop fence;
- `diagnostics.ts` kann ein altes `tunnel_metadata_error` nach Route-Recovery weiter als aktuell
  darstellen.

Ein nicht in HEAD liegender Commit `b5b6239` enthält bereits mehrere sinnvolle Ansätze und einen
deterministischen Lifecycle-Test. **Nicht cherry-picken:** der Commit ist groß/unrelated und löst
auch nicht alle obigen Punkte. Nur die guten Invarianten/Testfixtures chirurgisch übernehmen.

### Zielarchitektur: exactly one restart owner

Keine zusätzliche `generation++`-Zahl neben den heutigen Globals bauen. **Der per-process Run-Record
selbst ist die Generation.** Der heutige Code hält `child`, `lastError`, `lastUnreachable`,
`unreachableReason`, outage-run, `lastHandshake`, `pollErrors`, `launchedAt`, `healthBase`, `health`
und `shown` größtenteils supervisor-global. Genau deshalb muss jeder Launch Reset-Regeln erinnern und
alte Async-Callbacks können auf neue State-Zellen schreiben.

Bevorzugte Form, sinngemäß:

```ts
interface ClientRun {
  proc: ChildProcess;
  lastError: string;
  lastUnreachable: number;
  unreachableReason: string;
  outage: UnreachableRun;
  lastHandshake: number | null;
  pollErrors: number;
  launchedAt: number;
  healthBase: string | null;
  health: PollHealth | null;
  shown: ...;
}

let current: ClientRun | null;
```

Invarianten:

1. `launch()` erzeugt/publiziert **einen neuen `ClientRun`**. Reset-by-construction statt zehn
   einzeln zurückgesetzter Globals.
2. Line handlers, probes, timeout-/exit callbacks und `show*` schließen über genau diesen Run und
   mutieren/reporten nur bei `current === run && !stopped`.
3. `retire(run)` CASed `current` synchron auf `null` **vor** `stopTree(run.proc)`.
4. `scheduleRestart(run, reason)` darf nur der Pfad ausführen, der dieses Retire-CAS gewonnen hat;
   spätere `exit`/probe failures von A besitzen dann keinen Retry/backoff mehr.
5. **Process overlap ist separat zu fencen:** ein abgelaufener Restart-delay darf kein neues Child
   launchen, solange `stopTree(oldRun)` noch nicht wirklich abgeschlossen/gebounded retired ist.
   Backoff-Timer und stop barrier werden sequenziert; es darf nie für dieselbe Supervisor-Instanz
   zwei gleichzeitig owned child trees geben.
6. `healthBase()` projiziert nur `current?.healthBase ?? null`; im Replacement-Gap ist der Wert
   automatisch null statt stale A-Metadata.

Supervisor-global bleiben nur echte processübergreifende Facts: `stopped`, Restart-Timer/backoff-
Versuche und immutable opts/workDir. Alte parallele `proc !== child`/`done`/manual-reset guards danach
löschen, soweit der Run-owner sie ersetzt.

### Per-run health reset

Beim neuen run zurücksetzen:

- `lastHandshake` für die neue process generation;
- `lastUnreachable` / reason;
- complaint run;
- health snapshot;
- first-poll grace start;
- shown state.

Historische Daten für Logs dürfen separat angezeigt werden, dürfen aber nicht die neue run health
entscheiden. Der `ClientRun` macht diese Trennung strukturell statt konventionell.

Am besten eine einzige pure Route-Beobachtung (`PollHealth | null` bzw. ähnlich) pro Client-
Generation verwenden. Fresh proof entscheidet „connected“; bestätigte stale/complaint evidence
entscheidet „offline“; fehlende Daten bleiben unknown/connecting. Dieselbe Beobachtung soll
Diagnostics und Runtime speisen, nicht zwei verschiedene Heuristiken.

### Unknown != connected/offline

Wenn `/metrics` nicht lesbar ist oder `last_success` fehlt:

- nicht timestamp 0 erfinden;
- nicht aufgrund bloßer Ruhe "connected" behaupten;
- Runtime darf intern `unknown/connecting` bleiben, bis fresh proof da ist.

Wenn die bestehende `ConnectionState` dafür keinen Wert hat, zuerst prüfen, ob `connecting-tunnel`
die ehrliche Projektion ist. Kein neuer enum nur für kosmetische Genauigkeit.

### Umsetzung

Dateien:

- `src/main/tunnel/index.ts`
- `src/main/tunnel/health.ts`
- `test/tunnel.test.ts`
- eventuell `src/main/diagnostics.ts` nur für stale metadata projection

Regressionen als echte supervisor transitions, nicht nur classifier unit tests:

- one transient poll complaint + newer success => never user-visible offline;
- distinctive `poll timed out` => control-plane complaint; bare unrelated `context deadline exceeded`
  => keine Outage-Klassifikation;
- local MCP timeout containing `context deadline exceeded` => no OpenAI outage;
- supervisor stop => exactly one scheduled retry/backoff increment;
- retry delay < künstlich verzögertes `stopTree(old)` => replacement startet erst nach old-tree
  barrier; nie zwei child trees gleichzeitig alive;
- old child exit after replacement => ignored;
- new child cannot inherit old handshake freshness;
- metrics unavailable => unknown/connecting, never guessed healthy;
- recovery clears obsolete outage reason;
- während confirmed offline weiter neue Health-Snapshots reporten; Status darf aktualisiert werden,
  ohne die Outage zu leugnen;
- stop during awaited probe => no late report/timer;
- stale `tunnel_metadata_error` after recovered route not shown as current failure.
- stale Run A probe/exit/log callback nach Start von B => keine report/retry/healthBase mutation;
- zwei unabhängige Failure-Signale für A => genau ein Retire-CAS/Restart-Claim;
- A retired, B noch nicht ready => `healthBase()` null; B startet ohne A handshake/outage/shown.

### Delete opportunity

Nach generation fencing alle ad-hoc `done`/`proc !== child` checks prüfen und die überflüssigen
entfernen. Ziel ist weniger Restart-Zustand, nicht mehr.

---

## #31 — Persistent and self-verifying Secure MCP Tunnel setup

### Bereits vorhanden

Große Teile des Issues sind schon implementiert:

- tunnel IDs in persisted config;
- API key in secure OS storage;
- optional `autoConnect`, das beim App-Start tatsächlich `connect()` aufruft;
- per-surface `lastRequestAt` und `lastToolCallAt`;
- Core/Desktop separate cards/states;
- health route, poll errors, uptime, last handshake;
- Setup wizard erkennt "ChatGPT reached app but never ran a tool";
- required vs optional surfaces werden unterschieden.

Darum **kein neues Setup-State-System bauen**.

Wichtig: die heutigen per-surface `lastRequestAt`/`lastToolCallAt`-Clocks sind Runtime-Evidence und
werden mit dem MCP-Server-Lebenszyklus zurückgesetzt. Sie sind **kein** persistenter Beweis über einen
App-Restart. Persistiert werden soll nur das, wofür Restart-Durability semantisch nötig ist (z. B.
der zuletzt real an ChatGPT ausgelieferte List-Fingerprint), nicht jede Activity-Uhr.

### Fehlende Teile

1. Der Headline-Toolcount ist weiterhin aggregiert (`N available`) und kann Core/Desktop vermischen.
2. Der Desktop-OpenAI-Tunnel reportet aktuell nicht dieselbe `handshakeAt`/`health` evidence wie
   Core; globale Health-Felder sind faktisch Core-zentriert.
3. Es gibt keinen dauerhaften Tool-schema/permission fingerprint, der sagt, welche exakte
   `tools/list`-Form ChatGPT für diese Surface bereits gesehen/erfolgreich benutzt hat.
4. Setup recovery text kann die bestehende per-surface evidence noch stärker direkt auf den
   fehlenden Hop abbilden.
5. **Security/diagnostic leak:** Renderer `facts()` zeigt aktuell `status.localUrl`. Der lokale MCP-
   URL enthält den per-start Authorization-Token im Pfad. `diagnostics.ts` vermeidet diesen Wert
   bereits absichtlich; die Health UI soll ihn ebenfalls nicht anzeigen.

### Umsetzung

#### A. Toolcount + advertised schema aus **derselben** Registration-Authority

Der aktuelle `connection.ts::toolsFor(surface)` ist eine versteckte zweite Schema-Authority: er
rechnet Toolnamen aus **aktueller Config** neu aus. `mcp/server.ts::stableContext(surface)` hält die
exponierte Surface dagegen absichtlich monoton, damit ChatGPT mit einem gecachten älteren
`tools/list` weiter valide Calls schicken kann. Dadurch können UI-Toolcount und der wirklich
registrierte Endpoint schon heute auseinanderlaufen.

Darum `connection.ts::toolsFor()` **löschen**. Der bestehende `createRegistrar()`/`buildServer()`-
Pfad ist der schmale SSOT, weil dort jedes `server.registerTool(name, config, ...)` ohnehin
zentral vorbeiläuft. Dort zusätzlich den kanonischen advertised snapshot der tatsächlich
registrierten Tools behalten (Name + exact registration/schema config, ohne Handler/Secrets) und
für `SurfaceStatus`/Diagnostics/Fingerprint projizieren.

Aus diesem canonical advertised snapshot rendern:

```text
Core: X · Desktop: Y · Z total
```

Keine hardcoded 7/2-Zahlen.

#### B. Schema fingerprint

Fingerprint aus der **tatsächlich serialisierten Tool-Liste der `tools/list`-Antwort** der jeweiligen
Surface bilden: canonical tool names + descriptions/input schemas + surface identity, genau so wie
der Endpoint sie aus **demselben Registrar/stableContext advertised snapshot** ausliefert. **Nicht**
separat aus aktuellen Permissions rechnen: Permissions können sich ändern, während ChatGPT noch eine
ältere gecachte Discovery-Shape besitzt. Keine Secrets/URLs/Tunnel IDs hashen.

Persistieren/projizieren pro Surface eher als „list seen by ChatGPT“, nicht als erfundene
Human-Review-Evidenz:

```ts
lastObservedListFingerprint?: string
```

Aber: CoS kann nicht automatisch beweisen, dass der Benutzer ChatGPT's review UI akzeptiert hat.
Darum UI-Semantik ehrlich halten:

- `actions unchanged since ChatGPT last fetched this list` wenn ein realer **externer**
  `tools/list`-Request exakt diesen Fingerprint erhalten hat;
- `actions changed — refresh/review in ChatGPT` wenn die aktuell emittierte Discovery-Shape !=
  `lastObservedListFingerprint` ist.

Wenn Produktdesign wirklich das Wort „reviewed“ zeigen will, braucht es dafür eine explizite
Benutzerbestätigung; lokale Netzwerk-Evidenz darf nicht als Beobachtung der ChatGPT-Human-Review-UI
ausgegeben werden. Ein erfolgreicher real tool call beweist Reachability/Use, **nicht**, dass eine
neu hinzugekommene Action bereits entdeckt wurde. Tool Calls dürfen deshalb den List-Fingerprint
nicht fortschreiben. Self-diagnostics, lokale loopback probes und Tunnel-health probes ebenfalls
nicht.

#### C. Per-surface tunnel evidence ohne Doppelstaat

Wenn #31 echte Core-vs-Desktop Tunnelhealth anzeigen soll, `handshakeAt`/`health` auf
`SurfaceStatus` bzw. die existierende Surface-Projektion bringen und die globale Core-Kopie daraus
ableiten/entfernen, statt ein zweites Desktop-health subsystem zu bauen. `connection.ts` soll den
Desktop report dann nicht mehr auf nur `state/detail/publicUrl` reduzieren. Diagnostics iteriert
die verfügbaren Surfaces mit derselben Health-Struktur.

#### D. Local URL redaction

Die `Local server`-Zeile aus `renderer/main.ts::facts()` entfernen oder auf eine tokenfreie,
wirklich nicht-sensitive Darstellung reduzieren. **Nicht** den secret path substring abschneiden
und hoffen, das Format bleibe ewig gleich; am sichersten ist die UI braucht diese URL schlicht
nicht. Das ist unabhängig von Tunnel-ID/Key-Redaction.

#### E. Auto-connect

Bestehendes `ui.autoConnect` beibehalten, aber #31s Daily-Path wirklich erfüllen: `defaultConfig`
darf für ein noch unvollständiges Setup weiter fail-safe `false` sein, damit eine frische App nicht
in Connect-Fehlerloops startet. **Nach dem ersten erfolgreich abgeschlossenen stable OpenAI setup**
setzt der Wizard/Setup-Commit `autoConnect=true`, sofern der User es nicht explizit deaktiviert hat.
Bestehende/migrierte explizite `false`-Entscheidungen respektieren; kein stilles Opt-in bei Migration.
So ist „einmal sauber einrichten, danach App öffnen und Tunnel kommen wieder“ der Default-Pfad,
ohne den User seines Off-Schalters zu berauben.

### Tests

- app restart + saved ids/key + autoConnect => same tunnels reused;
- **fresh** stable setup ohne manuelles Suchen eines Advanced-Checkboxes => successful setup commit
  etabliert auto-connect; nächster App-Restart reused dieselben stable ids/key automatisch;
- explizites Auto-connect off => nächster Restart verbindet nicht;
- per-surface request/tool evidence bleibt logisch getrennt;
- Desktop/OpenAI health/handshake evidence wird nicht aus Core geraten;
- changing unrelated theme does not invalidate fingerprint;
- permission/tool schema change, die die emittierte `tools/list`-Shape ändert, invalidiert;
- capability wird in aktueller Config deaktiviert, während Endpoint/stable exposure weiterlebt =>
  SurfaceStatus count/list bleibt die wirklich weiterhin registrierte monotonic Shape; Handler darf
  die Live-Capability trotzdem `TOOL_DISABLED` verweigern;
- `forgetExposedSurface`/fresh endpoint => advertised snapshot und UI count/list schrumpfen zusammen;
- real external `tools/list` stores the exact serialized-list fingerprint;
- unchanged tool call without a new `tools/list` does **not** mark a changed list as seen;
- self-test/loopback `tools/list` does not mark ChatGPT evidence;
- renderer/diagnostics zeigen weder secret local MCP path noch key/tunnel credential data.

---

## #30 — autosaved New Chat draft blocks worker bootstrap

### Reproduzierbarer Codegrund

`extension/chatgpt-dom.js::insertPrompt()` verweigert absichtlich jede nicht-leere composer. Das ist
für normale Eingaben korrekt. `content.js::runCommand()/deliverCommand()` verwendet dieselbe Regel
für app-owned fresh bootstrap und meldet bei vorhandener Draft:

`the composer already holds something the user was writing`.

Default-safe Verhalten ist richtig; unattended users brauchen aber eine explizite persistente
Opt-in-Policy.

Der heutige Preserve-Fall ist **nicht mehr still**: die Content-Seite terminalisiert den Command
mit einem klaren failed ACK; der Bridge/Broker-Pfad markiert den Worker failed, gibt den Slot frei
und queued einen Prime-visible Report. Das ursprüngliche „Worker wirkt wie nichts passiert“ ist
damit bereits entschärft. Offen ist genau der gewünschte persistente unattended Opt-in.

### Architekturentscheidung

**Nicht `insertPrompt()` global permissiver machen.** Stattdessen Composer mutation explizit
policy-gesteuert machen.

Beispiel:

```ts
writeComposer(value, mode: 'require-empty' | 'replace-existing')
```

oder zwei klar benannte Funktionen. `replace-existing` darf nur erreicht werden, wenn alle
folgenden Fences bereits bewiesen sind:

1. authenticated bridge command erfolgreich redeemed;
2. command type ist fresh `worker` oder fresh `resume`, nicht revival;
3. command hat keinen target conversation id;
4. page besitzt weiterhin exact command marker/client lease;
5. `CLF_DOM.conversationId()` ist weiterhin null;
6. persistent user setting `replaceFreshChatDraftsForBootstraps === true`.

### Setting

App-owned persistente config, nicht nur page-local storage. Dadurch gilt die bewusste Policy über
Browser-/App-Restarts und alle Worker hinweg.

Default: **preserve**.

UI copy muss destruktiv klar sein, z. B.:

`Replace saved New Chat drafts when Chat On Steroids opens workers/resumes`.

Die Policy beim Redeem als Teil des **authenticated `BridgeCommand` snapshots** mitgeben. Der
Content-Script soll nicht selbst Config aus mehreren Speichern zusammensuchen und dadurch eine
zweite Policy-Authority werden.

### Verhalten preserve

- command sauber `failed` ack-en;
- exakte Ursache bis Prime/User surfacen;
- keine stillen retries, die denselben draft immer wieder treffen;
- user text niemals mergen oder absenden.

### Verhalten replace

- `insertPrompt()` konservativ lassen; stattdessen eine explizite destructive DOM primitive
  (`replacePromptExact`/shared composer writer) hinzufügen, die nur dieser fenced call site nutzt;
- bestehende draft mit editor-native clear löschen;
- verify empty;
- bootstrap einsetzen;
- nach Microtask erneut exact content + route + marker prüfen;
- senden.

### Nicht tun

- Draft in irgendeiner eigenen CoS-Datei "sichern" und später heuristisch wiederherstellen. ChatGPT
  besitzt Autosave/Route/Composer lifecycle; ein zweiter Draft-Store erzeugt mehr Datenverlust-Races.
- Existing conversation drafts überschreiben.
- Revival drafts überschreiben.

### Regressionen

- preserve default + saved New Chat draft => explicit failed command, draft unchanged;
- preserve failure => worker wird failed/freed und Prime erhält klare Ursache, kein zombie slot;
- replace opt-in + exact fresh worker => draft removed, exact bootstrap sent;
- replace opt-in + exact fresh resume => same;
- existing conversation/revival => draft always preserved regardless of setting;
- SPA retarget after redeem => no clear/no send;
- user types between clear/insert/send => exact-content fence aborts.

---

## #29 — macOS Desktop vertical slice / driver boundary

### Befund

PR #28 enthält bereits einen ernsthaften macOS-Slice mit ScreenCaptureKit, AXUIElement, CGEvent,
N-API/Swift packaging und umfangreicher lokaler/live Evidenz. Die Produktionsgrenze ist nach der
TCC-Härtung `Electron main -> Node Worker -> N-API addon -> Swift dylib`; der standalone Swift-CLI
ist nur Development-Probe. PR #28 ist aktuell GitHub-seitig CLEAN. Normale Drei-Host-CI ist aber
nicht dasselbe wie exact-head packaged TCC-/both-arch acceptance.

Das Issue fordert aber ausdrücklich, diesen Slice zu nutzen, um die tragfähige Desktop-driver
boundary zu finden. Ein großer Mac-Zweig sollte nicht einfach zusätzlich neben einem Windows-
Sonderpfad landen, wenn dadurch `computer/index.ts` zu einer immer größeren OS-Verzweigung wird.

### Zielgrenze

Der zweite adversarial Pass gegen den **realen PR-#28-Code** zeigt, dass die kleinste sinnvolle
Grenze tiefer liegt als ein Interface mit einer Methode pro Desktop-Fähigkeit. PR #28 hat Windows-
PowerShell und Mac Worker/N-API bereits auf denselben `NativeRequest`/`NativeReply`-artigen op-
Transport gebracht; die Hauptverzweigung sitzt in `sendHelperRequest`. Diese bewiesene Überlappung
nutzen statt dieselbe Op-Matrix in einem neuen `DesktopDriver` noch einmal zu modellieren.

Shared `ComputerService` besitzt weiterhin:

- capabilities / tool semantics;
- frame IDs / freshness;
- ref lifetime;
- partial batch semantics;
- output/image bounds;
- route evidence;
- target/foreground ownership policy;
- MCP errors.
- request queue + shared op construction;
- native reply validation;
- partial-batch accounting und gemeinsame ref/frame transformation.

Native Backend/Transport besitzt nur:

- `request(NativeRequest): Promise<NativeReply>`;
- `stop()` / native lifecycle;
- availability/permission facts, soweit sie wirklich backend-spezifisch sind;
- optional `timeoutFor(request)`/native deadline budget, wenn Windows/Mac real unterschiedliche
  startup/action budgets brauchen.

Die eigentlichen `snapshot`/`capture`/`act`/... Ops bleiben **ein gemeinsames Protocol**, kein zweites
Methodenset pro OS.

Nicht OS-spezifisch duplizieren: stale-ref policy, frame validation rules, batch semantics,
permission capability model.

### Vorgehen

1. PR #28 als Referenzbranch behalten und exact-head Datei-/Security-Diff reviewen; breite Doku-
   Änderungen bei Bedarf vom native Slice trennen, aber den validierten Backend nicht neu bauen.
2. **Zuerst den realen Slice paketiert auf macOS akzeptieren und mergen**, wenn exact-head CI +
   packaged live acceptance grün sind. Das Issue selbst fordert ausdrücklich die Vertical-Slice-
   Reihenfolge; ein breiter Vorab-Refactor wäre spekulative Abstraktion.
3. Diff analysieren und jede neue Mac-Verzweigung als shared-policy vs native-mechanism markieren.
4. `tools-desktop.ts` **Schemas/Permissions/Recording-Vertrag** unverändert lassen, aber PR #28s
   platformneutrale shared hardening bewusst reviewen/forward-porten: combined 8MiB MCP image-result
   budget (`desktopImageResult`), truthful `uiUnavailable` rendering und browserneutrale Copy sind
   shared semantics, kein Mac-Driver-Code.
5. Shared `computer/index.ts` behält frame IDs, stale-ref policy, coordinates, batching,
   output/image bounds und Ziel-/Foreground-Revalidation.
6. Nur native **Transport/Lifecycle** herausziehen:
   - Windows Backend: child/process-tree lifecycle + PowerShell bootstrap + transport;
   - Mac Backend: Worker/N-API/dylib/TCC native lifecycle + transport;
   - shared `NativeRequest` construction und `NativeReply` interpretation bleiben in einer
     `ComputerService`-Pipeline.
7. **Zero-/low-behavior extraction** hinter ein kleines Interface. Keine speculative 30-method
   abstraction.
8. Platform availability aus Backend-Support ableiten statt neue `darwin`-Branches in mehreren
   Schichten zu verteilen.
9. `helperTimeoutMs(request, platform)` nicht als neue `process.platform==='darwin'`-Policy im
   Shared Service konservieren; wenn der Unterschied echt native-performance/lifecycle ist, liefert
   das Backend den Deadline-Budget-Hinweis.
10. Nur Transport-/Lifecycle-Code konsolidieren, den beide realen Backends als identisch beweisen.
11. Bestehende Windows Suites unverändert gegen `WindowsBackend` laufen lassen und Mac regressions
    gegen denselben Shared Service.
12. **Nach dem Slice-Merge** aus dem echten Windows+Mac-Overlap die kleinste Transport-Grenze
    extrahieren. Dieser Cleanup kann derselbe Issue-Follow-up sein, soll aber nicht den bereits
    funktionierenden Mac-Slice in einen Vorab-Großrefactor verwandeln.
13. #29 erst schließen, wenn sowohl der Mac-Slice ausgeliefert/akzeptiert als auch die verbleibende
    OS-Verzweigung entweder sauber am Driver-Seam sitzt oder bewusst als kleinere, belegte Form
    dokumentiert ist.

### Interface-Leitlinie

Bevorzugt **Transport statt Capability-Spiegel**, sinngemäß:

```ts
interface NativeDesktopBackend {
  request(request: NativeRequest): Promise<NativeReply>;
  stop(): Promise<void>;
  availability(): NativeAvailability;
  timeoutFor?(request: NativeRequest): number;
}
```

Wenn später ein echter Mechanismus diese Form sprengt, Interface dann anhand realer Divergenz
erweitern. Nicht jetzt sechs Methoden aus den heutigen MCP-Actions zurückprojizieren.

### Acceptance

- Windows behavior/regressions unverändert;
- Mac arm64 + x64 packaging/runtime;
- semantic refs stale safely;
- focus/window ownership revalidation before mutation;
- permission failure typed, not guessed;
- identischer synthetischer `NativeReply` erzeugt über Win/Mac Test-Backends identische
  frame/ref/batch/output semantics im Shared Service;
- live ChatGPT Core + Desktop attribution E2E.

---

## #22 — Firefox support

### Befund

Nicht "nur ein paar `chrome` APIs umbenennen". Der heutige Code ist eng an Chrome MV3 gebunden:

- Manifest nutzt `background.service_worker`;
- Firefox unterstützt für MV3 weiterhin background scripts/event page statt extension service
  worker;
- Code verwendet `chrome.storage.session`, `chrome.tabs`, `chrome.scripting`, alarms usw.;
- `fiber.js` braucht MAIN-world injection;
- bridge CORS akzeptiert derzeit nur `chrome-extension://...`, Firefox sendet `moz-extension://...`.

MAIN execution world und `storage.session` sind in modernen Firefox WebExtensions verfügbar; die
entscheidende Portability-Arbeit ist deshalb Manifest/background lifecycle + bridge origin policy,
nicht ein Rewrite des Content-Scripts.

Zusätzlich ist der **Desktop-App Browser-Custody-Pfad** heute Chrome/Chromium-orientiert
(`src/main/browser.ts`). Volle Firefox-Unterstützung heißt daher nicht nur „Extension läuft in
Firefox“, sondern CoS muss den vom Benutzer gewählten Companion-Browser auch für exact-chat
open/reload/revival korrekt ansprechen. Und ein dauerhaft installierbares Firefox-Release braucht
einen signierten XPI-Pfad; temporary `about:debugging` ist nur Dev-Smoke und verschwindet nach
Browser-Neustart.

### Verdeckter Root Cause: Pairing/Custody ist heute global-singleton, aber nicht installation-scoped

Firefox macht einen Fehler sichtbar, der auch mit zwei Chrome-Profilen reproduzierbar wäre:

- `/pair` mintet heute bei jedem Provisioning-Request einen neuen **globalen** `bridgeToken`;
- jede Extension-Instanz single-flightet Pairing nur in ihrem eigenen Background-Lifetime;
- zwei Profile/Browser mit stale Token können daher abwechselnd 401 → `/pair` fahren und sich den
  globalen Token gegenseitig wegrotieren;
- selbst ein gemeinsamer Token wäre nicht genug: jede Instanz pollt global `/status`, und
  `takePendingRepair()` würde den Repair dem Browser geben, der zufällig zuerst pollt;
- `conversationStillOpen()` sieht ebenfalls nur die Tabs der eigenen Installation, daher kann
  `/closed` aus Profil A „letzter Tab weg“ behaupten, obwohl Profil B dieselbe Conversation hält.

**Quality >> Quantity Entscheidung für #22:** nicht jetzt ein Multi-Browser-Presence-Cluster bauen.
Für diesen Port darf genau **eine Companion-Installation/Profile gleichzeitig Browser-Automation
besitzen**. Simultane aktive Companion-Profile wären ein eigenes größeres Architekturprojekt.

### Architekturentscheidung

Kein globales `chrome -> browser` Rewrite nötig. Moderne Browser unterstützen weitgehend dieselben
Promise APIs. Baue nur eine dünne Boundary für echte Differenzen.

### Umsetzung

1. **Cross-browser manifest build**:
   - canonical extension source beibehalten;
   - Chrome manifest mit `service_worker`;
   - Firefox manifest mit `background.scripts`/event page semantics;
   - keine zwei manuell driftenden kompletten manifests, sondern kleines build transform oder
     shared base + browser delta.
   - Firefox bekommt eine feste Gecko extension id und `strict_min_version` passend zur benötigten
     MAIN-world-Unterstützung (mindestens Firefox 128, sofern die Live-Revalidation das bestätigt).
2. **Background lifecycle audit**:
   - sicherstellen, dass code keine ServiceWorker-only Globals voraussetzt;
   - `storage.session` bleibt durable-for-browser-session authority;
   - startup/install/alarm behavior in Firefox tests abbilden.
3. **Bridge origin**:
   - `originOf()` darf nicht einfach blind jedes `moz-extension://` erlauben, ohne dieselbe
     bearer-token boundary zu behalten;
   - akzeptiere nur extension schemes (`chrome-extension`, `moz-extension`) und weiterhin niemals
     http(s)/`null`;
   - CORS echo exakt auf valid extension origin.
4. **MAIN-world Fiber**:
   - static `content_scripts.world = MAIN` und repair injection mit `scripting.executeScript({world:
     'MAIN'})` in Firefox smoke testen.
5. **Tabs/scripting/storage behavior**:
   - kleinste browser adapter helper nur dort, wo API return/error semantics differieren.
   - #40 `autoDiscardable`/`frozen`-Support als Chrome-spezifische capability feature-detecten; ein
     Firefox-Port darf an fehlender/eingeschränkter Tab-Discard-API nicht scheitern oder so tun, als
     gäbe es denselben Freeze-Mechanismus.
6. **Installation-scoped Pairing/Custody**:
   - jede Extension-Installation/Profile mintet einmal eine zufällige `installationId` in
     `storage.local` und sendet `{installationId, browserFamily}` bei Pair/Auth mit;
   - App persistiert die **ausgewählte Companion-Installation** zusammen mit der Bridge-Credential-
     Authority; gleiche Installation darf Pairing idempotent reparieren, eine andere bekommt
     `companion_already_paired` / switch-required statt den Token still zu rotieren;
   - der alte Browser darf nach einem expliziten Switch nicht durch seinen nächsten 401 automatisch
     zurück-pairen und die Auswahl stehlen;
   - `/status` repair custody, `/closed`, command/revival und recovery akzeptieren nur die aktuell
     ausgewählte Installation. Damit bleibt die heutige Single-Browser-Semantik erhalten, aber sie
     ist jetzt explizit und race-safe;
   - **kein** app-seitiges globales Set aller Browser-Tabs/Profiles für #22 bauen.
7. **App-side browser custody (`src/main/browser.ts`)**:
   - hardcoded Chrome/Chromium assumptions auf einen kleinen user-authoritative
     `companionBrowser` target reduzieren, das **Family + selected installation/profile** meint,
     nicht nur ein Executable;
   - exact-chat URLs/markers bleiben browserneutral;
   - Open/reload/revival verwendet genau den gewählten Browser, nicht opportunistisch einen
     zweiten Browser;
   - wenn mehrere Firefox-Profile existieren, darf Release-Acceptance erst grün sein, wenn
     `browser.ts` nachweislich in derselben gepaarten Profile-Installation öffnet; sonst Scope
     ehrlich auf den unterstützten ausgewählten/default Profile-Pfad begrenzen statt „Firefox“
     global zu behaupten;
   - Setup-/error copy browserneutral machen.
8. **Distribution**:
   - Dev: temporary install smoke zulassen;
   - Release/Beta: signierten XPI-Artefaktpfad in Release/Packaging integrieren;
   - Chrome-Paket unverändert weiterbauen; kein gemeinsamer Artefakt-Blob mit unklarer Manifest-
     Semantik.

### Security regressions

- `https://chatgpt.com`, arbitrary web origin, `Origin:null` => forbidden;
- valid Chrome extension + token => allowed;
- valid Firefox extension + token => allowed;
- extension origin ohne token => nicht autorisiert;
- zweite Chrome/Firefox installation mit anderer `installationId` => kann den aktiven Pairing-Owner
  nicht durch Auto-Provisioning verdrängen;
- expliziter Companion-Switch invalidiert alte Custody; alter Browser kann sie nicht 401→pair
  zurückstehlen;
- keine neue public loopback permission.

### Live matrix

- Firefox normal chat recording;
- tool attribution;
- worker spawn/revive;
- Compact & Resume;
- extension/background restart;
- Firefox event-page suspension/restoration mit `storage.session` journal;
- browser restart session restoration;
- MAIN Fiber repair;
- exact-chat open/reload über app-side Firefox custody;
- Chrome + Firefox gleichzeitig installiert/laufend: Firefox ausgewählt => Chrome kann weder Token
  stehlen noch `/status` repair konsumieren noch `/closed` authority ausüben; expliziter Switch zu
  Chrome beweist die inverse Richtung;
- zwei Profile derselben Browser-Familie: nur die ausgewählte `installationId` besitzt Custody;
- installierter/signierter XPI update/restart smoke.

---

## #2 — Power Agent tools

### Befund

PR #17 implementiert einen großen `power` composite tool mit `open_url`, `web_fetch`, app/process
management, `system_exec` und system-wide filesystem access. `tools-power.ts` ist im aktuellen Baum
nicht vorhanden; PR ist offen.

### Quality >> Quantity Entscheidung

**Issue als architecture-superseded schließen; PR #17 nicht mergen.** Das Proposal vermischt
mehrere sehr verschiedene Fähigkeiten und
dupliziert bestehende Autorität:

- `system_exec` dupliziert `exec_command`;
- `fs_system_*` dupliziert über command authority praktisch vorhandenen Host-Zugriff, umgeht aber
  bewusst den approved-root mental/security model;
- `process_list/kill` und `launch_app` sind mit command authority bereits erreichbar;
- `open_url` ist eher Desktop/UI navigation als Core filesystem/terminal primitive;
- `web_fetch` baut einen zweiten Network/HTML-fetch stack in einen lokalen MCP-Connector, obwohl
  ChatGPT selbst Web-Fähigkeiten hat und dieser Connector bisher bewusst kleine lokale surfaces hat.

Mehr Tool-Schemas oder ein 600+-Zeilen "Power" helper sind kein Gewinn, wenn die Fähigkeiten schon
durch die vorhandene sicherheitsverständliche Primitive abgedeckt sind.

Das ist inzwischen auch im aktuellen Test-/Architekturvertrag ausdrücklich sichtbar:
`tools-core.ts` behandelt prozedurale Host-Aktionen als Komposition über Primitive; die MCP-
Regressions halten den kleinen Surface-Budget bei **7 Core / 2 Desktop** und haben frühere
`launch_app`/`open_url`/process-Sondertools bewusst retired.

### Empfohlene Issue-Auflösung

#2 mit kurzer Architekturbegründung schließen und PR #17 schließen. Falls `web_fetch` unabhängig
wirklich einen einzigartigen Produktnutzen hat, **neues einzelnes Issue** eröffnen und dort zuerst
beweisen, warum ChatGPT-Web/Skill/`exec_command`-Komposition nicht reicht. Die anderen Wünsche
brauchen keinen neuen MCP-Surface:

| Wunsch | Entscheidung |
|---|---|
| system_exec | **Reject:** `exec_command` ist die Autorität. |
| fs_system_* | **Reject:** approved roots nicht durch parallele API unterlaufen. Wenn user wirklich host-wide command grants, kann command das bereits. |
| launch_app | **No new tool:** über `exec_command` dokumentieren/recipe; Desktop tool nur falls später semantic app launch ohne shell ein Produktziel wird. |
| process list/kill | **No new tool:** command recipe; kein permanenter schema cost. |
| open_url | Nur separat erwägen, wenn browser focus/navigation als häufige sichere UX primitive nachweislich gebraucht wird. Dann eher Desktop `computer` action als neues Core tool. |
| web_fetch | Nicht in #2 mergen. Nur als neues, separat begründetes Issue evaluieren. |

### PR #17

Schließen, nicht weiter aufblähen. Kein "weil schon implementiert" als Merge-Kriterium.

---

## 6. PR-Entscheidungstabelle

| PR | Empfehlung |
|---|---|
| #17 Power tools | **Schließen, nicht mergen.** Bestehende Primitive + 7-Core/2-Desktop-Surface-Budget sind die bewusst kleinere Architektur. |
| #28 macOS Desktop | **Exact-head packaged Mac acceptance, dann Vertical Slice mergen.** Driver-Seam anschließend aus zwei realen Backends extrahieren; kein spekulativer Vorab-Großrefactor. |
| #37 public-history / packaging | **Bereits gemerged; #24 CLOSED.** Nur Release-History-/workflow gate separat härten. |
| #38 Project routes | **Bereits gemerged; #25 CLOSED.** Lokale verhaltensäquivalente Commits nicht doppelt anwenden. |
| #39 long handoff auto-compaction | **Nicht as-is mergen.** Failure evidence/Regressionen übernehmen; Ziel ist WAL sole authority + checkpoint-aware replay/abandon und Delete der Broker-Transfer-Lease, nicht ein `/activity` heartbeat. PR entsprechend reworken oder superseden. |

---

## 7. Vollständige Acceptance Matrix vor Issue-Close

### Browser / conversation

- root chat `/c/<id>`;
- Project chat `/g/<project>/c/<id>`;
- share route never owned;
- fresh worker;
- worker revive existing chat;
- fresh resume;
- hidden worker finishes without foreground wake;
- autosaved draft preserve default;
- autosaved draft replace opt-in;
- SPA retarget during bootstrap;
- manual Stop;
- site transport error;
- stale open turn one-shot recovery.

### Compact & Resume

- threshold crossing during active turn;
- threshold already exceeded before current turn;
- pre-dispatch `not-attempted` / `attempted-unresolved` abandonment ist bounded und replay-safe;
- crash genau nach `dispatched-unresolved` => kein blindes Replay/Wall-clock-abort;
- `sent(sourceMessageId)` handoff > 10min/>20min => exact marker bleibt authority, kein self-compact;
- app process restart during live source handoff;
- content document reload during live source handoff;
- tab close/reopen mit serverseitigem HANDOFF marker;
- full browser restart + marker/WAL reconciliation;
- destination dispatch/reload folgt denselben no-replay fences;
- no recursive self-compaction;
- exact destination commit;
- background exec owner A→B moves atomically/idempotently with committed continuation projection.

### Unified exec

- one background process running;
- multiple parallel running;
- exited unread below threshold;
- exited unread at threshold;
- drain releases gate;
- global capacity pressure never evicts retained unread output;
- full global cap => new reservation refused, every existing session id still drainable;
- wrong conversation isolation;
- A→B Compact & Resume => old A denied, new B can drain inherited live/unread exec sessions;
- transient write_stdin failure/retry;
- open turn + completed unread progress status.

### Tunnel

- startup first poll slow;
- one transient timeout;
- local MCP probe timeout;
- true network outage > confirm window;
- successful recovery;
- unready local child restart;
- child exit during supervisor stop;
- old generation probe/exit completes after replacement => no report/retry/state mutation;
- stop while probe pending;
- app disconnect/reconnect;
- app restart with saved stable tunnel id/key;
- Core and Desktop evidence separate.
- actual external per-surface `tools/list` fingerprint recorded; self-test/probe not counted;
- changed emitted list + unchanged cached tool call => changed list still shown as unseen.

### Platform

- Windows current Desktop suite;
- macOS arm64/x64 driver slice;
- Firefox extension install/background lifecycle;
- Firefox signed-XPI release/update path;
- app-side exact-chat custody in selected Firefox companion browser;
- bestehendes Chrome recorder/command/ownership behavior unverändert; #40 darf nur die **abgeleitete
  discardability policy + lifecycle observation** ergänzen, nicht Tab-Identity neu definieren;
- Chrome Memory Saver discard + Chrome 132+ frozen lifecycle getrennt akzeptieren.

---

## 8. Required validation per implementation batch

Validation läuft in Stufen. Ein späterer grüner Layer ersetzt keinen früheren Beweis.

### S0 — Provenance / Repro-Tuple

Vor jedem Ergebnis festhalten:

```text
HEAD + origin/main
dirty paths
Issue/PR state
evidence location = worktree | commit | PR | main | released artifact
```

Keine Testzahl ohne dieses Tuple als „Fix bewiesen“ zitieren. Für historische Regressionen den
pre-fix behavior in isolierter Fixture/Checkout nachweisen; **nicht** den gemeinsam dirty Worktree
zurückdrehen.

### S1 — Pure invariants, ohne sleeps

- #21 checkpoint/replay/abandon + projection ownership;
- #34 cadence + exact terminal-delivery obligation;
- #36 manager-capacity retention + caller-scoped obligation/admission;
- #40 pure browser-protected-conversation projection + reversible effect-journal reducer;
- #23 classifier/generation/health reduction;
- #30 config/policy fences;
- #31 serialized-list fingerprint + redaction;
- #22 manifest/origin/browser-delta.

### S2 — Subsystem integration

- bridge ↔ continuation WAL/rebind/projection;
- continuation commit ↔ exec-owner migration;
- MCP kernel ↔ UnifiedExec ownership/admission;
- app `/status` browser-protection projection ↔ extension `tabConversations` ↔ reversible
  `autoDiscardable` mutation journal;
- fake-child tunnel supervisor lifecycle;
- config → IPC/preload/renderer → authenticated BridgeCommand draft policy;
- runtime obligations → `/activity` → `.clf-stage`.

Assert explizit, dass dabei **kein zweiter persistenter Writer** für denselben Fakt entstanden ist.

### S3 — Crash-/Reload-Matrix nach echter Lebenszeit

Nicht pauschal „browser/app restart“ schreiben. Getrennt testen:

1. App process restart;
2. extension service-worker / Firefox event-page restart;
3. content document reload;
4. tab close/reopen;
5. full browser restart;
6. SPA A→B→A;
7. stale async completion nach owner/generation replacement.

Für #21 jede Source-/Destination-Send-Grenze separat schneiden: vor dispatch replaybar, nach dispatch
nie blind replaybar; committed-but-projection-not-published muss nach Restart reparierbar bleiben.
Nicht nur eine „restart“-Testzeile: die Checkpoints `attempted-unresolved`, `dispatched-unresolved`
und `sent(messageId)` als Cross-Product gegen mindestens **content reload, extension service-worker /
Firefox event-page restart, tab close/reopen, full browser restart (storage.session stirbt), App-
Restart (WAL restores) und SPA retarget** testen. Wo eine Dimension physikalisch nicht sinnvoll ist,
explizit begründen statt sie still wegzulassen.

Für #40 die reversible Browser-Side-Effect-WAL an **drei** Commit-Grenzen schneiden:

1. journal persisted → crash vor `tabs.update(false)`;
2. `tabs.update(false)` erfolgreich → worker stirbt vor nächster reconciliation/bookkeeping;
3. restore `tabs.update(prior)` erfolgreich → worker stirbt vor journal delete.

Zusätzlich Full-Browser-Restart: `storage.session` verschwindet erwartbar; aktive exact chats werden
aus App-/Broker-Truth neu geschützt, unrelated/user-preprotected tabs werden nicht blind mutiert.

### S4 — Browser harness / deterministic DOM

- Project route identity;
- fresh/revival/resume bootstrap;
- draft preserve/replace fences;
- source/destination marker reconciliation;
- klassifizierter vs. unerkannter transport failure;
- hidden final convergence + next-poll arming.
- `tabs.onUpdated({discarded:true})` / `{frozen:true}` bleibt non-terminal und mintet keinen eigenen
  reload owner; feature detection ohne `frozen` bleibt kompatibel.

Der Harness beweist **nicht** reale Chromium hidden-tab timer throttling.

### S5 — Prime-only live browser

- Chrome hidden worker finalisiert ohne Focus;
- #35 Runtime-View live: active workers, running Background Exec, completed-unread threshold und
  queued browser recovery nacheinander erzeugen; `.clf-stage` zeigt nur wirklich bewiesene Facts,
  echte Progress-Evidence ersetzt/cleart die Zeile sofort. Ohne expliziten Wait-on-worker-Beweis
  muss die UI `N workers still running` o. ä. sagen, **nicht** `Prime blocked on Worker N`;
- saved draft preserve + opt-in replace;
- Compact handoff mit reload an den Send-Grenzen;
- site transport error / one-shot stale-turn recovery;
- #40 via `chrome://discards`: exact active tab non-auto-discardable, unrelated tab unverändert;
- manual Urgent Discard/frozen observation: kein Ownership-Verlust, kein Focus-Steal/Reload-Storm;
- Project chat smoke bleibt als Regression für das bereits geschlossene #25.

Firefox dieselben relevanten Flows erst nach vorhandenem Browser-Port live ausführen.

### S6 — Build / Native / Package

Während eines Implementierungsbatches die enge Feedback-Schleife klein halten:

```powershell
npx vitest run <focused suites + adjacent protocol/ownership suites>
git diff --check
```

`npm run typecheck` ist optionales schnelles Feedback bei breiten TS-Änderungen, aber kein Grund,
vor jedem kleinen Testlauf dieselbe ganze Pipeline zu bezahlen. **Vor production-code done / Merge
einmal `npm run verify`**; das enthält bereits `rg`, privacy verify, `tsc --noEmit` und die volle
Vitest-Pipeline inklusive shutdown suite. Kein zusätzliches `npm test` davor.

`npm run build` **nur dann**, wenn Bundling/native resources/Extension shipping/Installer-Verhalten
vom Quelltest abweichen kann. Bei package-sensitive Änderungen danach zusätzlich den **exakten
Release-Candidate-Pfad** ausführen, nicht nur string-/fixture-basierte `packaging.test.ts` assertions.
macOS Desktop braucht eine real paketierte SCK/AX/CGEvent/TCC-Aktion; App-Startup allein ist kein
Desktop-Beweis.

### S6.1 — Public-history gate muss fail-closed und vollständig sein

Beim Audit wurden **drei unabhängige False-Green-Klassen** im Release-Privacy-Gate reproduziert:

1. **Shallow commit ancestry:** alle Workflows, die aktuell `verify-public-history`/`verify:ci`
   ausführen, benutzen `actions/checkout` ohne `fetch-depth: 0`. Aktuelle #37/#38 CI-Runs zeigen
   `fetch-depth: 1`, `fetch-tags: false` und melden pro Host tatsächlich nur
   `Public-history privacy check passed (1 commits, 0 tags)`. Release-/Publish-Runs zeigen dasselbe
   Pattern in Package-/Preflight-/Final-Publish-Gates. Der vollständige lokale Clone findet dagegen
   die echten unsafe Ancestors `9e27c0f` / `03acfba`.
2. **Vollständige Commit-History, aber fehlende Tags:** ein nicht-shallow `git clone --no-tags` kann
   einen unsafe annotated tag, der auf HEAD-Ancestry zeigt, komplett verstecken. Der heutige Script
   sieht `0 tags` und besteht. `is-shallow-repository=false` beweist also nur Commit-Ancestry, nicht
   Ref-/Tag-Vollständigkeit.
3. **Gelöschte historische Blob-Inhalte:** `checkHistory()` prüft Metadata für alle `rev-list HEAD`
   Commits, scannt File-Inhalt aber nur einmal am **aktuellen `HEAD` tree**. Repro: Commit A enthält
   einen geblockten privaten Pfad in `leak.txt`, Commit B löscht die Datei; full-history Verify ist
   heute trotzdem grün, obwohl der Blob aus öffentlicher HEAD-Ancestry weiterhin recoverable ist.

Vor jedem Release deshalb **Script + Checkout + Object-Scope** zusammen fixen:

1. `verify-public-history.mjs` prüft `git rev-parse --is-shallow-repository` und **failt closed**, wenn
   die komplette commit ancestry nicht verfügbar ist.
2. Tag-Completeness separat beweisen. Alle CI/release/publish-Checkouts setzen mindestens
   `fetch-depth: 0` **und `fetch-tags: true`** / expliziten full tag fetch. Der Verifier darf einen
   Clone mit `remote.origin.tagOpt=--no-tags` nicht als vollständigen public-history proof akzeptieren;
   für Release-Mode remote tag refs (`git ls-remote --tags origin`) gegen lokal vorhandene refs
   abgleichen und bei fehlenden refs/network uncertainty fail-closed statt `0 tags` als Erfolg zu
   interpretieren.
3. **Alle einzigartigen Blobs/Paths, die aus `HEAD`-Ancestry erreichbar sind, genau einmal scannen,**
   nicht `git grep HEAD` pro Tip-Tree. Bevorzugt `git rev-list --objects HEAD` als Reachability-
   Authority + `git cat-file --batch`/äquivalente bounded object reads:
   - object path/name auf blocked text prüfen;
   - jeden unique blob content bounded/binary-safe auf blocked markers prüfen;
   - nie den Secret-Wert selbst in Error-Output echoen, nur Label + object/path context;
   - kein O(commits × files)-Loop, wenn unique object traversal dasselbe sauberer beweist.
4. `--staged`/commit-message checks bleiben der schnelle **pre-commit current-tree** Gate; sie ersetzen
   den vollständigen reachable-history scan nicht.

Das **schwächt #24 nicht ab**; im Gegenteil, es stellt sicher, dass der bereits korrigierte Scope
wirklich über die komplette checked-out `HEAD`-Linie urteilt. Unrelated branches bleiben draußen;
annotated tags werden wie heute nur privacy-relevant, wenn sie in die HEAD-Linie merged/reachable
sind — aber der Verifier muss die vorhandenen Tag-Refs überhaupt vollständig kennen, bevor er diese
Frage beantworten kann.

Pflichtregressionen:

- depth-1 clone versteckt unsafe ancestor => verifier fails completeness;
- non-shallow `--no-tags` clone versteckt unsafe merged annotated tag => verifier fails completeness;
- full ancestry: unsafe blob in ancestor, am Tip gelöscht => verifier fails privacy;
- unrelated fetched branch mit unsafe content/identity, **nicht** in HEAD ancestry => kein #24-
  Regression false positive;
- failures nennen Typ/Ort, aber drucken nie geblockte Secret-Literale selbst.

Wenn `verify` an public-history/packaging/platform environment scheitert: erst unterscheiden, ob es
ein aktueller Codefehler, bekannte host condition oder bereits durch #24 gelöster alter Branch-
Zustand ist. **Keine Checks deaktivieren, nur um grün zu werden.**

Für den aktuellen Audit-Snapshot ist bereits bekannt: ein vollständiger Public-History-Check kann
wegen echter unsafe HEAD-Ancestors `9e27c0f` / `03acfba` fehlschlagen. Das ist ein realer Release-
History-Blocker, nicht Grund, #24 wieder aufzureißen oder `verify-public-history` abzuschwächen.

### S7 — Release / Installation / Issue-Close

- tagged artifact + Checksums/Signatur nach dem wirklichen Release-Pfad;
- installierter Build, nicht nur `main`, für release-gated Bugs;
- #26 erst schließen, wenn ein ausgelieferter Build mit #19 den historischen Repair-Fall genau
  einmal repariert und danach still bleibt;
- #22 erst nach signiertem XPI install/update/restart;
- #29 erst nach **exact PR/head** packaged Mac arm64+x64 + realer SCK/AX/CGEvent/TCC Desktop-Aktion
  + korrekter Core/Desktop attribution; normale source CI allein reicht nicht;
- #31 erst nach realem **externen Core UND Desktop `tools/list`** discovery fingerprint, Redaction-
  Regression sowie saved tunnel IDs/key + autoConnect über App-Restart; Self-Test zählt nicht;
- #40 erst nach installed-Chrome live discard-protection + lifecycle observation; ein Unit-Test von
  `tabs.update` allein zählt nicht;
- browserabhängige Issues erst nach Prime-only Live-Acceptance schließen.

---

## 9. Definition of done für den gesamten offenen-Issue-Pass

Der Pass ist erst fertig, wenn:

1. unmittelbar vor dem finalen Handoff **`gh issue list --state open` erneut gezogen** wurde und
   jedes **zu diesem finalen Reconcile-Zeitpunkt offene** Issue einen eindeutigen Zustand hat:
   fixed+merged+released, consciously rejected/narrowed, oder mit einem reproduzierbaren
   verbleibenden Blocker; der letzte Audit-Snapshot hatte 13 offene Issues, aber die Zahl ist keine
   dauerhafte Architekturkonstante;
2. #27/#35/#36 nicht drei konkurrierende progress watchdogs erzeugt haben;
3. #23/#31 dieselbe Tunnel-health authority verwenden;
4. #21 die Continuation-WAL als einzige A→B-Authority nutzt, die Broker-Transfer-Lease entfernt ist
   und live Background-Exec-Ownership im selben committed projection path mitwandert;
5. Project route parsing überall dieselbe Conversation-Semantik verwendet;
6. Draft replacement nur mit expliziter user policy + exact fresh-bootstrap proof möglich ist;
7. Firefox/macOS ports gemeinsame Policy nicht duplizieren;
8. Tool surface durch #2 nicht unnötig wächst;
9. #40 Browser-Custody keinen Keepalive-/Reload-Watchdog neben #27 geschaffen hat und nur eigene
   `autoDiscardable`-Mutationen restauriert;
10. `npm run verify` auf **vollständiger HEAD-Ancestry grün** ist, Build/Package-Gates für betroffene
    Surfaces grün sind und **kein Release mit einer dokumentierten Privacy-Ausnahme als done zählt**.
    Ein ungelöster History-Blocker blockiert den Release; ein gelöster Blocker wird anschließend
    erneut full-history verifiziert;
11. Prime-only live acceptance für die browserabhängigen Reliability-Pfade dokumentiert ist.

---

## 10. Audit-/Iterationsprotokoll dieses Plans

Dieser Stand ist **Iteration 4 nach erneutem GitHub-Reconcile + laufendem Drei-Worker-Adversarial-
Review**.

### Iteration 1 — Prime baseline

- die damals 14 offenen Issues via `gh` inventarisiert;
- aktuelle Branch-/PR-/Commit-Historie verglichen;
- zentrale Codepfade gelesen;
- focused suites lokal ausgeführt;
- erster issue-by-issue Fixplan geschrieben.

### Iteration 2 — exakt drei Read-only Sub-Agenten

Es wurden genau drei Worker parallel benutzt, alle ohne Browser/Desktop und ohne Repo-Edits:

1. **Runtime reliability:** #21, #26, #27, #34, #35, #36.
2. **Platform/surfaces:** #2, #22, #29, #31.
3. **Concrete bugs:** #23, #24, #25, #30.

Sie verglichen Issues mit aktuellem Code, PR-/Commit-History und gezielten Tests. Wichtige
Korrekturen zur ersten Fassung:

- #21: vorhandene stable HANDOFF source-message identity als Lease-Beweis verwenden; keinen neuen
  capture heartbeat state bauen.
- #36: globaler Capacity-Code kann retained exited/unread Output evicten; Data-Integrity-Fix vor
  UX/admission gate priorisieren.
- #26: Bugfix ist da, aber hot `/activity` compatibility repair ist spätere Löschschuld.
- #27: stale-turn root recovery ist bereits materiell gefixt; keine zweite Recovery bauen.
- #31: Persistence ist weitgehend done; echter Rest ist per-surface evidence/schema UX plus
  sensitive local-URL redaction.
- #2: nicht „vielleicht kleiner mergen“, sondern als durch die Primitive-Architektur superseded
  schließen.

### Iteration 3 — Reduktions-/Konsistenzpass

Der finale Plan trennt jetzt bewusst:

- **Turn-Liveness** (besitzt Recovery) von **Outstanding Obligations** (read-only UI/model projection);
- **Tunnel runtime truth** (#23) von **Setup projection** (#31);
- **native Desktop mechanism** (#29) von shared Desktop policy;
- **Browser manifest/runtime portability** (#22) von gemeinsamem Extension-Code;
- **Conversation identity** (#25) von destructive composer policy (#30).

Neue State-Machines wurden aus dem Plan gestrichen, wo bestehende Identität/Owner bereits genügen.
Der Implementierer soll diesen Reduktionsstandard bei jedem Batch erneut anwenden: wenn eine
vorgeschlagene neue Struktur nur einen vorhandenen Owner spiegelt, nicht bauen.

### Iteration 4 — GitHub-/Worktree-Reconcile + zweite adversarial Runde

Der erneute Audit hat den Plan materiell verändert:

- GitHub hatte beim letzten Pull **13** offene Issues; #40 wurde mitten im Audit neu angelegt,
  während #24/#25 bereits in `origin/main` gemerged und CLOSED sind. Darum finaler `gh`-Reconcile
  statt hard-coded Issue-Count als DoD.
- Branch-Divergenz wird als Verhalten-vs.-Git-Topologie behandelt; keine Hash-basierte Doppelarbeit.
- #21 wurde von „bessere inactivity lease“ auf **sole Continuation transaction + delete duplicate
  broker transfer lease + checkpoint-aware no-replay semantics** verschärft.
- committed continuation muss neben recorder/workspace/goal/swarm auch **UnifiedExec ownership** A→B
  publizieren/reparieren.
- #34 braucht exact terminal-delivery obligation und darf den nächsten Poll nicht hinter langen
  Compact-/Goal-Side-Effects blockieren.
- #36 löscht globale exited-LRU-Eviction vollständig; Capacity ist Admission, nicht GC.
- #31 fingerprintet nur die real an ChatGPT ausgelieferte `tools/list`-Shape; ein alter Tool Call
  beweist keine neue Discovery.
- #27 bleibt offen bis der neue klassifizierte Transport-Error-Trigger aus dem dirty Worktree
  integriert + live akzeptiert ist; er benutzt dieselbe one-shot recovery authority.
- #40 ergänzt eine dritte Runtime-Dimension: semantic browser-live need wird app-seitig abgeleitet,
  physical tab protection + reversible `autoDiscardable` side effect gehören der Extension;
  `discarded`/`frozen` sind Browser-Lifecycle-Evidence, keine Conversation-Terminals.
- PR #28 wird als realer Mac Vertical Slice **vor** spekulativer Driver-Abstraktion behandelt.
- Der Release-Audit fand einen zusätzlichen Infrastruktur-Blocker: Privacy-Verify in Actions läuft
  heute auf shallow checkouts und kann deshalb falsch grün sein. Script + Workflows müssen fail-
  closed/full-history werden, bevor ein Release-Green als Beweis zählt.
