// Drives an Express app in-process: no listener, no socket, no network.
//
// The app is a plain (req, res) handler, so a request is a real IncomingMessage
// fed from memory and a real ServerResponse whose writes are collected instead of
// being flushed to a socket. This is the seam the deployment depends on — if the
// app can be invoked this way, a serverless platform can invoke it too.

import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

const JSON_TYPE = 'application/json';

function lowercaseKeys(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

function toResponse(res, buffer) {
  const text = buffer.toString('utf8');
  const contentType = String(res.getHeader('content-type') ?? '');
  return {
    status: res.statusCode,
    headers: res.getHeaders(),
    text,
    json: contentType.includes('json') && text ? JSON.parse(text) : null,
  };
}

/**
 * @param {Function} app             an Express application
 * @param {{method?:string,url?:string,headers?:object,body?:unknown}} options
 * @returns {Promise<{status:number,headers:object,text:string,json:any}>}
 */
export function inject(app, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

  const req = new IncomingMessage(new Socket());
  req.method = method.toUpperCase();
  req.url = url;
  req.headers = { host: 'localhost', ...lowercaseKeys(headers) };
  if (payload) {
    if (!req.headers['content-type']) req.headers['content-type'] = JSON_TYPE;
    req.headers['content-length'] = String(payload.length);
  }

  const res = new ServerResponse(req);
  const chunks = [];
  res.write = (chunk, _encoding, callback) => {
    if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
    if (typeof callback === 'function') callback();
    return true;
  };

  return new Promise((resolve, reject) => {
    res.end = (chunk, _encoding, callback) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      if (typeof callback === 'function') callback();
      res.emit('finish');
      resolve(toResponse(res, Buffer.concat(chunks)));
      return res;
    };
    req.on('error', reject);

    app(req, res);

    if (payload) req.push(payload);
    req.push(null);
  });
}
