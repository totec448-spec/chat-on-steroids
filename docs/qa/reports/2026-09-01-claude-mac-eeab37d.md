# macOS-Verifikation, sechs Teile — Lauf gegen `eeab37d`

**Datum:** 2026-09-01
**Zweig:** `integrate/browser-and-desktop-064733`
**Repository-Stand:** `b22a086` (= `eeab37d` plus ein Commit, der verlorene Berichte wiederherstellt)
**Installierte App:** `2.0.2+b502298` — zwei Commits hinter der Spitze; beide ändern nur `docs/`
**Maschine:** macOS 27.0.0, arm64, ein Bildschirm 1728×1117 mit Skalierung 2, Node 22.23.2
**Rechte:** Screen Recording und Accessibility auf `Terminal.app`, beide erteilt

---

## Kurzfassung

**Alles Gestellte besteht.** `verify:ci` grün im Erstlauf, `verify:browser --headed` jetzt
**40/40** ohne FAIL und ohne SKIP, der Probe erreicht sein Urteil auf 34 Fenstern, Zeigerfeld und
Bild stimmen, alle vier Eingabezäune lehnen namentlich ab, der Zug bei zwei deckungsgleichen
Finder-Fenstern geht im ersten Anlauf durch.

**Der `snapshot`-Fund der letzten Runde ist behoben** — nachgeprüft, weil es frei war: ein
mehrdeutiges Fenster antwortet jetzt `ok: true` mit Bild `1080×760` und typisiertem
`uiUnavailable: {"code":"UIA_AMBIGUOUS_WINDOW", …}`. Vorher kam gar nichts.

**Die offene Frage aus 3c ist beantwortet, und die Antwort ist eine Zahl.** Zehn Scroll-Aufrufe
hintereinander brauchen **2495 ms**, im Median **234 ms** je Aufruf. Das ist spürbar. Und die
120-ms-Nachlaufzeit ist dabei rund fünfmal so lang wie nötig: **die Scrollposition steht nach
etwa 25 ms.** Gemessen mit einem eigenen Werkzeug, das nach dem Rad-Ereignis alle 10 ms abliest —
erste sichtbare Änderung nach 20,9 / 23,6 / 25,6 ms, und der Endwert stand in allen drei
Durchgängen schon beim ersten Messpunkt.

**Und eine Warnung, die nichts mit der App zu tun hat:** beim Start dieser Runde fehlten **sieben**
meiner Berichte im Zweig. Nicht nur ungesichert — aus der Historie verschwunden. Ich habe sie aus
dem Reflog wiederhergestellt und committet. Näheres unten.

---

## Teil 0 — Rechte

```json
{"op":"warm"}
{"accessibilityPermission":true,"ready":true,"screenPermission":true,"ok":true}
```

Beide erteilt, an `Terminal.app`. Kein Teil unten ist deshalb unmessbar.

---

## Teil 1 — `npm run verify:ci`

**Grün beim ersten Lauf** — sechste Runde in Folge.

```
 Test Files  73 passed | 3 skipped (76)
      Tests  1864 passed | 97 skipped (1961)

 Test Files  1 passed (1)
      Tests  2 passed (2)

ECHTER EXIT=0
```

---

## Teil 2a — `npm run verify:browser -- --headed`

```
40/40 checks passed
ECHTER EXIT=0
```

**Kein FAIL. Kein SKIP** — gezählt: `grep -cE "^(FAIL|SKIP)"` ergibt 0. Drei Prüfpunkte mehr als
im letzten Lauf.

- **„a positive scroll_y moves the page down": bestanden**, `before=0 after=300`.
- **„the page sees a trusted wheel event going down": bestanden**, mit
  `wheel deltaY=0.018157958984375 trusted=true`.
- **Keine SKIP-Zeile.**
- **„a screenshot of a scrolled page shows where the page is": bestanden** —
  `scrollTop=1200, band expected at row 350, found rgb(40,95,246)`.
- `one screenshot pixel is one CSS pixel — {"png":{"w":1200,"h":817},"reported":{"w":1200,"h":817},"viewport":{…,"ratio":2}}`

