# Prüfung 45 und 46, mit Instrumentierung statt noch eines Blindlaufs

**Datum:** 2026-09-02
**Stand:** `57afb44`
**Vorgehen:** `_debug` in `scrollTargetExpression`, ein gedrängtes Fixture, und A/B im selben Lauf.

---

## Kurzfassung — beide Ursachen sind dieselbe, und keine ist die vermutete

**Prüfung 46 ist kein Fehler im Treffertest.** Der Punkt-Treffertest findet in jedem einzelnen
Fall sofort das richtige Element: `DIV#strip`, `canX: true`, `scrollWidth 1816 / clientWidth 500`,
`chain`-Länge **1**. Er hat nie danebengegriffen.

**Prüfung 45 ist keine Flatterhaftigkeit im 200-ms-Fenster.** Das Fenster zu verbreitern hätte
nichts geholfen: die Bedingung, nach der gesucht wird, trifft unter dieser Lage **nie** zu.

**Beide haben eine gemeinsame Ursache: der getriebene Tab liegt im Hintergrund.**

| | Tab im Vordergrund | Tab im Hintergrund |
| --- | --- | --- |
| `visibilityState` | `visible` | `hidden` |
| Scroll: Antwort | `moved: true, acknowledged: true` | `BROWSER_SCROLL_FAILED` |
| Scroll: Dauer des Aufrufs | **388 ms** | **7275 ms** |
| Scroll: bewegt sich der Streifen? | ja, nach 153 ms | **innerhalb von 6 s nicht — später doppelt** |
| `createdTab` in fünf Klicks | **5 von 5** | **0 von 5** |
| `openerTabId` des neuen Tabs | = getriebener Tab | = **Popup-Tab**, nicht der getriebene |

Beide Male ist die gemeldete Ablehnung **im Augenblick der Messung richtig** — und beide Male ist
sie kurz darauf falsch, weil Chrome die Ereignisse nicht verwirft, sondern nachholt.

---

## 1. Die Instrumentierung

In `extension/browser-driver.js` trägt `scrollTargetExpression` jetzt ein `_debug` mit:

- `matched` — das Element, auf dem die Schleife stehen blieb, mit `tag`, `id`, `class`,
  `scrollWidth`/`clientWidth`, `scrollHeight`/`clientHeight`, `scrollLeft`/`scrollTop`,
  `overflowX`/`overflowY`, `rect` und den beiden abgeleiteten Flags `canX`/`canY`;
- `fallback: true` und `matched: null`, wenn sie bis zum Fenster durchgefallen ist;
- `chain` — jedes Element, das sie auf dem Weg nach oben angesehen hat, mit denselben Feldern;
- `stack` — zusätzlich `document.elementsFromPoint`, also **was sonst noch unter dem Punkt liegt**,
  bis zu sechs tief. Das ist die Angabe, mit der sich „das Falsche hat gewonnen" beantworten lässt,
  ohne raten zu müssen.

`before._debug` und `after._debug` werden als `beforeDebug`/`afterDebug` durchgereicht — **auf
beiden Wegen**: im Erfolgsobjekt und, als Eigenschaften am geworfenen Fehler, auf dem
`BROWSER_SCROLL_FAILED`-Pfad. Der Ablehnungsfall ist der, den man sehen will; eine frühere Runde
hat genau dort die Belege verloren.

**Beides ist ausdrücklich als vorübergehend gekennzeichnet** und steht mit einem Kommentar da, der
sagt, warum es existiert und wann es weg kann.

## 2. Das gedrängte Fixture

Nicht ein sauberer Streifen für sich, sondern ein `#panel` mit lauter Nachbarn, die einen
Punkt-Treffertest verwirren können:

```html
<pre id="statuslog" …overflow:auto>       vier Zeilen, breiter als der Kasten
<textarea id="notes" …>                   Standard overflow:auto
<div id="strip" …overflow-x:auto>         das echte Ziel, Inhalt 1800px in 500px
<div id="hoverbait" …>                    reagiert auf mouseover und wächst dabei
<a id="blank" target="_blank">             für Prüfung 45
```

Der Streifen schreibt bei jedem eigenen `scroll`-Ereignis seinen `scrollLeft` in `#statuslog` —
damit sagt die Seite selbst, was mit ihr geschehen ist, unabhängig von jeder Antwort des Treibers.
Das Original-`#wide` aus dem Standard-Fixture bleibt daneben stehen, sodass beide im **selben Lauf**
vergleichbar sind.

## 3. Die exakte Wiederholung

```
### H1) gedraengter Streifen, Tab im Hintergrund   #strip, Punkt 275,746, visibilityState=hidden
  Aufruf 7275 ms | Antwort moved=undefined acknowledged=undefined
    | BROWSER_SCROLL_FAILED: neither a scroll gesture nor a wheel event was taken at 275,746,
      and the page did not move
  strip.scrollLeft 0 -> 0;  erste Bewegung: keine
  Verlauf: 2:0 610:0 1219:0 1828:0 2437:0 3047:0 3659:0 4268:0 4877:0 5488:0 6097:0 6708:0
```

