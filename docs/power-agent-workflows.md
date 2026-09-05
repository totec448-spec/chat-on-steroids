# Power Agent workflows

Issue #2 asks for separate `open_url`, `web_fetch`, `launch_app`, process and system-file MCP
schemas. Core intentionally keeps a small primitive surface instead: `exec_command` is the
system-execution primitive, while `read` / `apply_patch` enforce the approved-file workflow.

Use these recipes when the `exec_command` permission is enabled.

## Open a URL

- Windows PowerShell: `Start-Process 'https://example.com'`
- macOS: `open 'https://example.com'`
- Linux: `xdg-open 'https://example.com'`

## Fetch a page/API

- Cross-platform when curl is present: `curl -fsSL 'https://example.com'`
- Windows PowerShell: `(Invoke-WebRequest -UseBasicParsing 'https://example.com').Content`

For research that does not need the local machine, ChatGPT's normal web tools remain preferable.

## Launch an application

- Windows PowerShell: `Start-Process notepad.exe` or `Start-Process code -ArgumentList '.'`
- macOS: `open -a 'Visual Studio Code' .`
- Linux: launch the application's normal command.

## Inspect / terminate processes

- Windows PowerShell: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 30`
  and `Stop-Process -Id <pid>` when the user actually asked to stop it.
- macOS/Linux: `ps -eo pid,ppid,etime,comm,args` and `kill <pid>`.

Do not invent a second filesystem authority. `read` and `apply_patch` remain the explicit
approved-root file interface, and shell/system actions remain subject to the command permission.