Zum `deltaY`: 0,018 ist der kleinste Wert, den ich in dieser Reihe gesehen habe (vorher 6,3 / 6,5 /
6,7 / 292). Er ist trotzdem richtig — `wheellog` behält nur das letzte Ereignis der Geste, und das
ist ihr Ausklingen. Die Prüfung verlangt `trusted=true` und eine Ziffer ungleich null; `0.018…`
erfüllt das über die 1 an der ersten signifikanten Stelle. Wer daraus eine Erwartung baut, baut auf
Sand — die Spanne über sechs Läufe ist mehr als vier Größenordnungen.

---

## Teil 2b — `node scripts/probe-macos-helper.mjs arm64`

**Auf dem belebten Schreibtisch gelaufen:** 33 Fenster vor dem Start, keines minimiert — davon
neunzehn Finder-Fenster, Chrome, zwei Safari, zwei UTM, Spark, Step Two, vier Terminals.

10 von 10, `ECHTER EXIT=0`:

```
ok    it lists windows to capture — ok
      34 windows listed, 34 not minimized
      window 3188 "cos-probe-window.txt" at 214,112 656x422
ok    it captures the window again — ok
      second capture pointer=outside_region
      image 640x412, 347 pixels differ, box {"x":8,"y":9,"width":316,"height":207}
      pointer was expected near 320,206
      99 changed within 32px of the pointer, 248 elsewhere (density 0.0234 vs 0.0010)
      PIXELS CONFIRM the pointer is drawn, at the position it was moved to
```

Er nimmt sein eigenes Fenster aus 34, und die Dichte trägt das Urteil. **99 Pixel auf der
Zeigerfläche — zum vierten Lauf in Folge derselbe Wert.**

**Was sich gegenüber der Ankündigung des Skripts verhält statt sich zu verweigern:** die
Bildschirmaufnahme (`pointer=system`) und die Fensteraufnahme mit handkompositiertem Zeiger
(`pointer=drawn`). Und das Aufräumen hält: kein `-128`, kein zurückgelassenes Fenster.

---

## Teil 2c — Der Zeiger, im Bild

TextEdit-Dokumentfenster, id 3193, bei 214,112, 656×422.

**Fall 1 — Zeiger in der Fenstermitte (542,323):** `POINTER-FELD: "drawn"`

**Das Bild:** ein Zeiger ist sichtbar — **kein Pfeil, sondern ein I-Balken**, der Textcursor über
einem Textbereich. Erwartet bei (320,0 / 205,8); dort sitzt er.

**Fall 2 — Zeiger außerhalb (1070,152):** `POINTER-FELD: "outside_region"`

**Das Bild:** kein Zeiger, an keiner Stelle.

```
A 640x412 ch4 | B 640x412 ch4
abweichende Pixel: 324
Bounding-Box: x 9..323  y 9..215
inside  PNG-Kopf: 640 x 412
outside PNG-Kopf: 640 x 412
```

**Feld und Bild stimmen überein, in beiden Fällen.** Achter Lauf in Folge.

---

## Teil 3a — Fokus, bestätigt

```
--- 2. op:focus id=3049 ---   {"ok":true,"foreground":3049,"focused":true}
--- 3. act/focus auf 3049 ---  {"foreground":3049,"ok":true,"completed_count":1,"routes":["focus"]}
--- 4. Cmd+L ---               {"ok":true,"foreground":3049,"completed_count":2,"routes":["focus","sendinput"]}
--- 5. Chrome-Fenster ---
    {"id":3051,"width":1402,"height":136,"process":"Google Chrome","state":"open","title":"Google Chrome window","y":59,"x":100}
    {"state":"foreground","id":3049,"process":"Google Chrome","width":1728,"height":1002,"y":33,"title":"Example Domain","x":0}
--- 6. act/focus auf den Container 3051 ---
{"message":"the requested window could not be activated: another window of the same application is in front (window 3049)","error_code":"FOCUS_FAILED","ok":false,"completed_count":0,"scroll":null}
--- 6b. op:focus id=3051 ---   {"ok":true,"focused":false,"foreground":3049}
--- 7. Escape ---              {"completed_count":2,"routes":["focus","sendinput"],"foreground":3049,"ok":true}
```

**Die abweisende Klausel, wörtlich:**

> `the requested window could not be activated: another window of the same application is in front (window 3049)`

