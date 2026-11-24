'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

const isProduction =
  process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const PORT = Number(process.env.PORT) || 3000;
const APPS_SCRIPT_TIMEOUT_MS = Number(process.env.APPS_SCRIPT_TIMEOUT_MS) || 25000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const MUSEUMS_FILE = path.join(__dirname, 'data', 'museums.json');

// Assuntos aceitos no formulário (devem coincidir com as opções do index.html)
const CONTACT_SUBJECTS = [
  'Produção de evento',
  'Formação e oficinas',
  'Patrocínio',
  'Outro'
];
const MESSAGE_STATUSES = ['nova', 'em_andamento', 'respondida', 'arquivada'];

app.disable('x-powered-by');

// Atrás do proxy do Render, sem isto todos os visitantes pareceriam ter o mesmo IP
// e dividiriam o mesmo limite de requisições. Ajustável por TRUST_PROXY.
const trustProxy = process.env.TRUST_PROXY !== undefined
  ? Number(process.env.TRUST_PROXY)
  : (isProduction ? 1 : 0);
app.set('trust proxy', Number.isNaN(trustProxy) ? 0 : trustProxy);

/* ------------------------------------------------------------------ *
 * Segurança: Helmet + Content Security Policy
 * ------------------------------------------------------------------ */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-src': ['https://sketchfab.com'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      // Em http://localhost isto quebraria o carregamento em alguns navegadores
      'upgrade-insecure-requests': isProduction ? [] : null
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  next();
});

app.use(express.json({ limit: '25kb' }));
app.use(express.urlencoded({ extended: false, limit: '25kb' }));

// Respostas da API nunca devem ser guardadas em cache
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ------------------------------------------------------------------ *
 * Arquivos estáticos (frontend)
 * ------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

/* ------------------------------------------------------------------ *
 * Limitadores de requisições
 * ------------------------------------------------------------------ */
const limiterBase = {
  standardHeaders: 'draft-7',
  legacyHeaders: false
};

const contactLimiter = rateLimit({
  ...limiterBase,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: { message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});

const searchLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60 * 1000,
  limit: 30,
  message: { message: 'Muitas pesquisas seguidas. Aguarde um instante.' }
});

// Conta apenas tentativas que FALHAM (token errado, 404...): protege contra força bruta
const adminFailLimiter = rateLimit({
  ...limiterBase,
  windowMs: 15 * 60 * 1000,
  limit: 15,
  skipSuccessfulRequests: true,
  message: { message: 'Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.' }
});

// Limite geral para o uso normal do painel
const adminLimiter = rateLimit({
  ...limiterBase,
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: { message: 'Limite de requisições administrativas atingido. Aguarde alguns minutos.' }
});

/* ------------------------------------------------------------------ *
 * Utilitários
 * ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Texto de várias linhas (mensagem, descrição)
const clean = (value, max = 500) =>
  String(value ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);

// Texto de linha única (nome, assunto, e-mail): impede quebra de linha
const cleanLine = (value, max = 200) =>
  String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max);

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function validSketchfabEmbed(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'sketchfab.com' &&
      /^\/models\/[a-zA-Z0-9-]+\/embed\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Comunicação com o Google Apps Script
 * ------------------------------------------------------------------ */
async function appsScriptRequest(action, data = {}) {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (!url || !secret) {
    throw new Error('Integração com Google Apps Script não configurada.');
  }

  let response;

  try {
    // O Apps Script responde ao POST com um redirecionamento (302) para
    // script.googleusercontent.com; o fetch precisa segui-lo.
    response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, action, secret }),
      signal: AbortSignal.timeout(APPS_SCRIPT_TIMEOUT_MS)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('Tempo esgotado ao aguardar o Google Apps Script.');
    }
    throw new Error(`Falha de rede ao chamar o Google Apps Script: ${error.message}`);
  }

  const text = await response.text();
  let result;

  try {
    result = JSON.parse(text);
  } catch {
    // Normalmente é uma página HTML de login/erro do Google
    throw new Error(
      `O Apps Script não devolveu JSON (HTTP ${response.status}). ` +
      'Confirme que a implantação é um app da Web com acesso "Qualquer pessoa" ' +
      'e que APPS_SCRIPT_URL termina em /exec.'
    );
  }

  if (!response.ok || !result || result.ok !== true) {
    throw new Error(
      (result && result.message) || 'Erro na comunicação com o Google Apps Script.'
    );
  }

  return result.data;
}

