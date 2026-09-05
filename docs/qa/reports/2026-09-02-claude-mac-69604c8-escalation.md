# Die Eskalation in `ensureTabActive` (`63be1c0`) — bestätigt, mit einem Befund

**Datum:** 2026-09-02
**Stand:** `69604c8`
**Installierte App:** `2.0.2+735c269` — **älter als `0af28f0`**, siehe Teil 3

---

## Die Zahlen, um die gebeten wurde

| | `broughtToFront` | Scroll | Klick |
| --- | --- | --- | --- |
| **Fall 1** — anderer Tab im selben Fenster vorn | **fehlt** (also false) | 376 / 414 / 679 ms | 48 / 50 / 53 ms |
| **Fall 2** — TextEdit ist die vorderste Anwendung | **fehlt** (also false) | 1125 / 1141 / 1145 ms | 43 / 47 / 49 ms |
| **Fall 3z** — Chrome-Fenster minimiert | **fehlt — und das ist falsch** | 2435 ms | — |
| Vergleich: unbedingter Fokus, Vorrunde | — | 1191 ms | — |

**Fall 1 ist genau so, wie er sein soll.** **Fall 2 eskaliert nicht — weil er es nicht muss, was der
eigentliche Fund dieser Runde ist.** **Und dort, wo die Eskalation wirklich greift, meldet
`broughtToFront` das Gegenteil dessen, was geschehen ist.**

---

## 1. Gleiches Fenster — der leichte Weg greift

Getriebener Tab hinter dem Popup-Tab, Chrome ist die aktive Anwendung:

```
  SCROLL Fall 1
    vorderste App:   "Google Chrome for Testing" -> "Google Chrome for Testing"
    visibilityState: hidden -> visible
    Dauer 679 ms | moved=true acknowledged=true
    strip.scrollLeft 0 -> 150
    broughtToFront: (fehlt)

  KLICK Fall 1
    Dauer 48 ms | createdTab=JA 813763335 | hit=a#blank
    broughtToFront: (fehlt)
```

**`visibilityState` erholt sich, `moved: true`, `createdTab` kommt zurück, und `broughtToFront`
fehlt.** Der leichte Pfad feuert also wirklich; die Eskalation bleibt aus. Genau das war die Frage.

## 2. Andere Anwendung vorn — und hier wird es interessant

Die Vorbedingung habe ich zuerst **einzeln** gemessen, statt sie anzunehmen. TextEdit vorderste
Anwendung, getriebener Tab hinter dem Popup-Tab, dann `chrome.tabs.update({active: true})` **allein**:

```
  vorderste App jetzt: "TextEdit", Seite: hidden
  Vorbedingung: nach tabs.update({active:true}) allein (915 ms) ist visibilityState = visible
  vorderste App dabei: "TextEdit"
```

**Die Tab-Aktivierung allein stellt die Sichtbarkeit wieder her — obwohl Chrome nicht die aktive
Anwendung ist und auch nicht wird.** Damit ist die Erwartung des Auftrags widerlegt, und zwar
sauber:

**`document.visibilityState` kennt keinen Anwendungsfokus.** Es hängt daran, ob der Tab der aktive
seines Fensters ist und ob das Fenster sichtbar ist — nicht daran, welche macOS-Anwendung vorn
steht. Ein Chrome-Fenster, das offen und unverdeckt hinter TextEdit liegt, komponiert weiter.

Der Scroll bestätigt es:

```
  SCROLL Fall 2
    vorderste App:   "TextEdit" -> "TextEdit"
    visibilityState: visible -> visible
    Dauer 1145 ms | moved=true acknowledged=true
    strip.scrollLeft 150 -> 300
    broughtToFront: (fehlt)
```

**TextEdit bleibt vorn, der Scroll wirkt trotzdem, und es wird nichts nach vorn gerissen.**

**Damit ist die Nebenwirkung aus der Vorrunde in diesem Fall verschwunden.** Ich hatte gemessen:
TextEdit → Chrome for Testing, 1191 ms. Jetzt: TextEdit bleibt TextEdit. Das ist der Gewinn der
Zweistufigkeit, und er ist größer als erwartet — nicht „billiger, wenn nicht eskaliert wird",
sondern „in diesem Fall gar keine Eskalation nötig".

**Eine Beobachtung, die ich nicht als Eskalation missverstehen will:** beim Klick in Fall 2 wechselt
die vorderste Anwendung von TextEdit zu Chrome. Das ist **nicht** `ensureTabActive` —
`broughtToFront` fehlt, und der Klick öffnet einen `_blank`-Tab. Chrome hebt sich selbst, weil es
einen neuen Tab anlegt und fokussiert. Das tut jeder Browser, wenn eine Seite einen Tab öffnet.

