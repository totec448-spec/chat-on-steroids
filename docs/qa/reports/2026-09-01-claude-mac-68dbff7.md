# macOS-Verifikation, sechs Teile — Lauf gegen `68dbff7`

**Datum:** 2026-09-01
**Zweig:** `integrate/browser-and-desktop-064733`
**Repository-Stand:** `cbfff76` (= `68dbff7` plus drei reine Berichts-Commits)
**Installierte App:** `2.0.2+68dbff7`
**Maschine:** macOS 27.0.0, arm64, ein Bildschirm 1728×1117 mit Skalierung 2, Node 22.23.2
**Rechte:** Screen Recording und Accessibility auf `Terminal.app`, beide erteilt

---

## Kurzfassung

Alle gestellten Prüfungen bestehen: `verify:ci` grün im Erstlauf, `verify:browser --headed`
**37/37** ohne FAIL und ohne SKIP, der Probe erreicht sein Urteil **auf dem belebten Schreibtisch**,
Zeigerfeld und Bild stimmen überein, alle vier Eingabezäune lehnen namentlich ab.

Die beiden Messungen aus 3b liefern das erhoffte Ergebnis — und dabei ist etwas herausgefallen, das
weiter reicht als die Frage, die gestellt war:

**`AXWindowNumber` gibt es auf dieser Maschine nicht.** Nicht „ist nil", sondern das Attribut wird
gar nicht angeboten: es fehlt in den 28 Attributen, die ein Chrome-Fenster führt, und ein
Direktlesen gibt AXError **−25205** (`kAXErrorAttributeUnsupported`). Über 26 Fenster aus 11
Prozessen hinweg: **0 Treffer.** Damit läuft der Id-Zweig in `matchingAXWindow` nie, jede Zuordnung
geht über die Geometrie, und `UIA_NO_OWN_WINDOW` ist hier nicht etwa selten, sondern unerreichbar.

Und das hat einen Preis, der in diesem Lauf zugeschlagen hat: **zwei gleich große Fenster derselben
Anwendung an derselben Stelle sind nicht mehr unterscheidbar.** Mein erster Ziehversuch scheiterte
an `UIA_FAILED: multiple accessibility windows ambiguously match window 1846`, weil ein
Finder-Fenster aus dem letzten Lauf exakt dieselben Maße an derselben Position hatte. Der Zaun hat
richtig abgelehnt statt das falsche Fenster zu bedienen — aber die Aktion war damit unmöglich, bis
ich ein Fenster verschob. Auf deinem Schreibtisch liegen gerade zwei weitere solche Paare.

---

## Teil 0 — Rechte

```json
{"op":"warm"}
{"ok":true,"screenPermission":true,"accessibilityPermission":true,"ready":true}
```

Beide erteilt, an `Terminal.app` als GUI-Vorfahr. Kein Teil unten ist deshalb unmessbar.

---

## Teil 1 — `npm run verify:ci`

**Grün beim ersten Lauf, ohne Eingriff** — zweite Runde in Folge.

```
Electron binary is missing; installing it once before the tests start.
 Test Files  73 passed | 3 skipped (76)
      Tests  1864 passed | 97 skipped (1961)

 Test Files  1 passed (1)
      Tests  2 passed (2)

ECHTER EXIT=0
```

`scripts/ensure-electron.mjs` greift wieder. Die Race, die drei Läufe hintereinander jeden Erstlauf
rot gefärbt hat, ist damit zum zweiten Mal nachweislich weg.

---

## Teil 2a — `npm run verify:browser -- --headed`

```
37/37 checks passed
ECHTER EXIT=0
```

**Kein FAIL. Kein SKIP** — gezählt, nicht überflogen: `grep -cE "^(FAIL|SKIP)"` ergibt 0.

Die vier gestellten Fragen und die neue fünfte:

