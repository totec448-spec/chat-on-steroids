# `ensureTabActive` gegen `17d9b8f` — bestätigt, mit derselben Instrumentierung

**Datum:** 2026-09-02
**Stand:** `17d9b8f` (Fix: `44839df`)
**Erweiterung:** aus dem Checkout in ein frisches Profil kopiert und geladen — der Lauf baut sein
eigenes Chrome-Profil auf, ein Nachladen von Hand entfällt. `desktop:mac` ist hier ohne Belang.

---

## Kurzfassung

| | vor dem Fix | nach `44839df` |
| --- | --- | --- |
| Scroll aus dem Hintergrund, Dauer | **7275 ms** | **528 ms** |
| Scroll aus dem Hintergrund, Antwort | `BROWSER_SCROLL_FAILED` | **`moved: true, acknowledged: true`** |
| Streifen bewegt sich | erst später, **doppelt** (300 statt 150) | sofort, **exakt 150**, Beginn nach 154 ms |
| `visibilityState` vor / nach dem Aufruf | `hidden` / `hidden` | **`hidden` / `visible`** |
| `createdTab`, Tab im Hintergrund | **0 von 5** | **5 von 5** |
| `openerTabId` des neuen Tabs | Popup-Tab | **getriebener Tab** |
| Prüfung 33: Bild und refs danach | — | **kein leeres Bild, refs benutzbar** |

`npm run verify:browser -- --headed`: **45 von 45**, kein FAIL, kein SKIP. Upstream hat zwei eigene
Prüfungen dafür aufgenommen, die dasselbe messen wie mein Repro.

---

## 1. Derselbe Repro, dieselben Koordinaten

Gleiches gedrängtes Fixture, gleicher Punkt `275,746`, Tab durch den Popup-Tab in den Hintergrund
gedrängt:

```
### H1) gedraengter Streifen, Tab im Hintergrund
    #strip, Punkt 275,746, visibilityState vorher=hidden nachher=visible
  Aufruf 528 ms | Antwort moved=true acknowledged=true
  strip.scrollLeft 0 -> 150;  erste Bewegung: 154 ms
  getroffen: DIV#strip canX=true scrollWidth=1816/500 overflowX=auto
```

**Ja, `visibilityState` kippt vor der Ausführung zurück auf `visible`** — der Treiber erzwingt es,
und mein Messpunkt nach dem Aufruf sieht `visible`, wo vor dem Aufruf `hidden` stand.

**Und die Bewegung ist exakt einmal 150, nicht 300.** Das ist der aussagekräftigste Einzelwert des
ganzen Laufs: die Verdopplung war der Fingerabdruck des alten Fehlers — Geste *und* Rad-Rückfall
wurden beide nachgeholt, weil beide ins Leere gelaufen waren. Jetzt greift die Geste, der Rückfall
läuft gar nicht erst an.

Ein zweiter Hintergrund-Scroll später im selben Lauf, zur Bestätigung:

```
### H2) Scroll aus dem Hintergrund, nach dem Fix
  Aufruf 503 ms | moved=true acknowledged=true | strip.scrollLeft 450 -> 600
```

**Alles Danebengezielte bleibt richtig.** Der Fix hat die Urteilskraft nicht aufgeweicht:

```
V3) textarea (277,690)            -> Fallback auf window   moved=false   richtig
V4) Protokoll-<pre> (274,634)     -> Fallback auf window   moved=false   richtig
V5) Hover-Overlay (489,783)       -> Fallback auf window   moved=false   richtig
V6) Streifen unter dem Overlay    -> DIV#strip             moved=true    300 -> 450
```

## Prüfung 45 — 5 von 5, im Hintergrund

```
  --- Tab im VORDERGRUND ---   createdTab JA ×5, opener=456310750 (= getriebener Tab)
  --- Tab im HINTERGRUND ---   createdTab JA ×5, opener=456310750 (= getriebener Tab)
  ZUSAMMEN: Vordergrund 5/5, Hintergrund 5/5
```

Vor dem Fix stand hier `opener = <Popup-Tab>` und `0 von 5`. **Die Zuschreibung stimmt jetzt in
allen zehn Klicks**, und zwar weil der getriebene Tab zum Zeitpunkt des Klicks wirklich der aktive
ist — nicht, weil am Abfragefenster etwas geändert wurde. Das Fenster ist unverändert 200 ms; es
war nie das Problem.

## 2. Die Nebenwirkung — gemessen, nicht vermutet

`chrome.windows.update({ focused: true })` holt nicht nur den Tab nach vorn, sondern **die ganze
Anwendung**. Gemessen mit TextEdit als vorderster Anwendung:

