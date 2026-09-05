# Chat On Steroids — Vollständiger Release-QA-Bericht

## Dokumentstatus

**Release-Empfehlung:** **HOLD**  
**Getestete Git-SHA:** `5709d323e8a2749822c3fb685a77379aca05e784`  
**Build-Typ:** Fix-Build nach vorherigem QA-HOLD  
**Testplattform:** echter Apple-Silicon-Mac / macOS ARM64  
**App-Version:** Chat On Steroids `2.0.2`  
**Installationspfad:** `/Applications/Chat On Steroids.app`  
**Testziel:** ausschließlich Verifikation des tatsächlich installierten Produktions-Builds; keine Quellcodeänderungen, keine Reparaturen während des Tests, kein Mocking, keine Ersatz-Automation anstelle der Chat-On-Steroids-Desktop-Funktionen.

---

# 1. Executive Summary

Der frühere **P1-Crash im `pressKeys`-Pfad** ist auf echter Apple-Silicon-Hardware unter realer Desktop-Nutzung **nicht mehr reproduzierbar**. Der problematische Single-Character-Pfad wurde in Serien belastet, einschließlich Zeichen, deren Auflösung vom aktiven Keyboard-Layout abhängt. Der Chat-On-Steroids-Hostprozess blieb während des gesamten Stresslaufs unter derselben PID aktiv; es entstand **kein neuer macOS-Crashreport**, kein `SIGTRAP`, kein `EXC_BREAKPOINT`, kein Prozessverlust und kein Desktop-Verbindungsabbruch.

Die frühere **P2-Regression für TextEdit `set_value`** ist ebenfalls **behoben**. Ein leerer, sichtbar editierbarer TextEdit-AXTextArea ließ sich nativ mit `set_value` beschreiben. Der gleiche Pfad funktionierte außerdem bei bereits vorhandenem Inhalt und bei vollständigem Ersetzen des Dokumentwertes. Die Safety-Gates blieben dabei fail-closed: explizit deaktivierte Controls wurden weiterhin abgewiesen, und die Sonderbehandlung des fehlenden `AXEnabled` wurde nicht allgemein auf Klicks oder andere mutierende Aktionen ausgeweitet.

Die **Wrong-Window-/Target-Window-Sicherheit** blieb intakt. Stale oder nicht mehr aktive Targets führten zu Fehlern wie `INPUT_TARGET_REQUIRED` bzw. `INPUT_TARGET_LOST`, statt Eingaben in ein anderes Fenster umzuleiten.

Der **Project-Conversation-/Caller-Binding-Fix** für Routen der Form `/g/<project>/c/<conversation-id>` funktionierte in einem echten ChatGPT Project. Ein normaler Projekt-Chat wurde erzeugt, der resultierende Project-Conversation-Pfad war korrekt, und ein anschließender Chat-On-Steroids-Desktop-Tool-Aufruf lief ohne Caller-/Conversation-Binding-Fehler. Wichtig: Dieser Projekt-Chat war **kein Worker-Chat**. Er wurde bewusst im selben Browser-Tab geöffnet. Das Verhalten „Worker-Chats öffnen in neuem Tab“ wurde in diesem Lauf nicht verifiziert, weil der Worker-/Swarm-Test #35 blockiert war.

Der Build ist trotzdem **nicht releasefähig**, weil die frühere **Foreground-Window-Freshness-P2** weiterhin reproduzierbar ist. Insbesondere bei transienten Chrome-Hilfsfenstern bzw. Omnibox-/Link-Preview-Fenstern meldete Desktop mehrfach `No foreground window`, obwohl Chrome sichtbar und tatsächlich die Vordergrund-App war. Dieser Zustand kann legitime Desktop-Aktionen blockieren und ist funktional relevant. Deshalb lautet die Release-Empfehlung **HOLD**.

---

# 2. Testmatrix

| Testbereich | Ergebnis | Schweregrad / Einordnung |
|---|---|---|
| Test 1 — Build / Basic Health | **PASS** | keine neue Startup-/Basic-Health-Regression |
| Test 2 — P1 `pressKeys` Crash Regression | **PASS** | früherer P1 nicht reproduzierbar |
| Test 3 — Target-/Wrong-Window Safety | **PASS** | fail-closed Verhalten erhalten |
| Test 4 — TextEdit `set_value` | **PASS** | früherer P2 behoben |
| Test 5 — Foreground-Window Freshness | **FAIL** | **P2** |
| Test 6 — Project Conversation / Caller Binding | **PASS** | Fix verifiziert; Navigation-Restrisiko bleibt |
| Test 7 — #34 | **BLOCKED** | exakter Partial→Final-Race nicht kontrolliert reproduzierbar |
| Test 7 — #35 | **BLOCKED** | Swarm durch andere Conversation belegt |
| Test 7 — #36 | **PASS** | fertige Exec-Ergebnisse blieben per `session_id` abrufbar |
| Test 8 — General Desktop Regression | **FAIL** | aufgrund der reproduzierbaren Foreground-P2 |

Separat geforderte Statusübersicht:

- **P1 pressKeys crash regression:** PASS
- **TextEdit set_value regression:** PASS
- **foreground-window freshness:** FAIL — P2
- **wrong-window safety:** PASS
- **Project conversation/caller binding:** PASS
- **#34:** BLOCKED
- **#35:** BLOCKED
- **#36:** PASS