- **„a positive scroll_y moves the page down": bestanden**, mit echten Zahlen auf beiden Seiten.
- **`scrollTop` davor 0, danach 300** — wörtlich
  `PASS  a positive scroll_y moves the page down  — before=0 after=300`.
- **„the page sees a trusted wheel event going down": bestanden**, mit
  `wheel deltaY=0.382110595703125 trusted=true`.
- **Keine SKIP-Zeile.**
- **„a screenshot of a scrolled page shows where the page is": bestanden.** Wörtlich:
  `scrollTop=1200, band expected at row 350, found rgb(40,95,246)`.

Zum letzten Punkt: der Prüfpunkt tut genau, was angekündigt war. Die Seite steht bei 1200, das
farbige Band liegt an einem bekannten Dokument-Offset, und die erwartete Bildzeile 350 trägt
tatsächlich die Bandfarbe. Ein Screenshot, der den Dokumentanfang zeigte, hätte dort die
Hintergrundfarbe.

**Und ein zweiter Prüfpunkt, der hier zum ersten Mal etwas beweist**, weil diese Maschine einen
2×-Bildschirm hat:

```
PASS  one screenshot pixel is one CSS pixel  — {"png":{"w":1200,"h":817},"reported":{"w":1200,"h":817},"viewport":{"width":1200,"height":817,"x":0,"y":0,"ratio":2}}
```

`ratio: 2`, und die tatsächlichen PNG-Maße stimmen mit den gemeldeten überein. Der
Retina-Verdopplungsfehler aus `e20d032` ist damit dort geprüft, wo er auftrat — auf einem
Bildschirm mit Skalierung 2. Auf einem 1×-Gerät hätte derselbe Prüfpunkt nichts bewiesen.

Zum `deltaY`: 0,38 ist kein Fehler. `synthesizeScrollGesture` liefert eine Folge von
Rad-Ereignissen, und `wheellog` behält nur das letzte, also das Ausklingen der Geste. Die Prüfung
verlangt `deltaY ≥ 1`… — genauer: sie verlangt `trusted=true` und eine Ziffer ungleich null in
`deltaY`; `0.382…` erfüllt das über die 3 an der ersten signifikanten Stelle. Dass die Zahl von
Lauf zu Lauf zwischen 0,4 und 293 schwankt, ist eine Eigenschaft der Geste, nicht des Treibers.

---

## Teil 2b — `node scripts/probe-macos-helper.mjs arm64`

**Auf dem belebten Schreibtisch gelaufen**, wie verlangt: 23 Fenster vor dem Start, davon Chrome,
Safari, ChatGPT, Spark, Parsec, UTM, neun Finder-Fenster und vier Terminals — keines minimiert.

10 von 10, `ECHTER EXIT=0`:

```
ok    it lists windows to capture — ok
      24 windows listed, 24 not minimized
      window 1821 "cos-probe-window.txt" at 185,83 656x422
ok    it names a foreground window — ok
      foreground=1821, opened window 1821, window list claims 1821
ok    it captures that window — ok
      pointer=drawn captureMode=window
ok    it captures the window again — ok
      second capture pointer=outside_region
      image 640x412, 348 pixels differ, box {"x":8,"y":9,"width":316,"height":207}
      pointer was expected near 320,206
      99 changed within 32px of the pointer, 249 elsewhere (density 0.0234 vs 0.0010)
      PIXELS CONFIRM the pointer is drawn, at the position it was moved to
```

**Beide Änderungen wirken, und sie wirken genau unter der Bedingung, unter der es vorher scheiterte.**

- Er nimmt **sein eigenes** Fenster (`cos-probe-window.txt`, id 1821) aus 24 zur Auswahl stehenden.
  Im letzten Lauf hatte er unter denselben Umständen ein fremdes Chrome-Fenster mit der
  Neuer-Tab-Seite erwischt und 19 097 abweichende Pixel gemeldet.
