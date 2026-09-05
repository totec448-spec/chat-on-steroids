# Confirmation round — ChatGPT, the browser tool

Paste everything below the line into a ChatGPT conversation with the Core and Desktop connectors
enabled. Short and targeted: these are the four browser steps that failed the last round, three of
which have since been fixed.

**Setup that matters.** The connector must actually be picked in ChatGPT, not merely running. The
app can only attribute a call once the extension has observed a real request id in a real ChatGPT
turn. If the app's status still reads "Pick the tunnel in ChatGPT", stop and fix that first —
every step here is unreachable without it.

**What this round is for.** Every step below was driven against the live site on 2026-09-05, from
a clean profile, through the real extension over CDP — not against a fixture. All of them passed:

    set_value on the real select    -> {"set":"g1_e0","value":"1","selected":"Option 1"}
    unmatched option                -> BROWSER_ACTION_REFUSED: g1_e0 has no option matching that
                                       text. Options: Option 1, Option 2   (select left untouched)
    /hovers observe                 -> all three targets exposed:
                                       "name: user1 View profile", user2, user3
    move_ref on one                 -> {"moved":{"x":105,"y":200},"hit":"img","covered":false}
    Logout click_ref                -> hit=i covered=false navigated=true, landing on /login
    navigate to a dead port         -> BROWSER_URL_REFUSED naming the unreachable address
    detach then observe             -> refused, not the Chrome error page

So this is a confirmation that the same code behaves the same way through ChatGPT's own connector
path, which is the one thing that run could not cover. A disagreement with the table above is the
interesting result and worth reporting in full; agreement can be one line per step.

---

You are confirming four browser fixes. Only use the public test site named here. Do not create
accounts or enter real personal data.

After each step write one line: `N. PASS`, `N. FAIL — <exact evidence>`, or `N. SKIP — <reason>`.
Quote literal error text; a paraphrase is worth far less. Never report a step you did not run.

1. `navigate` to `https://the-internet.herokuapp.com/dropdown`, then `observe`.
2. `set_value` on the dropdown with `Option 1`. Re-observe and confirm it now reads back as
   selected. Last round this silently did nothing: `click_ref`, keyboard, `set_value` and typing
   all reported success and the page still read "Please select an option". Report the exact value.
3. `set_value` on the same dropdown with `Purple`. It must be **refused by name, listing the
   available options** — not reported as success. Quote the refusal verbatim.
4. `navigate` to `/hovers` and `observe`. The three hover targets must now have refs, named from
   their captions (`name: user1` and so on). Last round the only ref on the page was an unrelated
   footer link. List the refs and names you see.
5. `move_ref` to one of those refs. Confirm the caption appears **without** a click.
6. `navigate` to `/login`, submit `tomsmith` / `SuperSecretPassword!` (the page's own documented
   demo credentials), and confirm you reach the secure area.
7. `click_ref` the Logout button. Two outcomes are acceptable and one is not.
   - It navigates. Fine.
   - It does not navigate, **and the result says so** — `navigated: false`, the address it did not
     reach, and a note about something outside the page swallowing the click. Also fine, and it is
     the honest answer: your last run caught the cause on screen, a Chrome-native "Passwort ändern"
     dialog in front of the tab. That dialog is painted by the browser process and suspends input
     to the page; no protocol event announces it, so it cannot be detected, only its effect can.
   - It does not navigate and the result reads like plain success. **That is a FAIL** and is the
     thing this fix exists to prevent.

   Quote the complete `click_ref` result either way. If a Chrome password or permission dialog is
   on screen, say so and dismiss it, then click Logout again and report whether it works second
   time — that would confirm the dialog is the cause rather than merely present.

   For what it is worth before you start: this exact button was driven against the live site from
   a clean profile on 2026-09-05 and worked — `hit=i covered=false navigated=true`, landing on
   `/login`. The login click had the same `hit=i` and also worked. So `hit=i` is not the cause,
   measured on the real page rather than a fixture, and a profile with no saved-password state has
   nothing to raise the dialog. A failure here therefore says something about the profile, not the
   click, and the useful thing to report is what is on screen.
8. `navigate` to `http://127.0.0.1:1/` — a port nothing is listening on. Report exactly what
   happens; a named refusal is the expected answer.
9. `detach`, then immediately `observe`. It may re-attach to an ordinary tab; that is deliberate
   and the tool says so. What must **not** happen is the thing you saw last round: a tab holding
   `chrome-error://chromewebdata/` returned as though it were a real page. Report the URL it gives
   you, or the refusal.
10. Final summary: a line per step, then every FAIL restated with its exact evidence.
