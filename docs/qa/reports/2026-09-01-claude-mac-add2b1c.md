# macOS-Verifikation, sechs Teile — Lauf gegen `add2b1c`

**Datum:** 2026-09-01
**Zweig:** `integrate/browser-and-desktop-064733`
**Repository-Stand:** `0aab2ed` (= `add2b1c` plus sechs reine Berichts-Commits)
**Installierte App:** `2.0.2+add2b1c` — genau die Spitze
**Maschine:** macOS 27.0.0, arm64, ein Bildschirm 1728×1117 mit Skalierung 2, Node 22.23.2
**Rechte:** Screen Recording und Accessibility auf `Terminal.app`, beide erteilt

---

## Kurzfassung

**Drei Dinge, die repariert wurden, sind nachgeprüft und halten.** Der Titel-Tie-Break wirkt jetzt
auch bei Chrome, wo er zuvor wegen der Titeldekoration nichts tat. `focusableUnknown` unterscheidet
`ambiguous` von `unavailable` richtig — und `unavailable` ist zum ersten Mal überhaupt aufgetreten.
Der Probe räumt sein Fenster auf, statt es stehen zu lassen.

**Ein Fund, und er hängt an genau dieser Reparatur.** Der neue Fehlercode `UIA_AMBIGUOUS_WINDOW`
wurde aus `UIA_FAILED` herausgelöst, steht aber nicht in der Ausnahmeliste von `snapshot`
(`main.swift:2168–2171`). Ergebnis, an zwei Fenstern nebeneinander gemessen:

```
snapshot id=949  (mehrdeutig, neuer Code)     -> ok=false, error_code=UIA_AMBIGUOUS_WINDOW, image=null
snapshot id=2431 (unavailable, UIA_FAILED)    -> ok=true,  image={"width":1012,"height":766},
                                                 uiUnavailable={"code":"UIA_FAILED", …}
snapshot id=949  ohne includeUi                -> ok=true,  image={"height":760,"width":1080}
```

Dasselbe Fenster liefert sein Bild, sobald man den Baum nicht mitverlangt — und liefert gar nichts,
sobald man ihn verlangt und er mehrdeutig ist. Der Kommentar an der Stelle sagt ausdrücklich
„Screen capture is an independent capability… keep the already-valid image". Genau für den Fall,
der eben seinen eigenen Code bekommen hat, gilt das nicht mehr.

---

## Teil 0 — Rechte

```json
{"op":"warm"}
{"accessibilityPermission":true,"screenPermission":true,"ok":true,"ready":true}
```

Beide erteilt, an `Terminal.app`. Kein Teil unten ist deshalb unmessbar.

---

## Teil 1 — `npm run verify:ci`

**Grün beim ersten Lauf** — fünfte Runde in Folge.

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
37/37 checks passed
ECHTER EXIT=0
```

**Kein FAIL. Kein SKIP** — gezählt: `grep -cE "^(FAIL|SKIP)"` ergibt 0.

- **„a positive scroll_y moves the page down": bestanden**, `before=0 after=300`.
- **„the page sees a trusted wheel event going down": bestanden**, `wheel deltaY=6.327667236328125 trusted=true`.
- **Keine SKIP-Zeile.**
- **„a screenshot of a scrolled page shows where the page is": bestanden** —
  `scrollTop=1200, band expected at row 350, found rgb(40,95,246)`.
- `one screenshot pixel is one CSS pixel — {"png":{"w":1200,"h":819},"reported":{"w":1200,"h":819},"viewport":{…,"ratio":2}}`

---

## Teil 2b — `node scripts/probe-macos-helper.mjs arm64`

**Auf dem belebten Schreibtisch gelaufen:** 39 Fenster, keines minimiert.

10 von 10, `ECHTER EXIT=0`:

```
ok    it lists windows to capture — ok
      39 windows listed, 39 not minimized
      window 2450 "cos-probe-window.txt" at 330,228 656x422
ok    it captures the window again — ok
      second capture pointer=outside_region
      image 640x412, 351 pixels differ, box {"x":8,"y":9,"width":316,"height":207}
      pointer was expected near 320,206
      99 changed within 32px of the pointer, 252 elsewhere (density 0.0234 vs 0.0010)
      PIXELS CONFIRM the pointer is drawn, at the position it was moved to
```

**Was sich gegenüber der Ankündigung des Skripts verhält statt sich zu verweigern:** die
Bildschirmaufnahme (`pointer=system`) und die Fensteraufnahme mit handkompositiertem Zeiger
(`pointer=drawn`).

**Das Aufräumen funktioniert jetzt.** TextEdit-Fenster vor und nach dem Lauf gezählt:

```
vorher (8):  …-1f9cc17-QA.md | Sichern | QA Chat On Steroids 2 | pointer-doc.txt |
             …-2a80994-QA.md | QA Chat On Steroids | cos-probe-window.txt | qa-long.txt