- Die Dichte trägt das Urteil, wo das umschließende Rechteck es nicht konnte. Das Kästchen ist mit
  316×207 noch immer zu groß für die alte `localised`-Schwelle — die Titelleiste und der blinkende
  Einfügecursor sind ja weiterhin da. Aber 99 Pixel auf der Zeigerfläche gegen 249 auf dem ganzen
  Rest ergeben **0,0234 gegen 0,0010**, ein Verhältnis von 23:1, und darauf lässt sich entscheiden.

Die 99 sind übrigens exakt die Zahl, die ich im letzten Lauf von Hand ausgerechnet hatte, als ich
zeigte, was das Urteil ohne die Cursorspalte gewesen wäre. Die Messung von damals und die Prüfung
von heute kommen auf denselben Wert.

**Was sich gegenüber der Ankündigung des Skripts verhält statt sich zu verweigern:** die
Bildschirmaufnahme (`pointer=system`) und die Fensteraufnahme mit handkompositiertem Zeiger
(`pointer=drawn`). Beide brauchen das Screen-Recording-Recht.

---

## Teil 2c — Der Zeiger, im Bild

Eigene Messung, unabhängig vom Probe. TextEdit-Dokumentfenster, id 1831, bei 214,112, 656×422.

**Fall 1 — Zeiger in der Fenstermitte (542,323):**

```
cursor  -> {"cursor":{"x":542,"y":323},"ok":true,"foreground":1831,"foregroundIsSelf":false}
capture -> {"focused":true,"region":{"width":656,"height":422,"x":214,"y":112},"image":{"height":412,"width":640},"captureMode":"window","pointer":"drawn", …}
POINTER-FELD: "drawn"
```

**Das Bild:** ein Zeiger ist sichtbar — **kein Pfeil, sondern ein I-Balken**, der Textcursor über
einem Textbereich. Das ist hier das richtige Ergebnis; ein Pfeil hieße, dass ein Standardbild
gezeichnet wird statt des tatsächlichen Systemzeigers.

**Wo er steht:** Fenstermitte in Fensterkoordinaten (328, 211), Bild auf 640 von 656 Pixeln
skaliert → erwartet bei (320,0 / 205,8). Der Glyph sitzt dort.

**Gegengeprüft, weil dieser Lauf auf einem 2×-Bildschirm stattfindet:** der PNG-Kopf sagt
`640 x 412`, die Antwort meldet `{"width":640,"height":412}`. Beide Zahlen stimmen; die Aufnahme
kommt nicht in doppelter Größe zurück.

**Fall 2 — Zeiger außerhalb (1070,152), Fenster unverändert:**

```
capture -> {"image":{"width":640,"height":412},"captureMode":"window","pointer":"outside_region", …}
POINTER-FELD: "outside_region"
```

**Das Bild:** kein Zeiger, an keiner Stelle.

**Pixelvergleich:**

```
A 640x412 ch4 | B 640x412 ch4
abweichende Pixel: 341
Bounding-Box: x 8..323  y 9..215 | Mitte 165.5/112.0
```

**Feld und Bild stimmen überein, in beiden Fällen.** Vierter Lauf in Folge mit demselben Ergebnis.

---

## Teil 3a — Fokus, bestätigt

```
--- 2. op:focus id=1691 ---
{"foreground":1691,"ok":true,"focused":true}
--- 3. act/focus auf 1691 ---
{"ok":true,"completed_count":1,"routes":["focus"],"foreground":1691,"cursor":{"x":1070,"y":152}}
--- 4. Cmd+L ueber den Helfer ---
{"cursor":{"x":1070,"y":152},"routes":["focus","sendinput"],"foreground":1691,"ok":true,"completed_count":2}
--- 5. Chrome-Fenster nach Cmd+L ---
    {"state":"open","height":136,"width":1402,"title":"Google Chrome window","process":"Google Chrome","id":1693,"y":59,"x":100}
    {"x":0,"y":33,"width":1728,"height":1002,"process":"Google Chrome","title":"Example Domain","id":1691,"state":"foreground"}
--- 6. act/focus auf den Container 1693 ---
{"failed_index":0,"error_code":"FOCUS_FAILED","routes":[],"completed_count":0,"ok":false,"message":"the requested window could not be activated: another window of the same application is in front (window 1691)"}
--- 6b. op:focus id=1693 ---
{"foreground":1691,"focused":false,"ok":true}
--- 7. Escape mit vorangehendem focus ---
{"ok":true,"completed_count":2,"routes":["focus","sendinput"],"cursor":{"x":1070,"y":152},"foreground":1691}
--- 8. danach ---
    {"y":33,"height":1002,"process":"Google Chrome","x":0,"id":1691,"width":1728,"state":"foreground","title":"Example Domain"}
```

