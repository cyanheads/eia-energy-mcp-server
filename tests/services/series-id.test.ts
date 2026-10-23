/**
 * @fileoverview Tests for the legacy APIv1 series-ID grammar and the mapping
 * of a `/v2/seriesid/{id}` answer onto a search result.
 * @module tests/services/series-id.test
 */

import { describe, expect, it } from 'vitest';
import { parseSeriesId, SeriesIdResponseSchema, seriesIdEntry } from '@/services/eia/series-id.js';

describe('parseSeriesId', () => {
  it.each([
    ['PET.RWTC.W', 'PET.RWTC.W'],
    ['NG.RNGWHHD.D', 'NG.RNGWHHD.D'],
    ['ELEC.PRICE.TX-RES.M', 'ELEC.PRICE.TX-RES.M'],
    ['pet.rwtc.w', 'PET.RWTC.W'],
    ['PET.W_EPC0_SAX_YCUOK_MBBL.W', 'PET.W_EPC0_SAX_YCUOK_MBBL.W'],
    ['INTL.57-1-USA-TBPD.A', 'INTL.57-1-USA-TBPD.A'],
    ['SEDS.TETCB.TX.A', 'SEDS.TETCB.TX.A'],
    [
      'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A',
      'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A',
    ],
    ['STEO.PATCPUS.Q', 'STEO.PATCPUS.Q'],
    ['EBA.ERCO-ALL.D.H', 'EBA.ERCO-ALL.D.H'],
    ['EBA.ERCO-ALL.D.hl', 'EBA.ERCO-ALL.D.HL'],
    ['PET.WGFUPUS2.4', 'PET.WGFUPUS2.4'],
    // Fits the grammar without being an ID; the lookup tells them apart.
    ['U.S.A', 'U.S.A'],
  ])('reads %s as the series ID %s', (query, id) => {
    expect(parseSeriesId(query)).toBe(id);
  });

  it.each([
    'Henry Hub',
    'petroleum/pri/spt',
    'U.S. crude oil stocks',
    'PET.RWTC',
    'RWTC.W',
    'PET.RWTC.X',
    'PET.RWTC.WW',
    'PET..W',
    '.PET.RWTC.W',
    'PET.RWTC.W.',
    'PET. RWTC.W',
    'PET.RW TC.W',
    'PET.RWTC/X.W',
    'PET.RWTC.5',
    'électricité.données.M',
    'crude oil production forecast',
  ])('does not read %s as a series ID', (query) => {
    expect(parseSeriesId(query)).toBeUndefined();
  });

  describe('work over caller-sized text', () => {
    /** Thread CPU milliseconds for `reps` runs of `fn`, the least of three trials. */
    function cpuMs(fn: () => void, reps: number): number {
      let best = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 3; trial++) {
        const start = process.threadCpuUsage();
        for (let i = 0; i < reps; i++) fn();
        const used = process.threadCpuUsage(start);
        best = Math.min(best, (used.user + used.system) / 1000);
      }
      return best;
    }

    /** Doubling the input at each step: the absolute bound at each size, then the span ratio. */
    function assertLinear(shape: (n: number) => string): void {
      const reps = 20;
      const timings: number[] = [];
      for (let n = 5_000; n <= 320_000; n *= 2) {
        const text = shape(n);
        const ms = cpuMs(() => parseSeriesId(text), reps);
        expect(ms, `${reps} parses at ${n} characters`).toBeLessThan(2_000);
        timings.push(ms);
      }
      const first = Math.max(timings[0] ?? 0, 0.05);
      expect((timings.at(-1) ?? 0) / first).toBeLessThan(256);
    }

    it.each([
      ['a long digit run', (n: number) => `${'1'.repeat(n)}.1.A`],
      ['many valid segments', (n: number) => `${'A.'.repeat(n / 2)}M`],
      ['many segments failing at the last one', (n: number) => `${'A.'.repeat(n / 2)} .M`],
      ['mixed text', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['whitespace alone', (n: number) => '  \r\n'.repeat(n / 4)],
      ['a dot run', (n: number) => `${'.'.repeat(n)}M`],
    ])('stays linear on %s', (_name, shape) => {
      assertLinear(shape);
    });
  });
});

