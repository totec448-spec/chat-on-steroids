# Chat On Steroids — Architekturplan für den offenen GitHub-Issue-Pass

Stand: 2026-08-31, nach erneutem GitHub-/Worktree-/PR-Audit und Simplification-/Efficiency-Pass  
Audit-Snapshot des Arbeitsbaums: `rebuild/2.0.3-from-2.0.2` @ `1cb3b54`  
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
13. **Jeder Batch hat ein Reduction-Budget, nicht nur ein Test-Budget.** Vorher/nachher mindestens
    zählen: persistierte Felder, langlebige Maps/Sets, Timer/Alarms/Leases, Recovery-/Retry-Owner,
    Hot-Path-Scans, model-facing Discovery-Bytes und betroffene LOC. Ein Reliability-Batch soll bei
    gleicher Capability standardmäßig **weniger** langlebigen Zustand und weniger Recovery-Pfade
    hinterlassen. Netto-Zuwachs braucht eine konkrete externe Invariante, die ohne neuen State nicht
    modellierbar ist.
14. **Bounded query means bounded work.** Ein Tool/UI-Call mit `limit` darf nicht zuerst alle
    Sessions oder komplette Journale materialisieren. `limit: N` braucht eine Page-/Range-/Tail-
    Primitive, deren CPU/I/O ebenfalls durch N bzw. einen expliziten Byte-/Session-Budget begrenzt
    ist. Vollscan ist nur für ausdrücklich vollständige Search/Audit/Repair-Flows erlaubt und muss
    resumable sein.
15. **Retry ist ein Zustand des existierenden Owners, keine neue State-Machine.** Ein neuer Fehler-
    Trigger darf höchstens einen bestehenden Command-/Turn-Recovery-Owner erneut schedulen. Keine
    parallelen `setTimeout`-Ketten in App, Extension und Content; maximal ein `nextAttemptAt`/
    existing sweep pro Operation.
16. **Ein neuer Browser-/Platform-Backend muss Komplexität ersetzen.** #42 darf nicht dauerhaft
    „persönlicher Browser + detached Chromium + Codex Browser“ als drei gleichberechtigte Wege
    hinterlassen. Erst die minimale Custody-Grenze definieren; danach genau einen Primary Path und
    einen bewusst zeitlich begrenzten Migrationspfad. Jeder zweite Backend-Pfad braucht ein explizites
    Delete-/Deprecation-Ziel.
17. **Caches/Indices sind keine kostenlosen Fixes.** Einen O(n)-Scan erst zentralisieren und messen.
    Nur wenn er bei realistischen Bounds hot ist, einen abgeleiteten Index ergänzen; der Index darf
    niemals neue Persistenz-/Ownership-Authority werden und muss aus der kanonischen Struktur in
    einem Schritt rekonstruierbar sein.
18. **Model-facing Bytes sind Produktkosten.** Shell-/OS-Hinweise, die bereits in Server-
    Instructions stehen, nicht zusätzlich in jedes Tool-Schema kopieren. Bestehende Discovery-
    Budgets werden nicht angehoben, um neue Prosa zu legitimieren; zuerst deduplizieren.

---

## 1. Verifizierter Ausgangszustand

### 1.1 GitHub-Wahrheit: offene vs. inzwischen geschlossene Issues

Der neueste `gh issue list --state open`-Audit ergibt **15 offene Issues**. Seit dem vorigen Plan-
Snapshot sind zusätzlich #41 und #42 offen. Der Issue-Snapshot ist bewusst zeitgestempelte Evidenz
und muss vor Implementation erneut gelesen werden:

