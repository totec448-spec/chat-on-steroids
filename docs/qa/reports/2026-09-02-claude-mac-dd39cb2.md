# macOS-Verifikation, sechs Teile — Lauf gegen `dd39cb2`

**Datum:** 2026-09-02
**Zweig:** `integrate/browser-and-desktop-064733`
**Repository-Stand:** `58227ed` (= `dd39cb2` plus zwei Berichts-Commits)
**Installierte App:** `2.0.2+95984b9` — zwischen ihrem Stand und HEAD ändert sich nur `docs/`
**Maschine:** macOS 27.0.0, arm64, ein Bildschirm 1728×1117 mit Skalierung 2, Node 22.23.2
**Rechte:** Screen Recording und Accessibility auf `Terminal.app`, beide erteilt

---

## Kurzfassung

**Alles Gestellte besteht, und zwei alte offene Punkte sind entschieden.**

**Fund 1 ist erklärt — durch Messung, nicht durch Argument.** Ich habe Read-only umgelegt und
beide Zustände nebeneinander gemessen: mit Read-only **an** zeigt der Setup-Schritt **nur** Screen
Recording (null Treffer für „Accessibility"), mit Read-only **aus** zeigt er **beide** Zeilen, beide
„Granted". Genau das sagt die Erklärung im Dokument voraus. Dazu ein Beleg, der es unabhängig
stützt: die App schreibt in ihr eigenes Protokoll
`macos permissions screen=granted accessibility=granted execution=in-process` — sie kennt beide
Rechte durchgehend, die Zeile fehlt nur dort, wo sie nichts anzufragen hat. **Kein Befund.**

**Der Darstellungsfehler im Permissions-Kasten ist behoben.** Der Read-only-Hinweis steht jetzt in
vier Zeilen sauber **über** der ersten Rechte-Zeile, die vollständig sichtbar ist samt Schalter —
in beiden Zuständen geprüft, mit Read-only an und aus, bei Standardfenstergröße.

**Die Streuschlüssel-Regel greift jetzt bei allen dreien**, jeweils mit einer eigenen, passenden
Meldung:

```
{"op":"warm","verification":{}}            -> warm does not recognize `verification`. It takes no fields beyond `op`.
{"op":"cursor","quatschSchluessel":1}      -> cursor does not recognize `quatschSchluessel`. It takes no fields beyond `op`.
{"op":"windows","quatschSchluessel":true}  -> windows does not recognize `quatschSchluessel`. It reads `focusable` only, besides `op`.
```

**Und der Zug geht wieder im ersten Anlauf**, auch bei zwei deckungsgleichen Finder-Fenstern. Der
Fehlschlag von vor zwei Runden bleibt damit unreproduziert — zwei Läufe in Folge.

---

## Teil 0 — Übersetzung und Rechte

```
$ npm run desktop:mac
gyp info ok
macOS arm64 desktop helper, in-process library and Node addon built and verified.
ECHTER EXIT=0
```

**Übersetzt fehlerfrei** — die Ausgabe enthält null Zeilen mit „error", kein `swiftc`-Fehler.

```json
{"op":"warm"}
{"ready":true,"screenPermission":true,"ok":true,"accessibilityPermission":true}
```

Beide Rechte erteilt, an `Terminal.app`. Kein Teil unten ist deshalb unmessbar.

---

## Teil 1 — `npm run verify:ci`

**Grün beim ersten Lauf** — zehnte Runde in Folge.

```
 Test Files  74 passed | 3 skipped (77)
      Tests  1880 passed | 97 skipped (1977)
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
- **„the page sees a trusted wheel event going down": bestanden**, `wheel deltaY=6.55780029296875 trusted=true`.
- **Keine SKIP-Zeile.**
- **„a screenshot of a scrolled page shows where the page is": bestanden** —
  `scrollTop=1200, band expected at row 350, found rgb(40,95,246)`.
- `one screenshot pixel is one CSS pixel — {"png":{"w":1200,"h":815},"reported":{"w":1200,"h":815},"viewport":{…,"ratio":2}}`

---

## Teil 2b — `node scripts/probe-macos-helper.mjs arm64`

**Auf dem belebten Schreibtisch:** 39 Fenster, davon vierzehn TextEdit- und elf Finder-Fenster,
Chrome, zwei Safari, zwei UTM, ChatGPT, Spark, vier Terminals.

10 von 10, `ECHTER EXIT=0`:

```
      39 windows listed, 39 not minimized
      window 4540 "cos-probe-window.txt" at 562,460 656x422
      99 changed within 32px of the pointer, 248 elsewhere (density 0.0234 vs 0.0010)
      PIXELS CONFIRM the pointer is drawn, at the position it was moved to
```

Sein eigenes Fenster aus 39, dieselben 99 Pixel wie in den acht Läufen davor, kein
zurückgelassenes Fenster.

**Was sich gegenüber der Ankündigung des Skripts verhält statt sich zu verweigern:** die
Bildschirmaufnahme (`pointer=system`) und die Fensteraufnahme mit handkompositiertem Zeiger
(`pointer=drawn`) — beide brauchen das Screen-Recording-Recht.

---

## Teil 2c — Der Zeiger, im Bild

TextEdit-Fenster 4545.

**Innen:** `POINTER-FELD: "drawn"` — im Bild ein **I-Balken**, der Textcursor über einem
Textbereich, an der erwarteten Stelle (~320/205 gegen erwartete 320,0/205,8). Kein Pfeil, und das
ist hier das richtige Ergebnis.
**Außen:** `POINTER-FELD: "outside_region"` — im Bild kein Zeiger, an keiner Stelle.

```
abweichende Pixel: 342 | Bounding-Box: x 8..323  y 9..215
```

**Feld und Bild stimmen überein.** Zwölfter Lauf in Folge.

---

## Teil 3a — Fokus

```
--- op:focus id=4525 ---   {"ok":true,"focused":true,"foreground":4525}
--- act/focus ---          {"routes":["focus"],"ok":true,"completed_count":1,"foreground":4525}
--- Cmd+L ---              {"routes":["focus","sendinput"],"ok":true,"completed_count":2}
--- Chrome-Fenster ---
    {"y":59,"state":"open","x":100,"id":4527,"width":1402,"height":136,"title":"Google Chrome window"}
    {"id":4525,"height":1000,"x":0,"state":"foreground","title":"Example Domain","y":33,"width":1728}
--- act/focus auf den Container 4527 ---
{"message":"the requested window could not be activated: another window of the same application is in front (window 4525)","ok":false,"error_code":"FOCUS_FAILED"}
--- op:focus id=4527 ---   {"ok":true,"foreground":4525,"focused":false}
```

**Die abweisende Klausel, wörtlich:**

> `the requested window could not be activated: another window of the same application is in front (window 4525)`

Fenster 4525 ist das Hauptfenster und steht in `{"op":"windows"}`. Der Container maß **1402×136** —
so breit wie sein Elternfenster.

**`find_ui` unter `id`:** `ok=true`, 12 Elemente, Maße `1402x136, 1370x92, 1360x34, 1370x50,
1370x40, 1354x40, 920x0` — alles Maße des Containers. **`UIA_NO_OWN_WINDOW` tritt nicht auf.**

**Der falsche Fensterschlüssel wird auf allen vier Operationen abgelehnt:** `find_ui`, `focus`,
`capture`, `snapshot`, jedes Mal `BAD_REQUEST`.

**`focusable`:** Container `false`, Hauptfenster `true`.

---

## Teil 3b — Die Punkte im Einzelnen

**Der Zug bei zwei deckungsgleichen Fenstern, verschiedene Titel** — `cos-a-r17` und `cos-b-r17`,
beide 800×550 bei 300,200:

```
vorher:  ziehmich.txt ZielOrdner  | Ziel: (leer)
{"completed_count":2,"foreground":4550,"cursor":{"x":981,"y":572},"routes":["focus","sendinput"],"ok":true}
nachher: ZielOrdner               | Ziel: ziehmich.txt
```

**Erster Anlauf, nichts verschoben, Datei bewegt, fünf Punkte im Pfad.**

**`focusable` über 41 Fenster:**

```
Verteilung: {"true":38,"false":1,"null":2}
  id= 1407 Finder  920x464  "Downloads"      focusable=null  unknown="ambiguous"
  id=  788 Finder  920x464  "Downloads"      focusable=null  unknown="ambiguous"
  id= 1685 Safari  53x48    "Safari window"  focusable=false
```

Die beiden `null` sind ein deckungsgleiches Paar bei 404,168 und lesen korrekt `ambiguous`.

**Die Ablehnung bei gleichem Titel nennt die Kandidaten:**

```
{"op":"find_ui","id":1407,"query":""}
{"ok":false,"error_code":"UIA_AMBIGUOUS_WINDOW","message":"window 1407 cannot be told apart from another window of the same application: \"Downloads\" 920x464 at 404,168; \"Downloads\" 920x464 at 404,168. Nothing was done. Nothing here can address them apart either — a focus would meet the same ambiguity — so move or close one of them from the application itself, then ask again."}
```

**Und `snapshot` behält dabei sein Bild** — frei mitgenommen, wie vorgeschlagen:

```
{"op":"snapshot","id":1407,"includeScreenshot":true,"includeUi":true}
  ok=true | image={"width":1280,"height":646}
  uiUnavailable={"code":"UIA_AMBIGUOUS_WINDOW", …}
```

**Die Zeiten**, 42 Fenster: Aufschlag im Median **132,7 ms** (43,6 → 176,4 ms). Die einfache Form
trägt das Feld nicht. Achter Punkt auf der Kurve: 60 / 109 / 128 / 106 / 77 / 82 / 128 / 133 ms bei
28 / 35 / 41 / 37 / 32 / 35 / 37 / 42 Fenstern.

---

## Teil 4 — Eingabe

### 4a — Ein Ziehen, das etwas bewegt

Siehe 3b: **Datei bewegt, fünf Punkte im Pfad, erster Anlauf.** Symbolpositionen über `find_ui`
bestimmt, nicht geschätzt.

### 4b — Tippen, wo es hingezielt war

```
Datei: "Runde 17 — Umlaute: ä ö ü ß\nZweite Zeile nach Umbruch"
Hex  : 52 75 6e 64 65 20 31 37 20 e2 80 94 20 55 6d 6c 61 75 74 65 3a 20 c3 a4 20
       c3 b6 20 c3 bc 20 c3 9f 0a 5a 77 65 69 74 65 20 5a 65 69 6c 65 20 6e 61 63 68 20 55 6d 62 72 75 63 68
```

Zeichengenau, inklusive `0a` für den Umbruch, der UTF-8-Umlaute (`c3a4` ä, `c3b6` ö, `c3bc` ü,
`c39f` ß) und des Geviertstrichs `e28094`.

### 4c — Der Eingabezaun

Mit TextEdit-Fenster 4558 im Vordergrund, fünf Formen:

```
Finder, Text      INPUT_TARGET_LOST  "window 4550 … (another application is frontmost); no input was sent"
TextEdit, Text    INPUT_TARGET_LOST  "window 4545 … (another window of the same application is in front (window 4558)); no input was sent"
TextEdit, Taste   INPUT_TARGET_LOST  dieselbe Klausel
TextEdit, Scroll  INPUT_TARGET_LOST  dieselbe Klausel
Klick ausserhalb  OUTSIDE_TARGET_WINDOW  "click at 5,5 is outside window 4558, which this batch is leased to (591,489 656x422)"
```

**Alle fünf lehnen namentlich ab, und nichts wurde getippt oder gescrollt.**

---

## Teil 5 — Die installierte App

```
$ curl -s http://127.0.0.1:8765/hello
{"app":"chat-on-steroids","version":"2.0.2","build":"2.0.2+95984b9","bridge":8,"compatible":false,"spoken":null,"paired":true,"disconnected":false}
```

**`build` lautet `2.0.2+95984b9`** — ein Paketstand, kein `2.0.2-dev`. Der Fenstertitel:
`Chat On Steroids 2.0.2+95984b9` — **dieselbe Zeichenkette.** Zwölfter Lauf in Folge.

`git rev-parse --short HEAD` sagt `58227ed`. Zwischen dem Stand der App und HEAD ändert sich
**ausschließlich `docs/`** — kein ausgelieferter Code.

**Erweiterung:** derselbe Ordner (`~/Library/Application Support/chat-on-steroids/extension`,
Realpfad identisch, kein Symlink), **alle zehn Dateien byte-identisch** mit dieser Kasse.

**Manifest:** `permissions = ["storage","scripting","alarms","debugger"]`,
`optional_permissions = ["tabs","tabGroups"]` — **`debugger` steht richtig.**

---

## Teil 5b — Der Permissions-Kasten und Fund 1

### Der Darstellungsfehler ist behoben — in beiden Zuständen geprüft

Der Read-only-Hinweis steht in vier Zeilen **über** der Liste:

> Read-only disables file changes, commands, browser control, mouse/keyboard input and clipboard
> writes at once, regardless of which boxes below are checked — screenshots and reads still work.
> Turn it back off here to restore write access; nothing else can.

Darunter beginnt die Liste mit einer **vollständig sichtbaren** ersten Zeile samt Schalter. Nichts
überlagert, nichts klippt, bei Standardfenstergröße (1080×700).

**Mit Read-only an:** erste Zeile „Look at files — 4 permissions" voll sichtbar, „Change files"
darunter korrekt ausgegraut mit „off in read-only mode".
**Mit Read-only aus:** erste Zeile ebenso voll sichtbar, alle drei Zeilen aktiv.

### Fund 1: erklärt, und diesmal gemessen

Ich habe Read-only umgelegt und den Setup-Schritt in beiden Zuständen abgefragt:

```
Read-only AN
  "Screen Recording"     -> 1 Treffer: "Screen Recording"
  "Accessibility"        -> 0 Treffer
  "Everything this Mac"  -> 1 Treffer: "Everything this Mac needs to grant has been granted."

Read-only AUS
  "Screen Recording"     -> 1 Treffer: "Screen Recording"
  "Accessibility"        -> 1 Treffer: "Accessibility"
  "Everything this Mac"  -> 1 Treffer: "Everything this Mac needs to grant has been granted."
```

Im Bild mit Read-only aus:

> **Allow desktop access** — Everything this Mac needs to grant has been granted.
> ● **Screen Recording** — Needed to take a screenshot or read what is on screen. — *Granted*
> ● **Accessibility** — Needed to click, type and inspect controls in other applications. — *Granted*

**Genau die Vorhersage der Erklärung.** Die Überschrift greift nicht zu weit: sie deckt jeweils
das ab, was gerade angefordert wird.

**Und ein unabhängiger Beleg**, den ich beim Durchsuchen des Fensterbaums gefunden habe — die App
schreibt in ihr eigenes Aktivitätsprotokoll:

```
macos permissions screen=granted accessibility=granted execution=in-process
```

Sie liest also durchgehend **beide** Rechte; die zweite Zeile fehlt nur in der Anzeige, und nur
dann, wenn sie nichts anzufragen hat. **Fund 1 ist damit kein Befund mehr.**

Read-only steht wieder auf **aus**, wie ich es vorgefunden habe — gegengeprüft: null Treffer für
„off in read-only mode".

### Fund 2 — nachgeholt, und die Vermutung im Auftrag stimmt

Maxim hat die beiden Anmeldungen an der Tastatur übernommen, damit dieser Teil laufen konnte.
Screen Recording für „Chat On Steroids" in den Systemeinstellungen entzogen, bei macOS' Rückfrage
**„Später"** gewählt, damit die App weiterläuft — und dann gemessen.

**Der laufende Prozess sieht den Entzug nicht.** Über vier Minuten hinweg, mit Navigation zum
Setup-Schritt und wiederholtem Abfragen des Fensterbaums:

> **Allow desktop access** — Everything this Mac needs to grant has been granted.
> ● **Screen Recording** — … — *Granted*
> ● **Accessibility** — … — *Granted*

Beide Zeilen grün, die Überschrift unverändert. **Und die App liest dabei durchgehend nach:** ihr
Aktivitätsprotokoll zeigt alle fünf bis sechs Sekunden `desktop timing op=warm`, also einen
frischen Aufruf an ihren Helfer. Sie fragt, und sie bekommt weiterhin „granted".

**Der frisch gestartete Prozess sieht ihn sofort.** Dieselbe App beendet und neu geöffnet, bei
unverändertem Systemzustand:

```
"Not granted"           -> 1 Treffer
"1 of 2 granted. macOS asks for these one at a time, and each is a diff…"
"Open Screen Recording" -> 1 Treffer  (Knopf, der vorher nicht existierte)
"Everything this Mac"   -> 0 Treffer
```

Im Bild: **Screen Recording — Not granted** (roter Punkt) neben **Accessibility — Granted**
(grüner Punkt).

**Damit ist die Frage des Auftrags beantwortet, und zwar in seinem Sinne:** der frische Prozess
liest die Wahrheit, der laufende nicht. **Das ist macOS, das seine Antwort pro Prozess festhält —
nicht diese App, die zu selten nachsieht.**

**Und die App weiß es selbst.** Im nicht erteilten Zustand steht im Kasten darunter:

> „Already switched this on in System Settings? macOS keeps its old answer for as long as the app
> is running. Fully quit Chat On Steroids and open it again to pick up the change."

Das ist zugleich die Antwort auf **„Der Neustart-Hinweis verdient seinen Platz oder nicht"**: er
erscheint genau in dem Zustand, in dem er gebraucht wird, und er beschreibt genau das Verhalten,
das ich gerade gemessen habe. Im erteilten Zustand ist er nicht da. **Er verdient seinen Platz.**

**Die Gegenrichtung ebenfalls gemessen.** Berechtigung wieder erteilt, erneut „Später" gewählt,
damit die App weiterläuft — und dann über zwei Minuten beobachtet:

```
  +10s … +110s: "Not granted"=1   "1 of 2 granted"=1
  +120s:        (kurzer Aussetzer beim Neuzeichnen)
  danach:       "Not granted"=1   "1 of 2 granted"=1   "Already switched…"=1
```

**Der laufende Prozess sieht auch die Erteilung nicht** — über zwei Minuten hinweg nicht. Erst
nach einem Neustart der App verschwindet der rote Punkt. Die Zwischenspeicherung wirkt also in
**beide** Richtungen.

**Ein Widerspruch zu meiner eigenen früheren Messung, den ich benennen muss.** Am 31. August habe
ich am **Helfer** gemessen, dass ein *Entzug* sofort gesehen wird — 107 Messpunkte, null
Abweichungen — und nur eine *Erteilung* nie. Heute sieht die **App** auch den Entzug nicht. Zwei
verschiedene Prozesse, womöglich zwei verschiedene Abfragewege; ich habe nicht geprüft, welcher.
Was heute gilt: für diesen Prozess und diese App hält macOS die alte Antwort in beiden Richtungen
fest.

### Der Knopf führt, wohin er sagt

Weil die Zeile im nicht erteilten Zustand endlich einen Knopf zeigt, war das zum ersten Mal
prüfbar. Systemeinstellungen vorher geschlossen, dann **„Open Screen Recording"** geklickt:

```
  geoeffnet: 845x1002 "Aufnahme von Bildschirm & Systemaudio"
```

**Genau der benannte Bereich.** Für Accessibility ist es weiterhin ungeprüft — diese Zeile stand
in keinem Moment auf „nicht erteilt", also gab es dort keinen Knopf.

### Der Zustand danach

Alle Schalter stehen wieder auf ein — im Bild gegengeprüft —, und die App wurde nach der erneuten
Erteilung neu gestartet, hält die Berechtigung also tatsächlich. `/hello` antwortet,
`2.0.2+95984b9`, Tunnel verbunden.

### Was davon nicht mehr messbar war

### Der frühere Stand dieses Punktes


In zwei Runden davor war dieser Punkt nicht messbar, weil macOS für jeden Rechte-Wechsel Touch ID
oder das Passwort verlangt und ich beides nicht liefere. Diesmal hat Maxim die zwei Anmeldungen
übernommen; damit ist er erledigt.

### Wie ich den Kasten als Mensch beurteile

**Was gut ist.** Der Read-only-Text erklärt in drei Sätzen, was die Einstellung tut, was sie nicht
tut („screenshots and reads still work") und wo man sie zurücknimmt. Die Zeilen sind aufklappbar
und tragen eine Zahl („4 permissions"), die sagt, wie viel dahintersteckt. Die Rechte-Zeilen im
Setup-Schritt sagen in einem Satz, wofür die Berechtigung da ist, ohne zu drohen.

**Was ich ändern würde.**

1. **Der Kasten scrollt, ohne es zu zeigen.** Sichtbar sind drei Zeilen, tatsächlich sind es sechs
   („Look at files", „Change files", „See and use the desktop", „Run programs", „Session
   recording", „Sub-agents"). Bei meiner ersten Aufnahme stand die Liste in der Mitte und ich hielt
   die sichtbaren für alle. Es gibt keinen Hinweis auf mehr.
2. **Kein Zeitstempel an der Rechte-Zeile.** „Granted" allein sagt nicht, wann zuletzt nachgesehen
   wurde. Der Kopf der App macht es bei der Verbindung vor („verified 23s ago"); an einer
   Berechtigung, die sich außerhalb der App ändern kann, wäre dasselbe genau richtig.
3. **Der Schritt liegt drei Klicks tief:** *Setup* → „Show all steps" → herunterscrollen.

---

## Teil 5c — Die beiden Verträge

### `act` lehnt ab, was es nicht kennt

```
"verification":{"until":"window_exists","match":"x"}  -> BAD_REQUEST :: act does not recognize `verification`. It reads `frame`, `targetWindow` and `actions` only. Nothing was done.
"quatschSchluessel":123                               -> BAD_REQUEST :: act does not recognize `quatschSchluessel`. …
```

### `act_ui` sagt, ob sich etwas bewegt hat

Eigene Seite in Chrome mit einer echten Checkbox:

```
act_ui click     -> {"name":"Ein harmloser Schalter","ok":true,"runtimeKey":"e46","changed":false,"route":"uia"}
   Seite danach: (noch nichts)
Stapel click_ui  -> {"ui_changed":false,"routes":["uia"],"ok":true,"completed_count":1}
   Seite danach: (noch nichts)
```

**Beide Angaben stimmen mit dem Bildschirm überein** — die Seite meldet ihren eigenen Zustand als
unverändert, weil `AXPress` auf Chromium-Bedienelementen nichts auslöst. Genau das sagt das Feld
jetzt.

*(Der Systemeinstellungs-Schalter aus dem vorletzten Lauf hat `changed: true` geliefert und der
Schalter sprang im Bild tatsächlich um — die Angabe war korrekt; die Änderung wurde danach von
macOS zurückgerollt, weil die Anmeldung fehlte.)*

**Der Menüpunkt: kein Weg führt hin.**

```
Rollen im TextEdit-Fensterbaum: ["Window","ScrollArea","Button","MenuButton","Image","StaticText","TextArea","ScrollBar","Group"]
Suche "Format": []
Koordinatenklick auf die Menueleiste: OUTSIDE_TARGET_WINDOW "click at 250,12 is outside window 4558, which this batch is leased to (591,489 656x422)"
```

`find_ui` ist fensterbezogen und enthält die Menüleiste nicht, also hat `act_ui` nichts zu
referenzieren; der Koordinatenklick wird vom Zaun abgelehnt, weil die Menüleiste außerhalb jedes
Fensters liegt. **Beide Ablehnungen benennen korrekt, was nicht stimmte.**

---

## Teil 5d — Die Streuschlüssel-Regel

**Alle drei lehnen jetzt namentlich ab**, jede mit ihrer eigenen, zutreffenden Erklärung:

```
{"op":"warm","verification":{}}            -> BAD_REQUEST :: warm does not recognize `verification`. It takes no fields beyond `op`. Nothing was done.
{"op":"cursor","quatschSchluessel":1}      -> BAD_REQUEST :: cursor does not recognize `quatschSchluessel`. It takes no fields beyond `op`. Nothing was done.
{"op":"windows","quatschSchluessel":true}  -> BAD_REQUEST :: windows does not recognize `quatschSchluessel`. It reads `focusable` only, besides `op`. Nothing was done.
```

**Und die legitimen Formen sind unberührt** — die Regressionsprobe:

```
{"op":"warm"}                      -> ok=true
{"op":"cursor"}                    -> ok=true
{"op":"windows"}                   -> ok=true, 37 Fenster, ohne focusable
{"op":"windows","focusable":true}  -> ok=true, 37 Fenster, focusable dabei
```

**Ein Detail, das mir gefällt.** `{"op":"cursor","window":1}` wird nicht von der neuen Regel
gefangen, sondern von der älteren, spezielleren:

> `this request names a window under \`window\`, but every operation reads it under \`id\`. Nothing was done. Send \`id\` — \`window\` belongs on an action inside \`act\`, and \`targetWindow\` on an \`act\` request.`

Das ist die hilfreichere von beiden Meldungen, und sie kommt zuerst. Die Reihenfolge stimmt.

`find_ui` und `capture` nehmen einen Streuschlüssel weiterhin stumm an — **das ist der
dokumentierte Umfang dieser Runde und kein Befund**, wie im Auftrag ausdrücklich festgehalten.

---

## Teil 6 — Die gestellten Fragen, kurz beantwortet

| Frage | Antwort |
|---|---|
| **`npm run desktop:mac` übersetzt?** | **Ja**, `gyp info ok`, EXIT 0, kein `swiftc`-Fehler |
| Screen Recording und Accessibility erteilt? | Ja, beide, an `Terminal.app` |
| `verify:ci` | **Grün beim ersten Lauf**: 1880 passed / 97 skipped (1977), EXIT 0 |
| `verify:browser --headed` | **42/42**, EXIT 0, kein FAIL, kein SKIP |
| Scroll-Richtung | **Beurteilt und bestanden**, `before=0 after=300` |
| Zeiger: Feld / Bild | `"drawn"` und I-Balken innen, `"outside_region"` und nichts außen — **sie stimmen überein** |
| Fokus-Klausel | `another window of the same application is in front (window 4525)` |
| Zug / Eingabezaun | **Ja** — fünf Wegpunkte, erster Anlauf; alle fünf Ablehnungen namentlich |
| Erweiterung = diese Kasse? | **Ja**, alle zehn Dateien byte-identisch, derselbe Ordner |
| **`act` mit `verification`** | **`BAD_REQUEST`, namentlich** |
| **`act_ui` mit `changed`** | **Passt zum Bildschirm**, einzeln wie im Stapel |
| **`warm`, `cursor`, `windows` mit Streuschlüssel** | **`BAD_REQUEST` bei allen dreien**, jeweils namentlich; legitime Formen unberührt |
| **Permissions-Kasten** | **Ja** — der Hinweis steht sauber über einer vollständig sichtbaren ersten Zeile, in beiden Read-only-Zuständen |
| **Der Zug-Rückschritt** | **Weiterhin unreproduziert**, zweiter Lauf in Folge |
| **Fund 1** | **Kein Befund mehr** — mit Read-only aus erscheinen beide Zeilen; die App protokolliert beide Rechte |
| **Fund 2** | **Erledigt und erklärt.** Laufender Prozess sieht weder Entzug (>4 min) noch Erteilung (>2 min); ein frisch gestarteter sieht beides sofort. macOS hält die Antwort pro Prozess fest — nicht die App |

---

## Was sonst auffiel

**Die Streuschlüssel-Regel ist jetzt eine Regel, kein Einzelfall mehr** — vier Operationen tragen
sie, und die Meldungen sind je Operation richtig statt generisch. Dass die ältere `window`-Regel
weiterhin zuerst greift und die bessere Auskunft gibt, ist die richtige Reihenfolge. Das ist der
erste dieser Punkte, den ich abhaken kann, ohne einen Nachsatz anzuhängen.

**Der Permissions-Kasten scrollt unsichtbar.** Von sechs Zeilen sind drei zu sehen. Mich hat das
in der ersten Aufnahme dieser Runde in die Irre geführt: ich hielt „Run programs / Session
recording / Sub-agents" für die ganze Liste und hätte um ein Haar berichtet, „Look at files" sei
verschwunden. Wenn es mir mit einem Werkzeug passiert, das den ganzen Baum lesen kann, passiert es
einem Menschen mit den Augen erst recht.

**Der Zug ist jetzt zweimal in Folge unauffällig.** Ich lasse den Befund von vor zwei Runden damit
fallen: vier Fehlschläge an einem Tag, an dem die App in einer Startschleife hing und fünfzehn
Finder-Fenster offen standen, gegen zwei saubere Läufe danach. Was ich daraus mitnehme: `drag` ist
der einzige Eingabepfad ohne Wirkungsbeleg. `scroll` hat `moved`, `act_ui` hat `changed` — ein
`moved` am Zug hätte damals in einer Zeile gesagt, was mich zwei Runden gekostet hat.

**Was ich am Zustand der Maschine berührt habe.** Zwei Finder-Fenster angelegt und über den Helfer
wieder geschlossen; Testordner entfernt; zwei TextEdit-Dokumente und zwei Chrome-Tabs im
Arbeitsordner geöffnet. **Read-only einmal an- und wieder ausgeschaltet** — gegengeprüft, es steht
wieder aus. `/pair` nicht aufgerufen.

**Für Fund 2 an den Systemeinstellungen:** „Chat On Steroids" die Bildschirmaufnahme entzogen und
danach wieder erteilt — beide Male hat Maxim sich angemeldet, und beide Male habe ich bei macOS'
Rückfrage **„Später"** gewählt, damit die App weiterlaufen und beobachtet werden konnte. Danach
**alle Schalter im Bild gegengeprüft: alle wieder an**, einschließlich beider Einträge der App.
Die App wurde nach der erneuten Erteilung neu gestartet, hält die Berechtigung also tatsächlich.
Sonst wurde an den Systemeinstellungen nichts angefasst.

**Fund 2 ist erledigt, und die App kommt dabei gut weg.** Sie liest alle fünf bis sechs Sekunden
nach, sie zeigt im richtigen Zustand einen Knopf, der zum richtigen Bereich führt, und sie erklärt
das Verhalten von macOS in eigenen Worten an der Stelle, wo es jemanden trifft. Was aussah wie eine
veraltete Zeile, ist eine veraltete Antwort des Betriebssystems — und die App sagt das, sobald sie
sie bekommt.

**Was ich nicht belegt habe.** Der Knopf für Accessibility, weil diese Zeile nie im nicht erteilten
Zustand war. Welcher Abfrageweg den Unterschied zu meiner Helfer-Messung vom 31. August erklärt.
Und warum der Zug vor zwei Runden viermal scheiterte — das bleibt unerklärt, auch wenn es nicht
mehr auftritt.