**Die abweisende Klausel, wörtlich:**

> `the requested window could not be activated: another window of the same application is in front (window 1691)`

Fenster 1691 ist das Hauptfenster und steht in `{"op":"windows"}`. Der Container ist exakt 1402×136.
Escape mit vorangehendem `focus` schließt ihn, danach fokussiert das Hauptfenster wieder.

**`find_ui` unter `id`, wie erwartet — der eigene Baum:**

```
{"op":"find_ui","id":1693,"query":""}
   ok=true  error_code=undefined  elemente=12
   erstes bounds: {"y":59,"width":1402,"x":100,"height":136}
   alle Maße im Baum: 1402x136, 1370x92, 1360x34, 1370x50, 1370x40, 1354x40, 920x0
```

Alles Maße des Containers, keines des Hauptfensters (1728×1002). **`UIA_NO_OWN_WINDOW` ist nicht
aufgetreten** — und Teil 3b unten erklärt, warum es hier gar nicht auftreten kann.

**Der falsche Schlüssel wird auf allen vier Operationen abgelehnt:**

```
{"op":"find_ui","window":1693}                                     -> BAD_REQUEST
{"op":"focus","window":1693}                                       -> BAD_REQUEST
{"op":"capture","window":1693,"maxWidth":320,"file":"/tmp/x.png"}  -> BAD_REQUEST
{"op":"snapshot","window":1693}                                    -> BAD_REQUEST
```

Wortlaut der Meldung:

> `this request names a window under `window`, but every operation reads it under `id`. Nothing was done. Send `id` — `window` belongs on an action inside `act`, and `targetWindow` on an `act` request.`

---

## Teil 3b — Die beiden Messungen

Direkt über die Accessibility-API, mit einem eigenen Swift-Werkzeug, nicht über den Helfer.
`AXIsProcessTrusted` meldet `true`.

### Messung 1 — Ist `kAXMainAttribute` setzbar?

```
Fenster 1693 — Google Chrome — "" — 1402x136 bei 100,59
  AXMain jetzt: false
  kAXMainAttribute settable = FALSE   (AXError 0)
  Dauer ueber 10 Aufrufe: min 0.031 ms, median 0.033 ms, max 0.049 ms

Fenster 1691 — Google Chrome — "Example Domain" — 1728x1002 bei 0,33
  AXMain jetzt: true
  kAXMainAttribute settable = TRUE   (AXError 0)
  Dauer ueber 10 Aufrufe: min 0.030 ms, median 0.031 ms, max 0.036 ms
```

**Genau die Trennung, auf die du das Feld bauen wolltest.** `false` für den Container, `true` für
das Hauptfenster, in beiden Fällen mit `AXError 0` — also eine echte Antwort und kein Fehlschlag,
der zufällig wie `false` aussieht.

**Ein Wermutstropfen aus derselben Messung.** Über die ganze Fensterliste ist der Container nicht
der einzige, der `false` meldet:

```
Nicht setzbar (kAXMain settable = false):
  1693  Google Chrome  ""  1402x136 bei 100,59
  1685  Safari         ""  53x48 bei -33,33
```

