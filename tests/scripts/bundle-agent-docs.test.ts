/**
 * @fileoverview The `.mcpb` cleaner and the packaging check agree on which
 * `node_modules/` entries are agent docs: trees at an installed package's root
 * go, while same-named directories deeper in a package — the MCP SDK's
 * `dist/ext/skills/` runtime modules — stay (cyanheads/mcp-ts-core#794).
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL at run time rather than imported: the script's repo-only
 * fallback import of `../src/mcp-server/skills.js` fails typecheck once `tsc`
 * reaches it (cyanheads/mcp-ts-core#797).
 */
const { checkBundleEntries } = (await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
)) as { checkBundleEntries: (entries: string[], bundleLabel: string) => string[] };

describe('bundle agent documentation boundaries', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/runtime/dist/skills/index.js',
    'node_modules/@scope/skills/index.js',
    'skills/eia-guide/SKILL.md',
  ])('preserves runtime or published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/package/skills/guide/SKILL.md',
    'node_modules/@scope/package/framework-skills/guide/SKILL.md',
    'node_modules/outer/node_modules/@scope/package/skills/guide/SKILL.md',
    'node_modules/outer/node_modules/package/.claude/settings.json',
    'node_modules/package/.agents/guide.md',
    'node_modules/package/docs/SKILL.md',
  ])('removes dependency agent documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toHaveLength(1);
  });
});