`#2, #21, #22, #23, #26, #27, #29, #30, #31, #34, #35, #36, #40, #41, #42`.

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
rebuild/2.0.3-from-2.0.2...origin/main [ahead 20, behind 6]
1cb3b54 fix final activity and missing-tab recovery
162e974 fix browser revival and stale chat recovery
2c6967a Make tunnel restarts single-owner
324648d Keep hidden activity delivery live
5463f17 Preserve unread exec results under capacity
b15445a Checkpoint recovery and open-issue audit
```

`origin/main` enthält inzwischen die Merges für #24, #25 und #33. Der lokale Branch enthält Teile
derselben Verhaltensänderungen bereits unter anderen Hashes. **`behind 6` bedeutet deshalb nicht
„sechs fehlende Produktfixes“.** Vor jeder Integration muss Verhalten statt Hash gezählt werden.

Der Worktree bleibt **geteilt**. Beim letzten Status-Snapshot war außer der hier bewusst nicht
angefassten untracked `docs/bug-audit-2026-08-31.md` kein fremder Source-Diff mehr sichtbar. Das ist
kein Freibrief für destructive Git-Kommandos: der Shared Tree kann sich während eines langen Runs
erneut ändern. Deshalb vor jedem Edit den konkreten Zielpfad nochmals gegen `git status`/`git diff`
prüfen und nur eigene Hunks anfassen.

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
- Issue-relevante offene PRs sind vor allem **#17** (#2), **#28** (#29) und **#39** (#21). **#43**
  (Codex Desktop thread/activity bridge RFC) ist architektonisch benachbart, aber kein Browser-
  Custody-Backend für #42 und darf nicht allein wegen ähnlicher „bridge“-Terminologie damit
  verschmolzen werden.
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
| #27 10+ min generating stall | 2-min inactivity recovery + klassifizierte Transport-Error-Recovery sind im aktuellen HEAD committed; Live-Akzeptanz bleibt offen | `b15445a`, danach Recovery-Härtung in `162e974` / `1cb3b54` | **Eine one-shot browser-recovery authority behalten; error- und inactivity-evidence nur als Trigger derselben Episode. Kein weiterer Watchdog; erst nach Live-Akzeptanz schließen.** |
| #29 macOS Desktop boundary | Umfangreiche validierte Mac-Vertical-Slice existiert in CLEAN PR #28 | Electron → Worker → N-API → Swift dylib; arm64 live/CI evidence | **Vertical slice nicht mit spekulativem Vorab-Refactor blockieren; erst sicher mergen, danach kleinsten echten Driver-Seam aus zwei Backends extrahieren.** |
| #30 autosaved New Chat draft blocks bootstrap | Safe failure/surfacing schon vorhanden; Opt-in fehlt | `insertPrompt()` + `runCommand()` + worker failure report | **Nur persistenten fresh-bootstrap Replace-Opt-in ergänzen; preserve default unverändert.** |
| #31 persistent/self-verifying Secure Tunnel | Persistence größtenteils schon fertig | config/safe storage/per-surface request+tool timestamps + monotonic surface exposure | **Fingerprint der tatsächlich ausgelieferten `tools/list`-Shape pro Surface; #23-health nur projizieren; capability-bearing lokale URLs aus generischen Renderer-Facts entfernen.** |
| #34 stale hidden worker output | **Lokal implementiert und getestet; Browser-Live-Akzeptanz bleibt offen** | lokaler Commit `324648d`; 382 Extension/Content-Tests | **Ein Scheduler entscheidet nach Arbeit; hidden generating/active läuft schnell, exact final delivery bleibt bis zum Feed-ACK live.** |
| #35 explain waits/blocks | Noch kein einheitliches Modell | Zustände existieren bei ihren Ownern; `.clf-stage` vorhanden | **Genau einen pure `waitStatusFor(conversationId)`-Selector in bestehender Stage-UI; keine Runtime-Registry und keine LLM-Statusmeldungen.** |
| #36 unread background exec results | **Lokal implementiert und getestet; Modell-Live-Akzeptanz bleibt offen** | lokaler Commit `5463f17`; 157 UnifiedExec/MCP-Tests | **LRU-Eviction gelöscht: Capacity ist Admission; exact-chat unread obligation begrenzt neue Starts und bleibt über `write_stdin` drainbar.** |
| #40 Chrome Memory Saver suspends agent tabs | Neu offen; Background kennt Tab-Identity, aber projiziert aktive Execution nicht in Chrome discard policy; `onUpdated` ignoriert `discarded`/`frozen` | `extension/background.js` + Chrome `tabs.autoDiscardable`/`discarded`/`frozen` APIs | **Eine read-only browser-live-required Projektion; bestehende 30s maintenance cadence reconciled `autoDiscardable=false` nur für tatsächlich execution-relevante Tabs. Discard ≠ Freeze: keine erfundene Freeze-API/Heartbeat.** |
| #41 message stream error auto-resume | Fehler-Evidenz existiert bereits; Gefahr ist eine zweite Retry-Maschine neben der vorhandenen stale-turn/browser recovery | Issue verlangt nur „detect error, prompt continue“; aktueller Bridge-/Content-Pfad besitzt bereits one-shot Recovery/Command-Custody | **Keinen neuen Retry-Subsystem bauen. Error ist ein weiterer Trigger in denselben conversation-scoped Recovery-Owner; gleiche Dedupe-/attempt identity, ein Budget, kein paralleler Timer.** |
| #42 detached Chromium / CDP | Produktproblem ist real (Focus-Steal/User-Browser-Coupling); heutiger Browser-Launcher probiert mehrere Chromium-Kandidaten, besitzt aber keine explizite Installation/Profile-Custody | `src/main/browser.ts::preferredBrowserCandidates/openInPreferredBrowser`; Extension besitzt Tab-/Document-/Command-Custody; PR #43 ist kein Browser-Backend | **Einen app-owned CompanionTarget (executable + profile) auswählen statt Candidate-Fanout als Runtime-Fallback. Bestehende Extension/Bridge behalten; CDP nur für bewiesene Capability-Gaps.** |

### 2.1 Lokaler Implementierungsstand dieses Passes

Seit dem ursprünglichen Checkpoint wurden mehrere Reliability-Pfade lokal weiter verändert. Dieser
Plan-Edit installiert, paketiert, pusht und schließt weiterhin keine Issues; er reconciled den
aktuellen HEAD und macht aus den bereits vorhandenen Fixes eine kleinere Zielarchitektur.

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
- **Browser revival/stale-chat recovery:** `162e974` ist ein positives Reduction-Beispiel: der
  Commit änderte `extension/background.js`/Bridge/Tests und löschte dabei netto deutlich mehr Code
  als er hinzufügte. Künftige Reliability-Batches sollen denselben Standard anstreben: eine stärkere
  Ownership-Invariante ersetzt mehrere Fallbacks, statt sie zu ergänzen.

Nicht implementiert wurden insbesondere #21, #22, #29, #30, #31, #35, #40, #41 und #42: ihre Architektur-
oder Produktentscheidungen sind größer als dieser Reliability-Pass oder brauchen Browser-/Plattform-
Live-Evidenz. Die bereits im Checkpoint vorhandenen #27-/Goal-/Tool-activity-Änderungen wurden als
vorhanden erkannt und nicht als zweite Parallel-Implementation neu gebaut.

---

## 3. Gemeinsame Architektur statt Issue-by-Issue Hotfixes

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

Ebenso **nicht autoritativ** ist ein Renderer-only „working“-Badge aus `SessionSummary.updatedAt`.
Das ist legitime Display-Heuristik, darf aber weder #27 Turn-Liveness, #35 konkrete Block-Gründe
noch #40 Browser-Protection treiben. Presentation clocks bleiben Presentation clocks.

#### B. Zwei Consumer brauchen zwei **enge pure Selector**, keine Runtime-Ontologie

Der vorige Plan-Entwurf schlug ein generisches `RuntimeObligation[]` mit `kind`, `requiresBrowser`,
`blocksExecAdmission` usw. vor. Das ist zwar read-only gedacht, aber als generische Zwischen-
Ontologie unnötig: jeder neue Feature-Typ würde einen weiteren String-Kind + Flags hinzufügen und
könnte langsam zu einer zweiten Lifecycle-Sprache neben den echten Ownern werden.

Auch ein zentraler neun-Felder-Inspector wäre unnötige Abstraktion. #35 fragt „warum wartet dieser
konkrete Chat?“; #40 braucht nur „welche Prime/Worker-Conversations sind execution-relevant?“.
Deshalb zwei enge pure Queries an den jeweiligen Owner-Grenzen:

```ts
waitStatusFor(conversationId) -> one display reason | null
protectedAgentConversations() -> Set<conversationId>
```

Beide besitzen/persistieren **nichts** und dürfen nur vorhandene Owner lesen. Es gibt keinen
`RuntimeObligation`-Store, kein `kind`-Array, keine generische `requiresBrowser`-/Admission-Sprache.

`waitStatusFor(id)` darf für genau diesen Chat lesen:

- recorder open-turn proof;
- continuation marker/checkpoint;
- laufender MCP/tool handler, soweit der Caller exakt bekannt ist;
- UnifiedExec `running` / `exitedUnread` für genau diese Conversation;
- Worker execution/wake aus dem Broker;
- Goal / Compact job;
- queued/handed browser command/recovery.

und deterministisch **einen** höchsten belegten Display-Grund + `since` wählen. #36 liest seine
Admission-Fakten weiterhin direkt aus UnifiedExec; kein UI-Selector wird Authority.

#27 benutzt dagegen weiterhin nur die bestehende Turn-Liveness für Recovery. #34 ist ein lokales
Scheduling-Problem: hidden **idle** darf langsam sein; hidden **working** oder ein Chat mit einer
exakt noch nicht round-tripped terminalen Assistant-Revision nicht.

**Nicht tun:** `pendingReason` persistieren, Background-Prozess-Existenz als Activity-Heartbeat
missbrauchen, einen zweiten stale-turn timer bauen oder Status als Transcript-Messages erzeugen.

#### C. Browser-Live-Custody bleibt für #40 **broker-scoped**

„Dieser Chat arbeitet“ und „Chrome darf einen **aktiven Agent-Tab** automatisch wegwerfen“ sind
nicht dieselbe Authority. Für Issue #40 reicht die vorhandene Broker-Topologie; sie muss nicht
Recorder/Goal/Compact/Continuation mitscannen. `protectedAgentConversations()` ist nur:

```text
active Prime conversation
+ active/waking/detached Worker conversation ids
-> distinct ids
```

Sleeping/finished/failed History erzeugt keinen Browser-Bedarf. Ein `detached` Worker erzeugt keinen
neuen Tab; existiert aber exact derselbe Tab noch/erneut, darf die Extension ihn während der
serverseitig möglichen Execution schützen. `activeUntil` und Renderer-Clocks sind ausdrücklich
keine Pin-Authority.

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

**Noch tiefer:** Auch der generische `bridge-commands`-WAL darf `resume` danach nicht als zweite
Transaktion behalten. Heute speichert Continuation bereits Token/Session/A→B/State/Handoff,
Claimant und beide Send-Checkpoints; parallel speichert ein `CommandSpec {type:'resume', sessionId,
token}` noch queued/leased owner/deadline/receipt. `sessionTokens` verbindet beide Welten zusätzlich.
Das erzeugt resume-spezifische Restore-/Expiry-/Cancel-/ACK-Choreographie in `bridge.ts`, obwohl die
Continuation bereits genau die externe Side-Effect-Grenze besitzt.

Ziel nach dem ersten #21-Cut:

1. Continuation erhält einen **inerten** `browserCommandId` als URL-/Redeem-Korrelation; niemals den
   Continuation-Token selbst in die URL legen.
2. Falls Dokument-Custody über Restart nötig ist, gehört `destinationOwner` direkt zur Continuation
   und ist nur solange übernehmbar, wie `sendUnattempted(destinationSend)` beweist, dass noch nichts
   dispatched wurde.
3. `/commands/redeem` löst diesen id direkt zur Continuation auf; `claimContinuationNow()`/
   Destination-Checkpoint ist der einzige Resume-Claim.
4. Resume-ACK committed/aborted direkt gegen die Continuation. Deren terminaler State ist zugleich
   die durable Receipt-Wahrheit; kein zweiter generic command receipt/TTL nötig.
5. Danach `resume` aus `CommandSpec`, command restore/migration, `sessionTokens`, generic command
   expiry/timer und resume-spezifische command-vs-continuation rollback/cancel branches löschen.

`bridge-commands` bleibt danach nur für Worker bootstrap/revival, deren semantische Authority
tatsächlich außerhalb der Continuation lebt. Dieser Schritt ist **nach** dem PrimeTransfer-Cut zu
machen, nicht gleichzeitig: zuerst eine durable Authority etablieren, dann den Adapter-State
löschen. Regressionen müssen lost ACK, document takeover before dispatch, crash after dispatch,
cancel und restart aus der Continuation allein beweisen.

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

### 3.4 Cluster D — Genau ein CompanionTarget + echte Portability boundaries (#22, #29, #42)

Firefox und macOS sind zwei verschiedene Ports und dürfen nicht in eine generische
"PlatformFramework"-Abstraktion gepresst werden.

- Browser automation bekommt **eine** app-seitige `CompanionTarget`-Authority statt getrennte
  „preferred browser“, „detached Chromium“ und „Firefox target“-Modelle. Minimal:

  ```ts
  CompanionTarget = { family, executable, profileSelector, installationId }
  ```

  `installationId` ist die gepaarte Extension-Instanz; executable/profileSelector sind nur deren
  Launch-Route. Candidate discovery darf Setup helfen, aber nach Auswahl öffnet Runtime **genau
  diesen** Target und fanoutet nicht bei jedem Worker/Resume über mehrere Browser.
- #42 etabliert diese Custody zuerst mit einem app-owned Chromium-Profil; CDP ist kein Bestandteil
  der Identity und kommt nur bei bewiesenem Capability-Gap hinzu.
- Firefox braucht danach nur eine **WebExtension runtime/manifest boundary** plus einen Firefox-
  Launch-Adapter für denselben `CompanionTarget`.
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

### 3.6 Cluster F — Broker-Persistenz und Session-I/O verkleinern, bevor neue Features darauf bauen

Dieser Pass hat neben den Issue-Flows zwei strukturelle Kostenquellen bestätigt, die sonst jede
weitere Reliability-Funktion teurer machen: mehrere durable Broker-Dateien für dieselbe Authority
und model-facing Session-Queries, deren sichtbares `limit` nicht ihr I/O begrenzt.

#### A. Retired-worker fences gehören in **denselben** Broker-Snapshot

Heute persistiert `agents.ts` den Swarm und `retiredWorkers` separat. Deshalb existieren zwei
debounced Sinks, zwei immediate Sinks und `persistAgentAuthorityNow()` muss erst die Retired-Datei
und danach den Swarm schreiben, weil ein Crash zwischen beiden unterschiedliche Authority-Welten
erzeugen kann. `index.ts`/`ipc.ts` müssen diese Zwei-Datei-Barriere mitverdrahten.

Ziel:

```text
BrokerSnapshot = active/dormant owner histories + retiredWorkerFences
```

- ein immediate durable Write veröffentlicht eine Authority-Revision atomar;
- `RetiredWorkersSnapshot`, `onRetiredWorkersPersist*`, `persistRetiredWorkersNow()` und die zweite
  Durable-State-Datei danach löschen;
- Upgrade liest die alte Datei **einmal**, merged noch lebende TTL-Fences in den neuen Snapshot und
  schreibt sie nie wieder separat;
- TTL bleibt eine Expiry des Fence-Fakts, nicht ein zweiter Broker-Lifecycle.

Das reduziert Code **und** eliminiert eine reale Cross-file Crash-Ordering-Anforderung.

#### B. Session-Tool-Limits müssen die Storage-Arbeit begrenzen

`session action=search` ruft aktuell zuerst `listAllSessions()` auf. Mit Query scannt es bis zu
`SEARCH_SCAN_SESSIONS = 100` Sessions und `searchOneSession()` materialisiert pro Session das ganze
Journal via `readEvents()`. Das sichtbare Resultat ist auf 30 Rows/~3k Tokens begrenzt, die I/O-
Kosten aber nicht entsprechend.

In zwei kleinen Schritten statt eines neuen Search-Index-Subsystems:

1. **No-query:** direkt `listSessionPage({cursor, limit: SEARCH_ROWS + 1})`; niemals alle Summaries
   materialisieren, nur um die 30 neuesten auszugeben.
2. **Query:** Store-seitig eine resumable bounded scan primitive verwenden/ergänzen, die höchstens
   einen expliziten Session-/Byte-Budget pro Call liest und einen Cursor zurückgibt. Der Tool-Cursor
   trägt dann `session + scan position`, sodass ein vollständiger Search über mehrere Calls exakt
   fortsetzbar bleibt. Kein `readEvents(summary.id)` über unbounded JSONL innerhalb einer 100er-
   Schleife.

Keinen globalen Volltextindex bauen, solange reale Profile nicht beweisen, dass bounded journal
scan unzureichend ist. Ein Index würde neue Migrations-, Repair- und Persistenzlogik kaufen.

#### C. Correlation-Retention an Session-Retention koppeln, nicht an eine willkürliche 50k-LRU

Der aktuelle HEAD hat den älteren „memory-only correlation“-Bug bereits verbessert: request-id
ownership wird durable gespeichert und beim Start aus bounded recent history reconciled. Eine
Invariante passt aber noch nicht zum Code-Kommentar „first proof is permanent“: `MAX_CORRELATIONS =
50_000` kann eine weiterhin gültige proof row rein nach Registry-Größe evicten.

Nicht den Cap einfach erhöhen. Entweder request-id ownership als sekundären Index der ohnehin
durablen Session-Lebenszeit führen oder beim Session-Retention/Delete denselben Owner-Eintrag
gezielt entfernen. Dann entfällt die unabhängige 50k-Eviction-Semantik. Bis zu dieser Konsolidierung
den Cap als bekannte Correctness-Grenze behandeln und nicht als „permanent“ dokumentieren.

#### D. Discovery-Bytes deduplizieren statt Budget erhöhen

Der reproduzierte `mcp.test.ts`-Fall ist deterministisch environment-dependent: `exec_command`
misst mit PowerShell 7 **3455 Bytes**, mit Windows PowerShell 5.1 **3572 Bytes** gegen `<3500`.
Die zusätzlichen 117 Bytes sind die PS5-`&&`/`||`-Warnung im `cmd`-Schema; dieselbe Warnung steht
bereits in den server instructions.

Kleinster Fix: PS5-Sonderprosa aus `EXEC_COMMAND_CMD_DESCRIPTION` löschen und ausschließlich in den
Instructions behalten. `<3500` unverändert lassen, Shell-Version-neutralität des Schemas testen.
Kein PATH-spezifisches Budget und kein „+200 Bytes weil Windows“.

Dasselbe Prinzip gilt für **Result-Bytes**: `exec_command` und `write_stdin` senden den potenziell
großen Command-Output heute zweimal — einmal im MCP-Text `content`, ein zweites Mal als
`structuredContent.output`. Für große Resultate bedeutet das nahezu doppeltes JSON/Wire-Volumen und
einen zweiten `truncatedOutput()`-Formatierungsdurchlauf; interne Consumer brauchen aus
`structuredContent` dagegen nur kleine Maschinen-Metadaten wie exit/session/chunk/wall-time.

Darum `structuredContent` metadata-only machen:

```text
chunk_id, wall_time_seconds, exit_code, session_id, original_token_count
```

`output` aus `execCommandStructuredOutput()` und `unifiedExecOutputSchema` löschen; Model-Output hat
genau **eine** Text-Authority. Wire-Regressions sollen bei z. B. 40 KiB Output beweisen, dass der Body
nur einmal vorkommt und die serialisierte Response grob nahe 1× statt 2× Payload bleibt.

Das verkleinert zugleich beide advertised exec output schemas. Den **gesamten** `outputSchema`
erst dann entfernen, wenn echte MCP-Client-Kompatibilität beweist, dass kein externer Consumer die
Metadata-Deklaration braucht; das ist optionaler zweiter Cut, nicht Voraussetzung für die sichere
Payload-Deduplizierung.

#### E. O(n)-Owner-Lookups erst messen, dann indexieren

`dormantRunForWorkerConversation()`/`dormantAgentForConversation()` scannen heute `dormantRuns ×
agents` und werden an mehreren Hot-Callsites verwendet. Das ist ein echter asymptotischer Geruch,
aber typische Worker-Zahlen sind klein. Deshalb zuerst beide Lookups zu **einem** kanonischen Helper
zusammenfassen und einen Benchmark/Counter mit realistischen 1/10/100 dormant histories ergänzen.
Nur wenn das messbar hot ist, einen transienten conversation→owner Index einführen, der bei Restore
in einem Pass aus `dormantRuns` gebaut wird; nie als zweite durable Datei.

#### F. Revival-Redeem darf keine Zwei-Datei-Transaktion bleiben

Der aktuelle Revival-Redeem publiziert **denselben Browser-Custody-Cut zweimal**: zuerst setzt der
Broker `waking + revivable=false` und fsynct den Swarm, danach schreibt die Bridge den durable
Command-Owner. Deshalb braucht `persistRevivalRedeem()` eine explizite Reihenfolge, Rollback des
Broker-Claims und einen zweiten fsync bei Broker-Write-Fehlern. Das ist genau die Cross-owner-
Transaction, die der Architekturplan sonst vermeiden will.

Sauberere Zielgrenze:

- Broker besitzt nur `sleeping -> waking -> active/sleeping/terminal` und Slot-Capacity.
- Bridge-Command-Lease (`owner`, `claimedAt`) besitzt ausschließlich „ein Browser hat diesen Wake
  vor Send exklusiv übernommen“.
- `/commands/redeem` serialisiert weiterhin per Command, persistiert **nur** diese Lease und prüft
  danach erneut, dass Worker/Conversation noch derselbe `waking`-Owner sind, bevor Payload rausgeht.
- Ein später alter MCP-Call darf `waking -> active` nur übernehmen, solange keine durable Revival-
  Lease für diese Conversation existiert. Diese Frage als schmalen Bridge→Broker-Selector/
  callback stellen; nicht als zweites persistiertes Broker-Bit spiegeln.

Danach `claimWorkerRevival()`, `rollbackWorkerRevivalClaim()`, `workerRevivalClaimed()`,
`broker-not-durable`-Redeem-Branches und einen critical swarm fsync pro Redeem löschen.

**`AgentInfo.revivable` separat reduzieren, nicht blind im selben Diff löschen.** Der aktuelle Code
benutzt das Feld zusätzlich für sleeping/finished/failed compatibility und Restore-Reparatur. Erst
nach dem Lease-Cut per Tests beweisen, dass die semantische Wiederverwendbarkeit vollständig aus
`state + context ceiling + conversation binding` ableitbar ist. Wenn ja, `revivable` aus der durable
Shape löschen und nur bei Bedarf als derived UI field projizieren. Keine Transport-Arbitration darf
dieses UI/semantic Bit danach noch missbrauchen.

#### G. Fiber-Dedupe darf bei langen Chats nicht periodisch alles vergessen

`refreshFiber()` dedupliziert Calls, Assistant-Messages, native Activities und authored user times
bereits über stabile Website-IDs. Danach werden aber alle vier Maps jeweils komplett gelöscht,
sobald ihre Größe `> 4000` ist. Ein Chat, dessen geladener Fiber-Snapshot selbst über diesem Wert
liegt, kann dadurch in eine deterministische Replay-Schleife geraten:

```text
scan >4000 ids -> dedupe maps clear -> next scan sees everything as new -> emits again -> clear -> …
```

Das vervielfacht gleichzeitig CPU, Browser-Journal-Writes und `/events`-Bytes. **Kein LRU/TTL als
Gegenfix.** Die Keys sind ChatGPT-eigene stabile IDs und werden bei echtem Conversation-Wechsel
bereits gelöscht.

Kleinster Fix:

1. zuerst die vier willkürlichen `> 4000 -> clear()`-Branches entfernen;
2. Fixture mit >4k, besser 10k stabilen Message/Tool-IDs zweimal unverändert scannen;
3. zweiter Scan muss **0 neue observations** erzeugen und Journal-/Transport-Größe flach bleiben;
4. Heap/Map-Größe messen. Nur falls echte Memory-Evidenz einen Bound verlangt, pro Scan eine
   `nextReported`-Map ausschließlich aus dem aktuellen Fiber-Snapshot aufbauen und am Ende ersetzen.
   Das ist Snapshot-Retention, keine LRU-State-Machine.

#### H. Den 15s Connectivity-Poll pro Tab in vorhandene Transport-Antworten falten

`content.js` startet zusätzlich zu Observation + Activity einen `STATUS_MS = 15_000`-Interval.
`checkStatus()` fragt den service worker, der `discover()` ausführt und bei Bedarf Provisioning/
`/hello` anstößt. Named Chats machen ohnehin `/activity` mit 0.75–30s dynamischer Cadence; New Chat
macht `settings_get`. Beide laufen bereits durch denselben `background.call()`-Pfad und beweisen
damit App/Pairing/Disconnect-Status.

Ziel: **keinen dritten periodischen Transport**.

- erfolgreiche `activity`/`settings_get`-Antwort => connected + paired;
- `app_not_found`, `not_paired`, `disconnected`, `incompatible_extension` aktualisieren dieselbe
  lokale Status-Projektion aus der vorhandenen Antwort;
- den `every(STATUS_MS, checkStatus)`-Interval löschen;
- falls UI beim allerersten Render wirklich vor Activity/Settings einen Zustand braucht, genau
  **einen** Startup-Status-Read erlauben, keinen Interval;
- Popup-`status` bleibt eine explizite User-Abfrage und darf seine eigene aktuelle Discovery machen.

Regression: app down→up, reconnect, explicit disconnect und incompatible extension müssen allein
durch die bestehenden Activity/Settings-Transporte korrekt im Content-UI erscheinen. Danach in
einem 5-Tab-Fixture beweisen, dass idle tabs keine zusätzlichen 15s Status-Messages mehr erzeugen.

### 3.7 Cluster G — #41/#42: neue Browser-Issues müssen bestehende Recovery/Custody **vereinfachen**

#### #41: erst prüfen, ob der aktuelle exact-chat Reload das gemeldete Problem bereits löst

Der aktuelle HEAD klassifiziert ChatGPT-Transportfehler bereits im DOM, recorded `chat_error` mit
`recoverable`, und alle Error-/Silence-/No-tab-Trigger konvergieren in `queueBrowserRecovery()` mit
einem `repairsInFlight`-Owner und einer gemeinsamen Cooldown-/Receipt-Semantik. Das ist fast exakt
die zugrunde liegende Capability, die #41 verlangt.

Darum **kein** sofortiger „prompt continue“-Timer nach jedem Error. Ein verlorener Browser-Stream
kann serverseitig noch weiterlaufen; ein zusätzlicher User-Turn würde dann Arbeit duplizieren.

1. Reproduziere #41 gegen `1cb3b54`: Transportfehler → genau ein exact-chat reload → prüfe, ob der
   ursprüngliche Turn nach Reload weiterläuft/settled.
2. Wenn ja: #41 als durch bestehende Recovery behaviorally solved behandeln; nur Regression/Live-
   Evidence ergänzen.
3. Nur wenn Reload beweisbar in einem **idle/failed** Chat mit stabiler partieller Assistant-Antwort
   endet und seitdem kein neuer User-Turn existiert, darf ein zweiter Recovery-Step denselben
   Episode-/Receipt-Owner benutzen und genau **eine** minimale Continue-Nachricht senden.
4. Dieser Step bekommt keinen eigenen Retry-Timer. Er ist eine weitere Phase desselben Repair-
   Episodes; Success/new progress/manual user input beendet ihn.

#### #42: Isolation zuerst durch Profile-Custody, CDP erst bei bewiesenem Capability-Gap

Das Problem hinter #42 ist nicht „wir brauchen CDP“, sondern „Automation darf den persönlichen
Browser/Fokus nicht besitzen“. Die bestehende Extension hat bereits Document-/Tab-/Command-Custody,
durable ACKs, page injection und exact-chat routing. Ein zweiter CDP-State-Stack würde diese Regeln
sonst noch einmal implementieren.

Minimaler Vertical Slice:

1. App-owned `companionProfileDir` + genau ein Chromium executable als explizite Custody-Identity.
2. Diesen Chromium mit dem dedizierten `--user-data-dir` starten; Benutzer loggt ChatGPT/Extension
   dort einmal ein. Browser-Bridge/Auth/commands bleiben unverändert.
3. Zuerst **headed but non-user-owned** testen: kein Focus-Steal des persönlichen Browsers, exact
   worker/revive/Compact flows bleiben dieselben.
4. Danach Headless als Modus derselben Profile-Custody testen. Moderne Chrome-Headless-Ausführung
   kann Extensions laden; das ist ein Deployment-/acceptance detail, keine neue App-Authority.
5. CDP nur ergänzen, wenn eine benötigte Operation mit Extension + process launch nicht möglich
   ist. Dann CDP auf lifecycle/navigation beschränken und **nicht** Conversation-/Command-Ownership
   spiegeln.

Chrome 136+ verlangt für Remote-Debugging ohnehin ein nicht-default `--user-data-dir`; das passt zur
Isolationsgrenze und ist ein weiterer Grund, niemals das persönliche Default-Profil per CDP zu
steuern. Chrome for Testing ist für Automation eine Option, aber eine zweite Distribution muss ihren
Install-/Update-Nutzen gegen den zusätzlichen Packaging-Stack rechtfertigen.

---

## 4. Empfohlene Ausführungsreihenfolge

### Batch 0 — Repository-Wahrheit herstellen, ohne fremde Arbeit zu zerstören

1. Dirty Worktree inventarisieren und unangetastet lassen.
2. `origin/main` gegen den lokalen Branch per `git cherry`/`range-diff` reconciliieren; #24/#25 als
   bereits CLOSED markieren, nicht erneut implementieren.
3. Offene PRs #17/#28/#39/#43 gegen die geplanten Dateien diffen; keine fremde Feature-Branch-
   Historie blind in den Reliability-Branch ziehen. #43 nur dann als Dependency behandeln, wenn
   #42 nachweislich denselben Browser-Process-Owner braucht — „bridge“ im Namen reicht nicht.
4. #2 / PR #17 architecture-superseded entscheiden; wenn Maintainer zustimmt, ohne Produktcode
   schließen.

### Batch 1 — Authority-/I/O-Reduktion zuerst

1. Broker-Authority atomar machen: `retiredWorkerFences` in den Swarm/Broker-Snapshot integrieren;
   zweite Retired-WAL + doppelte Persist-Sinks/Barrier löschen.
2. #21: Continuation als sole transaction, duplicate `PrimeTransfer`-Lease löschen, checkpoint-aware
   abandonment + recursive-auto-compact regression.
3. Danach `resume` aus dem generischen `bridge-commands`-WAL entfernen und Redeem/ACK direkt auf
   Continuation + inertem `browserCommandId` abbilden. Erst PrimeTransfer löschen, **dann** diesen
   Adapter-State — nicht beide Authority-Migrationen in einem unreviewbaren Diff vermischen.
4. **Im selben #21-Architekturpass** die #26 Compatibility-Reparatur aus `/activity` entfernen. Den exakt
   positiven Legacy-Repair für ein Compatibility-Fenster einmal bounded beim Startup/Restore
   reconciliieren; danach Hot-Poll-Caller löschen. Issue #26 bleibt trotzdem release-gated.
5. MCP bytes: PS5-only `exec_command`-Schema-Prosa löschen **und** exec/write_stdin output nur einmal
   als Text senden; `structuredContent` bleibt metadata-only. `<3500` Discovery-Budget unverändert.
6. Session Tool: no-query auf `listSessionPage` umstellen; Query-Scan bounded/resumable machen, ohne
   Volltextindex zu bauen.
7. Content hot path: >4k Fiber-dedupe clear entfernen und 10k unchanged replay=0 beweisen.
8. Per-tab Connectivity: 15s `checkStatus` interval in Activity/Settings-Transport falten.

**Batch-Gate:** Dieser Batch muss netto langlebige State-/Persistenzpfade löschen. Wenn danach mehr
durable Dateien, Timer oder Recovery-Owner existieren als vorher, Architektur erneut prüfen.

### Batch 2 — Reliability hot path auf den reduzierten Ownern

1. #36 ist lokal implementiert: Capacity/Admission nur revalidieren; keine zweite Obligation-
   Registry bauen.
2. #34 ist lokal implementiert: hidden working/final-delivery live/browser revalidieren; keinen
   zweiten Poll-Clock ergänzen.
3. #27 + #41 gemeinsam live reproduzieren. Bestehender `queueBrowserRecovery()` bleibt ein Owner;
   Transport-Error, Silence und fehlender Tab sind Evidenz/Phasen desselben Repair-Episodes.
4. #41 nur dann um einen one-shot Continue-Step erweitern, wenn exact reload nachweislich idle +
   partial endet. Sonst **kein neuer Code**.
5. #35: genau `waitStatusFor(conversationId)` als pure Display-Projektion; keine generische Runtime-
   Registry/Inspector-Ontologie.
6. #40: daraus targeted Chrome discard protection; keine neue Heartbeat-/Tab-Persistence-Schicht.

### Batch 3 — Tunnel correctness + setup

1. #23 ist lokal implementiert: single-owner Restart-/health state machine revalidieren.
2. #31 UI/setup projection danach auf dieselbe autoritative Runtime setzen.

### Batch 4 — Bootstrap, Browser-Isolation und Portability

1. #30 als **ein Boolean im authenticated command snapshot + bestehende Fences** implementieren;
   keinen Composer-Policy-State-Machine-Layer bauen.
2. #42 zuerst als dedicated Chromium profile mit bestehender Extension/Bridge vertical slicen;
   CDP nur bei bewiesenem Capability-Gap.
3. #29 CLEAN Mac vertical slice reviewen/akzeptieren; **danach**, mit zwei realen Backends als
   Evidenz, nur die kleinste echte Driver-Grenze extrahieren.
4. #22 Firefox portability layer als eigenständigen Plattform-Gate; #42-Custody-Seam wiederverwenden,
   aber keinen generischen Browser-Framework-Refactor vor zwei realen Backends. Nicht unter 2.0.3-Zeitdruck
   halb-validiert ausliefern.

### Batch 5 — Release-/Close-Pass

Nach den Implementierungsbatches alle Issue-Labels/PR-Verweise aktualisieren, Prime-only Live-
Acceptance dokumentieren und nur die tatsächlich ausgelieferten/abgelehnten Issues schließen.

---

# 5. Issue-by-Issue Implementierungsplan

## Closed historical issues — keine Implementation mehr

| Issue | Status | Was im Plan bleibt |
|---|---|---|
| #24 verify/history + AppImage contention | **CLOSED** | Nur S6.1 bleibt als separater Release-History-Gate; den alten Produktbug nicht wieder öffnen. |
| #25 Project chats | **CLOSED** | Zentrale Conversation-Route-Parser als Regression behalten; keine zweite Project-Route-Implementation. |

Diese Issues sind nur Herkunft für Regressionen. Ihr früherer Implementierungsverlauf gehört in Git,
nicht in den aktiven Plan.

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
Das muss **nicht** bis nach Release warten, sobald #21 die Continuation-WAL zur einzigen Transfer-
Authority macht: genau dann ist die positive Resume-Provenance beim Restore verfügbar. In demselben
Batch den Presentation-Poll als Repair-Owner entfernen. Für ein Compatibility-Fenster den heutigen
strikten positiven Repair-Beweis genau **einmal bounded beim Startup/Restore** über resume-origin
Sessions ausführen; Function/Proof darf temporär bleiben, der `/activity`-Caller nicht. #26 selbst
bleibt release-gated, weil das historische User-Problem erst in einem ausgelieferten Build als
gelöst gilt.

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

**Lokal gelandet:** `324648d` hält hidden working/final-delivery activity auf der schnellen bestehenden
Cadence und behält die exact terminal assistant revision bis zum Feed-ACK. Keine neue Poll-Familie.

**Plan-Aktion:** keinen zweiten Fix bauen. Nur die bereits geschriebene Regression + Prime-only Live-
Acceptance gegen hidden worker, final reply und foreground/background transition ausführen. Wenn Live
scheitert, zuerst die eine Scheduler-Entscheidung korrigieren; keine zusätzliche Visibility-/Timer-
State-Machine hinzufügen.

**Close-Gate:** Verhalten im ausgelieferten Build beweisen; commit/test allein schließt den Browser-
Issue nicht.

## #40 — Prevent Chrome Memory Saver from suspending active Prime/Worker tabs

### Root cause

Die Extension besitzt bereits exact `tabConversations` + document custody, aber projiziert den
Broker-Fakt „dieser Prime/Worker ist gerade execution-relevant“ nicht in Chrome
`autoDiscardable`. Ein neues Keepalive-/Heartbeat-System ist dafür unnötig.

### Kleinste Authority

Issue #40 braucht **keinen allgemeinen Runtime-Inspector** und keinen Browser→App-Telemetriekanal.
Der Broker kennt genau die Issue-Scope:

```ts
protectedAgentConversations(): Set<string>
  = active Prime
  + active/waking/detached Workers with conversationId