Ein Safari-Fenster von 53×48 Pixeln, das bei x = −33 halb außerhalb des Bildschirms liegt. Was das
ist, habe ich nicht weiter verfolgt; wichtig ist, dass `focusable: false` nicht nur den Omnibox-
Container markieren würde. Ob das falsch ist, kann ich nicht sagen — treiben will man ein
53×48-Fenster bei −33 vermutlich auch nicht.

### Messung 2 — Was es kostet

26 Fenster, 11 Prozesse. Zwei Durchgänge, in Phasen zerlegt:

| Phase | Durchgang 1 | Durchgang 2 |
|---|---|---|
| AX-Fensterlisten holen (11 Prozesse) | 95,579 ms | 75,497 ms |
| Zuordnung über `AXWindowNumber` | 13,127 ms — **0 Treffer** | 22,354 ms — **0 Treffer** |
| Zuordnung über Geometrie (Rest) | 7,468 ms — 26 Treffer | 12,290 ms — 26 Treffer |
| **`kAXMainAttribute` settable, 26 Fenster** | **1,159 ms** | **1,919 ms** |
| Summe | 117,333 ms | 112,061 ms |

**Die Antwort auf deine Frage: der Aufruf ist billig, der Weg dorthin nicht.** Das Attribut selbst
kostet rund **0,05 ms je Fenster**, für eine 26er-Liste zusammen unter 2 ms — das könnte `windows`
mühelos tragen. Aber um es zu stellen, braucht man das AX-Element, und dafür fallen **112 bis 117
ms** an, die eine reine `CGWindowListCopyWindowInfo`-Liste heute nicht bezahlt.

Der Löwenanteil ist Phase 1: einmal je Prozess `kAXWindowsAttribute` zu holen. Das ist ein
Rundlauf zu jeder fremden Anwendung, und elf davon summieren sich.

**Mein Rat auf dieser Grundlage: als Feld, das ein Aufrufer anfordert, nicht als eines, das jede
Liste bezahlt.** Ein `windows`-Aufruf von unter einer Millisekunde auf über hundert zu bringen,
damit ein Feld dasteht, das in fast jeder Liste für jedes Fenster `true` sagt, ist der falsche
Tausch. Als `{"op":"windows","focusable":true}` oder auf einem einzelnen Fenster ist es dagegen
billig und beantwortet genau die Frage, die ein Aufrufer hat, wenn eine Fokussierung gerade
abgelehnt wurde.

### Was dabei herausfiel, und wichtiger ist als beide Messungen

**`AXWindowNumber` wird auf dieser Maschine nicht angeboten.**

```
[0] "Example Domain - Google Chrome – mydealz"  AXError beim Namen-Kopieren: 0, 28 Attribute
     AXWindowNumber angeboten: false
     Direktlesen AXWindowNumber -> AXError -25205, Wert nil
     Attribute: AXActivationPoint, AXCancelButton, AXChildren, AXChildrenInNavigationOrder,
     AXCloseButton, AXDefaultButton, AXDocument, AXFocused, AXFrame, AXFullScreen,
     AXFullScreenButton, AXGrowArea, AXMain, AXMinimizeButton, AXMinimized, AXModal, AXParent,
     AXPosition, AXProxy, AXRole, AXRoleDescription, AXSections, AXSize, AXSubrole, AXTitle,
     AXTitleUIElement, AXToolbarButton, AXZoomButton
```

`−25205` ist `kAXErrorAttributeUnsupported`. Es ist nicht so, dass das Attribut leer wäre — es
existiert nicht. Und das gilt nicht nur für Chrome: über 26 Fenster aus 11 Prozessen ergab die
Zuordnung über `AXWindowNumber` **null Treffer**, alle 26 gingen über die Geometrie.

Drei Folgen, alle gemessen:

