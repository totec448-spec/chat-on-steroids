# QA — zwei Dokumente, mehr nicht

| Wer | Was | Datei |
|---|---|---|
| **ChatGPT** | der vollständige Durchlauf: 40 Prüfungen über Bildschirmfotos, Mauszeiger, Klicken, Fenster, Scrollen, Erweiterung, Onboarding, Robustheit | [chatgpt.md](chatgpt.md) |
| **Claude Code auf dem Mac** | sechs Teile: die Suiten, die drei Dinge, die nur ein echter Bildschirm beurteilen kann, der Fokus-Fehler, Eingaben unterhalb der App, und die installierte Fassung | [claude-mac.md](claude-mac.md) |

Vorher waren es sechs Dokumente, von denen vier überholt waren. Sie stehen in der Git-Historie.

## Vorbereitung, nur für ChatGPT

Claude Code braucht nichts davon — das Dokument baut den Helfer selbst.

1. **DMG installieren.** Der Fenstertitel muss `Chat On Steroids 2.0.2+<commit>` lauten, mit dem
   Commit aus den Release-Notizen. Fehlt der Teil hinter dem `+`, läuft eine ältere App und
   Testen ist sinnlos.
2. **Berechtigungen erteilen** — Systemeinstellungen → Datenschutz & Sicherheit →
   Bildschirmaufnahme und Bedienungshilfen, beide für Chat On Steroids. Danach die App komplett
   beenden (Cmd+Q) und neu starten: macOS merkt sich die Antwort pro Prozess.
3. **Erweiterung laden und neu laden.** In der App auf *Open extension folder*, in Chrome unter
   `chrome://extensions` den Entwicklermodus einschalten und den Ordner laden. War sie schon da,
   **Reload drücken** — der Treiber steckt in der Erweiterung, nicht in der App, ein neues Paket
   allein ändert in Chrome also nichts.
4. **Prüfen, dass drei Werkzeuge da sind.** Home → Health → Run checks muss
   `Local server … offers 3 tools: browser, computer, observe` zeigen. Stehen dort zwei, ist die
   Erweiterung nicht verbunden.
5. **Desktop-Connector in ChatGPT löschen und neu anlegen, dann neuen Chat öffnen.** Ein Connector
   behält die Werkzeugliste, die er beim Anlegen geholt hat, ein Chat die, die er beim Öffnen
   geladen hat. Dieser Schritt fehlte in drei verlorenen Durchläufen.

## Berichte

Beide Ausgaben vollständig kopieren, nichts kürzen, Fehlermeldungen wortgetreu lassen, und als
Datei unter `reports/` ablegen:

```sh
git add docs/qa/reports && git commit -m "QA reports" && git push
```

## Zwei Fallen

**Prüfung 24 ist bestanden, wenn sie abgelehnt wird.** Das Steuern der eigenen ChatGPT-Registerkarte,
`chrome://` und `file://` müssen verweigert werden. Steht das als Fehlschlag im Bericht, nicht
reparieren lassen.

**Wenn alle Mauszeiger-Prüfungen bestanden sind, einmal selbst nachsehen.** Genau das wurde schon
einmal behauptet und war falsch. Fenster-Bildschirmfoto mit der Maus mitten im Fenster, ist der
Pfeil im Bild — ja oder nein.