const STORAGE_FILES = ['messages', 'experiences'];

function validateStorageFile(name) {
  if (!STORAGE_FILES.includes(name)) {
    throw new Error('Arquivo de armazenamento não permitido.');
  }
  return name;
}

async function readJson(name) {
  validateStorageFile(name);

  const data = await appsScriptRequest('readJson', { file: name });

  if (data === null || data === undefined || data === '') return [];

  if (!Array.isArray(data)) {
    throw new Error(`O arquivo "${name}" no Google Drive não contém uma lista JSON.`);
  }

  return data;
}

async function writeJson(name, data) {
  validateStorageFile(name);

  if (!Array.isArray(data)) {
    throw new Error('Formato de dados inválido.');
  }

  await appsScriptRequest('writeJson', { file: name, data });
}

// Serializa ciclos "ler → alterar → gravar" do mesmo arquivo dentro desta instância,
// evitando que duas requisições simultâneas se sobrescrevam.
const locks = new Map();

function withLock(name, task) {
  const previous = locks.get(name) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  locks.set(name, run.catch(() => {}));
  return run;
}

// mutate(lista) devolve { list, result }; se list for omitido, nada é gravado.
function updateList(name, mutate) {
  return withLock(name, async () => {
    const list = await readJson(name);
    const outcome = await mutate(list);

    if (outcome && outcome.list) {
      await writeJson(name, outcome.list);
    }

    return outcome ? outcome.result : undefined;
  });
}

// Envolve handlers assíncronos: HttpError vira resposta controlada, o resto vira 500
const handle = (failureMessage, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ message: error.message });
    }

    console.error(`${failureMessage} ->`, error.message);
    return res.status(500).json({ message: failureMessage });
  }
};

/* ------------------------------------------------------------------ *
 * Autenticação administrativa
 * ------------------------------------------------------------------ */
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN || '';
  const supplied = String(req.get('x-admin-token') || '');

  if (!expected || !supplied) {
    return res.status(401).json({ message: 'Acesso administrativo não autorizado.' });
  }

  // Compara hashes de tamanho fixo em tempo constante
  if (!crypto.timingSafeEqual(sha256(expected), sha256(supplied))) {
    return res.status(401).json({ message: 'Token administrativo inválido.' });
  }

  next();
}

/* ------------------------------------------------------------------ *
 * Rotas públicas
 * ------------------------------------------------------------------ */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Cultura em Movimento API',
    appsScriptConfigured: Boolean(
      process.env.APPS_SCRIPT_URL && process.env.APPS_SCRIPT_SECRET
    ),
    adminConfigured: Boolean(process.env.ADMIN_TOKEN),
    frontendFound: fs.existsSync(path.join(PUBLIC_DIR, 'index.html')),
    museumCatalog: fs.existsSync(MUSEUMS_FILE),
    storage: 'Google Drive via Apps Script'
  });
});

// Formulário de contato
app.post('/api/contact', contactLimiter, async (req, res) => {
  const name = cleanLine(req.body?.nome, 100);
  const email = cleanLine(req.body?.email, 160).toLowerCase();
  const subject = cleanLine(req.body?.assunto, 120);
  const message = clean(req.body?.mensagem, 3000);

  if (name.length < 3) {
    return res.status(400).json({ message: 'Informe seu nome com pelo menos 3 caracteres.' });
  }

  if (!isEmail(email)) {
    return res.status(400).json({ message: 'Informe um e-mail válido.' });
  }

  if (!subject || !CONTACT_SUBJECTS.includes(subject)) {
    return res.status(400).json({ message: 'Selecione o assunto da mensagem.' });
  }

  if (message.length < 10) {
    return res.status(400).json({ message: 'A mensagem precisa ter pelo menos 10 caracteres.' });
  }

  const record = {
    id: crypto.randomUUID(),
    nome: name,
    email,
    assunto: subject,
    mensagem: message,
    status: 'nova',
    createdAt: new Date().toISOString()
  };

  // 1) Registra a mensagem no Google Drive
  try {
    await updateList('messages', (messages) => {
      messages.unshift(record);
      return { list: messages };
    });
  } catch (error) {
    console.error('Falha ao salvar contato:', error.message);
    return res.status(500).json({ message: 'Não foi possível registrar sua mensagem.' });
  }

  // 2) Pede ao Apps Script o e-mail administrativo e a confirmação ao visitante
  try {
    await appsScriptRequest('sendContactEmail', { name, email, subject, message });

    return res.status(201).json({
      message: 'Mensagem enviada com sucesso! Nossa equipe retornará em até dois dias úteis.'
    });
  } catch (error) {
    console.error('Falha no envio do e-mail:', error.message);

    return res.status(502).json({
      message: 'Sua mensagem foi registrada, mas o e-mail não pôde ser enviado. Nossa equipe poderá consultar o registro.',
      saved: true
    });
  }
});