1. **Der Id-Zweig in `matchingAXWindow` (`main.swift:643`) läuft hier nie.** Damit ist
   `UIA_NO_OWN_WINDOW`, das direkt hinter `guard axWindowNumber(window) == row.id` sitzt, auf
   dieser Maschine unerreichbar. Der Quelltextkommentar sagt inzwischen, der Wächter bleibe „for
   the case rather than the anecdote" — richtig, aber der Fall kann hier nicht eintreten, weil das
   Attribut fehlt, nicht weil keine Anwendung ihn erzeugt.
2. **`AXMain` steht dagegen in der Liste.** Das Feld aus 3b ist also baubar.
3. **Und die Geometrie muss alles alleine tragen** — siehe Teil 4a.

---

## Teil 4 — Eingabe, unterhalb der App

### 4a — Ein Ziehen, das etwas bewegt — beim ersten Versuch abgelehnt

```json
{"op":"act","targetWindow":1846,"actions":[{"type":"focus","window":1846},
 {"type":"drag","xs":[521,600,700,800,881],"ys":[322,370,430,480,522],"button":"left"}]}
{"failed_index":0,"completed_count":0,"error_code":"UIA_FAILED",
 "message":"multiple accessibility windows ambiguously match window 1846","routes":[],"ok":false}
```

Die Datei blieb liegen. Der Grund stand in der Fensterliste:

```
  id=1065 800x550 bei 200,150 "Downloads"
  id=1846 800x550 bei 200,150 "cos-drag-r9"
```

**Zwei Finder-Fenster mit identischen Maßen an identischer Position.** Da `AXWindowNumber` fehlt
(Teil 3b), ist die Geometrie das einzige Unterscheidungsmerkmal, und sie unterscheidet hier nichts.
Der Helfer hat richtig abgelehnt, statt das falsche Fenster zu bedienen — aber die Aktion war
unmöglich, bis eines der beiden Fenster woanders lag.

Ich habe das neue Fenster auf 820×570 bei 150,120 verschoben, damit war es eindeutig, und dann:

```json
{"op":"act","targetWindow":1846,"actions":[{"type":"focus","window":1846},
 {"type":"drag","xs":[471,560,660,750,831],"ys":[292,340,400,450,492],"button":"left"}]}
{"foreground":1846,"routes":["focus","sendinput"],"ok":true,"completed_count":2,"cursor":{"x":831,"y":492}}
```

```
vorher:  ziehmich.txt ZielOrdner  | Ziel: (leer)
nachher: ZielOrdner               | Ziel: ziehmich.txt
```

**Das Ziehen hat die Datei bewegt, mit fünf Punkten im Pfad.** Symbolpositionen über
`{"op":"find_ui","id":1846,…}` bestimmt, nicht geschätzt.

### 4b — Tippen, wo es hingezielt war

```
00000000: 5a65 696c 6520 6569 6e73 206d 6974 2055  Zeile eins mit U
00000010: 6d6c 6175 743a 20c3 a420 c3b6 20c3 bc20  mlaut: .. .. ..
00000020: c39f 0a5a 6569 6c65 207a 7765 6920 6e61  ...Zeile zwei na
00000030: 6368 205a 6569 6c65 6e75 6d62 7275 6368  ch Zeilenumbruch
```

Zeichengenau, inklusive `0a` für den Umbruch und der UTF-8-Umlaute (`c3a4` ä, `c3b6` ö, `c3bc` ü,
`c39f` ß).

### 4c — Der Eingabezaun

Mit TextEdit-Fenster 1831 im Vordergrund:

```
--- targetWindow=1846 (Finder), Text ---
{"ok":false,"error_code":"INPUT_TARGET_LOST","completed_count":0,"message":"window 1846 is no longer the exact active input target (another application is frontmost); no input was sent"}

--- targetWindow=1829 (anderes TextEdit-Fenster), Text ---
{"ok":false,"error_code":"INPUT_TARGET_LOST","completed_count":0,"message":"window 1829 is no longer the exact active input target (another window of the same application is in front (window 1831)); no input was sent"}

--- targetWindow=1829, Tastendruck ---
{"error_code":"INPUT_TARGET_LOST","completed_count":0,"message":"window 1829 is no longer the exact active input target (another window of the same application is in front (window 1831)); no input was sent","ok":false}

--- Klick bei 5,5, geleast auf Fenster 1831 ---
{"error_code":"OUTSIDE_TARGET_WINDOW","completed_count":0,"message":"click at 5,5 is outside window 1831, which this batch is leased to (214,112 656x422). No input was sent. Lease the window you meant, or take a screenshot of it and use coordinates from that image.","ok":false}
```

