import type { PluginCatalogEntry, PluginSource } from '../../shared/plugins.js';

/** Reviewed upstream recipes; versions are pinned until an explicit update. Icons are original CoS artwork. */
export const pluginCatalog: PluginCatalogEntry[] = [
  {
    id: 'blender',
    name: 'Blender MCP',
    description: 'Create and inspect 3D scenes through the community Blender addon.',
    icon: 'blender',
    color: '#e87932',
    source: { kind: 'python', package: 'blender-mcp', version: '1.9.1', command: 'blender-mcp' },
    homepage: 'https://github.com/ahujasid/blender-mcp',
    license: 'MIT',
    fields: [],
    tools: ['get_scene_info', 'get_object_info', 'get_viewport_screenshot', 'execute_blender_code'],
    instructions: [
      'Install Python 3.10+ and uv from https://docs.astral.sh/uv/getting-started/installation/.',
      'Install this plugin, then run uvx blender-mcp==1.9.1 install-addon in a terminal (or install addon.py from the source repository).',
      'In Blender: Preferences → Add-ons → enable Interface: MCP for Blender. Press N in the 3D viewport, open MCP for Blender, and click Start MCP Server.',
      'Restart this plugin. Ready requires tool discovery and a successful read-only scene probe.',
    ],
  },
  {
    id: 'memory',
    name: 'Knowledge Memory',
    description: 'A persistent local knowledge graph for your conversations.',
    icon: 'memory',
    color: '#9b7bd9',
    source: { kind: 'npm', package: '@modelcontextprotocol/server-memory', version: '2026.8.31' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    license: 'MIT / Apache-2.0; see upstream notices',
    fields: [],
    tools: ['create_entities', 'create_relations', 'add_observations', 'read_graph', 'search_nodes'],
    instructions: [
      'Install Node.js 20+ from https://nodejs.org/.',
      'Memory data survives plugin updates in a separate data directory. Uninstall removes its local data. Enable only the tools you want exposed.',
    ],
  },
  {
    id: 'playwright',
    name: 'Playwright Browser',
    description: 'Browser automation from Microsoft’s Playwright MCP server.',
    icon: 'playwright',
    color: '#45a66b',
    source: { kind: 'npm', package: '@playwright/mcp', version: '0.0.80' },
    homepage: 'https://github.com/microsoft/playwright-mcp',
    license: 'Apache-2.0',
    fields: [],
    tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill_form', 'browser_tabs', 'browser_take_screenshot'],
    instructions: [
      'Install Node.js 20+ and Google Chrome.',
      'This integration launches its own browser. External processes have your operating-system permissions.',
    ],
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    description: 'Fetch web pages and convert their content for model consumption.',
    icon: 'fetch',
    color: '#498edb',
    // This upstream release declares mcp>=1.1.3 but imports v1's McpError. Resolve
    // the reviewed SDK version with the server; unconstrained mcp2 crashes at import.
    source: { kind: 'python', package: 'mcp-server-fetch', version: '2025.4.7', command: 'mcp-server-fetch', dependencies: [{ package: 'mcp', version: '1.30.0' }] },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    license: 'MIT',
    fields: [],
    tools: ['fetch'],
    instructions: ['Install Python 3.10+ and uv.', 'This server can make network requests as your user account.'],
  },
  {
    id: 'heygen',
    name: 'HeyGen Video',
    description: 'Create avatar videos, generate speech and translate existing videos.',
    icon: 'heygen',
    color: '#8764d8',
    source: { kind: 'remote', url: 'https://mcp.heygen.com/mcp/v1/', auth: 'oauth' },
    homepage: 'https://developers.heygen.com/mcp/overview',
    license: 'Hosted service terms',
    fields: [],
    tools: ['Create avatar videos', 'Create avatars', 'Generate speech', 'Translate videos', 'Check video progress'],
    instructions: [
      'Connect, then sign in to your HeyGen account in the browser.',
      'Available operations depend on your account and the access you approve. HeyGen service terms and usage charges apply.',
    ],
  },
  {
    id: 'recraft',
    name: 'Recraft Design',
    description: 'Create vector artwork, edit images, remove backgrounds and build reusable styles.',
    icon: 'recraft',
    color: '#ce7952',
    source: { kind: 'remote', url: 'https://mcp.recraft.ai/mcp', auth: 'oauth' },
    homepage: 'https://www.recraft.ai/docs/mcp-reference/remote-server',
    license: 'Hosted service terms',
    fields: [],
    tools: ['Generate raster and vector images', 'Vectorize images', 'Remove or replace backgrounds', 'Upscale images', 'Create custom styles'],
    instructions: [
      'Connect, then sign in to your Recraft account in the browser.',
      'This is the maintained hosted service, replacing the discontinued local MCP package. Recraft service terms and usage charges apply.',
    ],
  },
  {
    id: 'unity',
    name: 'Unity Editor',
    description: 'Create scenes, edit GameObjects and materials, and run tests in your Unity Editor.',
    icon: 'unity',
    color: '#668da0',
    source: { kind: 'python', package: 'mcpforunityserver', version: '10.2.0', command: 'mcp-for-unity', args: ['--transport', 'stdio'] },
    homepage: 'https://github.com/CoplayDev/unity-mcp',
    license: 'MIT',
    fields: [],
    tools: ['manage_scene', 'manage_gameobject', 'manage_material', 'run_tests', 'read_console'],
    instructions: [
      'Install Python 3.10+, uv and Unity 2021.3 LTS or newer.',
      'In Unity Package Manager, add https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.2.0. Open Window → MCP for Unity and select stdio transport.',
      'Keep the Unity project open while using these tools. This community integration is maintained by Coplay/Aura and is not affiliated with Unity Technologies.',
    ],
  },
];

/** Reviewed notices belong to an exact distribution, never every version of a package. */
export function reviewedPluginLicense(source: PluginSource, fallback: string): string {
  return pluginCatalog.find(recipe => recipe.source.kind === source.kind &&
    recipe.source.package === source.package && recipe.source.version === source.version &&
    (source.kind === 'npm' || source.kind === 'python'))?.license ?? fallback;
}
