# Plugins legal footer

Base: `58bac85`, branch `fix/plugins-legal-footer`. CSS only.

## Finding

The Plugins page's "Legal Notices / Third-party Licenses" disclosure (and "About" on the same
page) had a summary rule with only width and cursor. It kept the native `list-item` marker, so a
▶ showed beside the app's chevron, and the chevron (`display: block`) took its own line with the
label on the next. Opened, the first paragraph sat directly under the summary.

## Change

The summaries use the app's existing disclosure pattern (`.setup-optional`): one flex row with
the chevron and label, no native marker, and ink on hover; the chevron already rotates when open.
The legal text gets the same 10px lead-in as About.

## Validation

- Electron captures of the footer closed and open: one aligned row, chevron centred on the label
  (9px of 19), text spaced below the summary.
- Layout tests: 47 passed.
