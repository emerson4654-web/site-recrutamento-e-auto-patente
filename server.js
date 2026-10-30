'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));

const PORT = Number(process.env.PORT || 3000);
const GROUP_ID = String(process.env.GROUP_ID || '13616747').trim();
const INITIAL_ROLE_ID = String(process.env.ROLE_ID_PADRAO || '').trim();
const ROBLOX_API_KEY = String(process.env.ROBLOX_API_KEY || '').trim();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const GAME_SERVER_SECRET = String(process.env.GAME_SERVER_SECRET || '').trim();
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MEMBERSHIP_PAGES = 1000;

let store = {
  settings: { roleId: INITIAL_ROLE_ID },
  baselineInitialized: false,
  knownMembershipIds: [],
  processedUserIds: [],
  logs: [],
  lastSyncAt: null,
  lastSyncMessage: 'Aguardando primeira sincronização.'
};
let syncRunning = false;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getRoleId() {
  return String(store.settings.roleId || INITIAL_ROLE_ID || '').trim();
}

function addLog(type, message, extra = {}) {
  store.logs.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type,
    message: String(message).slice(0, 500),
    ...extra
  });
  store.logs = store.logs.slice(0, 200);
  void saveStore();
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    store = {
      ...store,
      ...parsed,
      settings: { roleId: INITIAL_ROLE_ID, ...(parsed.settings || {}) },
      knownMembershipIds: Array.isArray(parsed.knownMembershipIds) ? parsed.knownMembershipIds : [],
      processedUserIds: Array.isArray(parsed.processedUserIds) ? parsed.processedUserIds : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveStore();
  }
}

let saveQueue = Promise.resolve();
function saveStore() {
  const snapshot = JSON.stringify(store, null, 2);
  saveQueue = saveQueue
    .catch(() => {})
    .then(() => fs.mkdir(DATA_DIR, { recursive: true }))
    .then(() => fs.writeFile(DATA_FILE, snapshot, { encoding: 'utf8', mode: 0o600 }));
  return saveQueue;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Configure ADMIN_TOKEN nas variáveis do Render antes de acessar o painel.' });
  }
  if (!safeEqual(req.get('x-admin-token'), ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Senha administrativa incorreta.' });
  }
  next();
}

function requireGameServer(req, res, next) {
  if (!GAME_SERVER_SECRET) {
    return res.status(503).json({ error: 'GAME_SERVER_SECRET ainda não foi configurado no servidor.' });
  }
  if (!safeEqual(req.get('x-game-secret'), GAME_SERVER_SECRET)) {
    return res.status(401).json({ error: 'Servidor do jogo não autorizado.' });
  }
  next();
}

