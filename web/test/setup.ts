import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// How long `waitFor` and `findBy…` keep looking before they give up. The
// default second is ample on an idle machine and not on a busy one, where a
// render that is merely slow reads as a render that never happened. A waiting
// test that passes stops waiting at once, so a longer ceiling costs only when
// something is really broken.
configure({ asyncUtilTimeout: 5000 });
