import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('NDBRAIN_COLLAB', () => {
  afterEach(() => {
    delete process.env['NDBRAIN_COLLAB'];
  });

  it('is on when unset', () => {
    expect(loadConfig().collab).toBe(true);
  });

  it('can be switched off', () => {
    process.env['NDBRAIN_COLLAB'] = 'false';
    expect(loadConfig().collab).toBe(false);
  });
});