Fenster 3049 ist das Hauptfenster und steht in `{"op":"windows"}`. Der Container maß hier
**1402×136** — das Elternfenster war wieder 1728 breit. Die Formulierung „so breit wie sein
Elternfenster" trifft es; die feste Zahl 1402 wäre wieder falsch gewesen.

**`find_ui` unter `id` — der eigene Baum:** `ok=true`, 12 Elemente, Maße `1402x136, 1370x92,
1360x34, 1370x50, 1370x40, 1354x40, 920x0` — alles Maße des Containers.
**`UIA_NO_OWN_WINDOW` ist nicht aufgetreten.**

**Der falsche Schlüssel wird auf allen vier Operationen abgelehnt** — `find_ui`, `focus`, `capture`,
`snapshot`, jedes Mal `BAD_REQUEST`.

**`focusable` auf denselben beiden:** Container `false`, Hauptfenster `true`.

---

## Teil 3b — Kurz, weil unverändert bestanden

- **`focusable`**, 37 Fenster: Aufschlag im Median **105,8 ms** (33,1 → 138,9 ms). Die einfache
  Form trägt das Feld nicht — geprüft. Vierter Punkt auf derselben Kurve: 60 ms bei 28 Fenstern,
  109 bei 35, 128 bei 41, 106 bei 37. Er folgt der Listenlänge.
- **Der Zug bei zwei deckungsgleichen Finder-Fenstern** (`cos-a-r13` / `cos-b-r13`, beide 800×550
  bei 300,200): **erster Anlauf, Datei bewegt, fünf Punkte im Pfad.**
- **`focusableUnknown`**: die verbliebenen drei nicht auflösbaren Fenster lesen alle `ambiguous`,
  und die Ablehnung nennt vier Kandidaten mit Titel, Maßen und Position. `unavailable` kam in
  diesem Lauf nicht vor — das Fenster, an dem es letzte Runde zu sehen war, ein
  TextEdit-Sicherungsdialog, existiert nicht mehr.

---

## Teil 3c — Die beiden neuen Punkte

### `snapshot` behält sein Bild — bestätigt

```
{"op":"find_ui","id":2986,"query":""}
{"error_code":"UIA_AMBIGUOUS_WINDOW","ok":false,"message":"window 2986 cannot be told apart from another window of the same application: …"}

{"op":"snapshot","id":2986,"includeScreenshot":true,"includeUi":true}
   ok=true | error_code=undefined
   image={"height":760,"width":1080}
   uiUnavailable={"code":"UIA_AMBIGUOUS_WINDOW","message":"window 2986 cannot be told apart from …"}
```

Genau die Form, die letzte Runde fehlte: Bild **und** typisierte Begründung. Der Rat „move or close
one of them" ist damit befolgbar, weil man sieht, worum es geht.

### Der Scroll berichtet, was ihm widerfahren ist

Zehn Aufrufe hintereinander auf ein langes TextEdit-Dokument (800 Zeilen), Zeiger im Textbereich:

```
   1    385.1 ms  ok=true  reachedTarget=true moved=true  0->0.1197            hitRole="AXTextArea" hitPid=57292 targetPid=57292
   2    261.9 ms  ok=true  reachedTarget=true moved=true  0.1197->0.2393       …
   3    227.0 ms  ok=true  reachedTarget=true moved=true  0.2393->0.3590       …
   4    216.2 ms  ok=true  reachedTarget=true moved=true  0.3590->0.4786       …
   5    233.8 ms  ok=true  reachedTarget=true moved=true  0.4786->0.5983       …
   6    251.9 ms  ok=true  reachedTarget=true moved=true  0.5983->0.7179       …
   7    216.3 ms  ok=true  reachedTarget=true moved=true  0.7179->0.8376       …
   8    224.5 ms  ok=true  reachedTarget=true moved=true  0.8376->0.9572       …
   9    231.0 ms  ok=true  reachedTarget=true moved=true  0.9572->1            …
  10    247.7 ms  ok=true  reachedTarget=true moved=false 1->1                 …
```

**Die Belege sind echt und sie setzen sich zusammen:** jeder Schritt trägt 0,11965, das Endergebnis
ist auf sechs Stellen die Summe. Und der zehnte Aufruf ist genau der Fall, für den das Feld gebaut
wurde — das Dokument ist am Ende, das Rad-Ereignis geht raus, nichts bewegt sich, und die Antwort
sagt `moved: false` statt „Done".