---

# 3. Testumgebung

## 3.1 Hardware und Betriebssystem

Die Tests liefen auf echter Apple-Silicon-Hardware, nicht in einer VM und nicht auf Intel/Rosetta.

Beobachtete Systemdaten:

```text
Darwin <hostname> 27.0.0
Darwin Kernel Version 27.0.0
RELEASE_ARM64_T6041
Architecture: arm64
macOS ProductVersion: 27.0
BuildVersion: 26A5421a
Hardware Model aus Crashreport: Mac16,7
System Integrity Protection: enabled
```

Damit wurde genau die für die Regression relevante Plattformklasse getestet: **macOS ARM64 / Apple Silicon**.

## 3.2 Installierte App

Installierte Anwendung:

```text
/Applications/Chat On Steroids.app
Version: 2.0.2
Bundle Identifier: com.chatonsteroids.app
Main executable: /Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids
```

Der relevante Hostprozess lief während des QA-Laufs als:

```text
PID 85890
/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids
```

Wichtige Child-Prozesse umfassten unter anderem GPU-, Network-Service- und Renderer-Helper sowie die Tunnel-Prozesse.

## 3.3 Build-Provenienz / Installationsabgleich

Im Download-Verzeichnis war der SHA-benannte Produktions-DMG vorhanden:

```text
~/Downloads/Chat-On-Steroids-macOS-arm64-5709d323.dmg
```

SHA-256 des DMG:

```text
e025d17d93cd5f58556641229099f1f0ef42c5a89f8dd1676a07a25dfe21f1b3
```

Ein vollständiger Git-SHA war im installierten Bundle nicht als einfacher String auffindbar. Deshalb wurde die installierte App direkt gegen die App im SHA-benannten DMG verglichen.

Folgende kritische Artefakte waren byte-identisch zwischen installierter App und DMG:

```text
app.asar
623b3f58268a23f7fd056f3968b5cd654799073f92411c6701139abc83007003

libcos-desktop.dylib
6fce8f7177d4741f8fd963b02e2160c2ee56271a383f41737dc782ee64f822fb

macos-desktop-addon.node
650b74352725263a9fb9cd2a4ff53190ab4810a670e37bf1f4e4e68083af02b7

rg binary
a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e

tunnel cloudflared
017976ec70051fcffb868dd857fd508d0ab6497d66fdbb498a021f91f898e633

tunnel-client
b1757220cf4722cec9085ee4a908cf0ee4c1a499a33bd99979b9a9c7669e29b1
```

Der tatsächlich installierte Produktions-Build entsprach damit dem im Download vorhandenen `5709d323`-Release-Artefakt für die für diesen Test relevanten Komponenten.

---

# 4. Historische Crash-Baseline

Vor Beginn des neuen QA-Laufs war bereits ein macOS-Problembericht für Chat On Steroids geöffnet. Dieser Bericht stammt **vor** dem aktuellen Testlauf und wurde nicht durch den getesteten Fix-Build während dieser Session neu erzeugt.

Historischer Crash:

```text
Process:             Chat On Steroids [72790]
Identifier:          com.chatonsteroids.app
Version:             2.0.2 (2.0.2)
Code Type:           ARM-64 (Native)
Role:                Foreground
Date/Time:           2026-08-30 20:34:25.5885 +0200
Launch Time:         2026-08-30 20:29:27.4961 +0200
Hardware Model:      Mac16,7
OS Version:          macOS 27.0 (26A5421a)
Triggered by Thread: 37 WorkerThread
Exception Type:      EXC_BREAKPOINT (SIGTRAP)
Termination Reason:  Namespace SIGNAL, Code 5, Trace/BPT trap: 5
```

Der relevante historische Crash-Stack war:

```text
_dispatch_assert_queue_fail
dispatch_assert_queue$V2.cold.1
dispatch_assert_queue
islGetInputSourceListWithAdditions
isValidateInputSourceRef
TSMGetInputSourceProperty
specialized Collection.map<A, B>(_:)
pressKeys(_:targetWindow:)
handle(_:)
response(for:)
cosDesktopHandleJSON(_:)
...
node::worker::Worker::Run()
...
thread_start
```

Der Crash bestätigt exakt die bekannte Altursache: Keyboard-Layout-/Text-Services-Abfragen aus einem Node WorkerThread statt auf dem korrekten Main-Queue-Pfad.

Für den aktuellen QA-Lauf wurde ein Baseline-Marker gesetzt:

```text
2026-08-30 21:55:18 /tmp/cos-release-qa-baseline
```

Nach diesem Zeitpunkt wurde während des gesamten Tests **kein neuer relevanter Chat-On-Steroids-Crashreport** erzeugt.

---

# 5. Test 1 — Build / Basic Health

## Ergebnis: PASS

### 5.1 Startfähigkeit

Die installierte App war gestartet und als normaler Electron-Hostprozess aktiv.

Initiale Haupt-PID:

```text
85890
```

Der Prozess blieb über den gesamten Test erhalten.

### 5.2 Desktop-Tool-Verfügbarkeit

Die echten Chat-On-Steroids-Desktop-Funktionen waren verfügbar und konnten gegen reale macOS-Fenster ausgeführt werden.

