// The deployed API: one function serving every /api route.
//
// Vercel's rewrite sends /api/anything here, but a rewrite replaces the path the
// function sees — /api/log/state arrives as /api. The rewrite therefore carries
// the original sub-path in a query parameter, and this entry point puts it back
// before Express routes the request. If a platform ever does preserve the path,
// the reconstruction produces the same URL, so this is correct either way.

import app from '../server/index.mjs';

/** Query parameter carrying the sub-path; set by the rewrite in vercel.json. */
const REWRITTEN_PATH = 'apiPath';

/** Plain route segments only — this value arrives from the query string. */
const SAFE_SUB_PATH = /^[A-Za-z0-9._~/-]*$/;

/** Restore the path the browser actually requested. */
function restoreRequestUrl(requestUrl) {
  const url = new URL(requestUrl ?? '/', 'http://tracespend.invalid');
  const subPath = url.searchParams.get(REWRITTEN_PATH);
  if (subPath === null || !SAFE_SUB_PATH.test(subPath) || subPath.includes('..')) return requestUrl;

  url.searchParams.delete(REWRITTEN_PATH);
  url.pathname = `/api/${subPath}`.replace(/\/+$/, '') || '/api';
  return `${url.pathname}${url.search}`;
}

export default function handler(req, res) {
  req.url = restoreRequestUrl(req.url);
  return app(req, res);
}