// Catálogo local de museus e espaços culturais (data/museums.json)
app.get('/api/museums', searchLimiter, handle(
  'Não foi possível consultar os espaços culturais.',
  async (req, res) => {
    const city = cleanLine(req.query.city, 120);
    const tokens = normalizeText(city).split(/[^a-z0-9]+/).filter(Boolean);

    if (city.length < 2 || tokens.length === 0) {
      throw new HttpError(400, 'Informe uma cidade ou região.');
    }

    const museums = JSON.parse(await fsp.readFile(MUSEUMS_FILE, 'utf8'));

    if (!Array.isArray(museums)) {
      throw new Error('O catálogo de museus precisa ser uma lista.');
    }

    // Cada termo digitado precisa iniciar alguma palavra do cadastro.
    // Assim "São Paulo, SP", "sao paulo" ou "paulista" funcionam,
    // e "sp" não casa por acaso com "exposições".
    const places = museums.filter((museum) => {
      const words = normalizeText([
        museum.city,
        museum.state,
        museum.region,
        museum.name,
        museum.address,
        museum.category,
        ...(museum.tags || [])
      ].join(' ')).split(/[^a-z0-9]+/).filter(Boolean);

      return tokens.every((token) => words.some((word) => word.startsWith(token)));
    });

    res.json({ city, count: places.length, places });
  }
));

// Experiências 3D públicas
app.get('/api/experiences', handle(
  'Não foi possível carregar as experiências.',
  async (_req, res) => {
    const experiences = await readJson('experiences');

    res.json({
      experiences: experiences
        .filter((item) => item.active !== false && validSketchfabEmbed(item.embedUrl))
        .map(({ id, title, description, embedUrl }) => ({ id, title, description, embedUrl }))
    });
  }
));

/* ------------------------------------------------------------------ *
 * Área administrativa (todas as rotas exigem token)
 * ------------------------------------------------------------------ */
app.use('/api/admin', adminFailLimiter, adminLimiter, requireAdmin);

app.post('/api/admin/login', (_req, res) => {
  res.json({ authenticated: true });
});

app.get('/api/admin/messages', handle(
  'Não foi possível ler as mensagens.',
  async (_req, res) => {
    const messages = await readJson('messages');
    res.json({ count: messages.length, messages });
  }
));

app.patch('/api/admin/messages/:id', handle(
  'Não foi possível atualizar o status.',
  async (req, res) => {
    const status = clean(req.body?.status, 20);

    if (!MESSAGE_STATUSES.includes(status)) {
      throw new HttpError(400, 'Status inválido.');
    }

    const item = await updateList('messages', (messages) => {
      const found = messages.find((message) => message.id === req.params.id);

      if (!found) throw new HttpError(404, 'Mensagem não encontrada.');

      found.status = status;
      found.updatedAt = new Date().toISOString();

      return { list: messages, result: found };
    });

    res.json({ message: 'Status atualizado.', item });
  }
));

app.delete('/api/admin/messages/:id', handle(
  'Não foi possível excluir a mensagem.',
  async (req, res) => {
    await updateList('messages', (messages) => {
      const filtered = messages.filter((message) => message.id !== req.params.id);

      if (filtered.length === messages.length) {
        throw new HttpError(404, 'Mensagem não encontrada.');
      }

      return { list: filtered };
    });

    res.json({ message: 'Mensagem excluída.' });
  }
));

app.get('/api/admin/experiences', handle(
  'Não foi possível ler as experiências.',
  async (_req, res) => {
    res.json({ experiences: await readJson('experiences') });
  }
));

