'use strict';

// Small JSON HTTP client with a keep-alive pool. A burst of N requests is all in
// flight at once (queued on 50 sockets) instead of opening N raw TCP
// connections, which overflows the OS accept backlog on Windows.

const http = require('http');

function createClient({ maxSockets = 50 } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets });

  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        url,
        {
          method,
          agent,
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            raw += c;
          });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    close: () => agent.destroy(),
  };
}

module.exports = { createClient };