**Alle vier lehnen namentlich ab, und es wurde nichts getippt.**

---

## Teil 5 — Die installierte App

### 5a — Bauidentität

```
$ curl -s http://127.0.0.1:8765/hello
{"app":"chat-on-steroids","version":"2.0.2","build":"2.0.2+68dbff7","bridge":8,"compatible":false,"spoken":null,"paired":true,"disconnected":false}
```

**`build` lautet `2.0.2+68dbff7`** — ein Paketstand, kein `2.0.2-dev`.

```json
{"x":324,"height":700,"process":"Chat On Steroids","width":1080,"state":"open","y":184,"id":1627,"title":"Chat On Steroids 2.0.2+68dbff7"}
```

**Der Titel trägt dieselbe Zeichenkette.** Vierter Lauf in Folge, in dem der Fix hält.

`git rev-parse --short HEAD` sagt `cbfff76` — das ist `68dbff7` plus drei Commits, die
ausschließlich QA-Berichte hinzufügen. Kein Quell-, Skript- oder Erweiterungscode liegt dazwischen.

### 5b — Die Erweiterung, die Chrome geladen hat

```
realpath App-Ordner:  ~/Library/Application Support/chat-on-steroids/extension
Chrome, Profile 1:    mbnahooibdhapmjpipmphdoadlaojkpm  location=4 (entpackt)
                      path = ~/Library/Application Support/chat-on-steroids/extension
```

**Derselbe Ordner**, kein Symlink im Weg. Byte-Vergleich gegen diese Kasse, alle zehn Dateien:

```
IDENTISCH  browser-driver.js   IDENTISCH  content.js
IDENTISCH  background.js       IDENTISCH  fiber.js
IDENTISCH  popup.js            IDENTISCH  overlay.css
IDENTISCH  manifest.json       IDENTISCH  popup.css
IDENTISCH  popup.html          IDENTISCH  chatgpt-dom.js
```

**Chrome läuft auf genau diesem Stand.**

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
| `verify:browser --headed` | **37/37**, EXIT 0, kein FAIL, kein SKIP |
| Scroll-Richtung | **Beurteilt und bestanden**, `before=0 after=300` |
| Scroll-Screenshot | **Bestanden**: `scrollTop=1200, band expected at row 350, found rgb(40,95,246)` |
| Probe auf belebtem Schreibtisch | **Erreicht sein Urteil**: eigenes Fenster gewählt, Dichte 0,0234 gegen 0,0010, `PIXELS CONFIRM` |
| Zeiger: Antwortfeld | `"drawn"` innen, `"outside_region"` außen |
| Zeiger: Bild | Innen ein I-Balken bei ~320/205, erwartet 320,0/205,8. Außen kein Zeiger. **Feld und Bild stimmen überein** |
| Fokus-Klausel | `another window of the same application is in front (window 1691)` |
| `find_ui` auf den Container | Eigener Baum, 1402×136. `UIA_NO_OWN_WINDOW` nicht aufgetreten — und hier auch nicht auslösbar |
| Falscher Fensterschlüssel | **`BAD_REQUEST`** auf `find_ui`, `focus`, `capture` und `snapshot` |
| 3b: `kAXMain` setzbar? | Container **FALSE**, Hauptfenster **TRUE**, beide mit AXError 0 |
| 3b: Kosten | Attribut 0,05 ms je Fenster (< 2 ms für 26). Weg zum AX-Element: **112–117 ms** |
| Ziehen | **Ja** — beim zweiten Versuch, fünf Wegpunkte. Der erste scheiterte an zwei deckungsgleichen Fenstern |
| Eingabezaun | **Ja**, alle vier Ablehnungen namentlich |
| Erweiterung = diese Kasse? | **Ja**, alle zehn Dateien byte-identisch, derselbe Ordner |