```

Sleeping/finished/failed History ist nicht geschützt. `detached` erzeugt keinen Tab; wenn derselbe
Chat aber physisch noch/erneut als exact `tabConversations`-Mapping existiert, darf Chrome ihn nicht
automatisch wegwerfen, solange die Broker-Execution noch lebt.

Die Extension liest diese kleine Menge im **bestehenden maintenance exchange** und reconciled nur
gegen ihre eigene Tab-Custody. Keine offene Recorder-Turn-Suche, kein Goal/Compact-Scan und keine
zweite Runtime-Ontologie nur für Memory Saver.

### Reversible Browser-Side-Effect

Wenn ein exact gemappter geschützter Tab `autoDiscardable === true` ist:

1. `{tabId, conversationId}` in `storage.session` als **owned mutation** persistieren. Ein Eintrag
   bedeutet bereits eindeutig „CoS sah vorher true und schuldet restore-to-true“; ein zusätzliches
   `previousAutoDiscardable:true` trägt keine Information.
2. Danach `chrome.tabs.update(tabId, {autoDiscardable:false})`.
3. Nach dem await Tab+Conversation erneut prüfen; numeric tab ids allein sind keine Identity.
4. Endet die Broker-Protection oder verlässt der Tab ChatGPT: nur einen CoS-owned Eintrag auf
   `autoDiscardable:true` restaurieren und den Eintrag danach löschen.
5. War der Wert schon `false`, besitzt CoS **nichts** und setzt später niemals blind `true`.
6. `tabs.onRemoved`: owned row löschen; ein nicht existierender Tab braucht keinen Restore.
7. MV3-worker restart lädt dieselbe browser-session-lokale Effect-Liste und reconciled im bereits
   vorhandenen maintenance owner weiter. Kein neuer Timer.

### `discarded` / `frozen` bleiben Extension-lokale Lifecycle-Evidence

- `discarded=true` oder `frozen=true` sind **kein** Conversation-Close und dürfen weder
  `releaseTab()` noch `/closed` noch Agent-Terminalisierung auslösen.
- Chrome ohne `frozen`-Feld bleibt per Feature Detection kompatibel.
- Es gibt **kein** `POST /status`, keine app-seitige `browserAvailability`-Projection und keinen
  zweiten Reload-Owner. Die bestehende exact-chat `queueBrowserRecovery()`-Authority bleibt allein
  zuständig, wenn die eigentliche Turn-Liveness später einen Repair verlangt.
- Kein `tabs.update({frozen:false})` erfinden und keinen Tab automatisch foregrounden.

### Minimal tests

- active Prime + active/waking/detached mapped Worker => exact mapped tabs non-discardable;
- sleeping/finished/failed/unrelated tabs => unverändert;
- preexisting `autoDiscardable=false` => kein owned row, kein späterer restore;
- owned row durable vor `tabs.update(false)`; crash vor/nach update converged idempotent;
- restore-to-true erfolgreich, crash vor row-delete => nächster reconcile bleibt idempotent;
- navigation/reused tab id => keine Mutation ohne exact conversation recheck;
- `discarded=true` / `frozen=true` => kein close/terminal/release und kein zweiter recovery owner;
- 5+ tabs über mehrere maintenance passes => **ein** vorhandener cadence owner, kein zusätzlicher
  Memory-Saver interval.

### Prime-only live acceptance

1. `chrome://discards`: aktiver Prime/Worker-Tab zeigt `autoDiscardable=false`; unrelated ChatGPT
   bleibt normal discardable.