async function robloxRequest(apiPath, options = {}) {
  if (!ROBLOX_API_KEY) {
    const error = new Error('ROBLOX_API_KEY não foi configurada no Render.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`https://apis.roblox.com${apiPath}`, {
    ...options,
    headers: {
      'x-api-key': ROBLOX_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 1000) }; }
  if (!response.ok) {
    const error = new Error(body.message || body.error || `Roblox respondeu HTTP ${response.status}.`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function extractIdFromPath(value, kind) {
  if (typeof value !== 'string') return '';

  // A Open Cloud pode devolver nomes de recurso como "users/123" e
  // "groups/123/memberships/456", sem uma barra inicial.
  const segments = value.trim().split('/').filter(Boolean);
  const index = segments.lastIndexOf(kind);
  if (index >= 0 && segments[index + 1]) {
    return decodeURIComponent(segments[index + 1]);
  }

  // Compatibilidade com URLs completas ou formatos antigos.
  const match = value.match(new RegExp(`(?:^|/)${kind}/([^/?#]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function normalizeMembership(item) {
  // No Group Membership v2, "user" normalmente é uma string de recurso,
  // por exemplo: "users/123456789" — não um objeto com a propriedade path.
  const userValue = item.user;
  const userObject = userValue && typeof userValue === 'object' ? userValue : {};
  const userPath = typeof userValue === 'string'
    ? userValue
    : (userObject.path || item.userPath || item.user_path || '');

  const membershipPath = item.path || item.membershipPath || item.membership_path || '';
  const membershipId = String(
    item.membershipId || item.membership_id || extractIdFromPath(membershipPath, 'memberships') || ''
  );
  const userId = String(
    item.userId || item.user_id || userObject.userId || userObject.id || extractIdFromPath(userPath, 'users') || ''
  );
  const username = String(userObject.username || userObject.name || item.username || '');
  const displayName = String(userObject.displayName || item.displayName || username || userId);

  return { membershipId, userId, username, displayName, raw: item };
}

async function listAllMemberships() {
  const all = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    const query = new URLSearchParams({ maxPageSize: '100' });
    if (pageToken) query.set('pageToken', pageToken);
    const body = await robloxRequest(`/cloud/v2/groups/${encodeURIComponent(GROUP_ID)}/memberships?${query}`);
    const rows = body.groupMemberships || body.memberships || body.groupMembership || [];
    if (!Array.isArray(rows)) throw new Error('Resposta inesperada ao consultar membros do grupo.');
    for (const row of rows) {
      const member = normalizeMembership(row);
      if (member.membershipId && member.userId) all.push(member);
    }
    pageToken = String(body.nextPageToken || '');
    pageCount += 1;
    if (pageCount >= MAX_MEMBERSHIP_PAGES && pageToken) {
      throw new Error('O grupo excedeu o limite de páginas desta sincronização.');
    }
  } while (pageToken);
  return all;
}

async function assignConfiguredRole(member) {
  const roleId = getRoleId();
  if (!roleId) throw new Error('Configure o ID da patente padrão no painel antes de atribuir cargos.');
  if (!/^\d+$/.test(roleId)) throw new Error('O ID da patente precisa conter somente números.');
  if (!member.membershipId || !member.userId) throw new Error('Não foi possível identificar a associação do membro.');

  const requestPath = `/cloud/v2/groups/${encodeURIComponent(GROUP_ID)}/memberships/${encodeURIComponent(member.membershipId)}:assignRole`;
  await robloxRequest(requestPath, {
    method: 'POST',
    body: JSON.stringify({ role: `groups/${GROUP_ID}/roles/${roleId}` })
  });

  store.processedUserIds = [...new Set([...store.processedUserIds, member.userId])].slice(-10000);
  addLog('success', `Cargo padrão atribuído a ${member.username || member.userId}.`, {
    userId: member.userId,
    username: member.username,
    roleId
  });
  return { userId: member.userId, username: member.username, roleId };
}

async function syncNewMembers() {
  if (syncRunning) return { skipped: true, message: 'Uma sincronização já está em andamento.' };
  if (!ROBLOX_API_KEY) throw new Error('Configure ROBLOX_API_KEY no Render.');
  if (!getRoleId()) throw new Error('Configure ROLE_ID_PADRAO no painel antes de iniciar a verificação.');

  syncRunning = true;
  try {
    const members = await listAllMemberships();
    const currentIds = new Set(members.map(member => member.membershipId));

    if (!store.baselineInitialized) {
      store.knownMembershipIds = [...currentIds];
      store.baselineInitialized = true;
      store.lastSyncAt = new Date().toISOString();
      store.lastSyncMessage = `Primeira leitura concluída: ${members.length} membros registrados como base. Nenhum cargo foi alterado nesta primeira leitura.`;
      await saveStore();
      addLog('info', `Primeira leitura: ${members.length} membros registrados como base. Nenhuma patente foi alterada.`);
      return { baselineCreated: true, totalMembers: members.length, assigned: 0 };
    }

    const known = new Set(store.knownMembershipIds);
    const newMembers = members.filter(member => !known.has(member.membershipId));
    let assigned = 0;
    const errors = [];

    for (const member of newMembers) {
      try {
        await assignConfiguredRole(member);
        store.knownMembershipIds.push(member.membershipId);
        assigned += 1;
      } catch (error) {
        errors.push(`${member.username || member.userId}: ${error.message}`);
        addLog('error', `Falha ao atribuir cargo a ${member.username || member.userId}: ${error.message}`, {
          userId: member.userId,
          username: member.username
        });
      }
    }

    // Mantém IDs conhecidos mesmo se alguém sair; isso evita reprocessar uma associação antiga.
    // Novas associações de quem entrar novamente terão outro membershipId.
    const currentKnown = new Set(store.knownMembershipIds);
    for (const id of currentIds) {
      if (currentKnown.has(id)) continue;
    }

    store.lastSyncAt = new Date().toISOString();
    store.lastSyncMessage = errors.length
      ? `Verificação concluída: ${members.length} membros; ${assigned} cargos atribuídos; ${errors.length} falhas.`
      : `Verificação concluída: ${members.length} membros; ${assigned} cargos atribuídos.`;
    await saveStore();
    addLog('info', store.lastSyncMessage);
    return { totalMembers: members.length, newMembers: newMembers.length, assigned, errors };
  } finally {
    syncRunning = false;
  }
}

app.get('/api/public-config', (req, res) => {
  res.json({ groupId: GROUP_ID, groupUrl: `https://www.roblox.com/communities/${GROUP_ID}` });
});

app.get('/api/admin/status', requireAdmin, (req, res) => {
  res.json({
    groupId: GROUP_ID,
    roleId: getRoleId(),
    apiConfigured: Boolean(ROBLOX_API_KEY),
    gameSecretConfigured: Boolean(GAME_SERVER_SECRET),
    baselineInitialized: store.baselineInitialized,
    knownMemberships: store.knownMembershipIds.length,
    processedUsers: store.processedUserIds.length,
    lastSyncAt: store.lastSyncAt,
    lastSyncMessage: store.lastSyncMessage,
    syncRunning
  });
});

app.put('/api/admin/role', requireAdmin, async (req, res) => {
  const roleId = String(req.body?.roleId || '').trim();
  if (!/^\d{1,20}$/.test(roleId)) {
    return res.status(400).json({ error: 'Informe um ID de cargo numérico válido.' });
  }
  try {
    // Confirma que esse cargo existe dentro do grupo antes de salvar a configuração.
    await robloxRequest(`/cloud/v2/groups/${encodeURIComponent(GROUP_ID)}/roles/${encodeURIComponent(roleId)}`);
    store.settings.roleId = roleId;
    await saveStore();
    addLog('config', `Patente padrão alterada para o ID ${roleId}.`);
    res.json({ ok: true, roleId });
  } catch (error) {
    res.status(error.status || 502).json({ error: `Não foi possível validar/salvar o cargo: ${error.message}` });
  }
});

app.post('/api/admin/sync', requireAdmin, async (req, res) => {
  try {
    const result = await syncNewMembers();
    res.json({ ok: true, ...result, message: store.lastSyncMessage });
  } catch (error) {
    store.lastSyncMessage = `Erro na verificação: ${error.message}`;
    addLog('error', store.lastSyncMessage);
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  res.json({ logs: store.logs.slice(0, 100) });
});

app.post('/api/game/recruit', requireGameServer, async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  const username = String(req.body?.username || '').trim();
  const nomenclatura = String(req.body?.nomenclatura || '').trim();
  if (!/^\d{1,20}$/.test(userId) || !username || !nomenclatura) {
    return res.status(400).json({ error: 'Envie userId, username e nomenclatura válidos.' });
  }
  if (nomenclatura.length > 3000 || username.length > 100) {
    return res.status(400).json({ error: 'Um dos campos ultrapassou o limite técnico de segurança.' });
  }

  try {
    // A confirmação da entrada pode levar alguns segundos para aparecer na
    // listagem Open Cloud. Fazemos algumas consultas curtas antes de recusar.
    let member = null;
    let totalMembersSeen = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const members = await listAllMemberships();
      totalMembersSeen = members.length;
      member = members.find(item => item.userId === userId) || null;
      if (member) break;
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    if (!member) {
      console.warn(`[recruit] UserId ${userId} não apareceu na lista de membros do grupo ${GROUP_ID}. Total de membros lidos: ${totalMembersSeen}.`);
      return res.status(409).json({ error: 'O Roblox ainda não confirmou sua entrada na consulta de membros. Aguarde alguns segundos e clique em CONTINUAR novamente.' });
    }
    const result = await assignConfiguredRole({ ...member, username: member.username || username });
    addLog('recruit', `Recrutamento pelo jogo: ${username} — ${nomenclatura}`, { userId, username, nomenclatura });
    if (!store.knownMembershipIds.includes(member.membershipId)) {
      store.knownMembershipIds.push(member.membershipId);
      await saveStore();
    }
    res.json({ ok: true, message: 'A patente padrão foi atribuída.', ...result });
  } catch (error) {
    addLog('error', `Falha no recrutamento de ${username}: ${error.message}`, { userId, username });
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'eb-recrutamento' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
  await loadStore();
  app.listen(PORT, () => {
    console.log(`EB Recrutamento online na porta ${PORT}`);
    if (ROBLOX_API_KEY) {
      // A primeira execução apenas registra a lista atual como base; não altera patentes existentes.
      if (getRoleId()) {
        setTimeout(() => syncNewMembers().catch(error => {
          store.lastSyncMessage = `Erro na primeira verificação: ${error.message}`;
          addLog('error', store.lastSyncMessage);
        }), 8000);
      }
      // O timer continua ativo mesmo que a patente seja cadastrada depois pelo painel.
      setInterval(() => {
        if (!getRoleId()) return;
        syncNewMembers().catch(error => {
          store.lastSyncMessage = `Erro na verificação automática: ${error.message}`;
          addLog('error', store.lastSyncMessage);
        });
      }, SYNC_INTERVAL_MS);
    }
  });
}

start().catch(error => {
  console.error('Não foi possível iniciar o servidor:', error);
  process.exit(1);
});
