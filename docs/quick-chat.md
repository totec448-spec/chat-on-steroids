# Global Quick Chat

Quick Chat opens a compact COS conversation from a global shortcut (`Ctrl+Shift+E` on Windows/Linux, `Cmd+Shift+E` on macOS), with a tray fallback if the shortcut is occupied. The panel is a separate window over the existing session and delivery infrastructure, not an independent assistant or provider client.

## First increment

- Reusable, resizable panel with the current COS appearance, language and default observed model.
- The same Workspace composer, Markdown transcript, collapsible tool activity, recent chats and search, model and reasoning controls, image/file attachments, clipboard paste and drafts; only the outer layout is compact.
- The history icon opens a dedicated history drawer using the shared chat-search controller; the title is display-only. It starts with the 30 most recent ordinary chats, marks the current one, offers new chat and searches older chats by title or recorded text. Switching retains each chat's drafts and does not drive the Workspace's browser tab. The compact welcome reads “How can I help?” and the native panel waits for renderer initialization before its first show.
- Durable outbox admission and exact session identity. Hiding the panel does not stop the turn. Expanding opens the same conversation in the workspace.
- The Workspace chat row menu offers Open in Quick Chat, opening the exact local session in the existing compact window or after its first renderer initialization. This navigation preserves drafts.
- The same sandboxed preload and security policy as the Workspace, explicit IPC ownership checks on window actions and independent local UI state. Attachment staging protects drafts in both windows.

## Verification and remaining platform work

This increment does not read or capture other applications or provide selection actions. Normal file attachments remain available. Native shortcut, focus and packaging need validation on each platform.