app.post('/api/admin/experiences', handle(
  'Não foi possível cadastrar a experiência.',
  async (req, res) => {
    const title = cleanLine(req.body?.title, 100);
    const description = clean(req.body?.description, 500);
    const embedUrl = cleanLine(req.body?.embedUrl, 500);

    if (title.length < 3) {
      throw new HttpError(400, 'Informe um título com pelo menos 3 caracteres.');
    }

    if (!validSketchfabEmbed(embedUrl)) {
      throw new HttpError(
        400,
        'Use o link oficial de incorporação do Sketchfab (https://sketchfab.com/models/ID/embed).'
      );
    }

    const item = {
      id: crypto.randomUUID(),
      title,
      description,
      embedUrl,
      active: true,
      createdAt: new Date().toISOString()
    };

    await updateList('experiences', (experiences) => {
      experiences.unshift(item);
      return { list: experiences };
    });

    res.status(201).json({ message: 'Experiência cadastrada.', item });
  }
));

app.patch('/api/admin/experiences/:id', handle(
  'Não foi possível atualizar a experiência.',
  async (req, res) => {
    const body = req.body || {};
    const changes = {};

    if (typeof body.active === 'boolean') {
      changes.active = body.active;
    }

    if (body.title !== undefined) {
      const title = cleanLine(body.title, 100);

      if (title.length < 3) {
        throw new HttpError(400, 'Informe um título com pelo menos 3 caracteres.');
      }

      changes.title = title;
    }

    if (body.description !== undefined) {
      changes.description = clean(body.description, 500);
    }

    if (body.embedUrl !== undefined) {
      const url = cleanLine(body.embedUrl, 500);

      if (!validSketchfabEmbed(url)) {
        throw new HttpError(400, 'Link de incorporação Sketchfab inválido.');
      }

      changes.embedUrl = url;
    }

    if (Object.keys(changes).length === 0) {
      throw new HttpError(400, 'Nenhuma alteração válida foi informada.');
    }

    const item = await updateList('experiences', (experiences) => {
      const found = experiences.find((experience) => experience.id === req.params.id);

      if (!found) throw new HttpError(404, 'Experiência não encontrada.');

      Object.assign(found, changes, { updatedAt: new Date().toISOString() });

      return { list: experiences, result: found };
    });

    res.json({ message: 'Experiência atualizada.', item });
  }
));

app.delete('/api/admin/experiences/:id', handle(
  'Não foi possível excluir a experiência.',
  async (req, res) => {
    await updateList('experiences', (experiences) => {
      const filtered = experiences.filter((experience) => experience.id !== req.params.id);

      if (filtered.length === experiences.length) {
        throw new HttpError(404, 'Experiência não encontrada.');
      }

      return { list: filtered };
    });

    res.json({ message: 'Experiência excluída.' });
  }
));

/* ------------------------------------------------------------------ *
 * Rotas inexistentes e erros
 * ------------------------------------------------------------------ */
app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'Rota da API não encontrada.' });
});

app.use((_req, res) => {
  res
    .status(404)
    .type('html')
    .send(
      '<!doctype html><html lang="pt-BR"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Página não encontrada</title>' +
      '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem">' +
      '<h1>Página não encontrada</h1><p>O endereço solicitado não existe.</p>' +
      '<p><a href="/">Voltar ao início</a></p></body></html>'
    );
});

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Requisição com JSON inválido.' });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Requisição grande demais.' });
  }

  console.error('Erro não tratado:', error.message);
  return res.status(500).json({ message: 'Erro interno do servidor.' });
});

/* ------------------------------------------------------------------ *
 * Inicialização
 * ------------------------------------------------------------------ */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cultura em Movimento: servidor iniciado na porta ${PORT}`);

  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    console.warn(`AVISO: ${path.join(PUBLIC_DIR, 'index.html')} não existe. O site não será exibido.`);
  }

  if (!process.env.APPS_SCRIPT_URL || !process.env.APPS_SCRIPT_SECRET) {
    console.warn('AVISO: APPS_SCRIPT_URL / APPS_SCRIPT_SECRET não configurados. Contato e experiências não funcionarão.');
  }

  if (!process.env.ADMIN_TOKEN) {
    console.warn('AVISO: ADMIN_TOKEN não configurado. A área administrativa ficará inacessível.');
  } else if (process.env.ADMIN_TOKEN.length < 16) {
    console.warn('AVISO: ADMIN_TOKEN curto. Use pelo menos 16 caracteres aleatórios.');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `ERRO: a porta ${PORT} já está em uso por outro processo. ` +
      'Provavelmente uma cópia antiga do servidor continua rodando e é ELA que responde ' +
      'às requisições (inclusive com 404 para CSS/JS). Encerre-a ou use outra PORT.'
    );
  } else {
    console.error('Erro ao iniciar o servidor:', error);
  }

  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Promise rejeitada sem tratamento:', reason);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