**Das ist die Wiederholung, und das `_debug` entlastet den Treffertest vollständig:**

```json
"matched": {
  "tag": "DIV", "id": "strip", "class": null,
  "scrollWidth": 1816, "clientWidth": 500,
  "scrollHeight": 44,  "clientHeight": 44,
  "scrollLeft": 0, "scrollTop": 0,
  "overflowX": "auto", "overflowY": "auto",
  "rect": { "x": 24, "y": 723, "w": 502, "h": 46 },
  "canX": true, "canY": false
},
"fallback": false,
"chain": [ …genau dieses eine Element… ]
```

`stack` — was sonst unter dem Punkt liegt:

```
DIV#strip   canX=true  canY=false  scrollWidth=1816/500  overflowX=auto
DIV#panel   canX=false canY=false  scrollWidth=532/532   overflowX=visible
DIV#tall    canX=false canY=false  scrollWidth=1168/1168 overflowX=visible
BODY        canX=false canY=false  scrollWidth=1200/1200 overflowX=visible
HTML        canX=false canY=false  scrollWidth=1200/1200 overflowX=visible
```

**Der Streifen liegt ganz oben, er ist scrollbar, er wird beim ersten Schritt gefunden.** Kein
Nachbar gewinnt, kein Overlay dazwischen, kein Durchfallen auf das Fenster.

**Und die Bewegung kommt trotzdem — nur später.** Beim Aktivieren des Tabs, unmittelbar nach dieser
Messung, stand `strip.scrollLeft` auf **300**: nicht 150. **Zweimal 150 — die Geste und der
Rad-Rückfall, beide nachgeholt, sobald der Tab wieder Bilder bekam.** Genau der Widerspruch, den
zwei Runden gemeldet haben: die Antwort sagt „nicht bewegt", das Bild kurz darauf zeigt Bewegung —
und die Verdopplung ist der Fingerabdruck, an dem man es erkennt.

## 4. Derselbe Punkt, Tab im Vordergrund

```
### V1) gedraengter Streifen, Tab im Vordergrund   #strip, Punkt 275,746, visibilityState=visible
  Aufruf 388 ms | Antwort moved=true acknowledged=true
  strip.scrollLeft 300 -> 450;  erste Bewegung: 153 ms

### V2) Original-#wide, Tab im Vordergrund   #wide, Punkt 117,481, visibilityState=visible
  Aufruf 1286 ms | Antwort moved=true acknowledged=true
  wide.scrollLeft 0 -> 150;  erste Bewegung: 154 ms
```

**7275 ms und keine Bewegung gegen 388 ms und 150 Pixel — bei identischem Punkt, identischem
Element, identischem Aufruf.** Der einzige Unterschied ist `visibilityState`.

## 5. Absichtlich danebengezielt

Weil der Auftrag es verlangt, und weil es die Gegenprobe zum Treffertest ist:

```
V3) auf das textarea gezielt (277,690)      -> KEINES, Fallback auf window   moved=false   richtig
V4) auf das Protokoll-<pre> (274,634)       -> KEINES, Fallback auf window   moved=false   richtig
V5) auf das Hover-Overlay (489,783)         -> KEINES, Fallback auf window   moved=false   richtig
V6) Streifen unter dem Overlay (506,746)    -> DIV#strip                     moved=true    450->600
```

**Jede dieser vier Antworten stimmt mit der Wirklichkeit überein.** Das `textarea` hat
`overflow:auto`, aber `scrollWidth == clientWidth` — es hat nichts zu scrollen, also fällt die
Schleife zu Recht durch. Das `#hoverbait`-Overlay ist nicht scrollbar, also ebenso. Und V6 zeigt,
dass ein Overlay in der Nähe den Streifen nicht verdeckt, solange der Punkt darüber liegt.

Eine Einschränkung, die ich selbst verursacht habe: in einem früheren Durchlauf hat das
`pre#statuslog` noch gepasst (`canX: true`, `scrollWidth 520/500`), in diesem nicht mehr — weil der
Streifen bei jedem Scrollen seinen Text auf eine kurze Zeile überschreibt und der Kasten dann nicht
mehr überläuft. **Das Fixture verändert sich selbst; das ist kein Befund über den Treiber.**

**Das Bildschirmfoto bestätigt alles unabhängig:** `strip scrollLeft=600` im Protokollfeld der
Seite, der Streifeninhalt entsprechend weit nach links gewandert, und `#wide` zeigt „h wider than
its own box" statt seines Anfangs — also die 150 Pixel aus V2.

## 6. Prüfung 45 — A/B im selben Lauf, zehn Klicks