2. Worker/Prime beendet execution obligation => nur CoS-owned Mutation wird freigegeben.
3. Manual Urgent Discard/Freeze erzeugt keinen Ownership-Verlust, Focus-Steal oder Reload-Storm;
   bestehende Recovery bleibt at-most-once.
4. Service-worker restart während Protection/Restore converged aus `storage.session`.

**Nicht tun:** site-wide Performance-Settings ändern, alle ChatGPT-Tabs pinnen, audio/WebSocket/
`setInterval`-Keepalive bauen oder frozen/discarded als neue app-seitige Lifecycle-State-Machine
modellieren.

---

## #36 — Background exec results accumulate unread

**Lokal gelandet:** `5463f17` entfernt result-bearing LRU-Eviction. Capacity ist Admission statt GC;
`running`/`exitedUnread` bleiben conversation-owned und über `write_stdin` drainbar.

**Plan-Aktion:** keine neue Queue/Obligation-Registry ergänzen. Revalidiere nur: global + per-chat
Admission, unread result survives pressure, `write_stdin` bleibt erlaubt, und model-facing Failure-
Taxonomie zählt process exit/rejection nicht als internen Tool-Defect.

**Close-Gate:** realer Prime/Worker flow mit unread background result beendet/erklärt den Turn ohne
Datenverlust; danach Release-Evidence.