**Ein mis-adressierter Scroll wird vom Zaun abgefangen, bevor ein Rad entsteht:**

```
{"op":"act","targetWindow":3199,"actions":[{"type":"scroll","x":571,"y":352,"scroll_y":120}]}
{"error_code":"INPUT_TARGET_LOST","message":"window 3199 is no longer the exact active input target (another window of the same application is in front (window 3193)); no input was sent","scroll":null,"ok":false}
```

Bestätigt, was das Dokument schreibt: `reachedTarget` ist in der Praxis fast immer `true`, weil der
Zaun vorher greift. `moved` ist die Hälfte, die die Antwort trägt.

### Die Kosten — die Frage, die offen war

**Zehn Scroll-Aufrufe: 2495 ms zusammen, Median 234 ms je Aufruf.** Zum Vergleich, gemessen am
selben Helferprozess und am selben Punkt:

```
move         median     2.5 ms   min 2.3    max 24.0
click        median   139.0 ms   min 127.7  max 396.6
scroll       median   206.1 ms   min 190.5  max 227.3
```

(206 ms ohne die vorangehende `focus`-Aktion; die 234 ms oben enthalten sie.)

**Ist es spürbar? Ja.** Wer zehnmal scrollt, wartet zweieinhalb Sekunden. Ein Modell, das sich
durch eine Seite arbeitet, macht das ständig.

**Und die 120 ms sind rund fünfmal so lang wie nötig.** Ich habe gemessen, wie lange das Scrollen
tatsächlich braucht, bis die Position steht: ein eigenes Werkzeug postet dasselbe Rad-Ereignis und
liest danach alle 10 ms dieselbe Kennzahl, die der Helfer liest (`AXVerticalScrollBar` → `AXValue`).
Drei Durchgänge:

```
Durchgang 1:  Start 0.601157 -> 0.641041   erste Aenderung nach 25.6 ms, Endwert steht ab 48.8 ms
Durchgang 2:  Start 0.641041 -> 0.680925   erste Aenderung nach 23.6 ms, Endwert steht ab 35.3 ms
Durchgang 3:  Start 0.680925 -> 0.720810   erste Aenderung nach 20.9 ms, Endwert steht ab 39.0 ms
```

In allen drei Durchgängen zeigte **schon der erste Messpunkt den Endwert** — „steht ab" ist nur
der zweite gleiche Messwert. Die Bewegung ist also nach etwa **21 bis 26 ms** abgeschlossen.

**Mein Vorschlag, gegen diese Zahl statt gegen ein Gefühl:** 50 ms gäbe rund das Doppelte der
gemessenen Zeit als Reserve und nähme den zehn Aufrufen etwa 700 ms ab. Wer sicherer gehen will,
nimmt statt einer festen Wartezeit eine Schleife: alle 10 ms lesen, abbrechen sobald zwei
aufeinanderfolgende Messwerte gleich sind, mit 120 ms als Obergrenze. Das kostet im Normalfall
30–40 ms und im schlechtesten nicht mehr als heute.

**Die Einschränkung dazu, ausdrücklich:** gemessen an TextEdit, dessen Textbereich ohne Animation
springt. Eine Anwendung mit weichem oder nachlaufendem Scrollen — ein Browser, eine Karte — kann
länger brauchen. Die 25 ms sind eine Untergrenze für diesen Fall, keine allgemeine Aussage. Wer die
Wartezeit fest kürzt, sollte dieselbe Messung einmal gegen einen animierenden Scroller wiederholen;
die Schleife oben wäre gegen beides unempfindlich.

---

## Teil 4 — Eingabe, unterhalb der App

### 4a — Ein Ziehen, das etwas bewegt

Zwei Finder-Fenster gleicher Größe an gleicher Position, verschiedene Titel. Symbolpositionen über
`{"op":"find_ui","id":3203,…}` bestimmt, nicht geschätzt.

```
vorher:  ziehmich.txt ZielOrdner  | Ziel: (leer)
{"cursor":{"x":981,"y":572},"routes":["focus","sendinput"],"foreground":3203,"completed_count":2,"ok":true}
nachher: ZielOrdner               | Ziel: ziehmich.txt
```