Bestätigte Grundfunktionen:

- Fensterauflistung
- aktives Fenster erkennen
- Fenster-spezifische Observation
- UI-/Accessibility-Struktur auslesen
- Screenshots / Frames
- Fokuswechsel
- UIA-basierte Aktionen
- SendInput-basierte Tastaturaktionen
- Native `set_value`-Aktionen

### 5.3 Grundlegende Observe-/Window-/Screen-Funktionalität

Es konnten reale Fenster von Chrome, TextEdit, Finder und Problem Reporter erkannt werden.

Beispiel aus der Fensterauflistung:

```text
426  TextEdit        ... foreground/open ...
357  Problembericht  ... open ...
321  Finder          ... open ...
379  Finder          ... open ...
94   Google Chrome   ... open/foreground ...
```

Screenshots und UI-Controls wurden korrekt geliefert.

### 5.4 Startup-/Basic-Health-Befund

Keine neue offensichtliche Startup-Regression, kein neuer Hostcrash und keine generelle Desktop-Verbindungsstörung beim Start des Testlaufs.

---

# 6. Test 2 — P1 Crash Regression: `pressKeys`

## Ergebnis: PASS

Dies war der wichtigste Release-Test.

## 6.1 Testaufbau

TextEdit wurde mit einem neuen leeren Dokument geöffnet. Das konkrete Fenster wurde beobachtet und als Input-Target verwendet.

Beispiel:

```text
Window: TextEdit
Title: Ohne Titel 3
TextArea id: First Text View
```

Die Eingaben erfolgten ausschließlich über die echten Chat-On-Steroids-Desktop-Funktionen. Es wurde kein AppleScript, kein shell-basierter UI-Ersatz und keine alternative Automation für den zu testenden Desktop-Pfad verwendet.

## 6.2 Funktionaler Keyboard-Mix

Getestet wurden unter anderem:

- einzelne Kleinbuchstaben
- Großbuchstaben über Shift
- unterschiedliche Buchstaben
- Ziffern
- layoutabhängige Sonderzeichen
- kurze Folgen
- Modifier-Chords
- Named Keys
- Cursor-/Pfeiltasten

Tatsächlich beobachtete Eingaben umfassten:

```text
a
B
c
1
9
Shift+1  -> !
Option+L -> @   (deutsches Keyboard-Layout)
d
e
f
Enter
g
Tab
h
Escape
Left / Right / Up / Down
Command+Left
```

Ein Observe des TextEdit-Dokuments bestätigte, dass die Zeichen tatsächlich im vorgesehenen TextEdit-Fenster gelandet waren. Beispielzustand:

```text
aBc19!@def
g	h
```

Damit wurde explizit der Keyboard-Layout-Auflösungspfad berührt, der zuvor in `TSMGetInputSourceProperty` auf dem falschen Thread gecrasht war.

## 6.3 Benennung von Named Keys

Ein Test mit der Benennung `arrowleft` wurde korrekt als unbekannter Key zurückgewiesen:

```text
BAD_KEY: unknown key arrowleft
```

Die unterstützte Key-Bezeichnung `left` funktionierte. Das ist kein Stabilitäts- oder Safety-Fehler, sondern lediglich eine API-Namenskonvention.

## 6.4 Single-Character-Stresstest

Der problematische Pfad wurde mindestens 100-mal separat ausgeführt.

Serien:

| Serie | Zeichen | Anzahl separater `keypress`-Aufrufe | PID danach | neue Crash-Datei |
|---|---:|---:|---:|---|
| 1 | `a` | 20 | 85890 | nein |
| 2 | `b` | 20 | 85890 | nein |
| 3 | `z` | 20 | 85890 | nein |
| 4 | `1` | 20 | 85890 | nein |
| 5 | `-` | 20 | 85890 | nein |

Gesamt: **100 separate Single-Character-Aufrufe** im eigentlichen Belastungsblock, zusätzlich zu den vorherigen funktionalen Einzeleingaben und Modifier-/Named-Key-Tests.

### 6.4.1 Serie 1

Nach 20 Eingaben:

```text
series1_pid
85890 ... /Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids

series1_new_crashes
<leer>
```

Desktop-Verbindung danach weiterhin funktionsfähig; TextEdit korrekt als foreground beobachtet.

### 6.4.2 Serie 2

Nach 40 kumulierten Single-Character-Calls:

```text
series2_pid
85890 ...

series2_new_crashes
<leer>
```

### 6.4.3 Serie 3

Nach 60 kumulierten Calls:

```text
series3_pid
85890 ...

series3_new_crashes
<leer>
```

### 6.4.4 Serie 4

Nach 80 kumulierten Calls:

```text
series4_pid
85890 ...

series4_new_crashes
<leer>
```

### 6.4.5 Fokuswechsel und Serie 5

Zwischen den Serien wurde die Vordergrundsituation verändert: Chrome wurde aktiv fokussiert und anschließend wieder zu TextEdit zurückgewechselt. Danach wurden weitere 20 einzelne `-`-Eingaben ausgeführt.

Nach 100 kumulierten Calls:

```text
series5_pid
85890 ...

series5_new_crashes
<leer>
```

Der beobachtete TextEdit-Inhalt enthielt danach die erwarteten langen Zeichenserien, u. a. die 20er-Blöcke für `a`, `b`, `z`, `1` und `-`.