```
  vor dem Scroll:  vorderste Anwendung = "TextEdit",                    Seite = hidden
  nach dem Scroll: vorderste Anwendung = "Google Chrome for Testing"    (1191 ms)
  -> Fokus gewechselt: JA
```

**Das ist ein echter Anwendungswechsel auf dem Mac, kein bloßer Tabwechsel in Chrome.** Wer gerade
tippt, verliert die Tastatureingabe an Chrome.

**Meine Meinung dazu, als Produktfrage.**

Ich halte es für vertretbar, aber nicht für gleichwertig mit dem, was der Treiber bisher tut. Der
Vergleich im Auftrag — Debugger-Banner, Tab-Gruppe, Zeiger-Overlay — trifft nur zur Hälfte: **das
sind alles Dinge, die den Treiber sichtbar machen, ohne dem Menschen etwas wegzunehmen.** Ein
Fensterwechsel nimmt etwas weg. Er unterbricht, was gerade getippt wird, und er kann eine Eingabe
in das falsche Fenster laufen lassen, wenn der Mensch im selben Augenblick weiterschreibt.

Trotzdem: **die Alternative ist schlechter.** Ohne den Fix ist jeder Scroll und jeder
`_blank`-Klick in einem Hintergrundtab still falsch — und zwar auf die schlimmste Art, nämlich mit
einer Ablehnung, die eine Sekunde später nicht mehr stimmt. Ein sichtbarer Fensterwechsel ist ein
ehrlicher Preis dafür, und er ist für den Menschen erklärbar: die Maschine benutzt den Browser, und
dazu muss der Browser vorn sein. Das ist dieselbe Wahrheit, die der Zeiger-Overlay ausspricht.

**Was ich ändern würde**, in dieser Reihenfolge:

1. **`chrome.tabs.update({active: true})` ohne `windows.update({focused: true})` versuchen und
   messen**, ob das für den Compositor schon reicht. Der Tab muss der aktive seines Fensters sein;
   ob das Fenster auch die vorderste *Anwendung* sein muss, ist eine eigene Frage, und ich habe sie
   nicht getrennt gemessen. Wenn `active` allein genügt, verschwindet die halbe Nebenwirkung
   umsonst.
2. Falls nicht: **den Wechsel in der Antwort benennen.** Ein Feld wie `broughtToFront: true` macht
   aus einer Überraschung eine Angabe. Der Treiber sagt heute schon, was er getroffen hat (`hit`)
   und ob es verdeckt war (`covered`) — dass er das Fenster nach vorn geholt hat, gehört in
   dieselbe Zeile.

## 3. Prüfung 33 — die andere Hälfte

Gemessen an zwei Stellen: nach den gewöhnlichen Vordergrund-Scrolls, und **unmittelbar** nach einem
Scroll aus dem Hintergrund.

```
  nach den Scrolls im Vordergrund:   refs=10  Bild=1200x817  36876 Bytes  (0.0376 B/Px)
    ref benutzbar: ok, hit=button#go | Seitenprotokoll: "clicked trusted=true"

  unmittelbar nach dem Hintergrund-Scroll: refs=10  Bild=1200x817  37279 Bytes  (0.0380 B/Px)
    ref benutzbar: ok, hit=button#go | Seitenprotokoll: "clicked trusted=true"
```

**Kein leeres Bild, und die refs sind benutzbar.** Ich habe beides hart geprüft statt nur
angeschaut: die Bildgröße von rund 37 KB für 1200×817 (0,038 Bytes je Pixel) ist die eines
gezeichneten Bildes — ein wirklich weißes PNG dieser Maße wiegt einige hundert Bytes. Und ein
frisch beobachteter `ref` wurde nicht nur zurückgegeben, sondern **benutzt**: der Klick landete auf
`button#go` und die Seite schrieb daraufhin `clicked trusted=true` in ihr eigenes Protokoll.

**Es ist also verschwunden, und zwar als Folgeerscheinung.** Das passt zur Ursache: ein Tab, der
nicht komponiert, liefert kein gezeichnetes Bild und keinen frischen Baum — beides derselbe
fehlende Compositor, der auch den Scroll verschluckt hat. Ich habe es in diesem Lauf **nicht ein
einziges Mal** wiedersehen können.

**Eine Einschränkung, die ich nicht verschweige:** ich konnte es hier nie *auslösen*, weil der Fix
den Zustand gar nicht mehr entstehen lässt, in dem es auftrat. Dass es weg ist, heißt streng
genommen „unter dieser Ursache weg" — nicht „unter jeder denkbaren Ursache weg". Sollte es
wiederkommen, ist der erste Griff die Frage, ob der Tab in dem Moment komponiert hat.