## #35 — Proactively explain when main chat is waiting/blocked

### Kleinste Lösung

Kein Progress-State-System. `bridge.ts` berechnet für **eine** Conversation auf Nachfrage:

```ts
waitStatusFor(conversationId) -> {kind, text, since?} | null
```

Der Selector persistiert nichts und liest nur owner-native Facts, die bereits existieren: running /
exited-unread UnifiedExec, konkrete Worker activity/wake, Continuation/Compact/Goal barrier und
queued/handed browser recovery. Recorder/`activeUntil` bleiben alleinige Turn-Liveness-Authority.

Priorität bleibt klein und deterministisch:

```text
needs_user > retrying > blocked > waiting > working > unknown-open-turn
```

Dabei nie behaupten „Prime wartet auf Worker 2“, wenn nur `worker-2 active` bekannt ist. Ohne echte
Dependency-Evidenz lautet die UI z. B. `2 workers still running`. Externe GitHub-/CI-Tracker werden
nicht erfunden; nur bereits vorhandene Tool-/Exec-Fakten dürfen projiziert werden.

### UI

Bestehende `.clf-stage` / `stageView()` wiederverwenden: eine mutable, nicht model-visible Zeile.
Kein neues Panel, keine Transcript-Messages, kein `pendingReason`-Store. Elapsed time darf aus
`since` low-cadence gerendert werden.