## 6.5 Stabilitätskriterien

Alle geforderten Kriterien für den früheren P1 waren erfüllt:

- kein `SIGTRAP`
- kein `EXC_BREAKPOINT`
- kein Host-Crash
- kein Prozessverlust
- PID blieb `85890`
- kein Hänger
- keine verlorene Desktop-Verbindung
- keine neue relevante Crash-Datei
- Eingaben landeten im vorgesehenen TextEdit-Fenster

## 6.6 Bewertung

Der frühere P1-Crash ist auf echter ARM64-Hardware unter realer Desktop-Belastung **nicht reproduzierbar**.

**P1 pressKeys crash regression: PASS**

---

# 7. Test 3 — Target-Window / Wrong-Window Safety

## Ergebnis: PASS

Der Crash-Fix darf nicht dazu führen, dass Tastatureingaben in ein anderes Fenster fallen, wenn der ursprüngliche Snapshot oder Target-Zustand veraltet ist.

## 7.1 Testablauf

1. TextEdit war aktiv und wurde frisch beobachtet.
2. Anschließend wurde Chrome in den Vordergrund gebracht.
3. Danach wurde versucht, Eingabe mit nicht mehr gültiger Target-Situation auszuführen.
4. Außerdem wurde ein mutierender Zugriff aus einem stale TextEdit-Kontext versucht.

## 7.2 Fail-Closed bei fehlendem explizitem Input-Target

Ein ungezielter Tastaturaufruf wurde abgewiesen mit:

```text
INPUT_TARGET_REQUIRED: application keyboard input requires targetWindow
```

Es wurde **keine** Eingabe in das zufällig aktive Chrome-Fenster geschickt.

## 7.3 Fail-Closed bei verlorenem Target

Ein weiterer stale-Target-Fall wurde abgewiesen mit:

```text
INPUT_TARGET_LOST: window 454 is no longer the exact active input target; no input was sent
```

Die entscheidende Safety-Eigenschaft ist der letzte Teil: **`no input was sent`**.

## 7.4 Weitere Safety-Gates

Ein Klick auf eine TextArea ohne verlässliches Enabled-Signal wurde weiterhin nicht allgemein permissiv behandelt. Die Sonderbehandlung des TextEdit-`set_value`-Falls hat die allgemeinen Mutations-Gates nicht geöffnet.

## 7.5 Bewertung

Die neue Implementierung ist in den getesteten stale-/wrong-window-Fällen fail-closed. Es wurde keine Eingabe im falschen Fenster beobachtet.

**wrong-window safety: PASS**

---

# 8. Test 4 — P2 Regression: TextEdit `set_value`

## Ergebnis: PASS

## 8.1 Ziel

Der vorherige QA-Lauf hatte auf einem sichtbaren, editierbaren, leeren TextEdit-AXTextArea den Fehler:

```text
UI_ACTION_DISABLED: the referenced accessibility control is disabled
```

obwohl physisches Tippen möglich war.

Der neue Fix soll fehlendes `AXEnabled` für `set_value` nur dann tolerieren, wenn Accessibility den Value tatsächlich als settable meldet.

## 8.2 Bestehender Inhalt → `set_value`

Auf dem bereits mit Keyboard-Stressdaten befüllten TextEdit-Dokument wurde nativ per `set_value` gesetzt:

```text
QA_SET_VALUE_EXISTING_5709d323
```

Ein anschließendes Observe bestätigte exakt:

```text
TextArea "QA_SET_VALUE_EXISTING_5709d323"
```

Damit funktionierte der native Value-Set-Pfad auf einem bereits befüllten Dokument.

## 8.3 Neues leeres Dokument → `set_value`

Es wurde ein neues TextEdit-Dokument erzeugt. Observation:

```text
TextArea "" id="First Text View"
```

Auf genau dieses leere TextArea wurde nativ gesetzt:

```text
QA_SET_VALUE_EMPTY_5709d323
```

Anschließende Observation:

```text
TextArea "QA_SET_VALUE_EMPTY_5709d323" id="First Text View"
```

Das ist die direkte Regression-Reproduktion des früheren P2-Falls. Der frühere Fehler trat nicht mehr auf.

## 8.4 Komplettes Ersetzen vorhandenen Inhalts

Anschließend wurde der gesamte Wert ersetzt durch:

```text
QA_SET_VALUE_REPLACED_5709d323
```

Observation danach:

```text
TextArea "QA_SET_VALUE_REPLACED_5709d323" id="First Text View"
```

## 8.5 Safety-Gate: explizit deaktiviertes Element

Ein explizit deaktiviertes Control wurde weiterhin mit dem erwarteten Fehler abgewiesen:

```text
UI_ACTION_DISABLED: the referenced accessibility control is disabled
```

Damit wurde die Fixlogik nicht pauschal auf alle deaktivierten Controls ausgedehnt.

## 8.6 Safety-Gate: Click-Verhalten

Auch Klicks auf Controls ohne verlässliches Enabled-Signal wurden nicht dadurch generell freigeschaltet. Das neue Verhalten ist auf den Wertsetzungsfall begrenzt.

## 8.7 Bewertung

Alle drei geforderten `set_value`-Varianten funktionierten:

- neues leeres Dokument
- vorhandener Inhalt
- kompletter Inhalt ersetzt

Gleichzeitig blieben negative Safety-Gates streng.

**TextEdit set_value regression: PASS**

---

# 9. Test 5 — Foreground-Window Freshness

## Ergebnis: FAIL — P2

Dies ist der zentrale verbleibende Release-Blocker.

## 9.1 Normaler Fokuswechsel-Stress

Zwischen TextEdit und Chrome wurden mehr als 20 unmittelbare Fokuswechsel ausgeführt.

Typisches Muster:

```text
focus TextEdit
observe -> TextEdit foreground
focus Chrome
observe -> Chrome foreground
focus TextEdit
observe -> TextEdit foreground
...
```

Bei normalen Hauptfenstern funktionierte diese Sequenz in vielen Wiederholungen korrekt. Beobachtete Fokus-Verifikationszeiten lagen typischerweise im Bereich von ca. 11–33 ms.

## 9.2 Reproduktion der alten Regression

Die alte P2 trat weiterhin auf, sobald Chrome transiente Hilfsfenster erzeugte.

### Fall A — Link-/Status-Preview

Nach Navigation zu ChatGPT `/projects` war Chrome sichtbar im Vordergrund. Während eines Hover-/Link-Preview-Zustands lieferte Desktop:

```text
No foreground window, so this is the whole primary monitor.
```

Dies trat **zweimal direkt hintereinander** auf.

`observe windows` zeigte gleichzeitig:

```text
426  TextEdit        open
357  Problembericht  open
321  Finder          open
379  Finder          open
94   Google Chrome   open  Release QA Test
494  Google Chrome   open  Google Chrome window
```

Das zusätzliche Chrome-Hilfsfenster hatte:

```text
window id: 494
bounds: -1,1014 175x22
content: https://chatgpt.com/projects
```

Trotz sichtbar aktivem Chrome-Hauptfenster war kein Fenster als `foreground` markiert.

Nach Wegbewegen des Mauszeigers und Verschwinden dieses transienten Hilfsfensters wurde Chrome wieder korrekt als foreground erkannt.

### Fall B — Chrome Omnibox Popup

Ein zweiter ähnlicher Zustand trat beim Omnibox-Popup auf.

Fensterliste:

```text
96  Google Chrome  open  Google Chrome window
94  Google Chrome  open  ChatGPT - Homelab Development
```

Window `96` war ein transienter Chrome-Popup-Container mit UI:

```text
WebArea "Omnibox Popup"
MenuItem "Google Fragen zu dieser Seite stellen ..."
```

Auch in diesem Zustand meldete Desktop wieder:

```text
No foreground window.
```

## 9.3 Funktionale Auswirkung

Das Problem ist nicht nur eine falsche Statusanzeige. Während dieses Zustands können legitime Aktionen auf das sichtbar aktive Hauptfenster blockiert werden.

Ein expliziter Fokusversuch auf das sichtbare normale Fenster konnte scheitern mit:

```text
FOCUS_FAILED: the requested window could not be activated
```

Die bestehende Wrong-Window-Sicherheit verhindert zwar, dass stattdessen in ein anderes Fenster geschrieben wird; sie führt in diesem Zustand aber zum Blockieren eigentlich legitimer Aktionen.

## 9.4 Minimize-/Restore-Anmerkung

Ein TextEdit-Fenster wurde im Smoke minimiert. Der Versuch, genau dieses minimierte Fenster anschließend über Window-Focus zu reaktivieren, schlug mit `FOCUS_FAILED` fehl.

Da nicht eindeutig geklärt war, ob `focus(window)` laut API ein minimiertes Fenster restaurieren muss oder nur bereits darstellbare Fenster fokussiert, wird dies nicht als separater Defekt hochgestuft. Es bleibt aber ein offener Verhaltenstest.

## 9.5 Bewertung

Die ursprüngliche Foreground-P2 ist weiterhin unter realistischen Chrome-Transient-Window-Situationen reproduzierbar.

**foreground-window freshness: FAIL — P2**

---

# 10. Test 6 — Project Conversation / Caller Binding

## Ergebnis: PASS

## 10.1 Ziel

Der Build enthält einen Fix für ChatGPT-Project-Routen der Form:

```text
/g/<project>/c/<conversation-id>
```

Verifiziert werden sollte:

- Conversation-ID korrekt erkannt
- App-Session / Caller-Binding wird aufgebaut
- normaler Chat-On-Steroids-Tool-Aufruf funktioniert
- kein Fehler aufgrund fehlender Caller-/Conversation-Zuordnung

## 10.2 Reales Project

Es wurde das echte ChatGPT Project geöffnet:

```text
Homelab Development
```

Die Project-Übersicht verwendete zunächst eine Route in der Form:

```text
/g/g-p-6a93d6fe7f008191be6262248831c7d9/project
```

Anschließend wurde **ein normaler neuer Chat innerhalb dieses Projects** erzeugt.

### Klarstellung zum Browser-Tab

Dieser Chat war **kein Worker-Chat**. Er wurde deshalb bewusst im **gleichen bestehenden Chrome-Tab** erzeugt. Das ist kein Testfehler und kein Hinweis auf eine Worker-New-Tab-Regression.