nachher (7): dieselben, ohne cos-probe-window.txt
```

Kein `-128` mehr in der Ausgabe, und das Fenster ist weg — auch das, das der vorige Lauf
hinterlassen hatte, denn der Probe hat es wiederverwendet und am Ende geschlossen. Der modale
Sicherungsdialog eines fremden Dokuments stand dabei die ganze Zeit offen und hat den Abschluss
nicht mehr blockiert.

---

## Teil 2c — Der Zeiger, im Bild

TextEdit-Dokumentfenster, id 2324, bei 214,112, 656×422.

**Fall 1 — Zeiger in der Fenstermitte (542,323):** `POINTER-FELD: "drawn"`

**Das Bild:** ein Zeiger ist sichtbar — **kein Pfeil, sondern ein I-Balken**, der Textcursor über
einem Textbereich. Erwartet bei (320,0 / 205,8); dort sitzt er.

**Fall 2 — Zeiger außerhalb (1070,152):** `POINTER-FELD: "outside_region"`

**Das Bild:** kein Zeiger, an keiner Stelle.

```
A 640x412 ch4 | B 640x412 ch4
abweichende Pixel: 342
Bounding-Box: x 32..323  y 9..215
inside  PNG-Kopf: 640 x 412
outside PNG-Kopf: 640 x 412
```

**Feld und Bild stimmen überein, in beiden Fällen.** Siebter Lauf in Folge.

---

## Teil 3a — Fokus, bestätigt

```
--- 2. op:focus id=2650 ---
{"foreground":2650,"focused":true,"ok":true}
--- 3. act/focus auf 2650 ---
{"cursor":{"x":1070,"y":152},"ok":true,"completed_count":1,"routes":["focus"],"foreground":2650}
--- 4. Cmd+L ---
{"cursor":{"y":152,"x":1070},"foreground":2650,"completed_count":2,"ok":true,"routes":["focus","sendinput"]}
--- 5. Chrome-Fenster ---
    {"y":126,"x":200,"height":136,"process":"Google Chrome","width":874,"title":"Google Chrome window","id":2652,"state":"open"}
    {"width":1200,"height":800,"y":100,"process":"Google Chrome","title":"Example Domain","x":100,"id":2650,"state":"foreground"}
--- 6. act/focus auf den Container 2652 ---
{"ok":false,"completed_count":0,"error_code":"FOCUS_FAILED","message":"the requested window could not be activated: another window of the same application is in front (window 2650)"}
--- 6b. op:focus id=2652 ---
{"ok":true,"foreground":2650,"focused":false}
--- 7. Escape mit vorangehendem focus ---
{"cursor":{"x":1070,"y":152},"ok":true,"completed_count":2,"foreground":2650,"routes":["focus","sendinput"]}
```

**Die abweisende Klausel, wörtlich:**

> `the requested window could not be activated: another window of the same application is in front (window 2650)`

Fenster 2650 ist das Hauptfenster und steht in `{"op":"windows"}`. Der Container maß **874×136**,
genau wie die aktualisierte Anleitung es nun sagt.

**`find_ui` unter `id` — der eigene Baum:** `ok=true`, 12 Elemente, Maße
`874x136, 842x92, 832x34, 842x50, 842x40, 826x40, 392x0` — alles Maße des Containers.
**`UIA_NO_OWN_WINDOW` ist nicht aufgetreten.**

**Der falsche Schlüssel wird auf allen vier Operationen abgelehnt** — `find_ui`, `focus`, `capture`,
`snapshot`, jedes Mal `BAD_REQUEST`.

---

## Teil 3b — Die Punkte im Einzelnen

### Der Titel-Tie-Break, jetzt gegen Chrome geprüft

Das ist der Fall, für den er geschrieben wurde und in dem er zuletzt nichts tat. Zwei
Chrome-Fenster, beide **800×550 bei 400,300**, verschiedene Titel:

```
   {"id":2650,"title":"Example Domain","y":300,"x":400,"width":800,"height":550,"state":"open"}
   {"id":2781,"title":"Informationen zur Version","y":300,"x":400,"width":800,"height":550,"state":"foreground"}
```

```
--- act/focus 2650 ---   {"completed_count":1,"routes":["focus"],"foreground":2650,"ok":true}
    active:              2650 "Example Domain"
