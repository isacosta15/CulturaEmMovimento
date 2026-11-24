/**
 * Cultura em Movimento - ponte Google Apps Script
 *
 * Funções (todas exigem o segredo compartilhado):
 *   readJson          -> lê messages.json / experiences.json no Google Drive
 *   writeJson         -> grava esses arquivos
 *   sendContactEmail  -> e-mail ao administrador + confirmação ao visitante
 *
 * CONFIGURAÇÃO (Configurações do projeto > Propriedades do script):
 *   SECRET      segredo compartilhado (mesmo valor de APPS_SCRIPT_SECRET no Render)
 *   CONTACT_TO  e-mail administrativo que recebe os contatos
 *   FOLDER_ID   (opcional) ID de uma pasta do Drive; se ausente, usa/cria
 *               a pasta "CulturaEmMovimento-dados" no seu Drive
 *
 * IMPLANTAÇÃO: Implantar > Nova implantação > App da Web
 *   Executar como: Eu     |     Quem tem acesso: Qualquer pessoa
 * Ao alterar este código, crie uma NOVA VERSÃO da implantação (Gerenciar implantações).
 * Na primeira implantação o Google pede autorização (Drive e envio de e-mail).
 */

var FILES = { messages: 'messages.json', experiences: 'experiences.json' };
var DEFAULT_FOLDER_NAME = 'CulturaEmMovimento-dados';

function doGet() {
  return json_({ ok: true, message: 'Cultura em Movimento - Apps Script ativo.' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');

    if (!secret || !safeEqual_(String(body.secret || ''), secret)) {
      return json_({ ok: false, message: 'Não autorizado.' });
    }

    switch (body.action) {
      case 'readJson':
        return json_({ ok: true, data: readJson_(body.file) });
      case 'writeJson':
        writeJson_(body.file, body.data);
        return json_({ ok: true, data: true });
      case 'sendContactEmail':
        return json_({ ok: true, data: sendContactEmail_(body) });
      default:
        return json_({ ok: false, message: 'Ação inválida.' });
    }
  } catch (err) {
    return json_({ ok: false, message: 'Erro interno: ' + err.message });
  }
}

/* ---------- Drive ---------- */
function getFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var it = DriveApp.getFoldersByName(DEFAULT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DEFAULT_FOLDER_NAME);
}

function getFile_(key, createIfMissing) {
  if (!FILES.hasOwnProperty(key)) throw new Error('Arquivo não permitido.');
  var folder = getFolder_();
  var it = folder.getFilesByName(FILES[key]);
  if (it.hasNext()) return it.next();
  if (!createIfMissing) return null;
  return folder.createFile(FILES[key], '[]', MimeType.PLAIN_TEXT);
}

function readJson_(key) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var text = getFile_(key, true).getBlob().getDataAsString('UTF-8');
    var data = text ? JSON.parse(text) : [];
    return Array.isArray(data) ? data : [];
  } finally {
    lock.releaseLock();
  }
}

function writeJson_(key, data) {
  if (!Array.isArray(data)) throw new Error('Os dados precisam ser uma lista.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    getFile_(key, true).setContent(JSON.stringify(data));
  } finally {
    lock.releaseLock();
  }
}

/* ---------- E-mail ---------- */
function oneLine_(v, max) {
  return String(v || '').replace(/[\r\n\u0000-\u001F]+/g, ' ').trim().substring(0, max);
}

function sendContactEmail_(b) {
  var to = PropertiesService.getScriptProperties().getProperty('CONTACT_TO');
  if (!to) throw new Error('CONTACT_TO não configurado.');

  var name = oneLine_(b.name, 100);
  var email = oneLine_(b.email, 160);
  var subject = oneLine_(b.subject, 120);
  var message = String(b.message || '').substring(0, 3000);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail do visitante inválido.');

  // 1) E-mail ao administrador (obrigatório). Texto simples: sem risco de HTML injetado.
  MailApp.sendEmail({
    to: to,
    replyTo: email,
    name: 'Cultura em Movimento (site)',
    subject: '[Contato do site] ' + subject + ' - ' + name,
    body: 'Nova mensagem pelo site\n\nNome: ' + name + '\nE-mail: ' + email +
          '\nAssunto: ' + subject + '\n\nMensagem:\n' + message
  });

  // 2) Confirmação ao visitante (melhor esforço: falha aqui não invalida o contato)
  var confirmationSent = true;
  try {
    MailApp.sendEmail({
      to: email,
      name: 'Cultura em Movimento',
      subject: 'Recebemos sua mensagem - Cultura em Movimento',
      body: 'Olá, ' + name + '!\n\nRecebemos sua mensagem sobre "' + subject +
            '" e retornaremos em até dois dias úteis.\n\nEquipe Cultura em Movimento\n' +
            '(Projeto fictício criado para fins acadêmicos.)'
    });
  } catch (err) {
    confirmationSent = false;
  }

  return { adminSent: true, confirmationSent: confirmationSent };
}

/* ---------- Utilidades ---------- */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
