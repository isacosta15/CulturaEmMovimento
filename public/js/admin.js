/* ==========================================================
   Cultura em Movimento - Painel administrativo
   ========================================================== */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const TOKEN_KEY = 'cm_admin_token';

  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* sem sessionStorage */ }

  let editingId = null;
  let experiences = [];

  const STATUS_OPTIONS = [
    ['nova', 'Nova'],
    ['em_andamento', 'Em andamento'],
    ['respondida', 'Respondida'],
    ['arquivada', 'Arquivada']
  ];

  /* ---------- Utilidades ---------- */
  const showDashboard = (visible) => {
    $('#dashboard').classList.toggle('hidden', !visible);
    $('#login-panel').classList.toggle('hidden', visible);
  };

  const setMessage = (selector, text, isError = false) => {
    const el = $(selector);
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError));
  };

  const saveToken = (value) => {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignora */ }
  };

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token,
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(data.message || 'Ocorreu um erro na solicitação.');
      error.status = response.status;
      throw error;
    }

    return data;
  }

  function logout(message = '') {
    saveToken('');
    token = '';
    cancelEdit();
    showDashboard(false);
    $('#admin-token').value = '';
    setMessage('#login-message', message, Boolean(message));
  }

  /* Erro numa ação do painel: sessão inválida volta ao login; o resto é avisado */
  function fail(error) {
    if (error.status === 401) {
      logout('Sessão inválida ou expirada. Entre novamente.');
      return;
    }
    alert(error.message);
  }

  /* ---------- Login ---------- */
  async function login() {
    const typed = $('#admin-token').value.trim();

    if (!typed) {
      setMessage('#login-message', 'Informe o token de acesso.', true);
      return;
    }

    const button = $('#login-button');
    button.disabled = true;
    token = typed;

    try {
      await api('/api/admin/login', { method: 'POST' });
      saveToken(token);
      setMessage('#login-message', '');
      showDashboard(true);
      await refreshAll();
    } catch (error) {
      token = '';
      setMessage('#login-message', error.message, true);
      showDashboard(false);
    } finally {
      button.disabled = false;
    }
  }

  $('#login-button').addEventListener('click', login);
  $('#admin-token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });
  $('#logout-button').addEventListener('click', () => logout());

  /* ---------- Mensagens ---------- */
  async function loadMessages() {
    const { messages } = await api('/api/admin/messages');
    const list = $('#messages-list');
    list.replaceChildren();

    if (!messages.length) {
      list.textContent = 'Nenhuma mensagem recebida até o momento.';
      return;
    }

    messages.forEach((item) => {
      const article = document.createElement('article');
      article.className = 'admin-item';

      const title = document.createElement('h3');
      title.textContent = item.assunto;

      const details = document.createElement('p');
      details.textContent =
        `${item.nome} · ${item.email} · ${new Date(item.createdAt).toLocaleString('pt-BR')}`;

      const body = document.createElement('p');
      body.textContent = item.mensagem;

      const select = document.createElement('select');
      select.setAttribute('aria-label', `Status da mensagem de ${item.nome}`);
      STATUS_OPTIONS.forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
      });
      select.value = item.status;

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn-secondary';
      save.textContent = 'Salvar status';
      select.addEventListener('change', () => { save.textContent = 'Salvar status'; });
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(`/api/admin/messages/${encodeURIComponent(item.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: select.value })
          });
          item.status = select.value;
          save.textContent = 'Salvo ✓';
        } catch (error) {
          fail(error);
        } finally {
          save.disabled = false;
        }
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-danger';
      del.textContent = 'Excluir';
      del.addEventListener('click', async () => {
        if (!confirm('Excluir esta mensagem permanentemente?')) return;
        try {
          await api(`/api/admin/messages/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          await loadMessages();
        } catch (error) {
          fail(error);
        }
      });

      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      actions.append(save, del);

      article.append(title, details, body, select, actions);
      list.append(article);
    });
  }

  /* ---------- Experiências ---------- */
  function startEdit(item) {
    editingId = item.id;
    $('#exp-title').value = item.title || '';
    $('#exp-description').value = item.description || '';
    $('#exp-url').value = item.embedUrl || '';
    $('#experience-form-title').textContent = 'Editar experiência 3D';
    $('#exp-submit').textContent = 'Salvar alterações';
    $('#exp-cancel').classList.remove('hidden');
    setMessage('#experience-message', '');
    $('#experience-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#exp-title').focus();
  }

  function cancelEdit() {
    editingId = null;
    $('#experience-form').reset();
    $('#experience-form-title').textContent = 'Cadastrar experiência 3D';
    $('#exp-submit').textContent = 'Cadastrar experiência';
    $('#exp-cancel').classList.add('hidden');
  }

  async function loadExperiences() {
    ({ experiences } = await api('/api/admin/experiences'));
    const list = $('#experiences-list');
    list.replaceChildren();

    if (!experiences.length) {
      list.textContent = 'Nenhuma experiência cadastrada.';
      return;
    }

    experiences.forEach((item) => {
      const article = document.createElement('article');
      article.className = 'admin-item';

      const title = document.createElement('h3');
      title.textContent = item.title;

      const description = document.createElement('p');
      description.textContent = item.description || 'Sem descrição.';

      const url = document.createElement('small');
      url.textContent = item.embedUrl;

      const status = document.createElement('span');
      status.className = 'admin-status';
      status.textContent = item.active ? 'Ativa (visível no site)' : 'Inativa (oculta no site)';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-secondary';
      edit.textContent = 'Editar';
      edit.addEventListener('click', () => startEdit(item));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn-secondary';
      toggle.textContent = item.active ? 'Desativar' : 'Ativar';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await api(`/api/admin/experiences/${encodeURIComponent(item.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: !item.active })
          });
          await loadExperiences();
        } catch (error) {
          toggle.disabled = false;
          fail(error);
        }
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-danger';
      del.textContent = 'Excluir';
      del.addEventListener('click', async () => {
        if (!confirm('Excluir esta experiência?')) return;
        try {
          await api(`/api/admin/experiences/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          if (editingId === item.id) cancelEdit();
          await loadExperiences();
        } catch (error) {
          fail(error);
        }
      });

      const actions = document.createElement('div');
      actions.className = 'admin-actions';
      actions.append(edit, toggle, del);

      article.append(title, description, url, status, actions);
      list.append(article);
    });
  }

  $('#exp-cancel').addEventListener('click', () => {
    cancelEdit();
    setMessage('#experience-message', '');
  });

  $('#experience-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const button = $('#exp-submit');
    button.disabled = true;

    const payload = {
      title: $('#exp-title').value,
      description: $('#exp-description').value,
      embedUrl: $('#exp-url').value
    };

    try {
      const result = editingId
        ? await api(`/api/admin/experiences/${encodeURIComponent(editingId)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload)
          })
        : await api('/api/admin/experiences', {
            method: 'POST',
            body: JSON.stringify(payload)
          });

      cancelEdit();
      setMessage('#experience-message', result.message);
      await loadExperiences();
    } catch (error) {
      if (error.status === 401) fail(error);
      else setMessage('#experience-message', error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  /* ---------- Inicialização ---------- */
  const refreshAll = () => Promise.all([loadMessages(), loadExperiences()]);

  $('#refresh-messages').addEventListener('click', () => {
    loadMessages().catch(fail);
  });

  if (token) {
    api('/api/admin/login', { method: 'POST' })
      .then(() => {
        showDashboard(true);
        return refreshAll();
      })
      .catch((error) => {
        if (error.status === 401) logout();
        else {
          showDashboard(true);
          setMessage('#experience-message', error.message, true);
        }
      });
  }
})();