### Minimal tests

- running background exec / exited-unread threshold;
- one/multiple workers + failure;
- Continuation durable barrier;
- exact browser recovery queued/retrying;
- unknown open turn;
- echte neue progress evidence ersetzt/entfernt den Status;
- Selector-Aufruf erzeugt **keinen** Broker/Recorder/Exec write.

Danach prüfen, ob der alte page-local 10-minute `No visible progress`-Diagnosepfad noch einzigartig
ist. Wenn #27 recovery + diese konkrete Statuszeile denselben Fall vollständig erklären, den alten
Warnpfad löschen statt drei Diagnosemechanismen zu behalten.

## #27 — Turn remains generating 10+ min after tool result

**Aktueller Stand:** Der 2-min inactivity grant, receipt-tracked exact-chat recovery und die
klassifizierte `chat_error` transport recovery sind im aktuellen HEAD committed. Alle Trigger
konvergieren in `queueBrowserRecovery()`; `162e974`/`1cb3b54` härten stale-chat/missing-tab/final
activity weiter. Das ist die Zielarchitektur, nicht ein weiterer 10-Minuten-Watchdog.

### Was noch offen ist

Nur live Verhalten + Interaktion mit #36/#41:

1. running Background Exec ist **keine** Liveness-Evidenz; ein echter attributed tool call ist es;
2. exited-unread Exec wird über #36 drain/admission sichtbar und darf Recovery nicht künstlich
   verhindern;