--- act/focus 2781 ---   {"routes":["focus"],"completed_count":1,"foreground":2781,"ok":true}
    active:              2781 "Informationen zur Version"
--- op:focus beide ---   {"ok":true,"focused":true,"foreground":2650}
                         {"ok":true,"focused":true,"foreground":2781}
```

**Beide Fenster lassen sich einzeln ansteuern**, und `active` bestätigt jedes Mal, dass das
gemeinte nach vorn kam. `find_ui` liefert für jedes den eigenen Baum, und dort sieht man die
Ursache des alten Fehlers unmittelbar:

```
find_ui id=2650  -> erstes Element: "Example Domain - Google Chrome – mydealz"
find_ui id=2781  -> erstes Element: "Informationen zur Version - Google Chrome – mydealz"
```

Der AX-Titel trägt Browsernamen und Profil angehängt, der Listentitel nicht. Auf Gleichheit
verglichen hätte hier nie etwas gepasst; die Enthaltensein-Relation greift.

### Der Finder-Zug, erneut und weiterhin im ersten Anlauf

Zwei Finder-Fenster, beide **800×550 bei 300,200**, Titel `cos-a-r12` und `cos-b-r12`.
`find_ui` trennt sie, und dann, ohne dass etwas verschoben wurde:

```json
{"op":"act","targetWindow":2791,"actions":[{"type":"focus","window":2791},
 {"type":"drag","xs":[621,700,800,900,981],"ys":[372,420,480,530,572],"button":"left"}]}
{"ok":true,"foreground":2791,"completed_count":2,"routes":["focus","sendinput"],"cursor":{"y":572,"x":981}}
```

```
vorher:  ziehmich.txt ZielOrdner  | Ziel: (leer)
nachher: ZielOrdner               | Ziel: ziehmich.txt
```

**Erster Anlauf, Datei bewegt, fünf Punkte im Pfad.**

### `focusableUnknown` — jetzt richtig, und `unavailable` erstmals gesehen

Über 41 Fenster:

```
Verteilung: {"true":32,"false":1,"null":8}

  id= 2431 TextEdit 506x383 bei 495,252 "Sichern"                      focusable=null unknown="unavailable"
  id= 2259 Finder   540x380 bei 400,207 "Chat On Steroids 2.0.2-arm64" focusable=null unknown="ambiguous"
  id= 1952 Finder   540x380 bei 400,207 "Chat On Steroids 2.0.2-arm64" focusable=null unknown="ambiguous"
  id= 1409 Finder   540x380 bei 400,207 "Chat On Steroids 2.0.2-arm64" focusable=null unknown="ambiguous"
  id=  949 Finder   540x380 bei 400,207 "Chat On Steroids 2.0.2-arm64" focusable=null unknown="ambiguous"
  id= 2601 Finder   540x380 bei 400,207 "Chat On Steroids 2.0.2-arm64" focusable=null unknown="ambiguous"
  id= 1407 Finder   920x464 bei 404,168 "Downloads"                    focusable=null unknown="ambiguous"
  id=  788 Finder   920x464 bei 404,168 "Downloads"                    focusable=null unknown="ambiguous"
  id= 1685 Safari   53x48   bei -33,62  "Safari window"                focusable=false
```

**Der Sicherungsdialog liest jetzt `unavailable`** statt wie im letzten Lauf `ambiguous`. Die
beiden Fehlercodes dahinter sind nun getrennt:

```
find_ui id=2431 -> {"error_code":"UIA_FAILED","message":"no accessibility window convincingly matches window 2431"}
find_ui id=949  -> {"error_code":"UIA_AMBIGUOUS_WINDOW","message":"window 949 cannot be told apart from another window of the same application: …"}
```

In zwei Läufen über 35 und 37 Fenster war `unavailable` nie aufgetreten; hier ist es das erste Mal.
Das Feld steht weiterhin nur neben `null` — geprüft.

### Die Ablehnung bei gleichem Titel

Fünf deckungsgleiche DMG-Fenster, alle „Chat On Steroids 2.0.2-arm64" bei 400,207. Die Ablehnung
nennt vier Kandidaten mit Titel, Maßen und Position und sagt, was zu tun ist — unverändert richtig,
nur unter neuem Code.

### Die Zeiten

Fünf Durchläufe je Form im Wechsel, 41 Fenster:

```
{"op":"windows"}                      min 19.9 ms, median 32.0 ms, max 248.2 ms
{"op":"windows","focusable":true}     min 158.0 ms, median 159.7 ms, max 192.0 ms
Aufschlag (Median):                   127.8 ms
```

Dritter Punkt auf derselben Kurve: 60 ms bei 28 Fenstern, 109 ms bei 35, 128 ms bei 41. Der
Aufschlag wächst mit der Liste, die einfache Form bleibt bei etwa 32 ms. Die Opt-in-Entscheidung
trägt weiterhin.

### Und der Fund: `snapshot` verliert sein Bild

Der neue Code steht nicht in der Liste, die `snapshot` durchwinkt
(`main.swift:2168–2171`: `ACCESSIBILITY_PERMISSION_REQUIRED`, `UIA_FAILED`, `UIA_NO_OWN_WINDOW`,
`UIA_TIMEOUT`). Zwei Fenster, derselbe Aufruf:

```
{"op":"snapshot","id":949,"includeScreenshot":true,"includeUi":true}
   ok=false | error_code=UIA_AMBIGUOUS_WINDOW | image=null | uiUnavailable=null