**Erster Anlauf, Datei bewegt, fünf Punkte im Pfad.**

### 4b — Tippen, wo es hingezielt war

```
00000000: 5275 6e64 6520 3133 20e2 8094 2055 6d6c  Runde 13 ... Uml
00000010: 6175 7465 3a20 c3a4 20c3 b620 c3bc 20c3  aute: .. .. .. .
00000020: 9f0a 5a77 6569 7465 205a 6569 6c65 206e  ..Zweite Zeile n
00000030: 6163 6820 556d 6272 7563 68              ach Umbruch
```

Zeichengenau, inklusive `0a` für den Umbruch, der UTF-8-Umlaute und des Geviertstrichs `e28094`.

### 4c — Der Eingabezaun

Mit TextEdit-Fenster 3193 im Vordergrund, **vier Formen geprüft**:

```
--- targetWindow=3203 (Finder), Text ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"message":"window 3203 is no longer the exact active input target (another application is frontmost); no input was sent"}

--- targetWindow=3199 (anderes TextEdit-Fenster), Text ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"message":"window 3199 is no longer the exact active input target (another window of the same application is in front (window 3193)); no input was sent"}

--- targetWindow=3199, Tastendruck ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"message":"… (another window of the same application is in front (window 3193)); no input was sent"}

--- targetWindow=3199, Scroll ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"scroll":null,"message":"… (another window of the same application is in front (window 3193)); no input was sent"}

--- Klick bei 5,5, geleast auf 3193 ---
{"error_code":"OUTSIDE_TARGET_WINDOW","ok":false,"completed_count":0,"message":"click at 5,5 is outside window 3193, which this batch is leased to (214,112 656x422). No input was sent. …"}
```

**Alle fünf lehnen namentlich ab, und es wurde nichts getippt und nichts gescrollt.**

---

## Teil 5 — Die installierte App

### 5a — Bauidentität

```
$ curl -s http://127.0.0.1:8765/hello
{"app":"chat-on-steroids","version":"2.0.2","build":"2.0.2+b502298","bridge":8,"compatible":false,"spoken":null,"paired":true,"disconnected":false}
```

**`build` lautet `2.0.2+b502298`** — ein Paketstand, kein `2.0.2-dev`.

```json
{"y":183,"process":"Chat On Steroids","x":324,"width":1080,"height":700,"state":"open","id":2996,"title":"Chat On Steroids 2.0.2+b502298"}
```

**Der Titel trägt dieselbe Zeichenkette.** Achter Lauf in Folge.

`git rev-parse --short HEAD` sagt `b22a086`. Die App steht auf `b502298`, zwei Commits hinter der
Spitze `eeab37d` — und `git diff --name-only eeab37d..HEAD` wie auch der Vergleich `b502298..eeab37d`
liefern ausschließlich `docs/`. Der gesamte Code der Spitze läuft in der App.

### 5b — Die Erweiterung, die Chrome geladen hat

**Derselbe Ordner** (`~/Library/Application Support/chat-on-steroids/extension`, Realpfad
identisch, kein Symlink), **alle zehn Dateien byte-identisch** mit dieser Kasse.

### 5c — Das Manifest

```
permissions          = ["storage", "scripting", "alarms", "debugger"]
optional_permissions = ["tabs", "tabGroups"]
```

**`debugger` steht in `permissions`.**

---

## Teil 6 — Die gestellten Fragen, kurz beantwortet