## 4. `moved: null` bei Chromium — die Antwort ist „gar nicht da"

Gefragt war: liegt der `AXVerticalScrollBar` weiter außen als acht Elternschritte, oder gibt es ihn
nicht?

```
=== Chrome, Webinhalt (Wikipedia)   Punkt 864,600   Startrolle AXStaticText
  bis  8 Eltern: nicht gefunden
  bis 60 Eltern: nicht gefunden   (Kette endet nach 19 Schritten)
  volle Kette: AXStaticText > AXGroup ×7 > AXWebArea > AXScrollArea > AXGroup ×7 > AXWindow > AXApplication
  im Teilbaum darunter: keiner
  Kosten je Aufruf: 8 Schritte 0.91 ms, 60 Schritte 1.23 ms

=== Chat On Steroids, eigene Electron-Oberflaeche   Punkt 700,600
  bis  8 Eltern: nicht gefunden
  bis 60 Eltern: nicht gefunden   (Kette endet nach 17 Schritten)
  Kosten je Aufruf: 8 Schritte 0.70 ms, 60 Schritte 1.35 ms
```

**Die Kette läuft in beiden Fällen bis `AXApplication` durch und findet nichts.** Nach oben ist
nichts mehr übrig, was man weiten könnte — 19 beziehungsweise 17 Schritte sind der ganze Weg.

**Und der scheinbar naheliegende Kandidat trägt es auch nicht.** In beiden Ketten steht ein
`AXScrollArea` direkt über dem `AXWebArea`. Ich habe seine Attribute aufgelistet — es sind
dreizehn, in Chrome und in der App **identisch**:

```
AXFrame, AXParent, AXChildren, AXSize, AXFocused, AXRole, AXTopLevelUIElement,
AXHelp, AXChildrenInNavigationOrder, AXPosition, AXWindow, AXRoleDescription, AXContents

AXVerticalScrollBar    = —
AXHorizontalScrollBar  = —
AXValue                = —
AXSelectedTextRange    = —
AXVisibleCharacterRange = —
AXPosition             = x:0 y:120        (die Lage des Kastens, nicht sein Scrollstand)
AXSize                 = w:1728 h:913
```

**Es gibt keinen einzigen Wert im Baum, aus dem sich ein Scrollstand lesen ließe** — weder unter
einem anderen Namen noch an einer anderen Stelle. `AXPosition` und `AXSize` beschreiben den
Sichtkasten, nicht den Inhalt darin.

**Antwort: nicht „weiter draußen", sondern „gar nicht da".** Die Erweiterung des Elternlaufs würde
0,3 bis 0,65 ms je Aufruf kosten und **nichts** finden. **Sie lohnt sich nicht.**

Was sich daraus ergibt, ohne dass ich es baue: Für Chromium — Browser wie eigene Oberfläche — ist
die Zugänglichkeits-API der falsche Ort für diese Frage. Der Browsertreiber beantwortet sie längst
richtig, weil er sie im Dokument stellt (`el.scrollLeft`, `scrollY`) statt im AX-Baum. Für die
eigene Electron-Oberfläche gäbe es denselben Weg. Der Helfer wird sie über AX nicht beantworten
können, und `movedUnknown: "nothing scrollable under the pointer"` ist dann die richtige Antwort —
sie ist wahr, sie erklärt sich, und sie behauptet nichts.

## Zur letzten Frage: die Diagnose kann raus

**Meine Einschätzung: diese Runde reicht.** Drei Gründe:

1. Der Fix ist an **beiden** Stellen bestätigt, mit demselben Aufbau, der den Fehler gefunden hat —
   und mit dem Wert, der ihn eindeutig kennzeichnet (150 statt 300).
2. **Die Abdeckung ist dorthin gewandert, wo sie hingehört.** `verify:browser` trägt jetzt selbst
   „a scroll over a backgrounded driven tab still moves it (ensureTabActive)" und das Gegenstück
   für `createdTab`, mit `hiddenBefore=hidden visAfter=visible` in der Ausgabe. Ein Diagnoseskript
   daneben würde dieselbe Sache ein zweites Mal prüfen, aber ohne im CI zu laufen.
3. Was noch offen ist — `moved: null` bei Chromium —, hat mit `_debug` nichts zu tun: die Antwort
   steht oben, und sie lautet, dass dort nichts zu finden ist.

Ich habe die Instrumentierung deshalb entfernt und `scripts/diag-scroll46.mjs` gelöscht. **Beides
ist in `afcb694` erhalten** und lässt sich mit einem `git checkout afcb694 -- <pfad>`
zurückholen, falls die nächste Runde es doch noch braucht. `verify:browser --headed` bleibt danach
bei 45 von 45.