**Zu den Zeiten, ehrlich:** Fall 2 kostet mehr als Fall 1 (≈1130 ms gegen 376–679 ms), obwohl Fall 1
*mehr* tut. Der Unterschied steckt **nicht** in `ensureTabActive` — in Fall 2 war die Seite schon
`visible`, die Funktion kehrte sofort zurück. Er steckt in der Gesten- und Nachlaufstrecke des
Scrolls selbst, die zwischen 300 und 2400 ms streut. **Ich kann aus diesen Zahlen keinen sauberen
Preis der Eskalation ableiten und tue es deshalb nicht.**

## 3. Wo die Eskalation wirklich greift — und wo sie sich falsch meldet

Weil Fall 2 nicht eskalierte, habe ich gesucht, was es tut. Verdecken durch ein
bildschirmfüllendes TextEdit-Fenster: `visibilityState` blieb `visible`. Minimieren per AppleScript:
schlug still fehl. **Minimieren über die Erweiterung selbst wirkte:**

```
  --- 3z) Fenster per chrome.windows.update({state:"minimized"}) ---
    Fensterzustand laut Chrome: {"windowId":617532932,"state":"minimized","focused":false}
    visibilityState im minimierten Fenster: hidden
  3z: visibilityState hidden -> nach tabs.update allein: hidden

  SCROLL Fall 3z
    visibilityState: hidden -> visible
    Dauer 2435 ms | moved=true acknowledged=true
    strip.scrollLeft 300 -> 450
    broughtToFront: (fehlt)
    Fensterzustand nach dem Scroll: {"state":"normal","focused":true}
```

Zeile für Zeile: das Fenster ist **wirklich** minimiert, `visibilityState` ist **`hidden`**,
**`tabs.update({active: true})` allein lässt es `hidden`** — der leichte Pfad versagt also, wie
vorgesehen. Der Treiber eskaliert, und die Eskalation **wirkt**: der Fensterzustand steht danach auf
`{"state":"normal","focused":true}`, die Sichtbarkeit kippt auf `visible`, der Scroll bewegt
korrekt 300 → 450 und meldet `moved: true`.

**Und trotzdem fehlt `broughtToFront`.** Es meldet `false`, wo der Treiber das Fenster
nachweislich nach vorn geholt hat.

### Warum — und die Zahl, die es entscheidet

```js
if (await waitVisible(300)) return { broughtToFront: false };
try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { … }
return { broughtToFront: await waitVisible(300) };
```

Der Rückgabewert ist nicht „habe ich eskaliert", sondern „ist die Sichtbarkeit **innerhalb von
300 ms nach** der Eskalation zurückgekommen". Ich habe gemessen, wie lange das Entminimieren eines
macOS-Fensters wirklich braucht, bis `visibilityState` kippt — dreimal:

```
    Runde 1: visibilityState kippte nach 556 ms   (die Obergrenze im Code ist 300 ms)
    Runde 2: visibilityState kippte nach 588 ms
    Runde 3: visibilityState kippte nach 585 ms
```

**Rund 570 ms gegen eine Grenze von 300 ms.** Das ist die Genie-Animation des Fensters, und sie ist
auf dieser Maschine reproduzierbar länger als das Zeitfenster.

**Folge: `broughtToFront` ist genau in dem Fall falsch, für den es erfunden wurde.** Der einzige
Zustand, den ich finden konnte, in dem die Eskalation überhaupt nötig ist, ist auch der, in dem das
Feld sie verschweigt. Wer sich auf `broughtToFront` verlässt, um dem Menschen zu erklären, warum
sein Fenster gerade aufgesprungen ist, bekommt in diesem Fall keine Erklärung.

**Wichtig zur Einordnung: das Verhalten ist richtig, nur die Meldung nicht.** Der Scroll wirkt, die
Sichtbarkeit kommt zurück, `moved: true` stimmt. Es ist ein Berichtsfehler, kein Steuerungsfehler —
dieselbe Gattung wie `changed`/`ui_changed`, nur diesmal andersherum: die Tat stimmt, die Auskunft
nicht.

**Was ich vorschlagen würde**, ohne es gebaut zu haben: das zweite `waitVisible` entscheidet heute
über zwei verschiedene Fragen zugleich — „habe ich eskaliert" und „hat es rechtzeitig gewirkt". Wenn
`broughtToFront` heißen soll „ich habe dein Fenster nach vorn geholt", dann ist es schon in dem
Moment wahr, in dem `chrome.windows.update({focused: true})` ohne Fehler zurückkommt. Ob die
Sichtbarkeit dann in 300 oder 600 ms folgt, ist eine zweite Tatsache und verdient allenfalls ein
zweites Feld. Und falls die Wartezeit weiterhin über den Rückgabewert entscheiden soll, muss sie
über 570 ms liegen — 800 ms wären auf dieser Maschine die erste Zahl mit Luft.

