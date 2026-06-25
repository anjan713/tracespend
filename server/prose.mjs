// Retired — superseded by server/index.mjs.
//
// The prose reword endpoint (/api/prose) and the activity log sink (/api/log)
// now live in server/index.mjs alongside the single-shot /api/ask pipeline.
// This shim keeps the old entry point working: `node server/prose.mjs` simply
// boots the full server. Use `npm run server` (which runs server/index.mjs).

import './index.mjs';
