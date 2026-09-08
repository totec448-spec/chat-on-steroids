# Optional plugin recipe license references

These exact upstream texts support the reviewed catalog. They are not the complete dependency notices for an installed plugin: CoS downloads those packages only when the user installs them, and retains their dependency directories and bundled code notices. They do not change the MIT license of CoS. The original CoS SVG illustrations are MIT artwork, not upstream logos.

`inventory.json` maps every local recipe to its pinned distribution, archive integrity and SHA-256 of the preserved license text. Hosted HeyGen and Recraft have no invented package/version or open-source grant: their small SERVICE-NOTICE files identify the official endpoint, setup documentation and provider terms. These references were checked on 2026-09-08.

Knowledge Memory 2026.8.31 references LICENSE in its npm manifest but omits that file from the tarball. Its supplement is the complete upstream LICENSE at the package's exact gitHead, including the transition from MIT to Apache-2.0 and the distinct documentation terms. Do not simplify this to MIT or suggest that every contribution has been relicensed. Fetch's older wheel retains its own MIT license; the later repository transition does not rewrite that artifact.

Playwright MCP's pinned tarball supplies Apache-2.0 LICENSE and no standalone NOTICE. Blender, Fetch and Unity's pinned Python wheels supply MIT license files and no standalone NOTICE. These observations describe the inspected direct server distributions, not an exhaustive transitive dependency audit. The rejected Context7, Exa, Firecrawl and Tavily recipes and their direct-package license snapshots were removed from the current inventory.

The app's `scripts/generate-third-party-notices.mjs` inventories production dependencies bundled with CoS and separately includes these optional catalog references for review before connection or installation. It must not represent optional packages as bundled dependencies or replace their complete installed notices with these direct-package references.
