/**
 * The preview mock has to keep matching the module it replaces.
 *
 * `vite.preview.config.ts` swaps the two at bundle time, where TypeScript is
 * not looking: a function dropped from the mock, or a signature that drifts,
 * would build cleanly and fail in the browser. This file puts the two back in
 * front of the compiler, so `tsc -b` — which `npm run build:preview` runs
 * first — rejects the mismatch instead.
 *
 * Nothing imports this at runtime, so it never reaches the bundle.
 */

import * as preview from './fake-api';

type RealApi = typeof import('../api/client');

/** Assignable only while the mock still offers the real module's surface. */
export const apiContract: RealApi = preview;
