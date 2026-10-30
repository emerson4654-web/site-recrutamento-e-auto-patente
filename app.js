'use strict';

const $ = (selector) => document.querySelector(selector);
let adminToken = '';

function showFeedback(element, message, success = false) {
  element.textContent = message;
  element.classList.toggle('success', success);
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(adminToken ? { 'x-admin-token': adminToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
  return data;
}

async function loadPublicConfig() {
  try {
    const data = await fetch('/api/public-config').then(response => response.json());
    $('#groupLink').href = data.groupUrl;
  } catch (error) {
    console.warn('Não foi possível carregar as informações públicas do grupo.', error);
  }
}

async function loadDashboard() {
  const status = await api('/api/admin/status');
  $('#groupIdValue').textContent = status.groupId;
  $('#memberCount').textContent = Number(status.knownMemberships || 0).toLocaleString('pt-BR');
  $('#processedCount').textContent = Number(status.processedUsers || 0).toLocaleString('pt-BR');
  $('#roleId').value = status.roleId || '';
  $('#lastSync').textContent = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('pt-BR') : 'Ainda não executada';
  $('#syncMessage').textContent = status.lastSyncMessage || 'Aguardando sincronização.';
  $('#syncButton').disabled = !status.apiConfigured || !status.roleId || status.syncRunning;
  $('#syncButton').textContent = status.syncRunning ? 'Verificando…' : 'Verificar agora ↻';
  $('#dashboard').classList.remove('hidden');
  $('#loginCard').classList.add('hidden');
  await loadLogs();
}

async function loadLogs() {
  const data = await api('/api/admin/logs');
  const container = $('#logsList');
  if (!data.logs || data.logs.length === 0) {
    container.innerHTML = '<div class="empty-state">Nenhum registro encontrado.</div>';
    return;
  }
  container.innerHTML = data.logs.map(log => {
    const time = new Date(log.at).toLocaleString('pt-BR');
    const type = String(log.type || 'info').replace(/[^a-z-]/g, '');
    const message = escapeHtml(log.message || 'Registro');
    return `<div class="log-item"><span class="log-time">${escapeHtml(time)}</span><span class="log-message">${message}</span><span class="log-type ${type}">${escapeHtml(type)}</span></div>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const feedback = $('#loginFeedback');
  adminToken = $('#adminToken').value.trim();
  showFeedback(feedback, 'Conferindo acesso…');
  try {
    await loadDashboard();
    showFeedback(feedback, '');
    $('#adminToken').value = '';
    toast('Acesso autorizado.');
  } catch (error) {
    adminToken = '';
    showFeedback(feedback, error.message);
  }
});

$('#roleForm').addEventListener('submit', async event => {
  event.preventDefault();
  const feedback = $('#roleFeedback');
  const roleId = $('#roleId').value.trim();
  showFeedback(feedback, 'Validando o cargo no Roblox…');
  try {
    await api('/api/admin/role', { method: 'PUT', body: JSON.stringify({ roleId }) });
    showFeedback(feedback, 'Patente padrão salva. Os dois sistemas usarão esse mesmo ID.', true);
    toast('Patente padrão atualizada.');
    await loadDashboard();
  } catch (error) {
    showFeedback(feedback, error.message);
  }
});

$('#syncButton').addEventListener('click', async () => {
  const button = $('#syncButton');
  button.disabled = true;
  button.textContent = 'Verificando…';
  $('#syncMessage').textContent = 'Consultando a lista de membros do grupo…';
  try {
    const result = await api('/api/admin/sync', { method: 'POST', body: '{}' });
    $('#syncMessage').textContent = result.message || 'Verificação concluída.';
    toast(result.baselineCreated ? 'Lista inicial registrada sem alterar cargos.' : 'Verificação concluída.');
    await loadDashboard();
  } catch (error) {
    $('#syncMessage').textContent = error.message;
    button.disabled = false;
    button.textContent = 'Tentar novamente ↻';
  }
});

$('#refreshLogs').addEventListener('click', async () => {
  try { await loadLogs(); toast('Histórico atualizado.'); }
  catch (error) { toast(error.message); }
});

$('#logoutButton').addEventListener('click', () => {
  adminToken = '';
  $('#dashboard').classList.add('hidden');
  $('#loginCard').classList.remove('hidden');
  $('#loginFeedback').textContent = '';
  toast('Você saiu do painel.');
});

loadPublicConfig();