```
  getriebener Tab (status().tabId): 1263279916
  Tabs vorher:  id=1263279916 active=true  …http://127.0.0.1:9834/
                id=1263279917 active=false …/popup.html

  --- Tab im VORDERGRUND ---
  Lauf 1: createdTab=JA  | Tabs 2->3 | neu: id=1263279918 opener=1263279916
  Lauf 2: createdTab=JA  | Tabs 2->3 | neu: id=1263279920 opener=1263279916
  Lauf 3: createdTab=JA  | Tabs 2->3 | neu: id=1263279922 opener=1263279916
  Lauf 4: createdTab=JA  | Tabs 2->3 | neu: id=1263279924 opener=1263279916
  Lauf 5: createdTab=JA  | Tabs 2->3 | neu: id=1263279926 opener=1263279916
  -> 5 von 5

  --- Tab im HINTERGRUND (visibilityState=hidden) ---
  Lauf 1: createdTab=nein | Tabs 2->3 | neu: id=1263279928 opener=1263279917
  Lauf 2: createdTab=nein | Tabs 2->3 | neu: id=1263279930 opener=1263279917
  Lauf 3: createdTab=nein | Tabs 2->3 | neu: id=1263279932 opener=1263279917
  Lauf 4: createdTab=nein | Tabs 2->3 | neu: id=1263279934 opener=1263279917
  Lauf 5: createdTab=nein | Tabs 2->3 | neu: id=1263279936 opener=1263279917
  -> 0 von 5
```

**Die Antwort ist eindeutig, und sie ist nicht die vermutete.**

Der Tab **öffnet sich jedes Mal** — 2 auf 3, in allen zehn Läufen, mit `hit=a#blank`. Im
Hintergrund trägt er aber `openerTabId = 1263279917` — **das ist der Popup-Tab, der gerade aktiv
ist, nicht der Tab, dessen Seite den Link enthält** (…916). `findCreatedTab` sucht nach

```js
tab.openerTabId === openerTabId   // openerTabId = session.tabId
```

und findet deshalb **nie** etwas. **Das 200-ms-Fenster ist unschuldig: die Bedingung selbst trifft
unter dieser Lage nicht zu, egal wie lange man wartet.** Verbreitern hätte 0 von 5 in 0 von 5
verwandelt, nur langsamer.

Im Vordergrund stimmt `openerTabId` mit dem getriebenen Tab überein, und die Prüfung besteht
fünfmal von fünf — ohne jede Änderung am Fenster.

---

## Was das für einen Fix bedeutet

Ich schlage nichts vor, was ich nicht gemessen habe, aber die Messung grenzt es scharf ein:

1. **Beide Fehlbefunde verschwinden, wenn der getriebene Tab aktiv ist.** `verify:browser` holt ihn
   vor dem Scroll-Test nach vorn (`/json/activate/…`, `scripts/verify-browser-driver.mjs:561`) —
   deshalb besteht Prüfung 46 dort und scheitert bei ChatGPT. Ein Aufrufer, der durch die App
   fährt, hat diese Zusicherung nicht.
2. **Für den Scroll** ist die Ablehnung im Augenblick korrekt, aber irreführend, weil die
   Ereignisse **nicht verworfen, sondern nachgeholt** werden. Eine Meldung, die den Hintergrund
   benennt — so wie `movedUnknown` beim Helfer sagt, warum es nichts weiß — wäre wahrer als
   „the page did not move". Die Verdopplung auf 300 zeigt außerdem, dass der Rad-Rückfall in diesem
   Zustand ein zweites Mal zuschlägt.
3. **Für `createdTab`** ist `openerTabId === session.tabId` die falsche Bedingung, sobald der
   getriebene Tab nicht der aktive ist. Was sich in allen zehn Läufen unterscheidet, ist nicht der
   Zeitpunkt, sondern der Vergleich.

## Belege und was liegen bleibt

- **Die Diagnose bleibt stehen**, wie gewünscht: `_debug` in `extension/browser-driver.js`,
  `beforeDebug`/`afterDebug` auf beiden Wegen.
- **`scripts/diag-scroll46.mjs`** ist der Lauf selbst — dieselbe Maschinerie wie
  `verify-browser-driver.mjs`, mit dem gedrängten Fixture, den Sichtbarkeitswechseln und dem
  A/B für Prüfung 45. Er ist wiederverwendbar; `COS_DIAG_SHOT=<pfad>` legt zusätzlich ein
  Bildschirmfoto ab. **Beides ist zum Entfernen gedacht, sobald der Fix bestätigt ist.**
- Protokolle: `diag46.log` (erster Lauf, ohne Aktivierung), `diag46c.log`, `diag46d.log` (A/B).

**Wo ich mich in dieser Untersuchung selbst korrigiert habe:** mein erster Diagnoselauf ließ die
Schritte weg, die den Fixture-Tab nach vorn holen, und ich hätte daraus beinahe geschlossen, dass
gar nichts mehr scrollt — auch nicht das unveränderte `#wide`. Genau dieser Fehler hat die Ursache
aufgedeckt, aber er war ein Fehler: **das erste Ergebnis maß meinen Aufbau, nicht den Treiber.**