| Frage | Antwort |
|---|---|
| Screen Recording und Accessibility erteilt? | Ja, beide, an `Terminal.app` |
| `verify:ci` | **Grün beim ersten Lauf**: 1864 passed / 97 skipped (1961), EXIT 0 |
| `verify:browser --headed` | **40/40**, EXIT 0, kein FAIL, kein SKIP |
| Scroll-Richtung | **Beurteilt und bestanden**, `before=0 after=300` |
| Scroll-Screenshot | **Bestanden**: `scrollTop=1200, band expected at row 350, found rgb(40,95,246)` |
| Probe auf belebtem Schreibtisch | **Erreicht sein Urteil** aus 34 Fenstern, 99 Pixel im Zeiger |
| Zeiger: Antwortfeld | `"drawn"` innen, `"outside_region"` außen |
| Zeiger: Bild | I-Balken bei ~320/205, erwartet 320,0/205,8. Außen kein Zeiger. **Beide stimmen überein** |
| Fokus-Klausel | `another window of the same application is in front (window 3049)` |
| `snapshot` bei Mehrdeutigkeit | **Behoben**: `ok:true`, Bild 1080×760, `uiUnavailable` typisiert |
| Scroll-Belege | **Echt und zusammensetzbar**; zehnter Aufruf meldet korrekt `moved:false` am Dokumentende |
| Kosten des Scrolls | **234 ms Median, 2495 ms für zehn — spürbar.** Nötig wären ~25 ms |
| Ziehen | **Ja**, fünf Wegpunkte, erster Anlauf, bei zwei deckungsgleichen Fenstern |
| Eingabezaun | **Ja**, alle fünf Ablehnungen namentlich, auch für Scroll |
| Erweiterung = diese Kasse? | **Ja**, alle zehn Dateien byte-identisch, derselbe Ordner |

---

## Was sonst auffiel

**Sieben meiner Berichte waren aus dem Zweig verschwunden.** Beim Start dieser Runde kannte `HEAD`
nur noch drei der zehn Berichte; die Commits, die `cff7282`, `e2364ad`, `719688a`, `68dbff7`,
`2a80994`, `b77021e` und `add2b1c` hinzugefügt hatten, waren nicht mehr in der Historie. Zwei
weitere lagen in Stashes, die ein `git pull --rebase` mit Autostash angelegt und nicht
zurückgeholt hatte. Ich habe alle sieben über das Reflog gefunden und in einem Commit
wiederhergestellt; der Zweig trägt jetzt wieder alle zehn. **Wer auf diesem Zweig mit `--rebase`
zieht, während hier ein vorgemerkter Stand liegt, verliert ihn stillschweigend** — das ist zweimal
hintereinander passiert und beim zweiten Mal hat es fertige Commits getroffen, nicht nur die
Vormerkung.

**Die 120 ms Nachlaufzeit sind der teuerste Einzelposten am Scroll und der am leichtesten zu
kürzende.** Die Zahlen stehen oben; die Schleifenvariante wäre gegen animierende Scroller
unempfindlich, gegen die ich nicht gemessen habe.

**`click` kostet 139 ms.** Das ist mir bei der Zerlegung aufgefallen, ohne dass ich es gesucht
hätte: ein `move` kostet 2,5 ms, ein `click` das Fünfundfünfzigfache. Der Unterschied Scroll gegen
Klick beträgt nur 67 ms, obwohl allein die Scroll-Nachlaufzeit 120 ms ist — der Klickpfad zahlt
also selbst rund 50 ms, die der Scrollpfad nicht zahlt. Ich habe dem nicht nachgespürt; es ist eine
Beobachtung aus zehn Messungen, kein Befund.

**Das `scroll`-Feld erscheint auch dort, wo nie gescrollt wurde.** Eine `FOCUS_FAILED`-Antwort auf
`{"type":"focus"}` trägt `"scroll":null`, ebenso jede abgelehnte Tastatureingabe. Das ist harmlos,
aber es macht jede Antwort um ein Feld breiter, das für sie bedeutungslos ist.

**Die Spanne des gemeldeten `deltaY` über sechs Läufe ist 0,018 bis 292.** Beides ist dieselbe
Geste und beides besteht die Prüfung. Wer die Zahl als Kennwert liest, liest etwas, das sie nicht
ist.

**Auf dem Schreibtisch liegen jetzt neunzehn Finder-Fenster**, darunter weiterhin mehrere
deckungsgleiche „Chat On Steroids 2.0.2-arm64" bei 400,207. Sie sind nicht von mir und werden von
Lauf zu Lauf mehr; sie sind zugleich der bequemste Testfall für die Mehrdeutigkeit.

**Was ich nicht belegt habe.** Ob eine kürzere Nachlaufzeit bei einem animierenden Scroller
ausreicht, habe ich nicht gemessen — nur bei TextEdit. Warum `click` 139 ms kostet, habe ich nicht
verfolgt. Die Kette Modell → MCP → App aus `docs/qa/chatgpt-desktop-qa-prompt.md` ist wieder nicht
angefasst worden, ebenso wenig der Onboarding-Schritt für die Rechte.