Das erwartete Verhalten „Worker-Chats öffnen in einem neuen Browser-Tab“ wurde in diesem Lauf **nicht geprüft**, da der Worker-/Swarm-Test #35 blockiert war.

## 10.3 Resultierende Project-Conversation-Route

Der neu erzeugte Project-Chat lief auf:

```text
/g/g-p-6a93d6fe7f008191be6262248831c7d9-homelab-development/c/6a948f35-42dc-83eb-9cb0-89c0e9434d27
```

Damit war die relevante `/g/<project>/c/<conversation-id>`-Form real vorhanden.

Conversation-ID:

```text
6a948f35-42dc-83eb-9cb0-89c0e9434d27
```

## 10.4 Tool-Aufruf aus der Project-Conversation

In diesem Projekt-Chat wurde folgende Aufgabe gestellt:

```text
Bitte verwende Chat On Steroids Desktop und führe einen normalen observe-Aufruf ohne Argumente aus. Antworte danach mit PROJECT_ROUTE_QA_OK.
```

Der Project-Chat führte den Desktop-Aufruf erfolgreich aus und antwortete sichtbar mit:

```text
PROJECT_ROUTE_QA_OK
```

## 10.5 Core-Session-Zuordnung

Core fand für die neue Conversation eine eigene aktive Session:

```text
Session: 2026-08-30-80410935
State: active
Recorded: 0 user · 1 tools · 2 events · 0 errors
```

Der aufgezeichnete Tool-Aufruf war:

```text
observe
Arguments: {}
Outcome: ok
```

Es gab **keinen** Fehler wegen fehlender Caller-, Project- oder Conversation-Zuordnung.

## 10.6 Navigation-Restrisiko

Ein längerer Navigate-away/Navigate-back-Zyklus innerhalb derselben Project-Conversation konnte wegen des parallel reproduzierten Foreground-/Chrome-Transient-Window-Problems nicht vollständig deterministisch bis in alle Randfälle belastet werden.

Der zentrale Fix — Erkennung und Tool-Binding einer realen `/g/<project>/c/<conversation-id>`-Route — ist jedoch erfolgreich verifiziert.

**Project conversation/caller binding: PASS**

---

# 11. Test 7 — Regression Smoke #34 / #35 / #36

# 11.1 #34 — Assistant Partial→Final Replacement

## Ergebnis: BLOCKED

Ziel war zu prüfen, dass ein neuer/längerer finaler Assistant-Stand nicht von einem älteren app-eigenen Replacement-Stand verdeckt wird.

Im realen Project-Tool-Turn war das finale Assistant-Ergebnis sichtbar und blieb erhalten. Es wurde kein offensichtliches Zurückfallen auf einen älteren Stand beobachtet.

Der exakte Race-Fall:

1. Assistant-Turn erscheint partiell,
2. danach wird derselbe Turn sichtbar länger/final,
3. ein älterer app-eigener Replacement-State darf den finalen Stand nicht überschreiben,

konnte aber in diesem Lauf nicht kontrolliert erzeugt und in beiden Zwischenzuständen beweissicher festgehalten werden.

Nach Testregel darf ein nicht vollständig ausgeführter Test nicht als PASS gewertet werden.

**#34: BLOCKED**

---

# 11.2 #35 — Wait-/Swarm-Status / Worker-Lifecycle-Projektion

## Ergebnis: BLOCKED

Ziel:

- nur minimale Worker-Lifecycle-Informationen für den aufrufenden Prime sichtbar
- keine fremden Task-/Secret-Details
- normaler eigener Worker-Lifecycle soweit möglich

Ein eigener Swarm-/Worker-Test konnte nicht gestartet werden, weil bereits eine andere ChatGPT-Conversation den einzigen verfügbaren Swarm belegte.

Exakter Fehler:

```text
AGENTS_BUSY: another ChatGPT conversation is already running the one sub-agent swarm this app supports. Nothing about that run is visible from here.
```

Positiv ist die Isolation: Es wurden **keine** fremden Task-Namen, Worker-Inhalte, Secrets oder sonstige Details der anderen Conversation offengelegt.

Der normale eigene Worker-Lifecycle konnte aber nicht gestartet werden. Damit sind insbesondere folgende Punkte **nicht** verifiziert:

- eigener Worker-Start
- Wait-/Status-Projektion während des eigenen Runs
- terminaler Worker-Abschluss
- Worker-Chat-New-Tab-Verhalten

Wichtig für die zuvor gestellte Rückfrage: Der Project-Chat aus Test 6 war kein Worker-Chat. Deshalb sagt dessen Same-Tab-Verhalten nichts über #35 oder das erwartete Öffnen echter Worker-Chats in einem neuen Tab aus.

**#35: BLOCKED**

---

# 11.3 #36 — Exec-Ergebnisse / `session_id`-Retention

## Ergebnis: PASS

Ziel:

- ein zurückgegebener `session_id` steht für noch nicht terminal abgerufene Arbeit
- das Resultat muss über dieselbe `session_id` weiter abrufbar bleiben
- fertige Ergebnisse dürfen nicht verschwinden, bevor sie gelesen wurden

## 11.3.1 Mehrere asynchrone Runs

Es wurden mehrere asynchrone Exec-Läufe erzeugt, die zunächst nur eine `session_id` zurückgaben:

```text
session_id: 2495
session_id: 69261
session_id: 48586
```

