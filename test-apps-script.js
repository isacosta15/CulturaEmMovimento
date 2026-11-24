'use strict';
/**
 * Diagnóstico da integração REAL com o Google Apps Script / Google Drive.
 *
 *   node test-apps-script.js            testa leitura e gravação (não altera dados:
 *                                       regrava exatamente o que leu)
 *   node test-apps-script.js --email    além disso, envia um e-mail de teste de verdade
 *                                       (administrador + confirmação para --to=<seu e-mail>)
 *
 * Usa APPS_SCRIPT_URL e APPS_SCRIPT_SECRET do arquivo .env.
 */
require('dotenv').config();

const url = process.env.APPS_SCRIPT_URL;
const secret = process.env.APPS_SCRIPT_SECRET;
const withEmail = process.argv.includes('--email');
const toArg = process.argv.find((a) => a.startsWith('--to='));

async function call(action, extra = {}) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...extra, action, secret }),
    signal: AbortSignal.timeout(30000)
  });

  const text = await response.text();
  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      `O Apps Script não devolveu JSON (HTTP ${response.status}).\n` +
      '   Causas comuns:\n' +
      '   - A implantação não está como "Executar como: Eu" + "Quem tem acesso: Qualquer pessoa".\n' +
      '   - Você alterou o código mas não criou uma NOVA VERSÃO da implantação.\n' +
      '   - APPS_SCRIPT_URL não é a URL de "App da Web" terminada em /exec.\n' +
      `   Início da resposta: ${text.slice(0, 120).replace(/\s+/g, ' ')}`
    );
  }

  if (!response.ok || !result.ok) {
    throw new Error(result.message || 'Falha desconhecida.');
  }

  return result.data;
}

(async () => {
  if (!url || !secret) {
    console.error('ERRO: defina APPS_SCRIPT_URL e APPS_SCRIPT_SECRET no arquivo .env');
    process.exit(1);
  }

  let failed = false;

  for (const file of ['messages', 'experiences']) {
    try {
      process.stdout.write(`Lendo "${file}"... `);
      const data = await call('readJson', { file });
      if (!Array.isArray(data)) throw new Error('o conteúdo não é uma lista JSON');
      console.log(`OK (${data.length} registro(s))`);

      process.stdout.write(`Gravando "${file}" (mesmo conteúdo)... `);
      await call('writeJson', { file, data });
      console.log('OK');
    } catch (error) {
      failed = true;
      console.log('FALHOU');
      console.error(`   ${error.message}`);
    }
  }

  if (withEmail) {
    const to = toArg ? toArg.slice(5) : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      console.error('Para --email informe o destinatário da confirmação: --to=voce@gmail.com');
      process.exit(1);
    }

    try {
      process.stdout.write('Enviando e-mail de teste... ');
      const out = await call('sendContactEmail', {
        name: 'Teste de Integração',
        email: to,
        subject: 'Outro',
        message: 'Mensagem de teste enviada por test-apps-script.js.'
      });
      console.log('OK', JSON.stringify(out));
      console.log('   Confira a caixa administrativa (CONTACT_TO) e a caixa de', to);
    } catch (error) {
      failed = true;
      console.log('FALHOU');
      console.error(`   ${error.message}`);
    }
  }

  console.log(failed ? '\nIntegração com problemas.' : '\nIntegração com o Google Drive funcionando.');
  process.exit(failed ? 1 : 0);
})();
