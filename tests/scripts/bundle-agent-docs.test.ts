/**
 * @fileoverview The `.mcpb` cleaner and the packaging check agree on which
 * `node_modules/` entries are agent docs: trees and `AGENTS.md`/`CLAUDE.md` at
 * an installed package's root go, as does a `SKILL.md` anywhere, while
 * same-named directories and files deeper in a package — the MCP SDK's
 * `dist/ext/skills/` runtime modules — stay (cyanheads/mcp-ts-core#794, #820).
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('bundle agent documentation boundaries', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/runtime/dist/skills/index.js',
    'node_modules/@scope/skills/index.js',
    'node_modules/package/docs/CLAUDE.md',
    'node_modules/@scope/package/dist/AGENTS.md',
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
    'node_modules/package/AGENTS.md',
    'node_modules/@scope/package/CLAUDE.md',
    'node_modules/outer/node_modules/package/CLAUDE.md',
    'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
  ])('removes dependency agent documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toHaveLength(1);
  });
});
