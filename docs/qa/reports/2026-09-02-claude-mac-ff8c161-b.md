# macOS-Verifikation, sechs Teile — zweiter Lauf gegen `ff8c161`

**Datum:** 2026-09-02
**Zweig:** `integrate/browser-and-desktop-064733`
**Repository-Stand:** `2230c32` (= `ff8c161` plus zwei Berichts-Commits)
**Installierte App:** `2.0.2+9c4a157` — läuft wieder; zwischen ihrem Stand und HEAD ändert sich
außer `docs/` nur `test/connection.test.ts`
**Maschine:** macOS 27.0.0, arm64, ein Bildschirm 1728×1117 mit Skalierung 2, Node 22.23.2
**Rechte:** Screen Recording und Accessibility auf `Terminal.app`, beide erteilt

---

## Kurzfassung

**Zuerst zwei Korrekturen an meinem eigenen letzten Bericht.**

1. **Der Zug bewegt wieder etwas — im ersten Anlauf.** Letzte Runde meldete ich vier Fehlschläge
   mit `ok: true`. Heute, gleicher Aufbau, gleicher Aufruf, fünf Wegpunkte: Datei bewegt. Der
   Rückschritt lag also nicht im Code, und meine Formulierung „in neun Läufen ging es, heute
   nicht" hat einen vorübergehenden Maschinenzustand wie einen Defekt aussehen lassen. Was letzte
   Runde anders war: die App hing in einer Startschleife, und der Schreibtisch trug fünfzehn
   Finder-Fenster. Ich kann die Ursache weiterhin nicht benennen — aber „Rückschritt" war das
   falsche Wort für etwas, das sich von selbst erledigt hat.
2. **Die App startet wieder.** Sie läuft auf `2.0.2+9c4a157`, Titel und `/hello` stimmen überein.
   Das Bundle war letzte Runde mitten im Lauf ausgetauscht worden; das hat sich aufgelöst, ohne
   dass ich etwas daran getan hätte.

**Alles Gestellte besteht.** `npm run desktop:mac` übersetzt, `verify:ci` grün im Erstlauf,
`verify:browser --headed` 42/42 ohne FAIL und SKIP, Probe erreicht sein Urteil auf 35 Fenstern,
Zeigerfeld und Bild stimmen überein, alle fünf Eingabezäune lehnen namentlich ab, `act` weist
fremde Schlüssel namentlich zurück, und `changed`/`ui_changed` passen zum Bildschirm.

**Die Scroll-Kosten bleiben, wo sie waren.** Zehn Scrolls in TextEdit: **1599 ms, Median 155 ms**.
Erwartet waren ~40 ms je bewegtem Scroll; gemessen sind **94 bis 165 ms**. In Chrome, wo die
Warteschleife gar nicht läuft, kostet ein Scroll **166 ms** — praktisch dasselbe. Die Schleife ist
also weiterhin nicht der Kostentreiber.

**Und die Blindheit auf Chromium-Inhalt besteht unverändert:** zehnmal `moved: null` mit
`movedUnknown: "nothing scrollable under the pointer"`, während die Seite sich um 25 552 Pixel
ändert.

---

## Teil 0 — Übersetzung und Rechte

```
$ npm run desktop:mac
  SOLINK_MODULE(target) Release/macos_desktop_addon.node
gyp info ok
macOS arm64 desktop helper, in-process library and Node addon built and verified.
ECHTER EXIT=0
```