### Was ich *nicht* zeigen konnte

**Ein echter anwendungsübergreifender Fall, der eskaliert, existiert nach dieser Messung nicht** —
jedenfalls nicht durch Anwendungsfokus allein. Ich habe drei Wege probiert:

| Zustand | `visibilityState` | reicht `tabs.update` allein? |
| --- | --- | --- |
| anderer Tab im selben Fenster vorn | `hidden` | **ja** |
| andere Anwendung vorn, Fenster offen | `visible` (war nie hidden) | entfällt |
| Fenster vollständig von TextEdit verdeckt | `visible` | entfällt |
| **Fenster minimiert** | **`hidden`** | **nein → Eskalation** |

Bemerkenswert: **Verdeckung allein macht die Seite nicht `hidden`.** Ich habe ein
bildschirmfüllendes TextEdit-Fenster über das Chrome-Fenster gelegt und aktiviert; `visibilityState`
blieb `visible`. Chromes Verdeckungserkennung greift hier nicht — was auch erklärt, warum der
alltägliche „ich arbeite in einer anderen App"-Fall nie eskalieren wird.

## 4. Der Einzug des Read-only-Hinweises

**Ich kann `0af28f0` nicht am Bildschirm bestätigen: die installierte App ist `2.0.2+735c269` und
damit älter als der Commit.** `/hello` sagt es, der Fenstertitel sagt es. Ein neueres DMG gibt es
nicht (`dist/` enthält keins). **Ein Bildschirmfoto dieser App zeigt den Zustand *vor* dem Fix, nicht
danach** — es als Bestätigung auszugeben wäre falsch.

Was ich stattdessen getan habe:

**a) Den Ist-Zustand vermessen**, damit es einen prüfbaren Vergleichswert gibt. App-Fenster bei
x=324, Standardgröße 1080×700, Home-Schritt:

```
  StaticText  "PERMISSIONS"              x=354   Einzug 30 px
  Button      "Look at files …"          x=355   Einzug 31 px
  Button      "Change files …"           x=355   Einzug 31 px
  Button      "See and use the desktop"  x=355   Einzug 31 px
  StaticText  "Read-only disables file…" x=339   Einzug 15 px   <-- 16 px weiter links
```

**Der Hinweis steht 15 px weiter links als alles andere in der Karte** — er sitzt bündig an der
Kante der Karte, während Überschrift und Zeilen 15 beziehungsweise 16 px eingerückt sind. Das
bestätigt die Beschreibung im Commit („0px in on both sides") an der installierten App, unabhängig
gemessen. Im Bildschirmfoto ist es deutlich zu sehen.

**b) Die Vorhersage benannt, an der sich der Fix prüfen lässt.** `#readOnlyHint { padding: 0 15px
10px }` verschiebt den Hinweis von **x=339 auf x=354** — also exakt auf die Position von
`PERMISSIONS`. **Wenn nach dem neuen Bauwerk `Read-only disables…` bei x=354 steht, ist der Fix
bestätigt; steht er weiter bei 339, ist er nicht angekommen.** Das ist in einer Zeile nachmessbar.

**c) Den neuen Test laufen lassen:** `test/renderer-layout.test.ts` ist grün, **28 von 28**, und
enthält die Zusicherung `expect(hint).toContain('padding: 0 15px 10px')`. Das prüft den Quelltext,
nicht die Darstellung — aber es schließt aus, dass die Regel wieder verschwindet.

**Sobald ein DMG mit `0af28f0` vorliegt, ist die Bestätigung ein Zweizeiler.** Sag Bescheid, dann
messe ich x nach.

---

## Was sonst auffiel

Im Health-Feld der App standen während dieses Laufs **`Poll errors 1`** und im Aktivitätskopf
**„13 problems"**, bei ansonsten grünem Zustand (`Tunnel → this app ok`, Laufzeit 4 h, „ChatGPT ran
a tool 46s ago"). Das lief neben meinen Messungen her und gehört nicht zu ihnen; ich melde es, weil
ich es gesehen habe, nicht weil ich es untersucht hätte.

## Zur Diagnose

**`scripts/diag-scroll46.mjs` habe ich wieder hergestellt und behalten** — es ist das Werkzeug, das
den `broughtToFront`-Fehler gefunden hat, und es misst ihn in einer Zeile nach, sobald das
Zeitfenster geändert wird. Es enthält jetzt zusätzlich die Fälle 1, 2, 3z und die Zeitmessung des
Entminimierens. **Es sollte verschwinden, sobald `broughtToFront` stimmt** — nicht vorher.
`_debug` in `browser-driver.js` bleibt entfernt; es hat mit dieser Frage nichts zu tun.