---

## Was sonst auffiel

**Zwei deckungsgleiche Fenster einer Anwendung sind nicht ansteuerbar.** Das ist der Fund dieses
Laufs, und er ist keine Randbedingung, die ich mir gebaut habe — er ist mir passiert, weil ich im
letzten Lauf ein Finder-Fenster stehen ließ. Auf deinem Schreibtisch liegen gerade zwei weitere
solche Paare, die ich nicht angelegt habe:

```
  540x380 bei 400,207 "Chat On Steroids 2.0.2-arm64"   (zweimal)
  920x464 bei 404,168 "ChatGPT_HomeLab" / "package-macos-arm64-3"
```

Beim zweiten Paar unterscheiden sich die Titel, beim ersten nicht einmal das. Solange
`AXWindowNumber` fehlt, kann der Helfer keines von beiden bedienen — er lehnt ab, was besser ist
als danebenzugreifen, aber der Aufrufer hat keinen Weg vorwärts, den er selbst gehen könnte. Die
Meldung nennt auch nicht die Kandidaten, zwischen denen es mehrdeutig war; täte sie das, könnte ein
Aufrufer wenigstens eines verschieben oder schließen. **Der Titel liegt in `windows` bereits vor**
und wird bei der Zuordnung nicht herangezogen — beim zweiten Paar oben würde er reichen.

**Der Wächter, den zwei Runden diskutiert haben, ist toter Code.** `UIA_NO_OWN_WINDOW` sitzt hinter
`axWindowNumber(window) == row.id`, und dieses Attribut existiert auf macOS 27 nicht — 0 Treffer
über 26 Fenster aus 11 Prozessen, AXError −25205. Das ist keine Kritik am Wächter; es ist die
Antwort auf die Frage, warum er nie feuert, und sie ist eine andere als die im Kommentar.

**Die Bilder und die Prüfung sagen dasselbe.** Der Probe meldet `99 changed within 32px of the
pointer` — exakt die Zahl, die ich im letzten Lauf von Hand ausgerechnet hatte, als ich zeigte, was
das Urteil ohne die Cursorspalte gewesen wäre. Zwei unabhängige Wege, ein Wert.

**Ich habe im letzten Lauf zwei Fenster stehen lassen.** Sie haben diesen Lauf einen Fehlschlag
gekostet. Beide sind jetzt geschlossen — nicht per AppleScript, das bei Finder in dieser Sitzung
zweimal hängen blieb, sondern über den Helfer selbst: `focus` plus `command+w`, was nebenbei ein
brauchbarer Nachweis ist, dass der Pfad im Alltag trägt.

**Eine zsh-Falle, weil sie mich hier erwischt hat:** zsh trennt unquotierte Variablen nicht in
Wörter. `for id in $IDS` läuft einmal mit dem ganzen String, nicht je Element. In bash-Beispielen
aus der Dokumentation funktioniert das, hier nicht.

**Was ich nicht belegt habe.** Was das 53×48-Safari-Fenster bei −33,33 ist, das ebenfalls
`kAXMain settable = false` meldet, habe ich nicht verfolgt — nur, dass es existiert und dass ein
`focusable`-Feld es mitmarkieren würde. Ob `AXWindowNumber` auf älteren macOS-Versionen oder für
andere Anwendungsarten existiert, kann ich von hier aus nicht sagen; gemessen ist eine Maschine mit
macOS 27.0.0. Die Kette Modell → MCP → App aus `docs/qa/chatgpt-desktop-qa-prompt.md` ist nicht
angefasst worden, ebenso wenig der Onboarding-Schritt für die Rechte.