describe('seriesIdEntry', () => {
  /** A `/v2/seriesid` answer as EIA sends it, trimmed to the fields read. */
  function answer(request: unknown, description?: string) {
    return SeriesIdResponseSchema.parse({
      response: { total: 1, frequency: 'monthly', data: [], description, id: 'x' },
      request,
      apiVersion: '2.1.14',
    });
  }

  it('maps the route, every facet as a string filter, the frequency, and the columns', () => {
    const entry = seriesIdEntry(
      'ELEC.GEN.ALL-US-99.Q',
      answer(
        {
          command: '/v2/seriesid/ELEC.GEN.ALL-US-99.Q',
          params: {
            frequency: 'quarterly',
            data: ['generation'],
            facets: { fueltypeid: ['ALL'], location: ['US'], sectorid: [99] },
            sort: [{ column: 'period', direction: 'desc' }],
            offset: 0,
            length: 1,
          },
          route: 'electricity/electric-power-operational-data',
        },
        'Monthly and annual electric power operations  \n    Sources: EIA-923',
      ),
    );
    expect(entry).toEqual({
      route: 'electricity/electric-power-operational-data',
      name: 'ELEC.GEN.ALL-US-99.Q',
      description: 'Monthly and annual electric power operations Sources: EIA-923',
      category: undefined,
      isLeaf: true,
      filter_hint: { fueltypeid: 'ALL', location: 'US', sectorid: '99' },
      frequency: 'quarterly',
      columns: ['generation'],
    });
  });

  it("keeps EIA's own case on facet values", () => {
    const entry = seriesIdEntry(
      'AEO.2023.REF2023.CNSM_NA_RESD_NA_ELC_NA_NA_QBTU.A',
      answer({
        params: {
          frequency: 'annual',
          data: ['value'],
          facets: { scenario: ['ref2023'], seriesId: ['cnsm_NA_resd_NA_elc_NA_NA_qbtu'] },
        },
        route: 'aeo/2023',
      }),
    );
    expect(entry.filter_hint).toEqual({
      scenario: 'ref2023',
      seriesId: 'cnsm_NA_resd_NA_elc_NA_NA_qbtu',
    });
    expect(entry.description).toBe('');
  });

  it('omits filter_hint and columns an answer leaves empty', () => {
    const entry = seriesIdEntry(
      'X.Y.A',
      answer({ params: { frequency: 'annual', data: [], facets: {} }, route: 'total-energy' }),
    );
    expect(entry).not.toHaveProperty('filter_hint');
    expect(entry).not.toHaveProperty('columns');
    expect(entry.frequency).toBe('annual');
  });

  it.each([
    ['no request', {}],
    ['no route', { request: { params: { frequency: 'annual', data: [], facets: {} } } }],
    [
      'a facet with two values',
      {
        request: {
          route: 'seds',
          params: { frequency: 'annual', data: ['value'], facets: { stateId: ['TX', 'CA'] } },
        },
      },
    ],
    [
      'no frequency',
      { request: { route: 'seds', params: { data: ['value'], facets: { stateId: ['TX'] } } } },
    ],
  ])('rejects an answer with %s', (_name, body) => {
    expect(SeriesIdResponseSchema.safeParse(body).success).toBe(false);
  });

  it.each([0, 307, '0', '2129'])('keeps the row total EIA reports (%j)', (total) => {
    const parsed = SeriesIdResponseSchema.parse({
      response: { total, frequency: 'annual', data: [] },
      request: { route: 'aeo/2023', params: { frequency: 'annual', data: ['value'], facets: {} } },
    });
    expect(parsed.response?.total).toBe(total);
  });

  it('reads an answer without a total as carrying none', () => {
    const parsed = SeriesIdResponseSchema.parse({
      response: { description: 'x' },
      request: { route: 'seds', params: { frequency: 'annual', data: [], facets: {} } },
    });
    expect(parsed.response).not.toHaveProperty('total');
  });
});