3. offener Turn ohne echte Progress-Evidenz => genau ein inactivity Repair;
4. klassifizierter Assistant-Transportfehler => derselbe Repair-Owner sofort, beliebiger Alert nie;
5. während eines `assistant-error`-Repairs dürfen weitere attributed calls die queued Episode nicht
   löschen;
6. nach exact reload #41 prüfen: setzt derselbe ursprüngliche Turn fort, ist **kein** Continue-Prompt
   nötig. Nur ein stabil idle/failed partial state darf die one-shot zweite Phase aus Cluster 3.7
   aktivieren.

### Minimal regressions / close gate

- active turn + silence threshold => exactly one queued/handed/done recovery;
- recovery receipt lost/fails => retry derselben Episode, kein neuer Owner;
- final answer oder manual stop vor threshold => no recovery;
- transport failure + ongoing tool calls => repair bleibt bestehen;
- ordinary hidden/ARIA alert => no recovery;
- lone chat und worker chat verwenden denselben exact-chat recovery path;
- Prime-only Live-Repro des ursprünglichen Stalls + Transport-Error-Fall auf installiertem Build.

Kein Issue-Close nur wegen Unit-Tests; aber auch **keine neue Integration** mehr erfinden, solange die
Live-Matrix keinen neuen Failure-Owner beweist.

