# External MCP plugins

Settings → Plugins manages external MCP integrations. Core and Desktop keep their existing
connectors, permissions and tool registration. Plugins uses a third, separately tokenized
endpoint and the shared **Chat On Steroids Plugins** connector.

## Setup

1. Open Plugins and choose **Set up plugins** in the prominent connection card.
   With OpenAI Secure Tunnels, create a separate Plugins tunnel, enter its ID in
   the dialog, and choose **Save & connect**. The existing API key and tunnel executable are reused.
   Cloudflare/manual transports publish the Plugins endpoint at its separate path.
2. Create the **Chat On Steroids Plugins** connector in ChatGPT using the displayed name,
   description and MCP URL. Keep the CoS connection running.
3. Open Settings → Plugins and click **+**. Choose a reviewed catalog recipe or a custom server. Review
   installation instructions and supply credentials in the secure fields.
4. A plugin becomes **Ready** only after connection and discovery succeed. Blender also
   requires its addon to answer a read-only scene probe. Local readiness does not prove
   that ChatGPT has enrolled the connector or refreshed its tools.
5. A persistent reminder and **Open ChatGPT plugins** action stay visible above the installed list.
   Successful installation, configuration and tool-policy changes also display a reminder to refresh the **Chat On Steroids Plugins** connector in ChatGPT. Refresh the connector in ChatGPT after changing enabled tools, or enable CoS's existing
   automatic connector refresh. Existing conversations can retain cached declarations;
   disabled tools refuse stale calls immediately.

Automatic refresh compares the name, description and input schema that the provider's
installed-tool UI exposes. For an upstream change confined to annotations or output schema,
refresh manually; the Plugins endpoint itself always serves the complete current declaration.

## Supported sources

- Pinned npm and Python recipes: Blender MCP, Knowledge Memory, Playwright Browser, Web Fetch and Unity Editor.
  Node.js/npm or Python/uv must be installed where the recipe requires them. CoS installs
  packages into private per-plugin directories and does not install missing system runtimes.
- An executable with explicit arguments (no shell interpolation).
- Remote Streamable HTTP MCP URLs, with HTTPS or loopback HTTP. Credentials use encrypted
  storage; do not embed them in URLs or arguments. HeyGen and Recraft use explicit browser OAuth
  authorization. Their hosted services have separate provider terms and account requirements.
- Local MCPB bundles using the upstream manifest parser and configuration expansion.
  Unsupported runtime/manifest setup reports an error rather than inventing a launch command.
- GitHub URLs that match reviewed recipes. Other repositories need an MCPB release or explicit
  package/executable configuration; a repository URL alone is not executable MCP configuration.

Blender needs the community addon installed and enabled in Blender, with its MCP server started
from the viewport sidebar. The catalog includes the upstream addon installation steps. Blender
is a third-party integration, not an official Blender feature supplied by CoS.

## Authority and lifetime

`src/main/plugins/manager.ts` owns installed records, enabled policy, connections, credentials
references and tool routing. `src/main/plugins/installer.ts` owns isolated package installation
and bounded archive extraction. The manager stores metadata through `durable.ts`, credentials
through `secrets.ts`, and preserves upstream package license files in installation directories.

External processes run with the current user's operating-system permissions. They do not inherit
CoS's approved-folder sandbox. CoS read-only mode refuses external plugin calls because upstream
annotations cannot prove that an external process is unable to mutate. Tool annotations are
otherwise relayed without making them more permissive.

The Plugins surface forwards complete JSON schemas and MCP results through the SDK and the
existing request attribution/recording dispatcher. Upstream tool names are preserved; conflicting declarations are excluded rather than renamed. Discovery is bounded to 64 exposed tools and 250 KB of schemas;
the installed tool list distinguishes enabled tools from those actually published within the limit.
Transport failures never automatically retry tool calls. A failed mutation can already have
taken effect; inspect its state before deciding to retry.

Fresh installs contain no plugins. Installed and enabled plugins keep their connection for the app's lifetime, until disabled or uninstalled. App startup restores those connections in the background without waiting for external server discovery before showing chats. Cached tool declarations remain available during startup; every call rechecks current enabled policy.

Restart reconnects/discovers a server. Configure changes its settings and write-only credentials.
Update stages a replacement and requires a successful connection before committing it; failure
restores the prior installation. Package versions stay pinned to reviewed recipes; custom version
changes use Configure. Uninstall stops the process and removes installation data and credentials.
Knowledge Memory retains its data across updates in a stable per-plugin data directory.

## Legal notices

CoS remains MIT licensed. Settings provides the bundled Third-party Notices, generated from
production npm dependencies by `scripts/generate-third-party-notices.mjs`. Platform binary
notices remain alongside their binaries. See [catalog artwork attribution](plugin-licenses.md).
External plugin licenses are shown per installation and remain separate from CoS's own license.
Reviewed labels apply only to the exact catalog distribution. Knowledge Memory's reviewed
MIT/Apache transition supersedes its incomplete manifest label; a custom version must supply
its own license information. `npm run verify:notices` checks installed production versions,
license material and catalog notice hashes on every CI platform without rewriting the local
notice file. Packaging regenerates the notices for its installed dependencies.

Notice completeness is not binary-release clearance. Exact corresponding-source and
replacement obligations for LGPL/MPL native dependencies remain a separate release check;
see [the audit](plugin-notice-audit.md).

## Validation

The plugin suites cover archive path and expansion limits, installation, subprocess discovery,
schema/result preservation, credential redaction, durable disabled state, rollback, and routing
through the real loopback MCP endpoint. `COS_PLUGIN_LIVE_TEST=1` enables an opt-in network test
of the pinned upstream Memory server. See [the notice and validation audit](plugin-notice-audit.md).