{"op":"snapshot","id":2431,"includeScreenshot":true,"includeUi":true}
   ok=true | image={"width":1012,"height":766} | uiUnavailable={"code":"UIA_FAILED","message":"no accessibility window convincingly matches window 2431"}

{"op":"snapshot","id":949,"includeScreenshot":true}          (ohne includeUi)
   ok=true | image={"height":760,"width":1080}
```

Der Unterschied zwischen der ersten und der zweiten Zeile ist ausschließlich der Fehlercode; der
Unterschied zwischen der ersten und der dritten ist ausschließlich `includeUi`. Ein Aufrufer, der
ein Bild und einen Baum anfordert, bekommt bei einem mehrdeutigen Fenster **weder noch**, obwohl
das Bild verfügbar wäre — und die Ablehnung rät ihm, ein Fenster zu verschieben, wozu er das Bild
gerade gebrauchen könnte.

---

## Teil 4 — Eingabe, unterhalb der App

### 4a — Ein Ziehen, das etwas bewegt

Gemessen als Teil von 3b. **Datei bewegt, fünf Punkte im Pfad, erster Anlauf.** Symbolpositionen
über `{"op":"find_ui","id":2791,…}` bestimmt, nicht geschätzt.

### 4b — Tippen, wo es hingezielt war

```
00000000: 5275 6e64 6520 3132 20e2 8094 2055 6d6c  Runde 12 ... Uml
00000010: 6175 7465 3a20 c3a4 20c3 b620 c3bc 20c3  aute: .. .. .. .
00000020: 9f0a 5a77 6569 7465 205a 6569 6c65 206e  ..Zweite Zeile n
00000030: 6163 6820 556d 6272 7563 68              ach Umbruch
```

Zeichengenau, inklusive `0a` für den Umbruch, der UTF-8-Umlaute und des Geviertstrichs `e28094`.

### 4c — Der Eingabezaun

Mit TextEdit-Fenster 2324 im Vordergrund:

```
--- targetWindow=2791 (Finder), Text ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"message":"window 2791 is no longer the exact active input target (another application is frontmost); no input was sent"}

--- targetWindow=2325 (anderes TextEdit-Fenster), Text ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"message":"window 2325 is no longer the exact active input target (another window of the same application is in front (window 2324)); no input was sent"}

--- targetWindow=2325, Tastendruck ---
{"error_code":"INPUT_TARGET_LOST","ok":false,"completed_count":0,"message":"window 2325 is no longer the exact active input target (another window of the same application is in front (window 2324)); no input was sent"}