**Übersetzt fehlerfrei**, kein `swiftc`-Fehler (die Ausgabe enthält null Zeilen mit „error").

```json
{"op":"warm"}
{"screenPermission":true,"accessibilityPermission":true,"ok":true,"ready":true}
```

Beide Rechte erteilt, an `Terminal.app`.

---

## Teil 1 — `npm run verify:ci`

**Grün beim ersten Lauf** — neunte Runde in Folge.

```
 Test Files  74 passed | 3 skipped (77)
      Tests  1878 passed | 97 skipped (1975)
 Test Files  1 passed (1)
      Tests  2 passed (2)
ECHTER EXIT=0
```

---

## Teil 2a — `npm run verify:browser -- --headed`

```
42/42 checks passed
ECHTER EXIT=0
```

**Kein FAIL. Kein SKIP** — gezählt: 0.

- **„a positive scroll_y moves the page down": bestanden**, `before=0 after=300`.
- **„the page sees a trusted wheel event going down": bestanden**, `wheel deltaY=6.2066650390625 trusted=true`.
- **Keine SKIP-Zeile.**
- **„a screenshot of a scrolled page shows where the page is": bestanden** —
  `scrollTop=1200, band expected at row 350, found rgb(40,95,246)`.
- `one screenshot pixel is one CSS pixel — {"png":{"w":1200,"h":817},"reported":{"w":1200,"h":817},"viewport":{…,"ratio":2}}`

---

## Teil 2b — `node scripts/probe-macos-helper.mjs arm64`

**Auf dem belebten Schreibtisch:** 34 Fenster, davon dreizehn Finder- und acht TextEdit-Fenster,
Chrome, zwei Safari, zwei UTM, vier Terminals.

10 von 10, `ECHTER EXIT=0`:

```
      35 windows listed, 35 not minimized
      window 4336 "cos-probe-window.txt" at 417,315 656x422
      99 changed within 32px of the pointer, 251 elsewhere (density 0.0234 vs 0.0010)
      PIXELS CONFIRM the pointer is drawn, at the position it was moved to
```

Sein eigenes Fenster aus 35, dieselben 99 Pixel wie in den sieben Läufen davor, kein
zurückgelassenes Fenster. **Was sich statt zu verweigern verhält:** Bildschirmaufnahme
(`pointer=system`) und Fensteraufnahme mit handkompositiertem Zeiger (`pointer=drawn`).

---

## Teil 2c — Der Zeiger, im Bild

TextEdit-Fenster 4341.

**Innen:** `POINTER-FELD: "drawn"` — im Bild ein **I-Balken**, der Textcursor über einem
Textbereich, an der erwarteten Stelle (~320/205 gegen erwartete 320,0/205,8). Kein Pfeil, und das
ist hier richtig.
**Außen:** `POINTER-FELD: "outside_region"` — im Bild kein Zeiger.

```
abweichende Pixel: 342 | Bounding-Box: x 8..323  y 9..215
```

**Feld und Bild stimmen überein.** Elfter Lauf in Folge.

---

## Teil 3a — Fokus

```
--- op:focus id=4171 ---   {"ok":true,"focused":true,"foreground":4171}
--- act/focus ---          {"routes":["focus"],"ok":true,"foreground":4171,"completed_count":1}
--- Cmd+L ---              {"routes":["focus","sendinput"],"ok":true,"completed_count":2}
--- Chrome-Fenster ---
    {"title":"Google Chrome window","width":1402,"height":136,"state":"open","x":100,"id":4173,"y":59}
    {"width":1728,"title":"Example Domain","height":1002,"state":"foreground","id":4171,"x":0,"y":33}
--- act/focus auf den Container 4173 ---
{"error_code":"FOCUS_FAILED","message":"the requested window could not be activated: another window of the same application is in front (window 4171)","ok":false}
--- op:focus id=4173 ---   {"ok":true,"foreground":4171,"focused":false}
```

**Die abweisende Klausel, wörtlich:**

> `the requested window could not be activated: another window of the same application is in front (window 4171)`

Fenster 4171 ist das Hauptfenster und steht in `{"op":"windows"}`. Der Container maß **1402×136**.

**`find_ui` unter `id`:** `ok=true`, 12 Elemente, Maße `1402x136, 1370x92, 1360x34, 1370x50,
1370x40, 1354x40, 920x0` — alles Maße des Containers. **`UIA_NO_OWN_WINDOW` tritt nicht auf.**

**Der falsche Schlüssel wird auf allen vier Operationen abgelehnt:** `find_ui`, `focus`, `capture`,
`snapshot`, jedes Mal `BAD_REQUEST`.

**`focusable`:** Container `false`, Hauptfenster `true`.

---

## Teil 3b — Kurz

`focusable`, 37 Fenster: Aufschlag im Median **128,0 ms** (48,3 → 176,3 ms). Die einfache Form
trägt das Feld nicht. Siebter Punkt auf der Kurve: 60 / 109 / 128 / 106 / 77 / 82 / 128 ms bei
28 / 35 / 41 / 37 / 32 / 35 / 37 Fenstern — er folgt der Listenlänge, mit spürbarer Streuung.

---

## Teil 3c — Die Scroll-Kosten

### Zehn Scrolls in TextEdit (AppKit-Scroller, keine Animation)

800 Zeilen, Zeiger im Textbereich.

```
   1    287.0 ms  moved=true  0->0.11965300628178283
   2    155.2 ms  moved=true  …->0.23930601256356565
   3    154.8 ms  moved=true  …->0.3589590188453485
   4     94.1 ms  moved=true  …->0.4786120251271313
   5    141.9 ms  moved=true  …->0.5982650314089142
   6    129.6 ms  moved=true  …->0.717918037690697
   7    164.8 ms  moved=true  …->0.8375710439724798
   8     93.9 ms  moved=true  …->0.9572240502542626
   9    107.0 ms  moved=true  …->1
  10    270.4 ms  moved=false 1->1

  min 93.9 ms, median 154.8 ms, max 287.0 ms
  Summe der zehn Aufrufe: 1598.8 ms
  Vergleich: eine move-Aktion kostet median 4.2 ms
```

**Die Belege setzen sich weiter auf sechs Stellen zusammen**, jeder Schritt trägt 0,11965, und der
zehnte meldet am Dokumentende korrekt `moved: false`.

**Die Erwartung von ~40 ms trifft weiterhin nicht zu.** Bewegte Scrolls kosten 94 bis 165 ms.

### Der animierende Scroller: Chrome

Lange HTML-Seite, 1199 Absätze, Zeiger mitten im Inhalt.

```
   1    386.7 ms  moved=null  hitRole="AXGroup"
   2–10 135.7–166.8 ms, alle moved=null, hitRole "AXWebArea" oder "AXGroup"
  min 135.7 ms, median 166.1 ms, max 386.7 ms, Summe 1825.9 ms
  movedUnknown: "nothing scrollable under the pointer"
```

**Zwei Dinge daraus.**

**Erstens, die Kosten.** In Chrome läuft die Warteschleife nie — es gibt keinen erreichbaren
Scrollbalken, also greift der Zweig mit dem festen `usleep(30_000)`. Trotzdem kostet ein Scroll
dort **166 ms** gegen **155 ms** in TextEdit, wo die Schleife läuft. **Zwei verschiedene
Wartewege, derselbe Preis.** Die Schleife ist nicht, was die Zeit ausmacht; der feste Anteil des
Scroll-Pfades ist es.

**Zweitens, die Blindheit.** Zehnmal `moved: null` — und die Seite bewegt sich nachweislich:

```
Aufnahme vor und nach einem Scroll von 900
A 640x371 ch4 | B 640x371 ch4
abweichende Pixel: 25552
Bounding-Box: x 9..639  y 35..367
```

Der gesamte Inhaltsbereich hat gewechselt. Das Feld, das „hat sich etwas bewegt" beantworten soll,
kann es auf Chromium-Inhalt nicht — und Chromium-Inhalt ist der Fall, aus dem der ursprüngliche
Bericht stammte, und zugleich die eigene Oberfläche der App. Das ist unverändert gegenüber dem
letzten Lauf; ich wiederhole es, weil es die einzige offene Stelle an einem sonst sauberen Feld ist.

---

## Teil 5c — Die beiden Verträge

### `act` lehnt ab, was es nicht kennt

```
"verification":{"until":"window_exists","match":"x"}  -> BAD_REQUEST :: act does not recognize `verification`. It reads `frame`, `targetWindow` and `actions` only. Nothing was done.
"verify":{"until":"foreground"}                       -> BAD_REQUEST :: act does not recognize `verify`. …
"quatschSchluessel":123                               -> BAD_REQUEST :: act does not recognize `quatschSchluessel`. …
```

**Alle drei namentlich abgelehnt**, mit der Liste der Schlüssel, die es gibt. Vor zwei Runden
antwortete dasselbe mit `ok: true`.

*(Anmerkung aus dem letzten Lauf, unverändert gültig: dieselbe Regel gilt nur für `act`.
`{"op":"windows","quatschSchluessel":1}` und dasselbe an `warm` und `cursor` werden weiterhin
still geschluckt.)*

### `act_ui` sagt, ob sich etwas bewegt hat

Eigene Seite in Chrome mit einer echten Checkbox, damit nichts am System hängt:

```
act_ui click     -> {"name":"Ein harmloser Schalter","changed":false,"route":"uia","runtimeKey":"e48","ok":true}
   Seite danach: (noch nichts)

Stapel click_ui  -> {"foreground":4171,"completed_count":1,"ok":true,"routes":["uia"],"ui_changed":false}
   Seite danach: (noch nichts)
```

**Beide Male stimmt die Angabe mit dem Bildschirm überein** — die Seite meldet ihren eigenen
Zustand als unverändert. `AXPress` wirkt auf Chromium-Bedienelementen nicht; genau das sagt das
Feld jetzt, statt es zu verschweigen.

**Der Menüpunkt: kein Weg führt hin.** Unverändert gegenüber dem letzten Lauf, hier erneut geprüft:

```
Rollen im TextEdit-Fensterbaum: ["Window","ScrollArea","Button","MenuButton","Image","StaticText","TextArea","ScrollBar","Group"]
Suche nach "Format": []
Koordinatenklick auf die Menueleiste: INPUT_TARGET_LOST "window 4341 is no longer the exact active input target (another application is frontmost); no input was sent"
```

`find_ui` ist fensterbezogen und enthält die Menüleiste nicht, also hat `act_ui` nichts zu
referenzieren; und ein Koordinatenklick auf die Menüleiste wird vom Zaun abgelehnt. **Die
Erwartung war, dass der semantische Weg hier gewinnt — gemessen kommt keiner von beiden hin.**
Die Ablehnung benennt jeweils korrekt, was nicht stimmte.

---

## Teil 4 — Eingabe

### 4a — Ein Ziehen, das etwas bewegt

Symbolpositionen über `find_ui` bestimmt: Datei (589,340) → Mitte 621,372; Ordner (949,540) →
Mitte 981,572.

```
vorher:  ziehmich.txt ZielOrdner  | Ziel: (leer)
{"completed_count":2,"cursor":{"y":572,"x":981},"foreground":4317,"ok":true,"routes":["focus","sendinput"]}
nachher: ZielOrdner               | Ziel: ziehmich.txt
```

**Datei bewegt, fünf Punkte im Pfad, erster Anlauf.** Vor dem Versuch gegengeprüft: keine
hängende Modifiertaste, keine hängende Maustaste.

### 4b — Tippen, wo es hingezielt war

```
Datei: "Runde 16 — Umlaute: ä ö ü ß\nZweite Zeile nach Umbruch"
Hex  : 52 75 6e 64 65 20 31 36 20 e2 80 94 20 55 6d 6c 61 75 74 65 3a 20 c3 a4 20
       c3 b6 20 c3 bc 20 c3 9f 0a 5a 77 65 69 74 65 20 5a 65 69 6c 65 20 6e 61 63 68 20 55 6d 62 72 75 63 68
```

Zeichengenau, inklusive `0a`, der UTF-8-Umlaute und des Geviertstrichs `e28094`.

### 4c — Der Eingabezaun

Mit TextEdit-Fenster 4354 im Vordergrund, fünf Formen:

```
Finder, Text      INPUT_TARGET_LOST  "window 4317 … (another application is frontmost); no input was sent"
TextEdit, Text    INPUT_TARGET_LOST  "window 4349 … (another window of the same application is in front (window 4354)); no input was sent"
TextEdit, Taste   INPUT_TARGET_LOST  dieselbe Klausel
TextEdit, Scroll  INPUT_TARGET_LOST  dieselbe Klausel
Klick ausserhalb  OUTSIDE_TARGET_WINDOW  "click at 5,5 is outside window 4354, which this batch is leased to (475,373 656x422)"
```

**Alle fünf lehnen namentlich ab, und nichts wurde getippt oder gescrollt.**

---

## Teil 5 — Die installierte App

```
$ curl -s http://127.0.0.1:8765/hello
{"app":"chat-on-steroids","version":"2.0.2","build":"2.0.2+9c4a157","bridge":8,"compatible":false,"spoken":null,"paired":true,"disconnected":false}
```

**`build` lautet `2.0.2+9c4a157`** — ein Paketstand, kein `2.0.2-dev`. Der Fenstertitel:
`Chat On Steroids 2.0.2+9c4a157` — **dieselbe Zeichenkette.** Elfter Lauf in Folge.

`git rev-parse --short HEAD` sagt `2230c32`. Zwischen dem Stand der App und HEAD ändert sich außer
`docs/` nur `test/connection.test.ts` — kein ausgelieferter Code.

**Erweiterung:** derselbe Ordner (`~/Library/Application Support/chat-on-steroids/extension`,
Realpfad identisch, kein Symlink), **alle zehn Dateien byte-identisch** mit dieser Kasse.

**Manifest:** `permissions = ["storage","scripting","alarms","debugger"]`,
`optional_permissions = ["tabs","tabGroups"]` — **`debugger` steht richtig.**

---

## Teil 5b — Der Rechte-Schritt

### Fund 1: die Erklärung passt zu dem, was ich sehe — die Gegenprobe habe ich nicht gemacht

Der PERMISSIONS-Kasten steht auf **Read-only**, und der erklärende Text sagt es selbst:

> Read-only disables file changes, commands, browser control, mouse … clipboard … regardless of
> which boxes are ticked — screenshots and reads still work. Turn it back off here to restore
> write access; nothing else can.

Die vier Zeilen darunter:

```
  Look at files              6 permissions          [ein]
  Change files               off in read-only mode  [aus, ausgegraut]
  See and use the desktop    4 permissions          [ein]
  Run programs               off in read-only mode  [aus, ausgegraut]
```

Und der Schritt unter *Setup*:

> **Allow desktop access** — Everything this Mac needs to grant has been granted.
> ● **Screen Recording** — Needed to take a screenshot or read what is on screen. — *Granted*

`find_ui` über den ganzen Fensterbaum: **ein** Treffer für „Screen Recording", **null** für
„Accessibility".

**Das ist genau der Zustand, den die Erklärung vorhersagt:** Read-only an, `control` damit
unterdrückt, also wird Accessibility nicht angefordert und die eine Zeile ist vollständig.

**Die entscheidende Gegenprobe habe ich nicht gemacht.** Sie verlangt, Read-only auszuschalten —
also auf deiner Maschine Dateiänderungen, Befehlsausführung und Browsersteuerung freizugeben. Das
ist eine Schutzeinstellung und keine Testeinstellung; ich schalte sie nicht ohne dich ab. **Fund 1
ist damit plausibel erklärt, aber nicht bewiesen.** Sag Bescheid, dann mache ich sie in einer
Minute: Read-only aus, beide Zeilen prüfen, Read-only wieder an.

### Fund 2: weiterhin nicht messbar

Der Widerruf von Screen Recording verlangt unter macOS 27 Touch ID oder das Passwort. Ich habe das
letzte Runde zweimal versucht, 18 Sekunden auf eine Hintergrund-Anmeldung gewartet, und beide Male
abgebrochen. **Ohne einen Menschen an der Tastatur ist die Zwei-Minuten-Messung und der Vergleich
zwischen frischem und laufendem Prozess in diesem Rahmen nicht durchführbar.** Ich habe es diesmal
nicht erneut versucht, weil das Ergebnis dasselbe wäre und jeder Versuch deine Systemeinstellungen
anfasst.

### Was mir an der Oberfläche auffiel

**Ein Fortschritt gegenüber letzter Runde:** der Erweiterungs-Schritt trägt jetzt einen **leeren
Kreis** statt eines Häkchens und sagt in Rot „Authorized, but the browser extension is not
currently connected. Last seen 6m ago." Letzte Runde stand derselbe rote Absatz neben einem grünen
Häkchen — jetzt passen Zeichen und Text zusammen.

**Ein Darstellungsfehler:** auf dem Startbildschirm überlagert ein Tooltip („Look at files —
6 permissions") die erste Zeile des PERMISSIONS-Kastens und verdeckt ihren Namen und ihren
Schalter. In der Aufnahme steht der Tooltip mitten über der Zeile, die er beschreibt.

**Und unverändert:** es gibt keinen Zeitstempel „zuletzt geprüft" an der Rechte-Zeile, und der
Schritt liegt drei Klicks tief unter *Setup* → aufklappen → „Show all steps".

---

## Teil 6 — Die gestellten Fragen, kurz beantwortet

| Frage | Antwort |
|---|---|
| **`npm run desktop:mac` übersetzt?** | **Ja**, `gyp info ok`, EXIT 0, kein `swiftc`-Fehler |
| Screen Recording und Accessibility erteilt? | Ja, beide, an `Terminal.app` |
| `verify:ci` | **Grün beim ersten Lauf**: 1878 passed / 97 skipped (1975), EXIT 0 |
| `verify:browser --headed` | **42/42**, EXIT 0, kein FAIL, kein SKIP |
| Scroll-Richtung | **Beurteilt und bestanden**, `before=0 after=300` |
| Zeiger: Feld / Bild | `"drawn"` und I-Balken innen, `"outside_region"` und nichts außen — **sie stimmen überein** |
| Fokus-Klausel | `another window of the same application is in front (window 4171)` |
| **Zug** | **Ja** — fünf Wegpunkte, erster Anlauf. Der Fehlschlag der letzten Runde ist nicht reproduzierbar |
| Eingabezaun | **Ja**, alle fünf Ablehnungen namentlich |
| Erweiterung = diese Kasse? | **Ja**, alle zehn Dateien byte-identisch, derselbe Ordner |
| **`act` mit `verification`** | **`BAD_REQUEST`, namentlich** — ebenso `verify` und ein Unsinn-Schlüssel |
| **`act_ui` mit `changed`** | **Passt zum Bildschirm**, einzeln (`changed`) wie im Stapel (`ui_changed`) |
| **Fund 1** | **Erklärt, nicht bewiesen.** Read-only ist an, die eine Zeile ist damit korrekt; die Gegenprobe mit Read-only aus habe ich bewusst nicht gemacht |
| **Fund 2** | **Nicht messbar.** macOS verlangt Touch ID oder Passwort für den Entzug |
| Zehn Scrolls | **1599 ms, Median 155 ms** — nicht die erwarteten 40 ms |
| Animierender Scroller | **`moved: null`** zehnmal, während die Seite sich um 25 552 Pixel ändert |

---

## Was sonst auffiel

**Ich habe letzte Runde einen vorübergehenden Zustand als Rückschritt gemeldet.** Der Zug ging
heute im ersten Anlauf. Der Unterschied zwischen „vier Fehlschläge in Folge" und „nicht
reproduzierbar" ist ein weiterer Lauf, und den hätte ich vor dem Wort „Rückschritt" machen sollen.
Was ich richtig gemacht habe: die Ausschlüsse mitzuliefern — dass der Helfer-Code unverändert war
und keine Taste hing — so dass heute nur noch der Wiederholungsversuch fehlte.

**Zwei Wartewege, ein Preis.** Dass ein Scroll in Chrome (feste 30 ms) genauso viel kostet wie
einer in TextEdit (Schleife bis 120 ms), ist der klarste Hinweis, den ich zu den Kosten liefern
kann: die verbleibenden ~150 ms sitzen im festen Teil des Scroll-Pfades, nicht im Warten. Wer
weiter kürzen will, sollte dort messen. Ich habe das nicht zerlegt.

**Die Schlüsselprüfung ist auf `act` beschränkt.** Das ist dieselbe Beobachtung wie im letzten
Bericht und sie steht noch: `windows`, `warm` und `cursor` nehmen jeden Unsinn stumm an. Beim
dritten Mal, dass eine Regel als Einzelfall repariert wird, ist das Muster selbst der Befund.

**Der Tooltip verdeckt die Zeile, die er erklärt.** Kleinigkeit, aber sie steht mitten auf dem
Startbildschirm, den ein neuer Benutzer zuerst sieht.

**Was ich am Zustand der Maschine berührt habe.** Ein Finder-Fenster angelegt und über den Helfer
wieder geschlossen, Testordner entfernt, drei TextEdit-Dokumente und zwei Chrome-Tabs im
Arbeitsordner geöffnet. **Read-only habe ich nicht abgeschaltet**, und an den Systemeinstellungen
habe ich diesmal nichts angefasst. `/pair` wurde nicht aufgerufen.

**Was ich nicht belegt habe.** Warum der Zug letzte Runde viermal scheiterte. Ob mit
ausgeschaltetem Read-only beide Rechte-Zeilen erscheinen. Wo genau die ~150 ms fester Kosten im
Scroll-Pfad sitzen. Und Fund 2, weiterhin, aus demselben Grund wie letzte Runde.
