'use strict';
/**
 * Mock local do Google Apps Script, usado SOMENTE em testes.
 * Reproduz o comportamento observado no Google:
 *   POST /macros/s/<id>/exec  ->  302 para /echo/<token>  ->  GET devolve o JSON
 * Contrato: { action, secret, ... } -> { ok, data | message }
 * Modos de falha (via POST /__mode): 'html' (página de login), 'slow', 'nosend'.
 */
const http = require('http');

function createMock({ secret, port = 0 }) {
  const db = { messages: [], experiences: [] };
  const results = new Map();
  const state = { mode: 'ok', emails: [], calls: [] };
  let counter = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');

      if (url.pathname === '/__mode' && req.method === 'POST') {
        state.mode = JSON.parse(raw).mode;
        res.end('ok');
        return;
      }

      if (url.pathname.startsWith('/echo/') && req.method === 'GET') {
        const out = results.get(url.pathname.slice(6));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(out || '{"ok":false,"message":"expirado"}');
        return;
      }

      if (url.pathname.endsWith('/exec') && req.method === 'POST') {
        if (state.mode === 'html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Faça login na sua conta do Google</body></html>');
          return;
        }

        let body;
        try { body = JSON.parse(raw); } catch { body = {}; }
        state.calls.push(body.action);

        let out;
        if (body.secret !== secret) {
          out = { ok: false, message: 'Não autorizado.' };
        } else if (body.action === 'readJson' && db[body.file]) {
          out = { ok: true, data: db[body.file] };
        } else if (body.action === 'writeJson' && db[body.file] && Array.isArray(body.data)) {
          db[body.file] = body.data;
          out = { ok: true, data: true };
        } else if (body.action === 'sendContactEmail') {
          if (state.mode === 'nosend') out = { ok: false, message: 'Cota de e-mails excedida.' };
          else {
            state.emails.push({ to: 'admin', ...body });
            state.emails.push({ to: body.email, confirmation: true });
            out = { ok: true, data: { adminSent: true, confirmationSent: true } };
          }
        } else {
          out = { ok: false, message: 'Ação inválida.' };
        }

        const respond = () => {
          const token = `t${++counter}`;
          results.set(token, JSON.stringify(out));
          res.writeHead(302, { Location: `/echo/${token}` });
          res.end();
        };
        if (state.mode === 'slow') setTimeout(respond, 3000);
        else respond();
        return;
      }

      res.writeHead(404);
      res.end('nope');
    });
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, db, state, port: server.address().port })
    )
  );
}

module.exports = { createMock };