--- Klick bei 5,5, geleast auf 2324 ---
{"error_code":"OUTSIDE_TARGET_WINDOW","ok":false,"completed_count":0,"message":"click at 5,5 is outside window 2324, which this batch is leased to (214,112 656x422). No input was sent. …"}
```

**Alle vier lehnen namentlich ab, und es wurde nichts getippt.**

---

## Teil 5 — Die installierte App

### 5a — Bauidentität

```
$ curl -s http://127.0.0.1:8765/hello
{"app":"chat-on-steroids","version":"2.0.2","build":"2.0.2+add2b1c","bridge":8,"compatible":false,"spoken":null,"paired":true,"disconnected":false}
```

**`build` lautet `2.0.2+add2b1c`** — ein Paketstand, kein `2.0.2-dev`, **und genau die Spitze.**

```json
{"title":"Chat On Steroids 2.0.2+add2b1c","process":"Chat On Steroids","width":1080,"y":184,"height":700,"id":2618,"x":324,"state":"open"}
```

**Der Titel trägt dieselbe Zeichenkette.** Siebter Lauf in Folge.

`git rev-parse --short HEAD` sagt `0aab2ed` = `add2b1c` plus sechs reine Berichts-Commits;
`git diff --name-only add2b1c..HEAD` liefert ausschließlich `docs/`.

### 5b — Die Erweiterung, die Chrome geladen hat

**Derselbe Ordner**, kein Symlink im Weg, alle zehn Dateien byte-identisch mit dieser Kasse.

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
| Probe auf belebtem Schreibtisch | **Erreicht sein Urteil** aus 39 Fenstern; räumt sein Fenster jetzt auf |
| Zeiger: Antwortfeld | `"drawn"` innen, `"outside_region"` außen |
| Zeiger: Bild | I-Balken bei ~320/205, erwartet 320,0/205,8. Außen kein Zeiger. **Beide stimmen überein** |
| Fokus-Klausel | `another window of the same application is in front (window 2650)` |
| Titel-Tie-Break bei **Chrome** | **Besteht jetzt.** Beide deckungsgleichen Fenster einzeln ansteuerbar |
| Titel-Tie-Break bei Finder | **Besteht**, Zug im ersten Anlauf |
| `focusableUnknown` | **Richtig.** Sicherungsdialog `unavailable`, sieben mehrdeutige `ambiguous` |
| `snapshot` bei Mehrdeutigkeit | **Verliert sein Bild** — neuer Code fehlt in der Ausnahmeliste |
| Ziehen | **Ja**, fünf Wegpunkte, erster Anlauf |
| Eingabezaun | **Ja**, alle vier Ablehnungen namentlich |
| Erweiterung = diese Kasse? | **Ja**, alle zehn Dateien byte-identisch, derselbe Ordner |

---

## Was sonst auffiel

**Ein neuer Fehlercode braucht eine Durchsicht aller Stellen, die den alten aufzählen.**
`UIA_AMBIGUOUS_WINDOW` aus `UIA_FAILED` herauszulösen hat `focusableUnknown` repariert und
`snapshot` gebrochen, weil dort eine Liste von Codes steht statt einer Eigenschaft. Eine Prüfung
auf „ist das ein Fehler der nur den AX-Baum betrifft" statt einer Aufzählung wäre gegen die nächste
Aufspaltung unempfindlich.

**Mein eigener Bericht der letzten Runde war beim Start dieser Runde verschwunden.** Der
Arbeitsbaum war sauber, die Datei fehlte, und sie lag in `stash@{0}` — ein externes
`git pull --rebase` hat den vorgemerkten Stand mit Autostash beiseitegelegt und nicht
zurückgeholt. Ich habe sie aus dem Stash-Commit wiederhergestellt und committet. Zwei Stashes
liegen noch da; beide enthalten nur Berichte, die inzwischen im Baum sind.

**Mein Testaufbau für Chrome hat ein zweites Fenster mit `chrome://version` gebraucht**, weil
`example.com` und `example.org` beide den Titel „Example Domain" tragen. Wer diesen Fall
nachstellt, sollte die Titel prüfen statt sie anzunehmen — mein erster Versuch hatte zwei Fenster
mit identischem Titel und hätte den Tie-Break gar nicht geprüft.

**Auf dem Schreibtisch liegen inzwischen fünf deckungsgleiche DMG-Fenster** — „Chat On Steroids
2.0.2-arm64", alle 540×380 bei 400,207, eines mehr als letzte Runde. Sie sind nicht von mir; jeder
Installationslauf legt offenbar eines dazu. Sie sind zugleich der bequemste Testfall für die
Mehrdeutigkeit, aber sie werden mehr.

**Der modale Sicherungsdialog für dein Dokument „QA Chat On Steroids 2" steht weiterhin offen.**
Ich habe ihn wieder nicht angefasst — dort hängen ungesicherte Änderungen dran. Er ist inzwischen
der einzige Fall auf dieser Maschine, an dem sich `focusableUnknown: "unavailable"` überhaupt
beobachten lässt.

**Die einfache `windows`-Form hat zum dritten Mal einen Ausreißer**: 248 ms bei einem Median von
32 ms, davor 294 ms und 245 ms. Dreimal beobachtet, Ursache nicht verfolgt.

**Was ich nicht belegt habe.** Ob `snapshot` vor dieser Aufspaltung bei einem mehrdeutigen Fenster
tatsächlich sein Bild lieferte, habe ich nicht gemessen — ich habe nur gemessen, dass es das heute
für den `UIA_FAILED`-Fall tut und für den neuen Code nicht. Was das 53×48-Safari-Fenster bei
−33,62 ist, das als einziges `focusable: false` meldet, habe ich weiterhin nicht verfolgt. Die
Kette Modell → MCP → App aus `docs/qa/chatgpt-desktop-qa-prompt.md` ist nicht angefasst worden.