Nach einer Pause wurden die gleichen Session-IDs erneut abgefragt.

Terminale Ergebnisse:

```text
QA36_RESULT_A
QA36_RESULT_B
QA36_RESULT_C
```

Alle Resultate waren noch vorhanden und vollständig abrufbar.

## 11.3.2 Zusätzlicher Lauf

Ein weiterer asynchroner Run:

```text
session_id: 82798
```

wurde nach Abschluss über dieselbe ID ausgelesen und lieferte:

```text
QA36_RESULT_D
```

## 11.3.3 Nicht vollständig getesteter Randfall

Der explizite Extremfall „sehr viele ungelesene terminale Resultate bis zur internen Kapazitäts-/Backpressure-Grenze“ wurde nicht bis zur maximalen Grenze provoziert.

Damit ist Retention für mehrere reale parallele/unread Results verifiziert, nicht aber jede theoretische Overflow-Grenze.

**#36: PASS**

---

# 12. Test 8 — General Desktop Regression

## Ergebnis: FAIL

Der allgemeine Desktop-Smoke deckte folgende Funktionen erfolgreich ab:

- Displays / Screen-Capture
- Window-Auflistung
- Observe
- UI-/Accessibility-Struktur
- Klick auf eindeutig aktiviertes Element
- `set_value`
- gezieltes `pressKeys`
- Screenshots
- Fensterwechsel
- erneute Observation nach Mutation
- mehrere Observe → Act → Observe-Sequenzen
- stale target / wrong-window fail-closed
- Prozess-/Crash-Kontrolle während mutierender Aktionen

Es wurden **keine** neuen nativen Helper-/Addon-Crashes, keine Desktop-Verbindungsabbrüche und keine falschen Eingaben in nicht autorisierte Fenster beobachtet.

Der Bereich erhält dennoch **FAIL**, weil die reproduzierbare Foreground-Window-P2 ein Kernbestandteil der Desktop-Funktionalität ist und legitime Aktionen blockieren kann.

---

# 13. Prozess- und Crash-Bilanz am Testende

Am Ende des Tests:

```text
=== final host process ===
85890 ... /Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids
```

Die Host-PID war weiterhin dieselbe wie zu Testbeginn.

Neue Crashreports seit Baseline:

```text
=== crashes since baseline ===
<leer>
```

Der einzige gefundene relevante Crashreport war der alte Bericht:

```text
~/Library/Logs/DiagnosticReports/Retired/Chat On Steroids-2026-08-30-203427.ips
```

Dieser lag zeitlich vor dem QA-Baseline-Marker und war damit kein Crash des getesteten aktuellen Runs.

---

# 14. Gefundene Fehler / Defects

## DEFECT-1 — Foreground window kann bei transienten Chrome-Hilfsfenstern verloren gehen

**Schweregrad:** P2  
**Status:** reproduzierbar im getesteten Build  
**Release-Relevanz:** HOLD

### Beschreibung

Desktop meldet `No foreground window`, obwohl sichtbar ein normales Chrome-Hauptfenster aktiv ist. Der Fehler tritt insbesondere auf, wenn Chrome ein transienteres eigenes Hilfsfenster erzeugt, z. B. Link-Preview/Status oder Omnibox-Popup.

### Reproduktion A

1. Chrome-Hauptfenster mit ChatGPT aktivieren.
2. Zu `/projects` navigieren.
3. Maus über einen Link bewegen, sodass ein Chrome-Preview-/Status-Hilfsfenster erscheint.
4. Unmittelbar Desktop `observe` ausführen.
5. Wiederholen.

### Ist-Verhalten

```text
No foreground window, so this is the whole primary monitor.
```

bzw.

```text
Desktop 1728x1117
No foreground window.
```

Fensterliste zeigt jedoch weiterhin das normale Chrome-Hauptfenster und zusätzlich ein kleines Chrome-Hilfsfenster.

### Reproduktion B

1. Chrome-Hauptfenster aktiv.
2. Omnibox-/Chrome-Popup öffnen.
3. Desktop-Observe oder Window-Status abfragen.

### Ist-Verhalten

Kein Fenster als foreground erkannt, obwohl Chrome sichtbar aktiv ist.

### Zusätzliche Auswirkung

Ein expliziter Fokusversuch auf das sichtbare Hauptfenster kann in diesem Zustand scheitern:

```text
FOCUS_FAILED: the requested window could not be activated
```

### Erwartetes Verhalten

Das normale aktive Chrome-Hauptfenster muss weiterhin als foreground/input target erkannt werden, oder der transiente Chrome-Container muss so aufgelöst werden, dass die zugehörige normale App-/Main-Window-Zuordnung erhalten bleibt.

### Sicherheitsbewertung

Positiv: Das System failt geschlossen und schreibt nicht automatisch in ein anderes Fenster.

Negativ: Die Freshness-/Target-Erkennung ist funktional falsch und blockiert legitime Desktop-Aktionen.

---

# 15. Behobene Altfehler

## 15.1 Früherer P1 — `pressKeys` WorkerThread/Main-Queue-Crash

**Vorher:** reproduzierbarer `EXC_BREAKPOINT (SIGTRAP)` über `TSMGetInputSourceProperty` auf `WorkerThread`.

