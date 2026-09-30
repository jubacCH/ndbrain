/**
 * The live-collaboration wire contract.
 *
 * Binary frames, each starting with a varUint message type. Sync and awareness
 * are the y-protocols formats unchanged; control carries one JSON object as a
 * varString, validated against `Control` on arrival.
 */

import { z } from 'zod';

export const COLLAB_PATH = '/api/v1/collab';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_CONTROL = 2;

/** Close codes. `gone` is used for "missing" and "not allowed" alike. */
export const CLOSE = {
  gone: 4404,
  deleted: 4410,
  origin: 4403,
  limit: 4429,
  full: 4503,
} as const;

export const Control = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    epoch: z.string(),
    canWrite: z.boolean(),
    persistedHash: z.string(),
  }),
  z.object({ type: z.literal('persisted'), hash: z.string() }),
  z.object({ type: z.literal('moved'), owner: z.string(), path: z.string() }),
  z.object({ type: z.literal('deleted'), by: z.string() }),
  z.object({ type: z.literal('access'), canWrite: z.boolean() }),
]);
export type Control = z.infer<typeof Control>;