## #23 — Tunnel supervisor false-offline / double-retry

**Lokal gelandet:** `2c6967a` macht `ClientRun` zur Process-/Health-Generation. Nur `current === run`
darf retire/restarten; Stop-Barriere verhindert überlappende Process-Trees; unbestätigte Health bleibt
`unknown/connecting` statt erfunden `offline/healthy`.

**Plan-Aktion:** keinen zweiten Supervisor bauen. Focused lifecycle regression + real external tunnel
smoke ausführen. Bei einem Fail die generation-owned transition reparieren und danach obsolete
`done`/`proc !== child`-Guards löschen, statt neue Guards aufzuschichten.

**Close-Gate:** transient poll failure, delayed old-child exit und concurrent failure signals erzeugen
je genau einen Owner/Restart; real Core/Desktop connectivity bleibt stabil.

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

**Nicht `insertPrompt()` global permissiver machen und keine neue Composer-Policy-State-Machine
bauen.** `deliverCommand()` hat vor dem Draft-Check bereits die wichtigen Identity-/Route-Fences:
durable redeemed owner, fresh-vs-targeted route, exact marker/client und `stillOnTarget()`.

Die gesamte neue Policy darf deshalb auf **einen** Wert schrumpfen:

```ts
BridgeCommand.replaceFreshDraft: boolean
```

Dieser Wert wird beim app-seitigen Command-Snapshot aus dem persistenten Setting eingefroren. Der
Content-Script liest keine Config selbst und erfindet keine zweite Policy-Authority.

**Nicht `insertPrompt()` global permissiver machen.** Am bereits existierenden Draft-Check darf
replacement nur passieren, wenn `target === null`, `replaceFreshDraft === true` und
`stillOnTarget()` weiterhin gilt. Danach bleiben die vorhandenen exact-content/route/marker checks
vor Send unverändert.

Beispiel:

```ts
writeComposer(value, mode: 'require-empty' | 'replace-existing')
```

oder zwei klar benannte Funktionen. **Diese Fences nicht ein zweites Mal modellieren**: der bestehende
`deliverCommand()`-Pfad beweist sie bereits. Der neue Branch braucht nur `fresh/no target + frozen
opt-in + stillOnTarget()`; Revival/existing conversation erreichen ihn strukturell nicht.

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
  oder den vorhandenen composer writer um einen expliziten Replace-Modus ergänzen. `clearPromptExact`
  besitzt bereits die native select-all/delete-Mechanik; **keine zweite Editor-Clear-Implementation**;
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

## #2 — Power Agent tools: bewusst ohne Produktcode schließen

PR #17 nicht mergen. `system_exec`, process/app helpers und system-wide filesystem duplizieren die
vorhandene command/filesystem authority; der große Composite-Surface würde permanente Discovery- und
Security-Kosten kaufen. `web_fetch` nur als separates Issue neu begründen, falls ein einzigartiger
Produktnutzen bewiesen wird. Die ausführliche Capability-Aufzählung gehört in Issue/PR-Kommentare,
nicht in diesen Ausführungsplan.

---

## 6. Canonical validation per implementation batch

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
- #40 pure `protectedAgentConversations()` + reversible effect-journal reducer;
- #23 classifier/generation/health reduction;
- #30 config/policy fences;
- #31 serialized-list fingerprint + redaction;
- #22 manifest/origin/browser-delta.

### S2 — Subsystem integration

- bridge ↔ continuation WAL/rebind/projection;
- continuation commit ↔ exec-owner migration;
- MCP kernel ↔ UnifiedExec ownership/admission;
- broker `protectedAgentConversations()` ↔ existing maintenance reply ↔ extension
  `tabConversations` ↔ reversible `autoDiscardable` mutation journal;
- fake-child tunnel supervisor lifecycle;
- config → IPC/preload/renderer → authenticated BridgeCommand draft policy;
- `waitStatusFor(conversationId)` → existing `/activity` → `.clf-stage`.

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

Für #21 nicht jede Lebenszeit künstlich mit jedem Checkpoint kreuzen. Die kanonische Crash-Matrix
beweist genau die **irreversiblen Grenzen**:

1. pre-dispatch / `attempted-unresolved` + owner loss => replaybar/übernehmbar;
2. `dispatched-unresolved` + process/document loss => nie blind replaybar;
3. `sent(messageId)` + Ablauf der alten TTL + App restart => Marker/WAL reconciled weiter;
4. committed rebind + crash vor Broker-/Exec-Projektion => idempotente projection repair.

Zusätzliche content/service-worker/browser/SPA-Dimensionen nur dort ergänzen, wo ein anderer Owner
oder eine andere Persistenz-Lebenszeit tatsächlich beteiligt ist. Testzahl ist kein Qualitätsziel.

Für #40 die reversible Browser-Side-Effect-WAL an **drei** Commit-Grenzen schneiden:

1. journal persisted → crash vor `tabs.update(false)`;
2. `tabs.update(false)` erfolgreich → worker stirbt vor nächster reconciliation/bookkeeping;
3. restore `tabs.update({autoDiscardable:true})` erfolgreich → worker stirbt vor journal delete.

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
- #35 `waitStatusFor` live: active workers, running Background Exec, completed-unread threshold und
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

## 7. Definition of done für den gesamten offenen-Issue-Pass

Der Pass ist erst fertig, wenn:

1. unmittelbar vor dem finalen Handoff **`gh issue list --state open` erneut gezogen** wurde und
   jedes **zu diesem finalen Reconcile-Zeitpunkt offene** Issue einen eindeutigen Zustand hat:
   fixed+merged+released, consciously rejected/narrowed, oder mit einem reproduzierbaren
   verbleibenden Blocker; der letzte Audit-Snapshot hatte **15** offene Issues, aber die Zahl ist keine
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