**Jetzt:** nach >100 separaten Single-Key-Aufrufen plus weiteren Modifier-/Layout-/Named-Key-Tests kein Crash, PID konstant, keine neue Crashdatei.

**Status:** behoben / PASS.

## 15.2 Früherer P2 — TextEdit leeres TextArea `set_value`

**Vorher:**

```text
UI_ACTION_DISABLED: the referenced accessibility control is disabled
```

auf leerer sichtbarer TextEdit-TextArea trotz physisch möglicher Eingabe.

**Jetzt:** natives `set_value` funktioniert auf leerem TextArea, bei bestehendem Inhalt und beim kompletten Ersetzen.

**Status:** behoben / PASS.

## 15.3 Project-Conversation-Route

**Vorheriges Risiko:** `/g/<project>/c/<conversation-id>` wurde nicht zuverlässig als Conversation-/Caller-Kontext erkannt.

**Jetzt:** reale Project-Conversation wurde erkannt; normaler Desktop-Tool-Aufruf lief in eigener aktiver Core-Session ohne Binding-Fehler.

**Status:** behoben / PASS für den getesteten Hauptpfad.

---

# 16. Nicht als Fehler gewertete Beobachtungen

## 16.1 Project-Chat im selben Browser-Tab

Der in Test 6 erzeugte Chat war ein **normaler Chat innerhalb eines ChatGPT Projects**, kein Worker-Chat.

Er wurde bewusst im bestehenden Tab geöffnet, weil der Test die Project-Conversation-Route und das Caller-Binding prüfen sollte.

Daraus folgt **keine** Aussage über das erwartete Worker-Verhalten.

Das bekannte/erwartete Produktverhalten „Worker-Chats öffnen in einem neuen Tab“ wurde nicht getestet, weil #35 nicht gestartet werden konnte.

## 16.2 `arrowleft` vs. `left`

`arrowleft` wurde als unbekannter Key abgewiesen, `left` funktionierte. Solange die API-Dokumentation `left` als gültige Benennung vorsieht, ist das kein Defekt.

## 16.3 Minimized Window Restore

Ein minimiertes TextEdit-Fenster ließ sich über den getesteten Window-Focus-Pfad nicht eindeutig restaurieren. Mangels klarer API-Erwartung wurde dies nicht separat als P2 gewertet.

---

# 17. Offene Risiken

1. **P2 Foreground-Freshness bleibt offen.** Transiente Chrome-Hilfsfenster können den Desktop-Zustand in `No foreground window` kippen.
2. **Worker-New-Tab-Verhalten ungetestet.** #35 war blockiert; daher ist nicht verifiziert, dass echte Worker-Chats weiterhin in einem neuen Tab geöffnet werden.
3. **#34 exakter Replacement-Race ungetestet.** Ein normaler finaler Assistant-Stand funktionierte, aber der partielle→finale Race konnte nicht deterministisch eingefangen werden.
4. **#35 eigener Worker-Lifecycle ungetestet.** Isolation gegen fremde Swarms wirkte korrekt, aber eigener Start/Wait/Finish konnte nicht ausgeführt werden.
5. **#36 extreme unread-result backpressure nicht bis Kapazitätsgrenze getestet.** Mehrere reale Resultate blieben korrekt erhalten.
6. **Project-Navigation-Randfälle nicht maximal belastet.** Der Kernpfad `/g/<project>/c/<conversation-id>` ist verifiziert, aber lange Navigate-away/back-Sequenzen wurden durch die Foreground-Regression erschwert.
7. **Minimize/restore-Verhalten über Window-Focus nicht abschließend spezifiziert/verifiziert.**

---

# 18. Priorisierung

## P0

Keine P0-Regression gefunden.

## P1

Der frühere `pressKeys`-Crash ist im getesteten Build nicht mehr reproduzierbar. Keine neue P1-Sicherheits- oder Stabilitätsregression gefunden.

## P2

Offen und reproduzierbar:

- Foreground-Window-Freshness / `No foreground window` bei transienten Chrome-Fenstern.

Behoben:

- TextEdit leeres TextArea `set_value`.

## P3 / sonstige Risiken

- unklare Restore-Semantik minimierter Fenster
- einzelne API-Key-Namenskonventionen
- nicht vollständig abgedeckte Race-/Capacity-Randfälle (#34/#36)

---

# 19. Release-Entscheidung

Die wichtigste Bedingung aus dem vorherigen QA-HOLD ist erfüllt: Der frühere P1 im `pressKeys`-Pfad ist auf echter macOS-ARM64-Hardware unter realer Belastung nicht mehr reproduzierbar. Der Hostprozess überlebte den gesamten Test unter derselben PID, und es entstand kein neuer Crashreport.

Auch der TextEdit-`set_value`-Fix und der Project-Conversation-/Caller-Binding-Hauptpfad funktionieren.

Trotzdem ist der Build nicht release-ready, weil die bekannte Foreground-Window-P2 weiterhin real und reproduzierbar ist. Die Regression kann legitime Desktop-Aktionen blockieren und betrifft einen zentralen Bestandteil des Desktop-Targetings. Ein Fix-Build nach vorherigem QA-HOLD sollte mit einer reproduzierbaren bekannten P2 in diesem Kernbereich nicht als sauberer Release-Candidate durchgewunken werden.

# HOLD
