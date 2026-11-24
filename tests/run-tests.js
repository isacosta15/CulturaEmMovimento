'use strict';
/**
 * Testes de integração: sobe o servidor real (processo separado) apontando para um
 * mock local do Apps Script e exercita todas as rotas por HTTP.
 * Uso: npm test      (não usa o seu .env nem o seu Apps Script real)
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createMock } = require('./mock-apps-script');

const ROOT = path.join(__dirname, '..');
const SECRET = 'segredo-de-teste-com-tamanho-ok';
const TOKEN = 'token-admin-de-teste-1234567890';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}
const section = (t) => console.log(`\n# ${t}`);

let ipCounter = 0;
const nextIp = () => `10.20.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function startServer(env) {
  const port = 3300 + Math.floor(Math.random() * 600);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TRUST_PROXY: '1', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(url + '/api/health'); if (r.ok) break; } catch { /* aguarda */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, proc, getLogs: () => logs, stop: () => proc.kill('SIGTERM') };
}

// requisição com IP "de cliente" distinto (usa X-Forwarded-For, como no Render)
async function call(base, method, route, { body, token, ip, raw } = {}) {
  const headers = { 'X-Forwarded-For': ip || nextIp() };
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-admin-token'] = token;
  const res = await fetch(base + route, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não é JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

(async () => {
  const mock = await createMock({ secret: SECRET });
  const mockUrl = `http://127.0.0.1:${mock.port}/macros/s/FAKEID/exec`;
  const main = await startServer({
    APPS_SCRIPT_URL: mockUrl,
    APPS_SCRIPT_SECRET: SECRET,
    ADMIN_TOKEN: TOKEN
  });
  const B = main.url;

  try {
    /* ---------------- Frontend e estáticos ---------------- */
    section('Frontend e arquivos estáticos');
    const home = await call(B, 'GET', '/');
    check('GET / responde 200 com HTML', home.status === 200 && /text\/html/.test(home.headers.get('content-type')));

    // Todo CSS/JS/ícone referenciado pelos HTML precisa existir e ter o MIME certo
    for (const page of ['/', '/admin.html']) {
      const html = (await call(B, 'GET', page)).text;
      const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)]
        .map((m) => m[1])
        .filter((u) => !/^(https?:|data:|mailto:)/.test(u));
      for (const ref of refs) {
        const r = await call(B, 'GET', ref.startsWith('/') ? ref : '/' + ref);
        const okType =
          ref.endsWith('.css') ? /text\/css/.test(r.headers.get('content-type')) :
          ref.endsWith('.js') ? /javascript/.test(r.headers.get('content-type')) : true;
        check(`${page} -> ${ref} (200 + MIME)`, r.status === 200 && okType, `status=${r.status}`);
      }
    }
    check('GET /admin (sem extensão) abre o painel', (await call(B, 'GET', '/admin')).status === 200);
    const nf = await call(B, 'GET', '/nao-existe');
    check('Página inexistente devolve 404 em HTML amigável', nf.status === 404 && /Página não encontrada/.test(nf.text));
    check('Rota /teste-servidor de debug foi removida', (await call(B, 'GET', '/teste-servidor')).status === 404);

    section('Cabeçalhos de segurança');
    const csp = home.headers.get('content-security-policy') || '';
    check('CSP presente e restritiva (script-src self)', /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
    check('CSP permite Sketchfab e Google Fonts', /frame-src https:\/\/sketchfab\.com/.test(csp) && /fonts\.googleapis\.com/.test(csp) && /fonts\.gstatic\.com/.test(csp));
    check('CSP sem upgrade-insecure-requests fora de produção', !/upgrade-insecure-requests/.test(csp));
    check('X-Powered-By removido', !home.headers.get('x-powered-by'));
    check('X-Content-Type-Options: nosniff', home.headers.get('x-content-type-options') === 'nosniff');
    check('API com Cache-Control: no-store', (await call(B, 'GET', '/api/health')).headers.get('cache-control') === 'no-store');
    check('index.html não possui <script> inline (compatível com a CSP)', !/<script>/.test(home.text));

    /* ---------------- API pública ---------------- */
    section('API: health e rotas inexistentes');
    const health = await call(B, 'GET', '/api/health');
    check('health ok com Apps Script e admin configurados', health.json?.status === 'ok' && health.json.appsScriptConfigured && health.json.adminConfigured && health.json.frontendFound);
    check('health não expõe segredos', !health.text.includes(SECRET) && !health.text.includes(TOKEN));
    const nr = await call(B, 'GET', '/api/nada');
    check('Rota de API inexistente -> 404 JSON', nr.status === 404 && nr.json?.message);
    const bad = await call(B, 'POST', '/api/contact', { raw: '{json quebrado' });
    check('JSON malformado -> 400 JSON (sem stack trace)', bad.status === 400 && bad.json?.message && !/at /.test(bad.text));

    section('Museus e espaços culturais (data/museums.json)');
    const m1 = await call(B, 'GET', '/api/museums?city=' + encodeURIComponent('São Paulo, SP'));
    check('"São Paulo, SP" (valor padrão do campo) retorna resultados', m1.status === 200 && m1.json.count >= 7, `count=${m1.json?.count}`);
    check('Resultados trazem nome, endereço e links', m1.json.places.every((p) => p.name && p.address && /^https:/.test(p.website) && /^https:/.test(p.mapsUrl)));
    const m2 = await call(B, 'GET', '/api/museums?city=sao%20paulo');
    check('Busca sem acento/caixa ("sao paulo") funciona', m2.json?.count === m1.json.count);
    const m3 = await call(B, 'GET', '/api/museums?city=Rio%20de%20Janeiro');
    check('"Rio de Janeiro" retorna os museus cariocas', m3.json?.count === 3, `count=${m3.json?.count}`);
    const m4 = await call(B, 'GET', '/api/museums?city=Sudeste');
    check('Busca por região ("Sudeste") funciona', m4.json?.count >= 11);
    const m5 = await call(B, 'GET', '/api/museums?city=paulista');
    check('Busca por parte do endereço ("paulista") acha o MASP', m5.json?.places?.some((p) => p.id === 'masp'));
    const m6 = await call(B, 'GET', '/api/museums?city=Cidade%20Inexistente');
    check('Pesquisa sem resultado -> 200 com lista vazia', m6.status === 200 && m6.json.count === 0 && Array.isArray(m6.json.places));
    const m7 = await call(B, 'GET', '/api/museums?city=a');
    check('Termo curto demais -> 400', m7.status === 400);
    const m8 = await call(B, 'GET', '/api/museums');
    check('Sem parâmetro -> 400', m8.status === 400);
    const m9 = await call(B, 'GET', '/api/museums?city=sp');
    check('"sp" casa só com o estado, não com "exposições"', m9.json?.places?.every((p) => p.state === 'SP'));
    const m10 = await call(B, 'GET', '/api/museums?city=' + encodeURIComponent('<script>alert(1)</script>'));
    check('Entrada com HTML é tratada como texto (sem erro)', m10.status === 200 && m10.json.count === 0);

    section('Experiências 3D (público)');
    const e0 = await call(B, 'GET', '/api/experiences');
    check('Sem experiências cadastradas -> lista vazia', e0.status === 200 && e0.json.experiences.length === 0);

    /* ---------------- Contato ---------------- */
    section('Formulário de contato');
    const valid = { nome: 'Maria Silva', email: 'Maria@Exemplo.com', assunto: 'Patrocínio', mensagem: 'Gostaria de conversar sobre um patrocínio.' };
    check('Nome curto -> 400', (await call(B, 'POST', '/api/contact', { body: { ...valid, nome: 'Jo' } })).status === 400);
    check('E-mail inválido -> 400', (await call(B, 'POST', '/api/contact', { body: { ...valid, email: 'maria@' } })).status === 400);
    check('Assunto vazio -> 400', (await call(B, 'POST', '/api/contact', { body: { ...valid, assunto: '' } })).status === 400);
    check('Assunto fora da lista -> 400', (await call(B, 'POST', '/api/contact', { body: { ...valid, assunto: 'Qualquer coisa' } })).status === 400);
    check('Mensagem curta -> 400', (await call(B, 'POST', '/api/contact', { body: { ...valid, mensagem: 'oi' } })).status === 400);
    check('Nada foi gravado após as rejeições', mock.db.messages.length === 0);

    const ok = await call(B, 'POST', '/api/contact', { body: valid });
    check('Contato válido -> 201 com mensagem de sucesso', ok.status === 201 && /sucesso/.test(ok.json?.message));
    check('Mensagem gravada no "Drive" (mock) com status "nova"', mock.db.messages.length === 1 && mock.db.messages[0].status === 'nova' && mock.db.messages[0].email === 'maria@exemplo.com');
    check('Apps Script recebeu sendContactEmail (admin + confirmação)', mock.state.calls.includes('sendContactEmail') && mock.state.emails.length === 2);

    const inj = await call(B, 'POST', '/api/contact', { body: { ...valid, nome: 'Ana\r\nBcc: x@y.com', assunto: 'Outro' } });
    check('Quebra de linha no nome é neutralizada (header injection)', inj.status === 201 && !/[\r\n]/.test(mock.db.messages[0].nome));

    mock.state.mode = 'nosend';
    const nosend = await call(B, 'POST', '/api/contact', { body: valid });
    check('Falha no e-mail -> 502 com saved:true e texto claro', nosend.status === 502 && nosend.json?.saved === true && /registrada/.test(nosend.json.message));
    check('...mas a mensagem continua gravada', mock.db.messages.length === 3);
    mock.state.mode = 'ok';

    section('Limite de tentativas do contato');
    const ipRL = '172.16.0.9';
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await call(B, 'POST', '/api/contact', { body: { ...valid, nome: 'X' }, ip: ipRL })).status);
    check('6ª tentativa do mesmo IP -> 429', statuses.slice(0, 5).every((s) => s === 400) && statuses[5] === 429, statuses.join(','));
    const otherIp = await call(B, 'POST', '/api/contact', { body: valid, ip: '172.16.0.77' });
    check('Outro IP (via X-Forwarded-For) NÃO é afetado (trust proxy ok)', otherIp.status === 201);

    section('Concorrência: 8 contatos simultâneos');
    const before = mock.db.messages.length;
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      call(B, 'POST', '/api/contact', { body: { ...valid, nome: `Visitante ${i}` } })));
    check('Todas responderam 201', burst.every((r) => r.status === 201));
    check('Nenhuma mensagem se perdeu (sem sobrescrita)', mock.db.messages.length === before + 8, `esperado ${before + 8}, obtido ${mock.db.messages.length}`);

    /* ---------------- Admin ---------------- */
    section('Área administrativa: autenticação');
    check('Sem token -> 401', (await call(B, 'GET', '/api/admin/messages')).status === 401);
    check('Token errado -> 401', (await call(B, 'GET', '/api/admin/messages', { token: 'errado' })).status === 401);
    check('Login com token correto -> authenticated', (await call(B, 'POST', '/api/admin/login', { token: TOKEN })).json?.authenticated === true);
    check('Login com token errado -> 401', (await call(B, 'POST', '/api/admin/login', { token: 'x' })).status === 401);
    for (const [m, r] of [['GET', '/api/admin/experiences'], ['DELETE', '/api/admin/messages/x'], ['PATCH', '/api/admin/experiences/x'], ['POST', '/api/admin/experiences']]) {
      check(`${m} ${r} protegida`, (await call(B, m, r)).status === 401);
    }

    section('Área administrativa: mensagens');
    const list = await call(B, 'GET', '/api/admin/messages', { token: TOKEN });
    check('Lista mensagens', list.status === 200 && list.json.count === mock.db.messages.length && list.json.count >= 12);
    const id = list.json.messages[0].id;
    const st = await call(B, 'PATCH', `/api/admin/messages/${id}`, { token: TOKEN, body: { status: 'respondida' } });
    check('Atualiza status', st.status === 200 && st.json.item.status === 'respondida' && mock.db.messages.find((x) => x.id === id).status === 'respondida');
    check('Status inválido -> 400', (await call(B, 'PATCH', `/api/admin/messages/${id}`, { token: TOKEN, body: { status: 'xyz' } })).status === 400);
    check('Mensagem inexistente -> 404', (await call(B, 'PATCH', '/api/admin/messages/nao-existe', { token: TOKEN, body: { status: 'nova' } })).status === 404);
    const n = mock.db.messages.length;
    check('Exclui mensagem', (await call(B, 'DELETE', `/api/admin/messages/${id}`, { token: TOKEN })).status === 200 && mock.db.messages.length === n - 1);
    check('Excluir de novo -> 404', (await call(B, 'DELETE', `/api/admin/messages/${id}`, { token: TOKEN })).status === 404);

    section('Área administrativa: experiências 3D');
    const emb = 'https://sketchfab.com/models/abc123def4567890abc123def4567890/embed';
    check('Título curto -> 400', (await call(B, 'POST', '/api/admin/experiences', { token: TOKEN, body: { title: 'a', embedUrl: emb } })).status === 400);
    for (const bad of ['https://evil.com/models/abc/embed', 'http://sketchfab.com/models/abc/embed', 'https://sketchfab.com.evil.com/models/abc/embed', 'javascript:alert(1)', 'https://sketchfab.com/3d-models/nome-abc']) {
      check(`URL rejeitada: ${bad}`, (await call(B, 'POST', '/api/admin/experiences', { token: TOKEN, body: { title: 'Teste', embedUrl: bad } })).status === 400);
    }
    const c1 = await call(B, 'POST', '/api/admin/experiences', { token: TOKEN, body: { title: 'Vaso grego', description: 'Peça do acervo', embedUrl: emb + '?autostart=1' } });
    check('Cadastra experiência (URL com query aceita)', c1.status === 201 && c1.json.item.active === true && mock.db.experiences.length === 1);
    const expId = c1.json.item.id;
    const pub1 = await call(B, 'GET', '/api/experiences');
    check('Aparece no endpoint público', pub1.json.experiences.length === 1 && pub1.json.experiences[0].title === 'Vaso grego');
    check('Endpoint público não vaza campos internos', !('active' in pub1.json.experiences[0]) && !('createdAt' in pub1.json.experiences[0]));
    const ed = await call(B, 'PATCH', `/api/admin/experiences/${expId}`, { token: TOKEN, body: { title: 'Vaso grego (editado)', description: 'Nova descrição', embedUrl: 'https://sketchfab.com/models/ffff1234/embed' } });
    check('Edita título, descrição e URL', ed.status === 200 && ed.json.item.title === 'Vaso grego (editado)' && ed.json.item.embedUrl.endsWith('ffff1234/embed') && mock.db.experiences[0].description === 'Nova descrição');
    check('Edição com URL inválida -> 400 e nada muda', (await call(B, 'PATCH', `/api/admin/experiences/${expId}`, { token: TOKEN, body: { embedUrl: 'https://evil.com/x' } })).status === 400 && mock.db.experiences[0].embedUrl.endsWith('ffff1234/embed'));
    check('Edição com título curto -> 400', (await call(B, 'PATCH', `/api/admin/experiences/${expId}`, { token: TOKEN, body: { title: 'a' } })).status === 400);
    check('Edição sem campos -> 400', (await call(B, 'PATCH', `/api/admin/experiences/${expId}`, { token: TOKEN, body: {} })).status === 400);
    const off = await call(B, 'PATCH', `/api/admin/experiences/${expId}`, { token: TOKEN, body: { active: false } });
    check('Desativa', off.status === 200 && off.json.item.active === false);
    check('Experiência inativa some do site público', (await call(B, 'GET', '/api/experiences')).json.experiences.length === 0);
    check('...mas continua na listagem administrativa', (await call(B, 'GET', '/api/admin/experiences', { token: TOKEN })).json.experiences.length === 1);
    await call(B, 'PATCH', `/api/admin/experiences/${expId}`, { token: TOKEN, body: { active: true } });
    check('Reativa e volta ao site', (await call(B, 'GET', '/api/experiences')).json.experiences.length === 1);
    mock.db.experiences.push({ id: 'adulterado', title: 'Adulterado', embedUrl: 'https://evil.com/x', active: true });
    check('Registro adulterado no Drive (URL fora do Sketchfab) não é publicado', (await call(B, 'GET', '/api/experiences')).json.experiences.every((x) => x.id !== 'adulterado'));
    mock.db.experiences.pop();
    check('Experiência inexistente -> 404', (await call(B, 'PATCH', '/api/admin/experiences/nao-existe', { token: TOKEN, body: { active: false } })).status === 404);
    check('Exclui experiência', (await call(B, 'DELETE', `/api/admin/experiences/${expId}`, { token: TOKEN })).status === 200 && mock.db.experiences.length === 0);
    check('Excluir de novo -> 404', (await call(B, 'DELETE', `/api/admin/experiences/${expId}`, { token: TOKEN })).status === 404);

    section('Força bruta no painel');
    const ipBF = '192.168.50.50';
    const codes = [];
    for (let i = 0; i < 17; i++) codes.push((await call(B, 'POST', '/api/admin/login', { token: 'chute' + i, ip: ipBF })).status);
    check('Após 15 falhas o IP é bloqueado (429)', codes.slice(0, 15).every((s) => s === 401) && codes[15] === 429, codes.join(','));
    const usage = [];
    for (let i = 0; i < 40; i++) usage.push((await call(B, 'GET', '/api/admin/experiences', { token: TOKEN, ip: '192.168.60.60' })).status);
    check('Uso normal do painel (40 requisições) não é bloqueado', usage.every((s) => s === 200));

    /* ---------------- Falhas do Apps Script ---------------- */
    section('Falhas na integração com o Apps Script');
    mock.state.mode = 'html';
    const h1 = await call(B, 'GET', '/api/experiences');
    check('Apps Script devolvendo HTML (acesso restrito) -> 500 controlado', h1.status === 500 && h1.json?.message);
    check('O log explica a causa (Qualquer pessoa / /exec)', /Qualquer pessoa/.test(main.getLogs()));
    const h2 = await call(B, 'POST', '/api/contact', { body: valid });
    check('Contato com Drive indisponível -> 500 sem fingir sucesso', h2.status === 500 && !h2.json.saved);
    mock.state.mode = 'ok';

    const wrong = await startServer({ APPS_SCRIPT_URL: mockUrl, APPS_SCRIPT_SECRET: 'segredo-errado', ADMIN_TOKEN: TOKEN });
    const w1 = await call(wrong.url, 'GET', '/api/experiences');
    check('Segredo incorreto -> 500 controlado e sem vazar segredo', w1.status === 500 && !w1.text.includes('segredo'));
    check('Log registra "Não autorizado"', /Não autorizado/.test(wrong.getLogs()));
    wrong.stop();

    const slow = await startServer({ APPS_SCRIPT_URL: mockUrl, APPS_SCRIPT_SECRET: SECRET, ADMIN_TOKEN: TOKEN, APPS_SCRIPT_TIMEOUT_MS: '800' });
    mock.state.mode = 'slow';
    const t0 = Date.now();
    const s1 = await call(slow.url, 'GET', '/api/experiences');
    check('Apps Script lento -> timeout em ~1s (não trava)', s1.status === 500 && Date.now() - t0 < 2500, `${Date.now() - t0}ms`);
    check('Log informa tempo esgotado', /Tempo esgotado/.test(slow.getLogs()));
    mock.state.mode = 'ok';
    slow.stop();

    const unconf = await startServer({ APPS_SCRIPT_URL: '', APPS_SCRIPT_SECRET: '', ADMIN_TOKEN: '' });
    const u0 = await call(unconf.url, 'GET', '/api/health');
    check('Sem configuração: servidor sobe e health informa', u0.json?.appsScriptConfigured === false && u0.json.adminConfigured === false);
    check('Sem ADMIN_TOKEN o painel fica inacessível (401)', (await call(unconf.url, 'POST', '/api/admin/login', { token: '' })).status === 401);
    check('Catálogo de museus funciona sem Apps Script', (await call(unconf.url, 'GET', '/api/museums?city=Curitiba')).json?.count === 1);
    unconf.stop();

    section('Porta ocupada (causa provável do 404 relatado)');
    const port = Number(new URL(B).port);
    const dup = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) } });
    let dupLog = '';
    dup.stderr.on('data', (d) => (dupLog += d));
    const code = await new Promise((r) => dup.on('exit', r));
    check('Segunda instância na mesma porta falha com mensagem clara', code === 1 && /já está em uso/.test(dupLog));
  } finally {
    main.stop();
    mock.server.close();
  }

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  if (failed) { console.log('Falhas:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error('Erro nos testes:', e); process.exit(1); });
