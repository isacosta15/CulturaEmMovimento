# Cultura em Movimento — versão 2.0

Projeto acadêmico (ESPRO): site institucional com backend Node.js + Express, usando **somente serviços gratuitos**.

## Arquitetura

| Parte | Tecnologia |
|---|---|
| Frontend | HTML, CSS e JavaScript puros (`public/`) |
| Backend | Node.js + Express (`server.js`) |
| E-mail | Google Apps Script (o Render **não** usa SMTP) |
| Armazenamento | Arquivos JSON no Google Drive, acessados pelo Apps Script |
| Museus | Catálogo local `data/museums.json` (sem API externa) |
| Experiências 3D | Incorporação oficial do Sketchfab (iframe) |
| Hospedagem | Render (plano gratuito) |

```
Navegador ──► Express (Render) ──► Apps Script (Web App) ──► Google Drive (messages.json, experiences.json)
                                                        └──► Gmail (e-mail ao administrador + confirmação ao visitante)
```

O Node nunca grava dados no disco do Render (que é efêmero). O segredo compartilhado e o token do painel existem apenas em variáveis de ambiente.

## Funcionalidades

**Visitante:** formulário de contato (validação no navegador e no servidor), pesquisa de museus por cidade/região, galeria de experiências 3D, filtro de projetos, tema claro/escuro, menu mobile.

**Administração (`/admin`):** login por token; consulta, alteração de status e exclusão de mensagens; cadastro, **edição**, ativação/desativação e exclusão de experiências 3D.

## Rotas da API

| Método | Rota | Acesso |
|---|---|---|
| GET | `/api/health` | Público |
| POST | `/api/contact` | Público (5 envios / 15 min por IP) |
| GET | `/api/museums?city=...` | Público |
| GET | `/api/experiences` | Público |
| POST | `/api/admin/login` | Token |
| GET | `/api/admin/messages` | Token |
| PATCH / DELETE | `/api/admin/messages/:id` | Token |
| GET / POST | `/api/admin/experiences` | Token |
| PATCH / DELETE | `/api/admin/experiences/:id` | Token |

O token é enviado no cabeçalho `x-admin-token`. Após 15 tentativas **falhas** em 15 minutos, o IP é bloqueado temporariamente.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `APPS_SCRIPT_URL` | Sim | URL do app da Web do Apps Script (termina em `/exec`) |
| `APPS_SCRIPT_SECRET` | Sim | Segredo compartilhado — igual à propriedade `SECRET` do Apps Script |
| `ADMIN_TOKEN` | Sim | Senha do painel `/admin` (mínimo 16 caracteres aleatórios) |
| `NODE_ENV` | Recomendada | `production` no Render |
| `PORT` | Não | O Render define automaticamente. Local: 3000 |
| `TRUST_PROXY` | Não | Nº de proxies confiáveis. Padrão: 1 em produção, 0 local |
| `APPS_SCRIPT_TIMEOUT_MS` | Não | Tempo máximo de espera pelo Apps Script (padrão 25000) |

Gerar um token forte: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

## 1. Configurar o Google Apps Script

1. Acesse <https://script.google.com> e crie um projeto.
2. Cole o conteúdo de `apps-script/Code.gs` no editor (se você já tem um Apps Script funcionando com as ações `readJson`, `writeJson` e `sendContactEmail`, pode mantê-lo).
3. Em **Configurações do projeto → Propriedades do script**, crie:
   - `SECRET` = um segredo longo e aleatório (será o `APPS_SCRIPT_SECRET`)
   - `CONTACT_TO` = e-mail que receberá as mensagens do site
   - `FOLDER_ID` = *(opcional)* ID de uma pasta do Drive; sem ele, é criada a pasta `CulturaEmMovimento-dados`
4. **Implantar → Nova implantação → App da Web**
   - Executar como: **Eu**
   - Quem tem acesso: **Qualquer pessoa**
5. Autorize as permissões (Drive e envio de e-mail) e copie a URL que termina em `/exec`.
6. Sempre que editar o código, use **Gerenciar implantações → Editar → Nova versão**. Sem isso, a URL continua executando o código antigo.

> Limites gratuitos: contas Gmail comuns enviam até ~100 destinatários/dia pelo Apps Script (cada contato usa 2). Suficiente para uso acadêmico.

## 2. Executar localmente

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# edite o .env com APPS_SCRIPT_URL, APPS_SCRIPT_SECRET e ADMIN_TOKEN
npm start
```

Abra <http://localhost:3000> e <http://localhost:3000/admin>.

Se aparecer **"a porta 3000 já está em uso"**, outra cópia do servidor ainda está rodando e é ela que responde às requisições (sintoma: CSS/JS com 404). Encerre-a (`Ctrl+C` no terminal antigo, ou feche processos `node`) ou defina outra `PORT`.

## 3. Testes

```bash
npm test                 # testes automáticos (usam um Apps Script simulado; não tocam em dados reais)
npm run test:apps-script # diagnostica a integração REAL com Drive (lê e regrava o mesmo conteúdo)
node test-apps-script.js --email --to=seuemail@gmail.com   # envia e-mails de teste de verdade
```

## 4. Publicar no Render

1. Envie o projeto ao GitHub (o `.gitignore` já exclui `.env` e `node_modules`). **Confirme que `.env` não foi enviado.**
2. No Render: **New → Web Service** → conecte o repositório.
3. Configuração:
   - Runtime: **Node** · Build Command: `npm install` · Start Command: `npm start`
   - Instance Type: **Free**
4. Em **Environment**, cadastre `NODE_ENV=production`, `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET` e `ADMIN_TOKEN`. Não cadastre `PORT`.
5. Após o deploy, abra `https://SEU-APP.onrender.com/api/health`: `appsScriptConfigured` e `adminConfigured` devem ser `true`.
6. Rode `node test-apps-script.js` localmente com o mesmo `.env` para validar Drive e e-mail.

> No plano gratuito o serviço "dorme" após ~15 minutos sem acesso; a primeira requisição pode levar cerca de 1 minuto.

## 5. Experiências 3D

1. No Sketchfab, escolha um modelo cujo autor permita incorporação (confira licença e atribuição).
2. Use **Share → Embed** e copie o endereço `https://sketchfab.com/models/ID/embed`.
3. Em `/admin`, cadastre título, descrição e a URL. Somente URLs `https://sketchfab.com/models/.../embed` são aceitas.

## Segurança

- Helmet com Content Security Policy restritiva (scripts apenas do próprio site; iframes apenas do Sketchfab).
- Token do painel comparado em tempo constante; limitação de tentativas; rotas administrativas sempre protegidas.
- Entradas validadas e sanitizadas; assunto do contato restrito à lista oficial; quebras de linha removidas de campos de linha única (evita injeção de cabeçalhos de e-mail).
- Segredos somente em variáveis de ambiente; nada sensível vai ao frontend.
- O token do painel fica em `sessionStorage` (apagado ao fechar a aba). É uma administração simples para apresentação, sem gestão de usuários.

## Limitações conhecidas

- O armazenamento em JSON no Drive não é um banco transacional. O servidor serializa gravações dentro de uma instância (plano gratuito = 1 instância), o que basta para este escopo. Para várias instâncias ou alto volume, migre para um banco de dados.
- O catálogo `data/museums.json` é curado manualmente: confira endereços e sites antes de apresentar e acrescente novos locais seguindo o mesmo formato.
