/**
 * @fileoverview Tests for the ISO/RTO acronym table and the facets it applies on.
 * @module tests/services/balancing-authorities.test
 */

import { describe, expect, it } from 'vitest';
import { balancingAuthorityAcronyms } from '@/services/eia/balancing-authorities.js';

describe('balancingAuthorityAcronyms', () => {
  it('maps each ISO and RTO balancing-authority code to its acronym', () => {
    const table = balancingAuthorityAcronyms('electricity/rto/region-data', 'respondent');
    expect(table && Object.fromEntries(table)).toEqual({
      ERCO: ['ERCOT'],
      CISO: ['CAISO'],
      CA: ['CAISO'],
      NYIS: ['NYISO'],
      SWPP: ['SPP'],
      SWPW: ['SPP'],
      ISNE: ['ISO-NE'],
      MISO: ['MISO'],
      PJM: ['PJM'],
    });
  });

  it.each([
    ['electricity/rto/region-data', 'respondent'],
    ['electricity/rto/daily-fuel-type-data', 'respondent'],
    ['electricity/rto/interchange-data', 'fromba'],
    ['electricity/rto/interchange-data', 'toba'],
    ['electricity/rto/region-sub-ba-data', 'parent'],
    ['electricity/operating-generator-capacity', 'balancing_authority_code'],
  ])('applies on %s %s', (route, facetId) => {
    expect(balancingAuthorityAcronyms(route, facetId)?.get('ERCO')).toEqual(['ERCOT']);
  });

  it.each([
    // CA is California here, not CAISO.
    ['electricity/retail-sales', 'stateid'],
    // Sub-balancing-authority zones are not the ISOs themselves.
    ['electricity/rto/region-sub-ba-data', 'subba'],
    // The pellet-plant survey's respondents are plants.
    ['densified-biomass/wood-pellet-plants', 'respondent'],
  ])('does not apply on %s %s', (route, facetId) => {
    expect(balancingAuthorityAcronyms(route, facetId)).toBeUndefined();
  });
});
