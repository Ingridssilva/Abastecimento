// ═══════════════════════════════════════════════════════════════
// Sistema de Abastecimento Empresa Exemplo v3.0

// Detecta requisicao de bombona/carote pelo fuel_method OU pelo nome do veiculo
function isCaroteReq(r) {
  if (!r) return false;
  if (r.fuel_method === 'bombona') return true;
  const veh = (r.vehicle || '').toUpperCase();
  return veh.startsWith('BOMBONA') || veh.startsWith('CAROTE');
}
// ═══════════════════════════════════════════════════════════════

const API = window.BACKEND_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : '');

// ── Detecção de dispositivo touch ────────────────────────────
// Adiciona classe 'touch-device' no body se for touch
// ── Detecção de touch ─────────────────────────────────────────
(function() {
  const isTouch = ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  document.documentElement.classList.add(isTouch ? 'touch-device' : 'no-touch');
  window.addEventListener('touchstart', function onFirstTouch() {
    document.documentElement.classList.add('touch-device');
    document.documentElement.classList.remove('no-touch');
    window.removeEventListener('touchstart', onFirstTouch);
  }, { passive: true });
})();

// ── Estado Global ─────────────────────────────────────────────
let SESSION = { role: null, name: null, isSup: false };
let DATA = { requests: [], vehicles: [], fuelRecords: [], prices: {}, bombonas: [], transfers: [], stations: [] };
let REPORT_DATA = [];

// ── Dados de referência ───────────────────────────────────────
// Lista de motoristas cadastrados (nomes de exemplo — em produção, carregar do banco de dados)
const DRIVERS = [
'ALEXANDRE SILVA SANTOS',
'BRUNO OLIVEIRA COSTA',
'CARLOS EDUARDO PEREIRA',
'DANIEL FERREIRA LIMA',
'EDUARDO ALMEIDA ROCHA',
'FELIPE SOUZA MARTINS',
'GABRIEL RODRIGUES NUNES',
'HENRIQUE BARBOSA DIAS',
'IGOR MENDES CARVALHO',
'JOÃO PAULO RIBEIRO',
'LUCAS MOREIRA TAVARES',
'MARCOS VINICIUS CASTRO',
'PAULO HENRIQUE AZEVEDO',
'RICARDO GOMES FREITAS',
'THIAGO CARDOSO NASCIMENTO',
'VICTOR HUGO MONTEIRO',
'WILLIAM ARAÚJO PINTO'
];

// Usuários de exemplo — troque por autenticação real (banco de dados / SSO) em produção
const SUPERVISORS = [
  { user:'supervisor1', pass:'troque-esta-senha', name:'FULANO DE TAL' },
  { user:'supervisor2', pass:'troque-esta-senha', name:'CICLANO DE TAL' },
  { user:'supervisor3', pass:'troque-esta-senha', name:'BELTRANO DE TAL' }
];

const CITIES = [
  'Santarém','Mojuí dos Campos','Lago Grande','Vila Gorete',
  'Juruti','Almeirim','Barcarena','Itaituba','Curuaí',
  'Vila Brasil','Membeca','Ilha das Onças','São Francisco'
];

const GAS_STATIONS = [
  'Posto Leal (Itaituba)','Posto Topázio (Juruti)',
  'Posto Nossa Senhora de Nazaré (Curuaí)','Posto Amanhecer (Barcarena)',
  'Posto Equador (Frente da base)','Posto Equador (Muiraquitã com Turiano)',
  'Auto Amanhecer (Muiraquitã Frente a Base)','Posto Petrogás (Almerim)',
  'Posto São João (Mojuí)','Posto Shell (Santarém)','Posto Ale (Santarém)',
  'Abastecimento em campo (Bombona)'
];

const FUEL_TYPES = ['Diesel S10','Diesel Comum','Gasolina Comum','Gasolina Aditivada','Etanol','GNV'];

// ── HTTP helpers ──────────────────────────────────────────────
let _submitting = false; // debounce global para evitar duplo submit

async function api(method, path, body) {
  try {
    const opts = { method, headers: {} };
    if (SESSION.name)         opts.headers['x-actor'] = SESSION.name;
    if (SESSION.sessionToken) opts.headers['x-session-token'] = SESSION.sessionToken;
    if (body && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    const r = await fetch(`${API}/api${path}`, opts);
    // Sessão expirada → força logout
    if (r.status === 401) {
      notify('Sessão expirada. Fazendo login novamente...', 'warning');
      setTimeout(() => { SESSION.sessionToken = null; SESSION.name = null; location.reload(); }, 1500);
      return null;
    }
    if (!r.ok) {
      await new Promise(res => setTimeout(res, 1500));
      const r2 = await fetch(`${API}/api${path}`, opts);
      const json2 = await r2.json();
      if (!r2.ok) throw new Error(json2.error || 'Erro desconhecido');
      return json2;
    }
    return await r.json();
  } catch (e) {
    notify(e.message, 'error');
    return null;
  }
}
const GET = p => api('GET', p);
const POST = (p, b) => api('POST', p, b);
const PUT = (p, b) => api('PUT', p, b);
const DEL = p => api('DELETE', p);

// ── Notificações & Loading ─────────────────────────────────────
function notify(msg, type = 'success') {
  const n = document.getElementById('notif');
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  n.className = `notif show ${type}`;
  n.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  setTimeout(() => n.classList.remove('show'), 3800);
}
const loading = v => document.getElementById('ld').classList[v ? 'add' : 'remove']('on');

// ── Utilidades ─────────────────────────────────────────────────
function nowISO() { return new Date().toISOString(); }
function today()  { return new Date().toISOString().split('T')[0]; }
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('pt-BR', { timeZone:'America/Sao_Paulo' }); } catch { return d; }
}
function fmtDateTime(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('pt-BR', {
      timeZone:'America/Sao_Paulo', day:'2-digit', month:'2-digit',
      year:'numeric', hour:'2-digit', minute:'2-digit'
    });
  } catch { return d; }
}
function shortName(n) {
  if (!n) return '—';
  const p = n.split(' ');
  return p.length > 1 ? `${p[0]} ${p[p.length - 1]}` : p[0];
}
function statusBadge(s) {
  const m = {
    pending: ['b-pending', '⏳ Pendente'],
    signed:  ['b-signed',  '✅ Aprovada'],
    completed: ['b-completed','✔️ Concluída'],
    rejected:  ['b-rejected', '❌ Rejeitada'],
    voided:    ['b-inativo',  '🚫 Anulada']
  };
  const [cls, lbl] = m[s] || ['b-pending', s];
  return `<span class="badge ${cls}">${lbl}</span>`;
}
function typeBadge(t) {
  const cls = 't-' + (t || '').toLowerCase().replace(/\s+/g, '\\ ');
  return `<span class="vtype ${cls}">${t || '—'}</span>`;
}
function fuelPct(cur, cap) {
  if (!cap) return 0;
  return Math.min(100, Math.round((cur / cap) * 100));
}
function fuelBarClass(pct) {
  if (pct >= 40) return 'ff-ok';
  if (pct >= 20) return 'ff-low';
  return 'ff-crit';
}
function $ (id) { return document.getElementById(id); }
function setHTML(id, html) { const el = $(id); if (el) el.innerHTML = html; }

// ══════════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════════
function showPanel(id) {
  document.querySelectorAll('#login-screen .panel').forEach(p => p.classList.remove('active'));
  const el = $(id);
  if (!el) { console.error('Panel not found:', id); return; }
  el.classList.add('active');
  // Popula motoristas ao abrir o painel
  if (id === 'panel-driver') populateDriverSelect();
}

function populateDriverSelect() {
  const sel = $('sel-driver');
  sel.innerHTML = '<option value="">Selecione seu nome...</option>';
  DRIVERS.forEach(d => sel.innerHTML += `<option value="${d}">${d}</option>`);
}

async function loginDriver() {
  const name = $('sel-driver').value;
  if (!name) return notify('Selecione seu nome', 'warning');
  loading(true);
  try {
    const res = await fetch(`${API}/api/auth/driver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!data.sessionToken) throw new Error('Sem token');
    SESSION = { role: 'driver', name, isSup: false, sessionToken: data.sessionToken };
    startApp();
  } catch(e) {
    notify('Erro ao fazer login. Tente novamente.', 'error');
  } finally {
    loading(false);
  }
}

// ── MSAL — Microsoft Authentication ──────────────────────
let msalInstance = null;

function getMSAL() {
  if (msalInstance) return msalInstance;
  // TODO: substitua pelos IDs do seu app registrado no Azure AD (Entra ID),
  // idealmente via window.AZURE_TENANT_ID / window.AZURE_CLIENT_ID injetados no build/deploy.
  const tenantId = window.AZURE_TENANT_ID || 'SEU_AZURE_TENANT_ID';
  const clientId  = window.AZURE_CLIENT_ID  || 'SEU_AZURE_CLIENT_ID';

  const MsalLib = window.msal;
  if (!MsalLib || !MsalLib.PublicClientApplication) {
    throw new Error('Biblioteca MSAL não carregou. Recarregue a página.');
  }

  msalInstance = new MsalLib.PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      redirectUri: window.location.origin + window.location.pathname,
      navigateToLoginRequestUrl: true
    },
    cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: true }
  });
  return msalInstance;
}

// Detecta se é mobile (popup bloqueado em mobile)
function isMobile() {
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
}

async function handleMsalRedirectResult() {
  try {
    const msalApp = getMSAL();
    const result = await msalApp.handleRedirectPromise();
    if (!result) return; // não veio de redirect

    const status = $('ms-login-status');
    if (status) status.textContent = '🔄 Verificando acesso...';

    const res = await fetch(`${API}/api/auth/microsoft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: result.accessToken })
    });
    const data = await res.json();

    if (!res.ok || !data.isSupervisor) {
      const msg = !res.ok ? (data.error || 'Acesso negado') : `Conta ${data.email} sem permissão de supervisor.`;
      notify(msg, 'error');
      showPanel('panel-supervisor');
      if (status) status.textContent = '❌ ' + msg;
      return;
    }

    SESSION = { role: 'supervisor', name: data.displayName.toUpperCase(), email: data.email, isSup: true, sessionToken: data.sessionToken };
    notify(`✅ Bem-vindo, ${data.displayName}!`);
    startApp();
  } catch(e) {
    console.error('MSAL redirect error:', e);
  }
}

async function loginMicrosoft() {
  const btn = $('btn-ms-login');
  const status = $('ms-login-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecionando...'; }
  if (status) status.textContent = '🔄 Abrindo Microsoft...';

  try {
    const msalApp = getMSAL();
    // Sempre usa redirect — funciona em mobile e desktop sem bloqueio de popup
    await msalApp.loginRedirect({
      scopes: ['User.Read'],
      prompt: 'select_account'
    });
    // A página redireciona — o código abaixo não executa
  } catch (e) {
    console.error('MSAL error:', e);
    notify('Erro ao iniciar login: ' + (e.message || e.errorCode), 'error');
    if (status) status.textContent = '❌ Erro: ' + (e.message || e.errorCode);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 21 21" fill="none"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg> Entrar com Microsoft`;
    }
  }
}

async function loginOperator() {
  const matricula = $('op-matricula').value.trim().toUpperCase();
  const password  = $('op-password').value.trim().toUpperCase();
  const errEl     = $('op-login-error');
  errEl.style.display = 'none';
  if (!matricula || !password) { errEl.textContent = 'Preencha matrícula e senha'; errEl.style.display = 'block'; return; }
  try {
    const res = await fetch(`${API}/api/operators/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matricula, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Credenciais inválidas'; errEl.style.display = 'block'; return; }
    SESSION = { role: 'operator', name: data.operator.name, isSup: false, isOperator: true, operator: data.operator, sessionToken: data.sessionToken };
    startApp();
  } catch(e) { errEl.textContent = 'Erro de conexão. Tente novamente.'; errEl.style.display = 'block'; }
}

function loginSup() {
  // Mantido para compatibilidade mas não exposto no UI
  const u = $('sup-u')?.value?.trim();
  const p = $('sup-p')?.value;
  if (!u || !p) return;
  const sup = SUPERVISORS.find(s => s.user.toLowerCase() === u.toLowerCase() && s.pass === p);
  if (!sup) return notify('Credenciais inválidas', 'error');
  SESSION = { role: 'supervisor', name: sup.name, isSup: true };
  startApp();
}

function toggleSidebar() {
  const sb  = document.getElementById('sidebar');
  const ov  = document.getElementById('sb-overlay');
  const open = sb.classList.toggle('open');
  if (ov) ov.style.display = open ? 'block' : 'none';
}

function closeSidebarMobile() {
  document.querySelector('.sidebar')?.classList.remove('open');
  $('sidebar-overlay')?.classList.remove('open');
  document.body.style.overflow = '';
}
function openSidebarMobile() {
  document.querySelector('.sidebar')?.classList.add('open');
  $('sidebar-overlay')?.classList.add('open');
  document.body.style.overflow = 'hidden'; // previne scroll do fundo no iOS
}

function logout() {
  SESSION = { role: null, name: null, isSup: false };
  DATA = { requests: [], vehicles: [], fuelRecords: [], prices: {}, bombonas: [], transfers: [], stations: [] };
  $('nav-sup').classList.add('hidden');
  $('btn-nb').classList.add('hidden');
  $('app').style.display = 'none';
  $('login-screen').style.display = 'flex';
  showPanel('panel-role');
  // Limpa sessão MSAL
  try {
    if (msalInstance) {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length) msalInstance.logoutPopup({ account: accounts[0] }).catch(()=>{});
    }
  } catch(e) {}
  if ($('ms-login-status')) $('ms-login-status').textContent = '';
}

// ══════════════════════════════════════════════════
// APP INIT
// ══════════════════════════════════════════════════
function startApp() {
  $('login-screen').style.display = 'none';
  $('app').style.display = 'block';
  $('sb-name').textContent = shortName(SESSION.name);
  $('sb-role').textContent = SESSION.isSup ? 'Supervisor / Gestor'
    : SESSION.isOperator ? '🛢️ Operador de Bombona'
    : 'Motorista / Operador';

  // Mostrar/ocultar áreas de gestão
  if (SESSION.isSup) {
    $('nav-sup').classList.remove('hidden');
    $('btn-nb').classList.remove('hidden');
    $('nav-bombonas-btn')?.classList.add('hidden');
    $('topbar-new-req').classList.remove('hidden');
  } else if (SESSION.isOperator) {
    $('nav-sup').classList.add('hidden');
    $('btn-nb').classList.remove('hidden'); // pode criar bombona
    $('nav-bombonas-btn')?.classList.remove('hidden'); // vê suas bombonas
    $('topbar-new-req').classList.remove('hidden');
  } else {
    // Motorista comum: sem aba de bombonas
    $('nav-sup').classList.add('hidden');
    $('btn-nb').classList.add('hidden');
    $('nav-bombonas-btn')?.classList.add('hidden');
    $('topbar-new-req').classList.remove('hidden');
  }

  $('cur-date').textContent = new Date().toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
  populateFormSelects();
  loadAll();

  // Auto-refresh inteligente — pausa quando aba oculta ou modal aberto
  let _refreshInterval = null;
  function startRefresh() {
    if (_refreshInterval) return;
    _refreshInterval = setInterval(() => {
      // Não atualiza se: aba não está visível, ou algum modal está aberto
      if (document.hidden) return;
      const modalAberto = document.querySelector('.modal.open, [id^="m-"].active');
      if (modalAberto) return;
      autoRefresh();
    }, 30000);
  }
  function stopRefresh() {
    if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopRefresh(); else startRefresh();
  });
  startRefresh();
}

async function loadAll() {
  loading(true);
  try {
    const [reqs, vehs, fuels, prices, bombs, transfers, stations, operators] = await Promise.all([
      GET('/requests' + (SESSION.isSup ? '' : `?driver=${encodeURIComponent(SESSION.name)}`)),
      GET('/vehicles'),
      GET('/fuel-records'),
      GET('/fuel-prices'),
      GET(SESSION.isSup || SESSION.isOperator ? '/bombonas' : `/bombonas?driver=${encodeURIComponent(SESSION.name)}`),
      GET(SESSION.isSup || SESSION.isOperator ? '/bombona-transfers' : `/bombona-transfers?driver=${encodeURIComponent(SESSION.name)}`),
      GET('/stations'),
      SESSION.isSup ? GET('/operators') : Promise.resolve([])
    ]);
    if (reqs) DATA.requests = reqs;
    if (vehs) DATA.vehicles = vehs;
    if (fuels) DATA.fuelRecords = fuels;
    if (prices) { DATA.prices = {}; prices.forEach(p => DATA.prices[p.fuel_type] = p.price); }
    if (bombs) DATA.bombonas = bombs;
    if (transfers) DATA.transfers = transfers;
    if (stations) DATA.stations = stations;
    if (operators) DATA.operators = operators;
    renderAll();
  } finally { loading(false); }
}

async function autoRefresh() {
  const [reqs, bombs] = await Promise.all([
    GET('/requests' + (SESSION.isSup ? '' : `?driver=${encodeURIComponent(SESSION.name)}`)),
    GET(SESSION.isSup || SESSION.isOperator ? '/bombonas' : `/bombonas?driver=${encodeURIComponent(SESSION.name)}`)
  ]);
  if (reqs) { DATA.requests = reqs; renderDashboard(); renderReqs(); populateReqFilters(); updateBadge(); }
  if (bombs) { DATA.bombonas = bombs; renderBombonas(); }
}

function renderAll() {
  renderDashboard();
  renderReqs();
  renderBombonas();
  renderTransfers();
  renderFuelRecords();
  renderVehicles();
  renderPrices();
  renderStations();
  renderOperators();
  renderTransferRecords();
  updateBadge();

  // Popula filtros de posto e motorista nos abastecimentos
  const stns = [...new Set(DATA.fuelRecords.map(r => r.gas_station).filter(Boolean))].sort();
  const ffStn = $('ff-stn');
  if (ffStn && ffStn.options.length <= 1) {
    stns.forEach(s => ffStn.innerHTML += `<option value="${s}">${s}</option>`);
  }
  const drvs = [...new Set(DATA.fuelRecords.map(r => r.driver).filter(Boolean))].sort();
  const ffDrv = $('ff-drv');
  if (ffDrv && ffDrv.options.length <= 1) {
    drvs.forEach(d => ffDrv.innerHTML += `<option value="${d}">${shortName(d)}</option>`);
  }

  // Popula filtros de localidade e posto na aba de Requisições
  populateReqFilters();
}

// Popula (ou re-popula) os selects de localidade e posto na aba Requisições
// Preserva o valor selecionado para não resetar o filtro em uso
function populateReqFilters() {
  const reqLocs = [...new Set(DATA.requests.map(r => r.city).filter(Boolean))].sort();
  const fLoc = $('f-loc');
  if (fLoc) {
    const prev = fLoc.value;
    fLoc.innerHTML = '<option value="">Todas localidades</option>';
    reqLocs.forEach(l => fLoc.innerHTML += `<option value="${l}">${l}</option>`);
    if (prev) fLoc.value = prev;
  }
  const reqStns = [...new Set(DATA.requests.map(r => r.gas_station).filter(Boolean))].sort();
  const fStn = $('f-stn');
  if (fStn) {
    const prev = fStn.value;
    fStn.innerHTML = '<option value="">Todos postos</option>';
    reqStns.forEach(s => fStn.innerHTML += `<option value="${s}">${s}</option>`);
    if (prev) fStn.value = prev;
  }
}

function updateBadge() {
  const pending = DATA.requests.filter(r => r.status === 'pending').length;
  const bdg = $('bdg');
  if (pending > 0) { bdg.textContent = pending; bdg.classList.remove('hidden'); }
  else bdg.classList.add('hidden');
}

// ── Navegação ─────────────────────────────────────────────────
const PAGE_TITLES = {
  dashboard:'Dashboard', requests:'Requisições', bombonas:'Bombonas',
  'fuel-records':'Abastecimentos', vehicles:'Frota', 'fuel-prices':'Preços',
  'fuel-consumption':'Consumo Médio', reports:'Relatórios', stations:'Postos',
  operators:'Operadores de Bombona', 'transfer-records':'Transferências de Bombonas',
  audit:'Auditoria', 'relatorio-mensal':'Relatório Mensal', 'auditoria-litros':'Auditoria de Litros', 'km-rodado':'KM Rodado'
};

const SUP_ONLY_PAGES = ['fuel-records', 'vehicles', 'fuel-prices', 'fuel-consumption', 'reports', 'stations', 'operators', 'transfer-records', 'audit', 'relatorio-mensal', 'relatorio-veiculo', 'relatorio-posto', 'relatorio-bombona', 'relatorio-localidade', 'auditoria-litros', 'km-rodado'];

function go(page) {
  if (!SESSION.isSup && !SESSION.isOperator && page === 'bombonas') return;
  if (!SESSION.isSup && SUP_ONLY_PAGES.includes(page)) return;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n => n.classList.remove('active'));
  $(`screen-${page}`)?.classList.add('active');
  document.querySelectorAll('.ni').forEach(n => { if (n.textContent.toLowerCase().includes(page.split('-')[0].toLowerCase())) n.classList.add('active'); });
  $('pg-title').textContent = PAGE_TITLES[page] || page;
  if (page === 'fuel-consumption') loadConsumption();
  if (page === 'bombonas') { renderBombonas(); renderTransfers(); }
  if (page === 'audit') loadAudit();
  if (page === 'transfer-records') renderTransferRecords();
  if (page === 'relatorio-mensal') {
    // Pré-seleciona o mês atual
    const now = new Date();
    if ($('rm-mes')) $('rm-mes').value = now.getMonth() + 1;
    if ($('rm-ano')) $('rm-ano').value = now.getFullYear();
  }
  if (page === 'relatorio-veiculo' || page === 'relatorio-posto' || page === 'relatorio-bombona' || page === 'auditoria-litros' || page === 'km-rodado') {
    populateRelatorioSelects();
  }
  if (page === 'relatorio-localidade') {
    populateRelatorioSelects();
    populateCidades();
  }
  closeSidebarMobile();
}

// ── Popula selects dos formulários ─────────────────────────────
function populateFormSelects() {
  // Driver select (login)
  populateDriverSelect();

  // New request — driver
  const drvInput = $('rq-drv');
  if (drvInput) drvInput.value = SESSION.name;

  // Plate select
  const plateSelect = $('rq-plate');
  if (plateSelect) {
    plateSelect.innerHTML = '<option value="">Selecione a placa / código...</option>';
    DATA.vehicles.filter(v => v.status === 'Ativo').forEach(v => {
      plateSelect.innerHTML += `<option value="${v.plate}">${v.plate} — ${v.model}</option>`;
    });
  }

  // Postos — usa banco de dados; cidade preenche automaticamente
  const stnSel = $('rq-stn');
  if (stnSel) {
    stnSel.innerHTML = '<option value="">Selecione o posto...</option>';
    const activeStations = DATA.stations.filter(s => s.active);
    activeStations.forEach(s => {
      stnSel.innerHTML += `<option value="${s.name}" data-city="${s.city}">${s.name} — ${s.city}</option>`;
    });
  }

  // Cidade — preenchida automaticamente ao selecionar posto (campo readonly)
  const cityInput = $('rq-city');
  if (cityInput) cityInput.value = '';

  // Fuel types
  [$('rq-fuel')].filter(Boolean).forEach(sel => {
    sel.innerHTML = '<option value="">Selecione...</option>';
    FUEL_TYPES.forEach(f => sel.innerHTML += `<option>${f}</option>`);
  });

  // Bombona responsible — usa operadores de bombona, não motoristas
  [$('nb-resp')].filter(Boolean).forEach(sel => {
    sel.innerHTML = '<option value="">Selecione o operador...</option>';
    (DATA.operators || []).forEach(op => {
      sel.innerHTML += `<option value="${op.id}" data-name="${op.name}">${op.name} (${op.matricula})</option>`;
    });
  });

  // Transfer vehicle
  const tfVpl = $('tf-vpl');
  if (tfVpl) {
    tfVpl.innerHTML = '<option value="">Nenhum (apenas saída de bombona)</option>';
    DATA.vehicles.filter(v => v.status === 'Ativo').forEach(v => {
      tfVpl.innerHTML += `<option value="${v.plate}" data-model="${v.model}">${v.plate} — ${v.model}</option>`;
    });
  }

  // Vehicles location filter
  const fvLoc = $('fv-loc');
  if (fvLoc) {
    const locs = [...new Set(DATA.vehicles.map(v => v.location).filter(Boolean))].sort();
    fvLoc.innerHTML = '<option value="">Todas localidades</option>';
    locs.forEach(l => fvLoc.innerHTML += `<option>${l}</option>`);
  }
}

function onPlate() {
  const plate = $('rq-plate').value;
  const veh = DATA.vehicles.find(v => v.plate === plate);
  $('rq-model').value = veh ? veh.model : '';
  if (veh?.fuel_type) {
    const sel = $('rq-fuel');
    for (let o of sel.options) if (o.value === veh.fuel_type) { sel.value = veh.fuel_type; break; }
  }
}

function onStation() {
  const opt = $('rq-stn').selectedOptions[0];
  const city = opt?.dataset?.city || '';
  const cityInput = $('rq-city');
  if (cityInput) cityInput.value = city;
}

function onMthChange() {
  const mth = $('rq-mth')?.value;
  const box      = $('bombona-info-box');
  const fPreco   = $('fg-preco-litro');
  const fFields  = $('fg-mth-fields');
  const fLitros  = $('fg-litros');
  const fValor   = $('fg-valor');
  const fVeiculo = $('fsec-veiculo'); // seção de veículo/placa

  const horiLbl = $('rq-hori-lbl');
  const vehLbl  = $('rq-veh-lbl');

  if (mth === 'litros' || mth === 'valor') {
    box?.classList.add('hidden');
    fPreco?.classList.remove('hidden');
    fFields?.classList.remove('hidden');
    fLitros?.classList.toggle('hidden', mth !== 'litros');
    fValor?.classList.toggle('hidden', mth !== 'valor');
    fVeiculo?.classList.remove('hidden');
    if (horiLbl) horiLbl.textContent = '📸 Foto do Painel do Veículo *';
    if (vehLbl)  vehLbl.textContent  = '📸 Foto da Placa do Veículo *';
    resetPU('pu-hori', 'f-hori', '📷 Foto do painel do veículo');
    resetPU('pu-veh',  'f-veh',  '📷 Foto da placa do veículo');
  } else if (mth === 'bombona') {
    box?.classList.remove('hidden');
    fPreco?.classList.add('hidden');
    fFields?.classList.add('hidden');
    fVeiculo?.classList.add('hidden'); // veículo não é necessário
    // Atualiza os cabeçalhos e labels das fotos para bombona — antes ficavam
    // travados em "Foto do Painel/Placa do Veículo" mesmo com o método
    // Bombona selecionado, confundindo quem estava enviando.
    if (horiLbl) horiLbl.textContent = '📸 Foto da Bombona (estado atual) *';
    if (vehLbl)  vehLbl.textContent  = '📸 Foto do Local/Campo onde está a Bombona';
    resetPU('pu-hori', 'f-hori', '📷 Foto da bombona (estado atual)');
    resetPU('pu-veh',  'f-veh',  '📷 Foto do local/campo onde está a bombona');
    // Mostra só as bombonas do próprio operador (filtradas por operator_id quando disponível)
    const sel = $('rq-bombona-sel');
    if (sel) {
      const myOpId = SESSION.operator?.id;
      let minhas = myOpId
        ? DATA.bombonas.filter(b => b.operator_id == myOpId && !b.locked)
        : DATA.bombonas.filter(b => normalizeStr(b.responsible_driver) === normalizeStr(SESSION.name) && !b.locked);
      if (minhas.length === 0) {
        sel.innerHTML = '<option value="" disabled>Nenhuma bombona atribuída a você</option>';
      } else {
        sel.innerHTML = '<option value="">Selecione a bombona...</option>';
        minhas.forEach(b => {
          const saldo = parseFloat(b.current_liters).toFixed(0);
          const cap   = parseFloat(b.capacity_liters).toFixed(0);
          const pct   = Math.round((parseFloat(b.current_liters)/parseFloat(b.capacity_liters))*100);
          const tag   = pct === 0 ? '🔴 VAZIA' : pct < 25 ? '🟡 BAIXA' : '🟢';
          sel.innerHTML += `<option value="${b.id}">${b.name} — ${tag} ${saldo}/${cap}L (${b.location||'—'})</option>`;
        });
      }
    }
  }
  calcReqTotal();
}

function calcBombonaTotal() {
  const litros = parseFloat($('rq-bombona-litros')?.value) || 0;
  const preco  = parseFloat($('rq-bombona-preco')?.value) || 0;
  const tot    = $('rq-bombona-total');
  if (tot) tot.value = litros && preco ? `R$ ${(litros * preco).toFixed(2)}` : '—';
}

function calcReqTotal() {
  const mth    = $('rq-mth')?.value;
  const preco  = parseFloat($('rq-preco-litro')?.value) || 0;
  const litros = parseFloat($('rq-litros')?.value) || 0;
  const valor  = parseFloat($('rq-valor')?.value) || 0;

  if (mth === 'litros') {
    const total = preco && litros ? preco * litros : 0;
    if ($('rq-total-calc')) $('rq-total-calc').value = total ? `R$ ${total.toFixed(2)}` : '—';
  } else if (mth === 'valor') {
    const litEst = preco && valor ? valor / preco : 0;
    if ($('rq-litros-calc')) $('rq-litros-calc').value = litEst ? `${litEst.toFixed(1)} L` : '—';
  } else if (mth === 'bombona') {
    const bLitros = parseFloat($('rq-bombona-litros')?.value) || 0;
    const bPreco  = parseFloat($('rq-bombona-preco')?.value) || 0;
    const tot = $('rq-bombona-total');
    if (tot) tot.value = bLitros && bPreco ? `R$ ${(bLitros * bPreco).toFixed(2)}` : bLitros ? `${bLitros} L solicitados` : '—';
  }
}

function onTfVeh() {
  const opt = $('tf-vpl').selectedOptions[0];
  $('tf-vmod').value = opt?.dataset.model || '';
  const plate = $('tf-vpl').value;
  $('tf-km-row')?.classList.toggle('hidden', !plate);
  if ($('tf-km')) $('tf-km').value = '';
  if ($('tf-km-hint')) $('tf-km-hint').textContent = '';
}

let _tfKmTimer = null;
function onTfKmInput() {
  clearTimeout(_tfKmTimer);
  _tfKmTimer = setTimeout(async () => {
    const km = parseInt($('tf-km')?.value);
    const plate = $('tf-vpl')?.value;
    const hint = $('tf-km-hint');
    if (!hint) return;
    if (!km || !plate) { hint.textContent = ''; return; }
    try {
      const check = await GET(`/validate-km?plate=${encodeURIComponent(plate)}&km=${km}`);
      if (check && !check.valid) {
        hint.style.color = '#ef4444';
        hint.textContent = `⚠️ Menor que o último KM registrado (${check.lastKm?.toLocaleString('pt-BR')} km) — confira antes de salvar.`;
      } else if (check?.lastKm) {
        hint.style.color = 'var(--green)';
        hint.textContent = `✅ Último KM registrado: ${check.lastKm.toLocaleString('pt-BR')} km`;
      } else {
        hint.textContent = '';
      }
    } catch { hint.textContent = ''; }
  }, 400);
}

// ══════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════
async function renderDashboard() {
  const myReqs = (SESSION.isSup
    ? DATA.requests
    : DATA.requests.filter(r => r.driver === SESSION.name)
  ).filter(r => r.status !== 'voided');

  const pending   = myReqs.filter(r => r.status === 'pending').length;
  const signed    = myReqs.filter(r => r.status === 'signed').length;
  const completed = myReqs.filter(r => r.status === 'completed').length;
  const rejected  = myReqs.filter(r => r.status === 'rejected').length;

  const myBombs = SESSION.isSup
    ? DATA.bombonas
    : SESSION.operator?.id
      ? DATA.bombonas.filter(b => b.operator_id == SESSION.operator.id)
      : DATA.bombonas.filter(b => normalizeStr(b.responsible_driver) === normalizeStr(SESSION.name));
  const bombsAtivas = myBombs.filter(b => {
    const s = (b.status || 'Ativa').toLowerCase();
    return s !== 'inativa' && s !== 'inactive' && s !== 'desativada';
  }).length;

  if ($('st-pending'))   $('st-pending').textContent   = pending;
  if ($('st-signed'))    $('st-signed').textContent    = signed;
  if ($('st-completed')) $('st-completed').textContent = completed;
  if ($('st-rejected'))  $('st-rejected').textContent  = rejected;
  if ($('st-bombs'))     $('st-bombs').textContent     = bombsAtivas;

  // Stats avançados do backend (apenas supervisores)
  if (SESSION.isSup) {
    try {
      const [stats, alertas] = await Promise.all([GET('/stats'), GET('/bombona-alertas')]);

      // Custo do mês
      if (stats?.financeiro && $('st-cost-mes')) {
        const custo = parseFloat(stats.financeiro.custo_mes || 0);
        const custoAnt = parseFloat(stats.financeiro.custo_mes_anterior || 0);
        const diff = custoAnt > 0 ? ((custo - custoAnt) / custoAnt * 100).toFixed(0) : null;
        $('st-cost-mes').textContent = custo.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
        if ($('st-cost-diff') && diff !== null) {
          $('st-cost-diff').textContent = diff > 0 ? `▲ ${diff}% vs mês ant.` : `▼ ${Math.abs(diff)}% vs mês ant.`;
          $('st-cost-diff').style.color = diff > 0 ? 'var(--red)' : 'var(--green)';
        }
      }

      // Requisições atrasadas (aprovadas há +4h sem concluir)
      if (stats?.requests?.signed_atrasadas > 0 && $('st-atrasadas')) {
        $('st-atrasadas').textContent = stats.requests.signed_atrasadas;
        $('st-atrasadas-box')?.classList.remove('hidden');
      }

      // Emergências pendentes
      if (stats?.requests?.emergency_pending > 0) {
        notify(`🚨 ${stats.requests.emergency_pending} requisição(ões) de EMERGÊNCIA pendente(s)!`, 'error');
      }

      // Alertas de bombonas críticas
      if (alertas?.length > 0 && SESSION.isSup) {
        const alertBox = $('dash-bomb-alertas');
        if (alertBox) {
          alertBox.classList.remove('hidden');
          setHTML('dash-bomb-alertas-list', alertas.map(b => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(239,68,68,0.08);border-radius:8px;border-left:3px solid var(--red);margin-bottom:6px">
              <div>
                <b style="color:var(--red)">${b.name}</b>
                <span style="font-size:.75rem;color:var(--text3);margin-left:8px">${b.location||'—'} · ${shortName(b.responsible_driver)}</span>
              </div>
              <div style="text-align:right">
                <b style="color:var(--red)">${parseFloat(b.pct_saldo)}%</b>
                <span style="font-size:.75rem;color:var(--text3);display:block">${parseFloat(b.current_liters).toFixed(0)}/${parseFloat(b.capacity_liters).toFixed(0)} L</span>
              </div>
            </div>`).join(''));
        }
      }
    } catch(e) { console.warn('Stats avançados falharam:', e.message); }
  }

  const rows = myReqs.slice(0, 10).map(r => `
    <tr>
      <td><code style="font-size:.78rem;background:#F1F5F9;padding:2px 6px;border-radius:4px">${r.id}</code></td>
      <td>${shortName(r.driver)}</td>
      <td><b>${r.plate || '—'}</b></td>
      <td>${r.fuel_type || '—'}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${fmtDateTime(r.date)}</td>
      <td>${r.real_value || r.estimated_value || '—'}</td>
      <td>${actionBtns(r, true)}</td>
    </tr>`).join('');
  setHTML('tb-recent', rows || emptyRow(8, 'Nenhuma atividade recente'));
}

// ══════════════════════════════════════════════════
// REQUISIÇÕES
// ══════════════════════════════════════════════════
function renderReqs() {
  const search = ($('f-search')?.value || '').toLowerCase();
  const status = $('f-status')?.value || '';
  const locF   = $('f-loc')?.value  || '';
  const stnF   = $('f-stn')?.value  || '';
  const start  = $('f-start')?.value || '';
  const end    = $('f-end')?.value || '';

  let list = DATA.requests;
  if (!SESSION.isSup) list = list.filter(r => r.driver === SESSION.name);
  if (search) list = list.filter(r =>
    r.driver?.toLowerCase().includes(search) || r.plate?.toLowerCase().includes(search) ||
    r.id?.toLowerCase().includes(search) || r.vehicle?.toLowerCase().includes(search)
  );
  if (status) list = list.filter(r => r.status === status);
  if (locF)   list = list.filter(r => (r.city || '') === locF);
  if (stnF)   list = list.filter(r => (r.gas_station || '') === stnF);
  if (start)  list = list.filter(r => r.date >= start);
  if (end)    list = list.filter(r => r.date <= end);

  const rows = list.map(r => `
    <tr>
      <td><code style="font-size:.78rem;background:#F1F5F9;padding:2px 6px;border-radius:4px">${r.id}</code></td>
      <td title="${r.driver}">${shortName(r.driver)}</td>
      <td><b>${r.plate || '—'}</b></td>
      <td style="font-size:.82rem">${r.vehicle || '—'}</td>
      <td>${r.fuel_type || '—'}</td>
      <td style="font-weight:700;color:var(--orange)">${r.liters || '—'}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${fmtDateTime(r.date)}</td>
      <td>${shortName(r.supervisor) || '—'}</td>
      <td>${r.real_value || r.estimated_value || '—'}</td>
      <td>
        ${r.pdf_url ? `<a class="pdf-btn" href="${r.pdf_url}" target="_blank">📄 PDF</a>` : ''}
        ${r.sharepoint_folder ? `<a class="sp-link" href="#" onclick="return false" title="${r.sharepoint_folder}">☁️ SP</a>` : ''}
        ${(r.photos||[]).length ? `<span class="sp-link">📷 ${r.photos.length}</span>` : ''}
      </td>
      <td>${actionBtns(r, false)}</td>
    </tr>`).join('');
  setHTML('tb-reqs', rows || emptyRow(12, 'Nenhuma requisição encontrada'));
}

function normalizeStr(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

function actionBtns(r, compact) {
  const btns = [];
  btns.push(`<button class="btn btn-outline btn-xs" onclick="viewReq('${r.id}')">👁️</button>`);

  // Alerta visual se aprovada há mais de 4h
  const horasAprovada = r.status === 'signed' && r.updated_at
    ? (Date.now() - new Date(r.updated_at).getTime()) / 3600000
    : 0;
  const alertaAtrasada = r.status === 'signed' && horasAprovada > 4;

  // Motorista: pode enviar fotos quando aprovada
  if (!SESSION.isSup && r.status === 'signed' && normalizeStr(r.driver) === normalizeStr(SESSION.name)) {
    const hasFotos = (r.photos||[]).some(p => p.photo_type === 'pump' || p.photo_type === 'receipt');
    if (!hasFotos)
      btns.push(`<button class="btn btn-warning btn-xs" onclick="openDriverPhotos('${r.id}')" title="Enviar fotos do abastecimento">📷 Fotos</button>`);
    else
      btns.push(`<span class="badge b-signed" style="font-size:.68rem">📷 OK</span>`);
  }

  if (SESSION.isSup && r.status === 'pending') {
    btns.push(`<button class="btn btn-success btn-xs" onclick="approveReq('${r.id}','${shortName(SESSION.name)}')">✅</button>`);
    btns.push(`<button class="btn btn-danger btn-xs" onclick="rejectReq('${r.id}','${shortName(SESSION.name)}')">❌</button>`);
  }
  if (SESSION.isSup && (r.status === 'pending' || r.status === 'signed')) {
    btns.push(`<button class="btn btn-outline btn-xs" onclick="openEditReqStation('${r.id}')" title="Editar posto/cidade">📍</button>`);
  }
  if (SESSION.isSup && r.status === 'signed') {
    const btnLabel = alertaAtrasada
      ? `<button class="btn btn-xs" style="background:rgba(239,68,68,0.2);color:#f87171;border:1px solid rgba(239,68,68,0.4);animation:pulse 1.5s infinite" onclick="openComplete('${r.id}')" title="⚠️ Aprovada há mais de ${Math.floor(horasAprovada)}h sem conclusão">⚠️ ${Math.floor(horasAprovada)}h</button>`
      : `<button class="btn btn-info btn-xs" onclick="openComplete('${r.id}')">⛽</button>`;
    btns.push(btnLabel);
  }
  if (r.status !== 'pending' || SESSION.isSup) {
    btns.push(`<button class="pdf-btn btn-xs" onclick="downloadPDF('${r.id}')">📄</button>`);
  }
  if (SESSION.isSup) {
    if (r.status !== 'voided') {
      btns.push(`<button class="btn btn-xs" style="background:rgba(107,114,128,0.2);color:#9CA3AF;border:1px solid rgba(107,114,128,0.3)" onclick="voidReq('${r.id}')" title="Anular — some dos relatórios mas fica no histórico">🚫 Anular</button>`);
    } else {
      btns.push(`<span class="badge b-inativo" style="font-size:.68rem">🚫 Anulada</span>`);
    }
    btns.push(`<button class="btn btn-danger btn-xs" onclick="delReq('${r.id}')" title="Excluir permanentemente">🗑️</button>`);
  }
  return `<div style="display:flex;gap:4px;flex-wrap:wrap">${btns.join('')}</div>`;
}

// ── Editar posto/cidade de requisição ─────────────────────────
function openEditReqStation(id) {
  const r = DATA.requests.find(x => x.id === id);
  if (!r) return;

  // Modal simples inline via prompt não é bonito — cria modal reutilizável
  const modal = document.createElement('div');
  modal.className = 'overlay open';
  modal.id = 'm-edit-station-temp';
  modal.innerHTML = `
    <div class="modal">
      <div class="mh">
        <span class="mt">📍 Editar Posto — ${id}</span>
        <button class="mc" onclick="document.getElementById('m-edit-station-temp').remove()">✕</button>
      </div>
      <div class="mb">
        <div style="background:rgba(247,147,30,0.08);border:1px solid rgba(247,147,30,0.2);border-radius:8px;padding:12px;margin-bottom:16px;font-size:.85rem">
          <b>Motorista:</b> ${r.driver}<br>
          <b>Placa:</b> ${r.plate||'—'} &nbsp;|&nbsp; <b>Combustível:</b> ${r.fuel_type||'—'}
        </div>
        <div class="form-grid">
          <div class="fg">
            <label>Posto *</label>
            <select id="ers-stn">
              <option value="">Selecione...</option>
              ${DATA.stations.filter(s=>s.active).map(s=>`<option value="${s.name}" data-city="${s.city}" ${s.name===r.gas_station?'selected':''}>${s.name} — ${s.city}</option>`).join('')}
            </select>
          </div>
          <div class="fg">
            <label>Cidade</label>
            <input id="ers-city" value="${r.city||''}" placeholder="Preenchida automaticamente">
          </div>
        </div>
      </div>
      <div class="mf">
        <button class="btn btn-outline" onclick="document.getElementById('m-edit-station-temp').remove()">Cancelar</button>
        <button class="btn btn-accent" onclick="saveReqStation('${id}')">💾 Salvar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Ao selecionar posto → preenche cidade
  document.getElementById('ers-stn').addEventListener('change', function() {
    const city = this.selectedOptions[0]?.dataset.city || '';
    document.getElementById('ers-city').value = city;
  });
}

async function saveReqStation(id) {
  const stn  = document.getElementById('ers-stn').value;
  const city = document.getElementById('ers-city').value.trim();
  if (!stn)  return notify('Selecione o posto', 'warning');
  if (!city) return notify('Informe a cidade', 'warning');
  loading(true);
  const res = await PUT(`/requests/${id}`, { gas_station: stn, city });
  if (res?.success) {
    notify(`✅ Posto atualizado para "${stn}" — ${city}`);
    document.getElementById('m-edit-station-temp')?.remove();
    const reqs = await GET('/requests');
    if (reqs) DATA.requests = reqs;
    renderReqs();
    renderDashboard();
  }
  loading(false);
}

async function openNewReq() {
  // ── Verificar se já há requisição ativa ──────────────────────
  const myReqs = DATA.requests.filter(r => r.driver === SESSION.name);
  const actives = myReqs.filter(r => r.status === 'pending' || r.status === 'signed');

  // Limite especial: LEONAN pode ter até 10 requisições ativas
  const LEONAN = 'LEONAN CONCEIÇÃO MONTEIRO';
  const maxActives = SESSION.name === LEONAN ? 10 : 4;
  const warnAt    = SESSION.name === LEONAN ? 9  : 3;

  // Bloqueia se atingiu o limite
  if (actives.length >= maxActives) {
    notify(`⏳ Você já tem ${actives.length} requisições em andamento. Conclua antes de abrir uma nova.`, 'warning');
    return;
  }

  // Verifica se há requisição aprovada sem fotos há mais de 24h → bloqueia nova
  if (actives.length >= warnAt && actives.some(r => r.status === 'signed')) {
    const req = actives[0];
    const approvedAt = new Date(req.updated_at || req.created_at);
    const diffH = (new Date() - approvedAt) / 3600000;
    const hasFotos = (req.photos||[]).some(p => p.photo_type === 'pump' || p.photo_type === 'receipt');

    if (!hasFotos && diffH >= 24) {
      notify(`🚫 Requisição ${req.id} aprovada há mais de 24h sem envio das fotos. Envie as fotos do abastecimento para desbloquear.`, 'error');
      return;
    }
    if (!hasFotos && diffH < 24) {
      const restH = Math.ceil(24 - diffH);
      notify(`⚠️ Requisição ${req.id} aprovada. Envie as fotos em até ${restH}h ou a próxima requisição será bloqueada.`, 'warning');
      // Não bloqueia — ainda pode abrir a segunda dentro das 24h
    }
  }
  $('rq-drv').value = SESSION.name;

  // Placa e posto entram em estado de "carregando" — dados frescos chegam
  // logo em seguida (ver fetch abaixo), sem travar a abertura da modal
  const sel = $('rq-plate');
  sel.innerHTML = '<option value="">Carregando veículos...</option>';
  sel.disabled = true;
  const stnSel = $('rq-stn');
  if (stnSel) { stnSel.innerHTML = '<option value="">Carregando postos...</option>'; stnSel.disabled = true; }

  $('rq-model').value = '';
  $('rq-km').value = '';
  if ($('rq-city')) $('rq-city').value = '';
  $('rq-notes').value = '';
  // Operador de bombona: pré-seleciona método bombona e bloqueia troca
  if (SESSION.isOperator) {
    if ($('rq-mth')) { $('rq-mth').value = 'bombona'; $('rq-mth').disabled = true; }
  } else {
    if ($('rq-mth')) { $('rq-mth').value = 'litros'; $('rq-mth').disabled = false; }
  }
  if ($('rq-preco-litro')) $('rq-preco-litro').value = '';
  if ($('rq-litros')) $('rq-litros').value = '';
  if ($('rq-valor')) $('rq-valor').value = '';
  if ($('rq-total-calc')) $('rq-total-calc').value = '';
  if ($('rq-litros-calc')) $('rq-litros-calc').value = '';
  if ($('rq-bombona-litros')) $('rq-bombona-litros').value = '';
  if ($('rq-bombona-preco')) $('rq-bombona-preco').value = '';
  if ($('rq-bombona-total')) $('rq-bombona-total').value = '';
  $('bombona-info-box')?.classList.add('hidden');
  $('fsec-veiculo')?.classList.remove('hidden');
  $('fg-preco-litro')?.classList.remove('hidden');
  $('fg-mth-fields')?.classList.remove('hidden');
  $('fg-litros')?.classList.remove('hidden');
  $('fg-valor')?.classList.add('hidden');
  if ($('rq-hori-lbl')) $('rq-hori-lbl').textContent = '📸 Foto do Painel do Veículo *';
  if ($('rq-veh-lbl'))  $('rq-veh-lbl').textContent  = '📸 Foto da Placa do Veículo *';
  resetPU('pu-hori', 'f-hori', '📷 Foto do painel do veículo');
  resetPU('pu-veh',  'f-veh',  '📷 Foto da placa do veículo');
  $('f-hori').value = ''; $('f-veh').value = '';
  openModal('m-new-req');
  // Se operador, dispara onMthChange para mostrar a bombona dele automaticamente
  if (SESSION.isOperator) {
    onMthChange();
    // Pré-seleciona a bombona do operador se ela estiver no select
    setTimeout(() => {
      const op = SESSION.operator;
      if (op?.bombona_id) {
        const opSel = $('rq-bombona-sel');
        if (opSel) for (let o of opSel.options) if (o.value == op.bombona_id) { opSel.value = o.value; break; }
      }
    }, 100);
  }

  // Busca veículos e postos FRESCOS da API (não confia só no cache
  // DATA.vehicles/DATA.stations, que pode ainda estar vazio se o load
  // inicial não terminou / Render acordando de cold start) — isso é o que
  // resolve o select de placa/posto abrindo vazio
  const [freshVehs, freshStations] = await Promise.all([
    GET('/vehicles'),
    GET('/stations')
  ]);
  if (freshVehs && freshVehs.length) DATA.vehicles = freshVehs;
  if (freshStations && freshStations.length) DATA.stations = freshStations;

  sel.disabled = false;
  sel.innerHTML = '<option value="">Selecione a placa / código...</option>';
  const activeVehs = DATA.vehicles.filter(v => v.status === 'Ativo');
  activeVehs.forEach(v => {
    sel.innerHTML += `<option value="${v.plate}">${v.plate} — ${v.model}</option>`;
  });
  if (!activeVehs.length) {
    notify('⚠️ Não foi possível carregar a lista de veículos. Verifique sua conexão e tente novamente.', 'error');
  }

  if (stnSel) {
    stnSel.disabled = false;
    stnSel.innerHTML = '<option value="">Selecione o posto...</option>';
    const activeStations = DATA.stations.filter(s => s.active);
    activeStations.forEach(s => {
      stnSel.innerHTML += `<option value="${s.name}" data-city="${s.city}">${s.name} — ${s.city}</option>`;
    });
    if (!activeStations.length) {
      notify('⚠️ Não foi possível carregar a lista de postos. Verifique sua conexão e tente novamente.', 'error');
    }
  }
}

async function createReq() {
  const mth    = $('rq-mth').value;
  const plate  = mth === 'bombona' ? '' : $('rq-plate').value;
  const model  = mth === 'bombona' ? 'BOMBONA' : $('rq-model').value;
  const km     = mth === 'bombona' ? '' : $('rq-km').value.trim();
  const city   = $('rq-city').value;
  const stn    = $('rq-stn').value;
  const fuel   = $('rq-fuel').value;
  const notes  = $('rq-notes').value.trim();

  if (mth !== 'bombona' && !plate) return notify('Selecione a placa', 'warning');
  if (mth !== 'bombona' && !km)    return notify('Informe o KM ou horímetro', 'warning');
  if (!stn)   return notify('Selecione o posto', 'warning');
  if (!city)  return notify('Selecione o posto para definir a cidade', 'warning');
  if (!fuel)  return notify('Selecione o combustível', 'warning');
  if (!notes) return notify('⚠️ Observações são obrigatórias! Informe o destino do combustível.', 'error');

  const precoLitro = parseFloat($('rq-preco-litro')?.value) || 0;
  const qLitros    = parseFloat($('rq-litros')?.value) || 0;
  const qValor     = parseFloat($('rq-valor')?.value) || 0;
  // Bombona specific fields
  const bLitros    = parseFloat($('rq-bombona-litros')?.value) || 0;
  const bPreco     = parseFloat($('rq-bombona-preco')?.value) || 0;

  if (mth === 'litros') {
    if (!precoLitro) return notify('Informe o preço atual do combustível', 'warning');
    if (!qLitros)    return notify('Informe a quantidade em litros', 'warning');
  } else if (mth === 'valor') {
    if (!precoLitro) return notify('Informe o preço atual do combustível', 'warning');
    if (!qValor)     return notify('Informe o valor em R$', 'warning');
  } else if (mth === 'bombona') {
    if (!$('rq-bombona-sel')?.value) return notify('Selecione a bombona a ser abastecida', 'warning');
    if (!bLitros) return notify('Informe quantos litros precisa abastecer na bombona', 'warning');
  }

  const isKm = /^\d+$/.test(km);
  const bombonaId = mth === 'bombona' ? $('rq-bombona-sel')?.value || null : null;

  // Calcular litros e valor estimado
  let estimatedLitros = null;
  let estimatedValue  = 'A definir';
  if (mth === 'litros' && precoLitro && qLitros) {
    estimatedLitros = qLitros;
    estimatedValue  = `R$ ${(qLitros * precoLitro).toFixed(2)}`;
  } else if (mth === 'valor' && precoLitro && qValor) {
    estimatedLitros = qValor / precoLitro;
    estimatedValue  = `R$ ${qValor.toFixed(2)}`;
  } else if (mth === 'bombona') {
    estimatedLitros = bLitros;
    estimatedValue  = bPreco ? `R$ ${(bLitros * bPreco).toFixed(2)}` : `${bLitros} L`;
  }

  // Nota do método
  let mthNote = '';
  if (mth === 'litros') mthNote = `${qLitros.toFixed(1)} L @ R$ ${precoLitro.toFixed(2)}/L`;
  else if (mth === 'valor') mthNote = `R$ ${qValor.toFixed(2)} @ R$ ${precoLitro.toFixed(2)}/L ≈ ${(estimatedLitros||0).toFixed(1)} L`;
  else if (mth === 'bombona') mthNote = `Bombona: ${$('rq-bombona-sel')?.selectedOptions[0]?.text || '—'} | ${bLitros} L${bPreco ? ` @ R$ ${bPreco.toFixed(2)}/L` : ''}`;

  // Evita enviar enquanto a foto ainda está sendo otimizada/comprimida
  if ($('pu-hori')?.classList.contains('pu-busy') || $('pu-veh')?.classList.contains('pu-busy')) {
    return notify('⏳ Aguarde a foto terminar de carregar antes de enviar', 'warning');
  }

  // Fotos obrigatórias (para bombona só foto da bombona, sem placa)
  const fhori = getPUFile('f-hori');
  const fveh  = getPUFile('f-veh');
  if (!fhori) return notify(`📷 ${mth === 'bombona' ? 'Foto da bombona' : 'Foto do painel'} é obrigatória`, 'error');
  if (mth !== 'bombona' && !fveh) return notify('📷 Foto da placa do veículo é obrigatória', 'error');

  // Debounce — evita duplo submit
  if (_submitting) return notify('Aguarde... enviando requisição.', 'warning');
  _submitting = true;

  // Validação de KM regressivo
  // Antes isso bloqueava o envio sem nenhuma saída. Como o último KM
  // registrado no banco pode estar errado (erro de digitação em
  // requisição anterior), agora avisamos e deixamos o motorista confirmar
  // que o valor dele está correto — a divergência fica registrada nas
  // observações para o supervisor revisar e corrigir o histórico.
  let kmOverrideNote = '';
  if (mth !== 'bombona' && plate && km && isKm) {
    try {
      const kmCheck = await GET(`/validate-km?plate=${encodeURIComponent(plate)}&km=${km}`);
      if (kmCheck && !kmCheck.valid) {
        const confirmou = confirm(
          `⚠️ O KM informado (${parseInt(km).toLocaleString('pt-BR')}) é menor que o último registrado para essa placa (${kmCheck.lastKm?.toLocaleString('pt-BR')}).\n\n` +
          `Isso geralmente indica um erro de digitação em uma requisição anterior, não no valor atual.\n\n` +
          `Tem certeza que o KM ${parseInt(km).toLocaleString('pt-BR')} está correto? Clique OK para enviar mesmo assim, ou Cancelar para revisar.`
        );
        if (!confirmou) {
          _submitting = false;
          return notify('Envio cancelado. Verifique o odômetro antes de tentar novamente.', 'warning');
        }
        kmOverrideNote = `⚠️ KM divergente confirmado pelo motorista (registro anterior: ${kmCheck.lastKm?.toLocaleString('pt-BR')} — possível erro de digitação no histórico)`;
      }
    } catch { /* ignora erro de validação */ }
  }

  loading(true);
  try {
    const res = await POST('/requests', {
      driver: SESSION.name,
      plate: plate || null,
      vehicle: mth === 'bombona' ? `BOMBONA — ${$('rq-bombona-sel')?.selectedOptions[0]?.text?.split(' —')[0] || ''}` : model,
      city, gas_station: stn, fuel_type: fuel,
      fuel_method: mth,
      fuel_method_qty: mth === 'litros' ? qLitros : mth === 'valor' ? qValor : mth === 'bombona' ? bLitros : null,
      price_per_liter: mth === 'bombona' ? (bPreco || null) : (precoLitro || null),
      liters: estimatedLitros ? `${estimatedLitros.toFixed(1)} L` : null,
      bombona_id: bombonaId,
      date: nowISO(),
      km: isKm ? parseInt(km) : null,
      horimetre: !isKm ? km : null,
      priority: $('rq-pri').value,
      notes: [notes, mthNote, kmOverrideNote].filter(Boolean).join(' | '),
      estimated_value: estimatedValue
    });

    if (res?.success) {
      const reqId = res.id;
      const fd = new FormData();
      fd.append('horimetre', fhori); // foto da bombona ou painel
      if (fveh) fd.append('vehicle', fveh); // foto da placa (só veículos)
      fetch(`${API}/api/requests/${reqId}/photos`, { method: 'POST', body: fd })
        .catch(e => console.warn('Upload foto req falhou:', e.message));
      notify(`✅ Requisição ${reqId} criada! Fotos sendo enviadas...`);
      closeModal('m-new-req');
      const reqs = await GET('/requests' + (SESSION.isSup ? '' : `?driver=${encodeURIComponent(SESSION.name)}`));
      if (reqs) DATA.requests = reqs;
      renderAll();
    }
  } catch(e) {
    notify('Erro ao criar requisição: ' + e.message, 'error');
  } finally {
    loading(false);
    _submitting = false;
  }
}

async function approveReq(id, sup) {
  if (!confirm(`Aprovar requisição ${id}?`)) return;
  loading(true);
  const res = await PUT(`/requests/${id}`, { status: 'signed', supervisor: sup });
  if (res?.success) {
    notify('Requisição aprovada! PDF sendo gerado e enviado ao SharePoint...', 'success');
    const reqs = await GET('/requests');
    if (reqs) DATA.requests = reqs;
    renderAll();
  }
  loading(false);
}

async function rejectReq(id, sup) {
  if (!confirm(`Rejeitar requisição ${id}?`)) return;
  loading(true);
  const res = await PUT(`/requests/${id}`, { status: 'rejected', supervisor: sup });
  if (res?.success) {
    notify('Requisição rejeitada', 'warning');
    const reqs = await GET('/requests');
    if (reqs) DATA.requests = reqs;
    renderAll();
  }
  loading(false);
}

async function voidReq(id) {
  if (!confirm(`Anular requisição ${id}?\n\nEla continuará visível no histórico mas NÃO contará em relatórios, valores ou dashboards.`)) return;
  loading(true);
  const res = await PUT(`/requests/${id}`, { status: 'voided' });
  if (res?.success) {
    const reqs = await GET('/requests');
    if (reqs) DATA.requests = reqs;
    renderAll();
    notify('Requisição anulada — não contará nos relatórios', 'warning');
  }
  loading(false);
}

async function delReq(id) {
  if (!confirm(`⚠️ EXCLUIR PERMANENTEMENTE a requisição ${id}?\n\nEsta ação apaga tudo do banco e NÃO pode ser desfeita.`)) return;
  loading(true);
  await DEL(`/requests/${id}`);
  const reqs = await GET('/requests');
  if (reqs) DATA.requests = reqs;
  renderAll();
  notify('Requisição excluída permanentemente', 'warning');
  loading(false);
}

async function downloadPDF(id) {
  const tok = SESSION.sessionToken ? `?_tok=${encodeURIComponent(SESSION.sessionToken)}` : '';
  window.open(`${API}/api/requests/${id}/pdf${tok}`, '_blank');
}

function viewReq(id) {
  const r = DATA.requests.find(x => x.id === id);
  if (!r) return;
  $('v-title').textContent = `Requisição ${r.id}`;
  const photos = r.photos || [];
  $('v-body').innerHTML = `
    <div class="dg">
      <div class="di"><div class="k">Motorista</div><div class="v">${r.driver}</div></div>
      <div class="di"><div class="k">Status</div><div class="v">${statusBadge(r.status)}</div></div>
      <div class="di"><div class="k">Placa / Código</div><div class="v">${r.plate || '—'}</div></div>
      <div class="di"><div class="k">Veículo</div><div class="v">${r.vehicle || '—'}</div></div>
      <div class="di"><div class="k">Cidade</div><div class="v">${r.city || '—'}</div></div>
      <div class="di"><div class="k">Posto</div><div class="v">${r.gas_station || '—'}</div></div>
      <div class="di"><div class="k">Combustível</div><div class="v">${r.fuel_type || '—'}</div></div>
      <div class="di"><div class="k">Método</div><div class="v">${r.fuel_method === 'litros' ? `🧪 Litros${r.fuel_method_qty ? ' — '+r.fuel_method_qty+' L' : ''}` : r.fuel_method === 'valor' ? `💰 Valor${r.fuel_method_qty ? ' — R$ '+Number(r.fuel_method_qty).toFixed(2) : ''}` : r.fuel_method === 'bombona' ? '🛢️ Via Bombona' : r.fuel_method || '—'}</div></div>
      <div class="di"><div class="k">KM / Horímetro</div><div class="v">${r.km ? r.km.toLocaleString('pt-BR') + ' km' : r.horimetre || '—'}</div></div>
      <div class="di"><div class="k">Data / Hora</div><div class="v">${fmtDateTime(r.date)}</div></div>
      <div class="di"><div class="k">Supervisor</div><div class="v">${r.supervisor || '—'}</div></div>
      <div class="di"><div class="k">Prioridade</div><div class="v">${{normal:'🟢 Normal',urgent:'🟡 Urgente',emergency:'🔴 EMERGÊNCIA'}[r.priority]||r.priority}</div></div>
      <div class="di"><div class="k">Litros</div><div class="v">${r.liters || 'A confirmar'}</div></div>
      <div class="di"><div class="k">Preço/L</div><div class="v">${r.price_per_liter ? 'R$ ' + Number(r.price_per_liter).toFixed(2) : 'A confirmar'}</div></div>
      <div class="di"><div class="k">Valor Estimado</div><div class="v">${r.estimated_value || '—'}</div></div>
      <div class="di"><div class="k">Valor Real</div><div class="v" style="color:var(--green);font-weight:800">${r.real_value || 'A confirmar'}</div></div>
    </div>
    ${r.notes ? `<div style="background:#FFF7ED;border-radius:8px;padding:12px;margin-top:8px;color:#1a1a1a"><b>Obs:</b> ${r.notes}</div>` : ''}
    ${r.sharepoint_folder ? `
      <div style="background:#EFF6FF;border-radius:8px;padding:12px;margin-top:8px;display:flex;align-items:center;gap:8px;color:#1a1a1a">
        <span>☁️</span><span style="font-size:.85rem"><b>SharePoint:</b> Sistema Abastecimento / ${r.sharepoint_folder}</span>
      </div>` : ''}
    ${photos.length ? `
      <div style="margin-top:14px">
        <div style="font-size:.85rem;font-weight:700;color:var(--navy);margin-bottom:8px">📷 Fotos no SharePoint (${photos.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${photos.map(p => `<a class="sp-link" href="${p.sharepoint_url}" target="_blank">📷 ${p.photo_type === 'horimetre' ? 'Horímetro' : p.photo_type === 'vehicle' ? 'Painel do Veículo' : p.photo_type}</a>`).join('')}
        </div>
      </div>` : ''}
  `;
  const pdfBtn = $('v-pdf');
  pdfBtn.classList.remove('hidden');
  pdfBtn.onclick = () => downloadPDF(id);
  openModal('m-view');
}

function openComplete(id) {
  const r = DATA.requests.find(x => x.id === id);
  if (!r) return;
  $('cp-id').value = id;
  $('cp-fuel').value = r.fuel_type || '';
  if ($('cp-notes')) $('cp-notes').value = '';

  // Seção Bombona
  const bombSec = $('cp-bombona-sec');
  if (isCaroteReq(r)) {
    bombSec?.classList.remove('hidden');
    const sel = $('cp-bombona-sel');
    if (sel) {
      sel.innerHTML = '<option value="">Selecione a bombona...</option>';
      // Sempre inclui a bombona original da requisicao (mesmo com fuel_type diferente ou locked)
      const visiveis = DATA.bombonas.filter(b =>
        (b.fuel_type === r.fuel_type && !b.locked) || String(b.id) === String(r.bombona_id)
      );
      visiveis.forEach(b =>
        sel.innerHTML += `<option value="${b.id}" ${String(b.id) === String(r.bombona_id) ? 'selected' : ''}>${b.name} — ${parseFloat(b.current_liters).toFixed(0)}L disponível</option>`
      );
      if (r.bombona_id) onCpBombonaChange();
    }
    $('cp-bombona-saldo').value = '';
    $('cp-price').value = '0';
  } else {
    bombSec?.classList.add('hidden');
    const precoReq = parseFloat(r.price_per_liter) || 0;
    $('cp-price').value = precoReq || '';
    const hint = $('cp-price-hint');
    if (hint) hint.innerHTML = precoReq ? `💡 Motorista informou <b>R$ ${precoReq.toFixed(2)}/L</b>` : 'Informe o preço real do posto';
  }

  let litrosSugerido = '';
  let litrosHint = '';
  const precoReq = parseFloat(r.price_per_liter) || 0;
  if (r.fuel_method === 'litros' && r.fuel_method_qty) {
    litrosSugerido = parseFloat(r.fuel_method_qty).toFixed(1);
    litrosHint = `💡 Motorista solicitou <b>${litrosSugerido} L</b>`;
  } else if (r.fuel_method === 'valor' && r.fuel_method_qty && precoReq) {
    litrosSugerido = (parseFloat(r.fuel_method_qty) / precoReq).toFixed(1);
    litrosHint = `💡 ≈ <b>${litrosSugerido} L</b>`;
  } else if (isCaroteReq(r)) {
    litrosHint = '💡 Informe os litros retirados da bombona';
  } else if (r.liters) {
    const m = r.liters.match(/[\d.]+/);
    if (m) { litrosSugerido = m[0]; litrosHint = `💡 Estimado: <b>${litrosSugerido} L</b>`; }
  }
  $('cp-liters').value = litrosSugerido;
  const lhint = $('cp-liters-hint');
  if (lhint) lhint.innerHTML = litrosHint;

  const mthLabel = r.fuel_method === 'litros' ? `🧪 ${r.fuel_method_qty || '?'} L`
    : r.fuel_method === 'valor' ? `💰 R$ ${parseFloat(r.fuel_method_qty||0).toFixed(2)}`
    : isCaroteReq(r) ? '🛢️ Bombona/Carote' : r.fuel_method || '—';

  setHTML('cp-req-info', `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Motorista</span><br><b>${shortName(r.driver)}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Placa</span><br><b>${r.plate||'—'}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Veículo</span><br><b>${r.vehicle || '—'}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Posto</span><br><b>${r.gas_station||'—'}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Cidade</span><br><b>${r.city||'—'}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Método</span><br><b>${mthLabel}</b></div>
      ${r.notes?`<div style="grid-column:1/-1"><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Obs.</span><br>${r.notes}</div>`:''}
    </div>`);

  calcTotal();

  // Mostra status das fotos do motorista
  const fotos = r.photos || [];
  const hasPump    = fotos.some(p => p.photo_type === 'pump');
  const hasReceipt = fotos.some(p => p.photo_type === 'receipt');
  const fotosEl = $('cp-fotos-status');
  if (fotosEl) {
    if (hasPump && hasReceipt) {
      fotosEl.style.cssText = 'background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:var(--green)';
      fotosEl.innerHTML = '✅ <b>Fotos do motorista recebidas</b> — Bomba e cupom fiscal enviados. Pode concluir.';
    } else {
      fotosEl.style.cssText = 'background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);color:var(--yellow)';
      const faltam = [!hasPump && '⛽ Bomba', !hasReceipt && '🧾 Cupom Fiscal'].filter(Boolean).join(' e ');
      fotosEl.innerHTML = `⚠️ <b>Fotos pendentes do motorista:</b> ${faltam} — O motorista ainda não enviou as fotos do abastecimento.`;
    }
  }

  openModal('m-complete');
}

function onCpBombonaChange() {
  const bid = $('cp-bombona-sel').value;
  const b = DATA.bombonas.find(x => x.id == bid);
  $('cp-bombona-saldo').value = b ? `${parseFloat(b.current_liters).toFixed(1)} L disponíveis` : '';
}

function calcTotal() {
  const p = parseFloat($('cp-price').value) || 0;
  const l = parseFloat($('cp-liters').value) || 0;
  $('cp-total').value = p && l ? `R$ ${(p * l).toFixed(2)}` : '—';
  // Recalcular dica de litros se método for valor
  const id = $('cp-id').value;
  const r = DATA.requests.find(x => x.id === id);
  if (r?.fuel_method === 'valor' && r.fuel_method_qty && p) {
    const est = (parseFloat(r.fuel_method_qty) / p).toFixed(1);
    const lhint = $('cp-liters-hint');
    if (lhint) lhint.innerHTML = `💡 R$ ${parseFloat(r.fuel_method_qty).toFixed(2)} ÷ R$ ${p.toFixed(2)}/L ≈ <b>${est} L</b>`;
  }
}

// ── Salvar valores sem concluir — gera novo PDF Aprovado ──────
async function updateReqValues() {
  const id     = $('cp-id').value;
  const price  = parseFloat($('cp-price').value);
  const liters = parseFloat($('cp-liters').value);
  const notes  = $('cp-notes').value.trim();
  if (!liters) return notify('Informe os litros abastecidos', 'warning');
  const r = DATA.requests.find(x => x.id === id);
  if (!isCaroteReq(r) && !price) return notify('Informe o preço por litro', 'warning');

  loading(true);
  const realValue = price && liters ? `R$ ${(price * liters).toFixed(2)}` : `${liters.toFixed(1)} L (bombona)`;
  const res = await PUT(`/requests/${id}`, {
    real_value: realValue,
    price_per_liter: price || null,
    liters: `${liters.toFixed(1)} L`,
    notes: notes || undefined,
    regenerate_pdf: true   // sinaliza para gerar novo PDF Aprovado
  });
  if (res?.success) {
    notify('✅ Valores salvos! Novo PDF Aprovado gerado. Aguardando fotos do motorista.', 'success');
    closeModal('m-complete');
    const reqs = await GET('/requests');
    if (reqs) DATA.requests = reqs;
    renderAll();
  }
  loading(false);
}

async function submitComplete() {
  const id     = $('cp-id').value;
  const price  = parseFloat($('cp-price').value);
  const liters = parseFloat($('cp-liters').value);
  const notes  = $('cp-notes').value.trim();
  const r      = DATA.requests.find(x => x.id === id);

  if (!liters) return notify('Informe os litros abastecidos', 'warning');
  if (!isCaroteReq(r) && !price) return notify('Informe o preço por litro', 'warning');

  // Bombona/Carote — so verifica se esta travada, SEM validar saldo
  // (saldo já foi adicionado ao aprovar; o motorista transfere separadamente)
  const bombonaId = isCaroteReq(r) ? ($('cp-bombona-sel')?.value || null) : null;
  if (isCaroteReq(r)) {
    if (!bombonaId) return notify('Selecione a bombona para registro', 'warning');
    const b = DATA.bombonas.find(x => x.id == bombonaId);
    if (b?.locked) return notify('Esta bombona está travada pelo administrador', 'error');
  }

  loading(true);
  const realValue = price && liters ? `R$ ${(price * liters).toFixed(2)}` : r?.estimated_value || 'Via Bombona';
  const res = await PUT(`/requests/${id}`, {
    status: 'completed',
    supervisor: shortName(SESSION.name),
    real_value: realValue,
    price_per_liter: price || null,
    liters: `${liters.toFixed(1)} L`,
    notes: notes || undefined,
    bombona_id: bombonaId || undefined
  });

  if (res?.success) {
    // Bombona: NÃO cria transferência aqui — o saldo já foi adicionado ao aprovar
    // e o motorista faz as transferências para os veículos separadamente
    notify(`✅ Requisição concluída! ${liters.toFixed(1)} L${price ? ` × R$ ${price.toFixed(2)} = ${realValue}` : ' via bombona registrado'}`);
    closeModal('m-complete');
    const [reqs, bombs] = await Promise.all([GET('/requests'), GET('/bombonas')]);
    if (reqs) DATA.requests = reqs;
    if (bombs) DATA.bombonas = bombs;
    renderAll();
  }
  loading(false);
}

// ── Fotos do motorista pós-aprovação ─────────────
function openDriverPhotos(id) {
  const r = DATA.requests.find(x => x.id === id);
  if (!r) return;
  $('dp-id').value = id;
  $('dp-method').value = r.fuel_method || '';

  setHTML('dp-req-info', `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:.85rem">
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Placa</span><br><b>${r.plate||'—'}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Posto</span><br><b>${r.gas_station||'—'}</b></div>
      <div><span style="color:var(--text3);font-size:.7rem;text-transform:uppercase;font-weight:700">Combustível</span><br><b>${r.fuel_type||'—'}</b></div>
    </div>`);

  // Label dinâmico: bombona → "carote abastecido", veículo → "painel do veículo"
  const isBombona = isCaroteReq(r);
  const lbl  = $('dp-panel-lbl');
  const hint = $('dp-panel-hint');
  if (lbl)  lbl.innerHTML  = isBombona
    ? '🛢️ Foto do Carote/Bombona Abastecida <span style="color:var(--red)">*</span>'
    : '📸 Foto do Painel do Veículo <span style="color:var(--red)">*</span>';
  if (hint) hint.textContent = isBombona
    ? '📷 Foto da bombona/carote após o abastecimento'
    : '📷 Foto do painel mostrando o hodômetro/horímetro após o abastecimento';

  // Reset todas as fotos
  resetPU('pu-dp-pump',    'dp-f-pump',    '📷 Foto do bico da bomba');
  resetPU('pu-dp-receipt', 'dp-f-receipt', '📷 Foto do cupom fiscal');
  resetPU('pu-dp-panel',   'dp-f-panel',   isBombona ? '📷 Foto da bombona/carote' : '📷 Foto do painel do veículo');
  openModal('m-driver-photos');
}

async function submitDriverPhotos() {
  const id       = $('dp-id').value;
  const method   = $('dp-method').value;

  if (['pu-dp-pump','pu-dp-receipt','pu-dp-panel'].some(id => $(id)?.classList.contains('pu-busy'))) {
    return notify('⏳ Aguarde a foto terminar de carregar antes de enviar', 'warning');
  }

  const fPump    = getPUFile('dp-f-pump');
  const fReceipt = getPUFile('dp-f-receipt');
  const fPanel   = getPUFile('dp-f-panel');

  if (!fPump)    return notify('📷 Foto da bomba/bico é obrigatória', 'error');
  if (!fReceipt) return notify('🧾 Foto do cupom fiscal é obrigatória', 'error');
  const panelLabel = method === 'bombona' ? 'carote/bombona' : 'painel do veículo';
  if (!fPanel)   return notify(`📸 Foto do ${panelLabel} é obrigatória`, 'error');

  loading(true);
  try {
    const fd = new FormData();
    fd.append('pump',    fPump);
    fd.append('receipt', fReceipt);
    fd.append(method === 'bombona' ? 'panel_carote' : 'panel_vehicle', fPanel);

    // Timeout de 30s para não travar infinito
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let json = {};
    try {
      const res = await fetch(`${API}/api/requests/${id}/photos`, {
        method: 'POST',
        body: fd,
        signal: controller.signal,
        headers: SESSION.sessionToken ? { 'x-session-token': SESSION.sessionToken } : {}
      });
      clearTimeout(timeout);
      json = await res.json().catch(() => ({}));
    } catch(fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === 'AbortError') {
        // Upload demorou mas pode ter chegado — considera sucesso e avisa
        notify('⚠️ Upload demorou. As fotos podem ter sido enviadas. Verifique a requisição.', 'warning');
        closeModal('m-driver-photos');
        const reqs = await GET(`/requests?driver=${encodeURIComponent(SESSION.name)}`).catch(()=>null);
        if (reqs) { DATA.requests = reqs; renderReqs(); }
        return;
      }
      throw fetchErr;
    }

    if (json.success) {
      notify('✅ Fotos enviadas! O supervisor será notificado para concluir.');
      closeModal('m-driver-photos');
      const reqs = await GET(`/requests?driver=${encodeURIComponent(SESSION.name)}`);
      if (reqs) DATA.requests = reqs;
      renderReqs();
    } else {
      notify(json.error || 'Erro ao enviar fotos', 'error');
    }
  } catch(e) {
    notify('Erro no envio: ' + e.message, 'error');
  } finally {
    loading(false);
  }
}
// ══════════════════════════════════════════════════
function renderBombonaReqs() {
  // Só exibe para supervisores
  const card = $('card-bombona-reqs');
  const tbody = $('tb-bombona-reqs');
  const bdg   = $('bdg-bombona-reqs');
  if (!card || !tbody || !SESSION.isSup) return;

  // Filtra requisições de método bombona que estão pending ou signed
  const pendentes = DATA.requests.filter(r =>
    isCaroteReq(r) && (r.status === 'pending' || r.status === 'signed') && r.status !== 'voided'
  );

  if (!pendentes.length) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  bdg.textContent = pendentes.length;

  const rows = pendentes.map(r => {
    const bomb = DATA.bombonas.find(b => b.id == r.bombona_id);
    const bombNome = bomb?.name || (r.bombona_id ? `#${r.bombona_id}` : '—');
    const litrosReq = r.fuel_method_qty ? `${parseFloat(r.fuel_method_qty).toFixed(0)} L` : '—';

    const statusBadgePt = r.status === 'pending'
      ? `<span class="badge b-pending">⏳ Pendente</span>`
      : `<span class="badge b-signed">✅ Aprovada</span>`;

    const acoes = [];
    if (r.status === 'pending') {
      acoes.push(`<button class="btn btn-success btn-xs" onclick="approveReq('${r.id}','${shortName(SESSION.name)}')" title="Aprovar requisição">✅ Aprovar</button>`);
      acoes.push(`<button class="btn btn-danger btn-xs" onclick="rejectReq('${r.id}','${shortName(SESSION.name)}')" title="Rejeitar">❌</button>`);
    }
    if (r.status === 'signed') {
      acoes.push(`<button class="btn btn-info btn-xs" onclick="openComplete('${r.id}')" title="Concluir abastecimento via bombona">⛽ Concluir</button>`);
    }
    acoes.push(`<button class="btn btn-outline btn-xs" onclick="viewReq('${r.id}')">👁️</button>`);

    return `<tr>
      <td><code style="font-size:.78rem;background:#F1F5F9;padding:2px 6px;border-radius:4px">${r.id}</code></td>
      <td><b>${shortName(r.driver)}</b></td>
      <td>🛢️ ${bombNome}</td>
      <td>${r.fuel_type || '—'}</td>
      <td><b>${litrosReq}</b></td>
      <td>${fmtDate(r.date)}</td>
      <td>${statusBadgePt}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">${acoes.join('')}</td>
    </tr>`;
  }).join('');

  tbody.innerHTML = rows;
}

function renderBombonas() {
  const grid = $('bc-grid');
  if (!grid) return;

  // Renderiza painel de requisições pendentes (só gestor)
  renderBombonaReqs();

  // Supervisor: vê todas | Operador: vê as suas | Motorista: não acessa esta tela
  const myBombs = SESSION.isSup
    ? DATA.bombonas
    : SESSION.operator?.id
      ? DATA.bombonas.filter(b => b.operator_id == SESSION.operator.id)
      : DATA.bombonas.filter(b => normalizeStr(b.responsible_driver) === normalizeStr(SESSION.name));

  const label = SESSION.isSup ? 'cadastrada' : 'atribuída a você';
  if (!myBombs.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="ico">🛢️</div><h3>Nenhuma bombona ${label}</h3><p>${SESSION.isSup ? 'Crie uma nova bombona.' : 'Fale com o supervisor.'}</p></div>`;
    return;
  }

  grid.innerHTML = myBombs.map(b => {
    const cur     = parseFloat(b.current_liters) || 0;
    const cap     = parseFloat(b.capacity_liters) || 0;
    const pct     = fuelPct(cur, cap);
    const cls     = fuelBarClass(pct);
    const isResp  = (SESSION.operator?.id && b.operator_id == SESSION.operator.id) || normalizeStr(SESSION.name) === normalizeStr(b.responsible_driver) || SESSION.isSup;
    const locked  = !!b.locked;
    return `
    <div class="bc" style="${locked ? 'border-color:rgba(239,68,68,0.4);' : ''}">
      <div class="bc-head" style="${locked ? 'background:rgba(239,68,68,0.12);' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <h3>🛢️ ${b.name} ${locked ? '<span style="background:rgba(239,68,68,0.2);color:var(--red);font-size:.7rem;padding:2px 8px;border-radius:99px;margin-left:6px">🔒 TRAVADA</span>' : ''}</h3>
            <div class="meta">${b.fuel_type} · ${b.location || 'Local não definido'} · Resp: ${shortName(b.responsible_driver)}</div>
          </div>
          ${SESSION.isSup ? `<button class="btn btn-xs ${locked ? 'btn-success' : 'btn-danger'}" onclick="toggleLockBombona(${b.id},${locked})" title="${locked ? 'Destravar bombona' : 'Travar bombona'}">${locked ? '🔓 Destravar' : '🔒 Travar'}</button>` : ''}
        </div>
      </div>
      <div class="bc-body">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><span style="font-size:1.6rem;font-weight:800;color:var(--text)">${cur.toFixed(0)}</span><span style="color:var(--text3);font-size:.85rem"> / ${cap.toFixed(0)} L</span></div>
          <div style="font-size:1.2rem;font-weight:700;color:${pct>=40?'var(--green)':pct>=20?'var(--yellow)':'var(--red)'}">${pct}%</div>
        </div>
        <div class="fuel-bar"><div class="fuel-fill ${cls}" style="width:${pct}%"></div></div>
        <div style="font-size:.75rem;color:var(--text3);margin-top:4px">
          Transferidos: ${parseFloat(b.total_transferred||0).toFixed(0)}L · ${b.transfer_count||0} transferência(s)
        </div>
        <div class="bc-acts">
          ${isResp && !locked ? `<button class="btn btn-accent btn-sm" onclick="openTransfer(${b.id})">🔄 Transferir</button>` : ''}
          ${locked ? `<span style="font-size:.8rem;color:var(--red);font-weight:600">⛔ Transferências bloqueadas</span>` : ''}
          ${SESSION.isSup ? `<button class="btn btn-success btn-sm" onclick="openRefill(${b.id})">➕ Reabastecer</button>` : ''}
          <button class="btn btn-outline btn-xs" onclick="openBombonaHistory(${b.id},'${b.name.replace(/'/g,"\\'")}')">📊 Histórico</button>
          ${SESSION.isSup ? `<button class="btn btn-xs ${locked ? 'btn-success' : 'btn-danger'}" onclick="toggleLockBombona(${b.id},${locked})" title="${locked ? 'Destravar bombona' : 'Travar bombona'}">${locked ? '🔓' : '🔒'}</button>` : ''}
          ${SESSION.isSup ? `<button class="btn btn-danger btn-xs" onclick="delBombona(${b.id})">🗑️</button>` : ''}
        </div>
        ${b.notes ? `<div style="font-size:.78rem;color:var(--text3);margin-top:8px;padding:8px;background:var(--dark3);border-radius:6px">${b.notes}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderTransfers() {
  let list;
  if (SESSION.isSup) {
    list = DATA.transfers;
  } else if (SESSION.isOperator) {
    // Operador vê TODAS as transferências das bombonas atribuídas a ele
    const myBombaIds = new Set(
      SESSION.operator?.id
        ? DATA.bombonas.filter(b => b.operator_id == SESSION.operator.id).map(b => b.id)
        : DATA.bombonas.filter(b => normalizeStr(b.responsible_driver) === normalizeStr(SESSION.name)).map(b => b.id)
    );
    list = DATA.transfers.filter(t => myBombaIds.has(t.bombona_id) || t.driver === SESSION.name);
  } else {
    list = DATA.transfers.filter(t => t.driver === SESSION.name);
  }
  const rows = list.map(t => {
    const photos = t.photos || [];
    return `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td><b>${t.bombona_name || '—'}</b><br><small style="color:var(--muted)">${t.bombona_fuel || ''}</small></td>
      <td>${shortName(t.driver)}</td>
      <td style="font-size:.78rem;color:var(--text3)">${t.registered_by && t.registered_by !== t.driver ? shortName(t.registered_by) : '—'}</td>
      <td>${t.vehicle_plate ? `<b>${t.vehicle_plate}</b> ${t.vehicle_model || ''}` : '— (saída direta)'}</td>
      <td><b style="color:var(--navy)">${parseFloat(t.liters).toFixed(1)} L</b></td>
      <td style="font-size:.8rem">${t.notes || '—'}</td>
      <td>
        ${photos.filter(p => p.sharepoint_url).map(p =>
          `<a class="sp-link" href="${p.sharepoint_url}" target="_blank">📷 ${p.photo_type === 'photo_before' ? 'Antes' : p.photo_type === 'photo_after' ? 'Depois' : 'Veículo'}</a>`
        ).join(' ')}
        ${!photos.filter(p=>p.sharepoint_url).length ? '—' : ''}
      </td>
    </tr>`;
  }).join('');
  setHTML('tb-transfers', rows || emptyRow(8, 'Nenhuma transferência registrada'));
}

function openNovaBombona() {
  $('nb-name').value = ''; $('nb-cap').value = ''; $('nb-cur').value = '';
  $('nb-loc').value = ''; $('nb-notes').value = '';
  const sel = $('nb-resp');
  sel.innerHTML = '<option value="">Selecione o operador...</option>';
  (DATA.operators || []).forEach(op => {
    sel.innerHTML += `<option value="${op.id}" data-name="${op.name}">${op.name} (${op.matricula})</option>`;
  });
  openModal('m-nb');
}

async function saveBombona() {
  const name     = $('nb-name').value.trim();
  const cap      = $('nb-cap').value;
  const respSel  = $('nb-resp');
  const operatorId = respSel.value;
  const operatorName = respSel.selectedOptions[0]?.dataset?.name || '';
  if (!name || !cap || !operatorId) return notify('Preencha nome, capacidade e operador responsável', 'warning');
  loading(true);
  const res = await POST('/bombonas', {
    name, fuel_type: $('nb-fuel').value, capacity_liters: parseFloat(cap),
    current_liters: parseFloat($('nb-cur').value) || 0,
    operator_id: parseInt(operatorId),
    responsible_driver: operatorName,
    location: $('nb-loc').value,
    notes: $('nb-notes').value
  });
  if (res?.success) {
    notify('Bombona criada com sucesso!');
    closeModal('m-nb');
    const bombs = await GET('/bombonas');
    if (bombs) DATA.bombonas = bombs;
    renderBombonas();
  }
  loading(false);
}

async function delBombona(id) {
  if (!confirm('Excluir esta bombona?')) return;
  await DEL(`/bombonas/${id}`);
  const bombs = await GET('/bombonas');
  if (bombs) DATA.bombonas = bombs;
  renderBombonas();
  notify('Bombona removida', 'warning');
}

async function toggleLockBombona(id, currentlyLocked) {
  const action = currentlyLocked ? 'destravar' : 'travar';
  if (!confirm(`Deseja ${action} esta bombona?`)) return;
  loading(true);
  const res = await PUT(`/bombonas/${id}`, { locked: !currentlyLocked });
  if (res?.success) {
    notify(`Bombona ${currentlyLocked ? 'destravada 🔓' : 'travada 🔒'}`, currentlyLocked ? 'success' : 'warning');
    const bombs = await GET('/bombonas');
    if (bombs) DATA.bombonas = bombs;
    renderBombonas();
  }
  loading(false);
}

function openTransfer(bid) {
  const b = DATA.bombonas.find(x => x.id === bid);
  if (!b) return;
  $('tf-bid').value = bid;
  $('tf-title').textContent = `🔄 Transferência — ${b.name}`;
  $('tf-info').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>🛢️ <b>${b.name}</b> — ${b.fuel_type}<br>
      📍 ${b.location || 'Local n/d'} · Resp: ${shortName(b.responsible_driver)}</div>
      <div style="text-align:right">
        <div style="font-size:1.4rem;font-weight:800;color:var(--navy)">${parseFloat(b.current_liters).toFixed(1)} L</div>
        <div style="font-size:.78rem;color:var(--muted)">disponível de ${parseFloat(b.capacity_liters).toFixed(0)} L</div>
      </div>
    </div>`;
  // Preenche select de colaboradores (lista completa de motoristas)
  const tfDriver = $('tf-driver');
  const drivers = [...DRIVERS].sort();
  tfDriver.innerHTML = '<option value="">Selecione o colaborador...</option>';
  drivers.forEach(d => {
    tfDriver.innerHTML += `<option value="${d}" ${d === b.responsible_driver ? 'selected' : ''}>${d}</option>`;
  });
  // Refresh vehicle select
  const tfVpl = $('tf-vpl');
  tfVpl.innerHTML = '<option value="">Nenhum (apenas saída de bombona)</option>';
  DATA.vehicles.filter(v => v.status === 'Ativo').forEach(v => {
    tfVpl.innerHTML += `<option value="${v.plate}" data-model="${v.model}">${v.plate} — ${v.model}</option>`;
  });
  $('tf-vmod').value = '';
  $('tf-liters').value = '';
  $('tf-date').value = today();
  $('tf-notes').value = '';
  if ($('tf-km')) $('tf-km').value = '';
  if ($('tf-km-hint')) $('tf-km-hint').textContent = '';
  $('tf-km-row')?.classList.add('hidden');
  resetPU('pu-tf1', 'tf-f1', '📷 Foto antes');
  resetPU('pu-tf2', 'tf-f2', '📷 Foto depois');
  resetPU('pu-tf3', 'tf-f3', '📷 Foto do veículo');
  ['tf-f1','tf-f2','tf-f3'].forEach(id => $(id).value = '');
  openModal('m-tf');
}

async function submitTf() {
  const bid    = $('tf-bid').value;
  const liters = parseFloat($('tf-liters').value);
  if (!liters || liters <= 0) return notify('Informe a quantidade de litros', 'warning');
  const b = DATA.bombonas.find(x => x.id == bid);
  if (b && liters > parseFloat(b.current_liters)) return notify(`Saldo insuficiente! Disponível: ${parseFloat(b.current_liters).toFixed(1)} L`, 'error');

  // Evita enviar enquanto alguma foto ainda está sendo otimizada/comprimida
  if (['pu-tf1','pu-tf2','pu-tf3'].some(id => $(id)?.classList.contains('pu-busy'))) {
    return notify('⏳ Aguarde a foto terminar de carregar antes de enviar', 'warning');
  }

  // Fotos obrigatórias
  const f1 = getPUFile('tf-f1');
  const f2 = getPUFile('tf-f2');
  const f3 = getPUFile('tf-f3');
  if (!f1) return notify('📷 Foto antes da transferência é obrigatória', 'error');
  if (!f2) return notify('📷 Foto depois da transferência é obrigatória', 'error');
  if (!f3) return notify('📷 Foto do veículo é obrigatória', 'error');

  const selectedDriver = $('tf-driver').value;
  if (!selectedDriver) return notify('Selecione o colaborador responsável', 'warning');

  loading(true);
  const fd = new FormData();
  fd.append('bombona_id', bid);
  fd.append('driver', selectedDriver);          // colaborador responsável pela bombona
  fd.append('registered_by', SESSION.name);     // supervisor/gestor que registrou
  fd.append('liters', liters);
  fd.append('notes', $('tf-notes').value);
  fd.append('date', $('tf-date').value || today());
  const plate = $('tf-vpl').value;
  const model = $('tf-vmod').value;
  if (plate) { fd.append('vehicle_plate', plate); fd.append('vehicle_model', model); }
  const kmVal = $('tf-km')?.value;
  if (plate && kmVal) fd.append('km', kmVal);
  fd.append('photo_before', f1);
  fd.append('photo_after', f2);
  fd.append('photo_vehicle', f3);

  const res = await api('POST', '/bombona-transfers', fd);
  if (res?.success) {
    notify(`Transferência de ${liters.toFixed(1)}L registrada! Fotos enviadas ao SharePoint.`);
    closeModal('m-tf');
    const [bombs, transfers] = await Promise.all([GET('/bombonas'), GET('/bombona-transfers')]);
    if (bombs) DATA.bombonas = bombs;
    if (transfers) DATA.transfers = transfers;
    renderBombonas();
    renderTransfers();
  }
  loading(false);
}

function openRefill(bid) {
  const b = DATA.bombonas.find(x => x.id === bid);
  if (!b) return;
  $('rf-id').value = bid;
  $('rf-info').innerHTML = `🛢️ <b>${b.name}</b><br>Saldo atual: <b>${parseFloat(b.current_liters).toFixed(1)} L</b> de ${parseFloat(b.capacity_liters).toFixed(0)} L<br>Combustível: ${b.fuel_type}`;
  $('rf-liters').value = '';
  openModal('m-refill');
}

async function submitRefill() {
  const id = $('rf-id').value;
  const liters = parseFloat($('rf-liters').value);
  if (!liters || liters <= 0) return notify('Informe a quantidade', 'warning');
  loading(true);
  const res = await POST(`/bombonas/${id}/abastecer`, { liters });
  if (res?.success) {
    notify(`${liters.toFixed(1)}L adicionados! Novo saldo: ${res.novoSaldo.toFixed(1)} L`);
    closeModal('m-refill');
    const bombs = await GET('/bombonas');
    if (bombs) DATA.bombonas = bombs;
    renderBombonas();
  }
  loading(false);
}

// ══════════════════════════════════════════════════
// ABASTECIMENTOS
// ══════════════════════════════════════════════════
function renderFuelRecords() {
  const stnF  = $('ff-stn')?.value  || '';
  const drvF  = $('ff-drv')?.value  || '';
  const fuelF = $('ff-fuel')?.value || '';
  const startF = $('ff-start')?.value || '';
  const endF   = $('ff-end')?.value   || '';

  let list = DATA.fuelRecords;
  if (stnF)  list = list.filter(r => (r.gas_station || '') === stnF);
  if (drvF)  list = list.filter(r => r.driver === drvF);
  if (fuelF) list = list.filter(r => r.fuel_type === fuelF);
  if (startF) list = list.filter(r => r.date >= startF);
  if (endF)   list = list.filter(r => r.date <= endF);

  // KM rodado por abastecimento: calculado sobre o histórico COMPLETO de cada
  // placa (não só a lista filtrada na tela), pra sempre bater com o abastecimento
  // anterior real do veículo — não com o que aparece na tela depois do filtro.
  const kmMap = buildKmRodadoMap(DATA.fuelRecords);

  // Totais do filtro atual
  const totalCusto = list.filter(r => r.status === 'completed').reduce((s, r) => {
    return s + (parseFloat((r.real_value||'0').replace(/[^\d.,]/g,'').replace(',','.')) || 0);
  }, 0);
  const totalLitros = list.filter(r => r.status === 'completed').reduce((s, r) => {
    return s + (parseFloat((r.liters||'0').replace(/[^\d.,]/g,'').replace(',','.')) || 0);
  }, 0);
  if ($('ff-total-custo'))  $('ff-total-custo').textContent  = totalCusto.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  if ($('ff-total-litros')) $('ff-total-litros').textContent = `${totalLitros.toFixed(0)} L`;
  if ($('ff-total-count'))  $('ff-total-count').textContent  = list.filter(r => r.status === 'completed').length;

  const rows = list.map(r => {
    const kmInfo = kmMap[r.request_id || r.id];
    const kmRodado = kmInfo ? kmInfo.valor : null;
    const kmTitle = kmRodado != null
      ? `Conferência: ${Number(kmInfo.kmAnterior).toLocaleString('pt-BR')} km (${fmtDate(kmInfo.dataAnterior)}) → ${Number(r.km).toLocaleString('pt-BR')} km (${fmtDate(r.date)}) = ${Number(kmRodado).toLocaleString('pt-BR')} km`
      : 'Sem abastecimento anterior com KM válido pra comparar';
    return `
    <tr>
      <td><code style="font-size:.75rem">${r.request_id || r.id}</code></td>
      <td title="${r.driver}">${shortName(r.driver)}</td>
      <td style="font-size:.82rem">${r.vehicle || '—'}</td>
      <td style="font-size:.82rem">${r.city || '—'}</td>
      <td style="font-size:.82rem">${r.gas_station || '—'}</td>
      <td>${r.fuel_type || '—'}</td>
      <td>${r.liters || '—'}</td>
      <td>${r.price_per_liter ? 'R$ ' + Number(r.price_per_liter).toFixed(2) : '—'}</td>
      <td style="font-weight:700">${r.real_value || r.estimated_value || '—'}</td>
      <td style="font-weight:700;color:var(--orange)" title="${kmTitle}">${kmRodado != null ? Number(kmRodado).toLocaleString('pt-BR') + ' km ℹ️' : '—'}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${fmtDateTime(r.date)}</td>
      <td>
        ${r.pdf_url ? `<a class="pdf-btn" href="${r.pdf_url}" target="_blank">📄 PDF</a>` : ''}
        ${SESSION.isSup && r.status === 'signed' ? `<button class="btn btn-info btn-xs" onclick="openComplete('${r.request_id||r.id}')">⛽ Completar</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  setHTML('tb-fuels', rows || emptyRow(13, 'Nenhum registro encontrado'));
}

// Calcula, para cada abastecimento COM placa e KM válidos, quantos km foram
// rodados desde o abastecimento anterior DAQUELE MESMO veículo (ordem cronológica
// real: data + created_at como desempate). Retorna { [request_id]: {valor, kmAnterior, dataAnterior} | null }.
function buildKmRodadoMap(records) {
  const byPlate = {};
  (records || []).forEach(r => {
    if (r.status !== 'completed' || !r.plate) return;
    const km = parseInt(r.km);
    if (!km || km <= 0) return;
    if (!byPlate[r.plate]) byPlate[r.plate] = [];
    byPlate[r.plate].push(r);
  });
  const map = {};
  Object.values(byPlate).forEach(list => {
    list.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
    list.forEach((r, i) => {
      const key = r.request_id || r.id;
      if (i === 0) { map[key] = null; return; }
      const prevKm = parseInt(list[i - 1].km);
      const curKm  = parseInt(r.km);
      map[key] = curKm > prevKm
        ? { valor: curKm - prevKm, kmAnterior: prevKm, dataAnterior: list[i - 1].date }
        : null;
    });
  });
  return map;
}

// ══════════════════════════════════════════════════
// FROTA
// ══════════════════════════════════════════════════
function renderVehicles() {
  const typeF = $('fv-type')?.value || '';
  const locF  = $('fv-loc')?.value || '';
  let list = DATA.vehicles;
  if (typeF) list = list.filter(v => v.type?.toUpperCase() === typeF.toUpperCase() || v.type?.toUpperCase().includes(typeF.toUpperCase()));
  if (locF)  list = list.filter(v => v.location === locF);

  const rows = list.map(v => `
    <tr>
      <td><b style="color:var(--navy)">${v.equipment_id || '—'}</b></td>
      <td><code style="background:#F1F5F9;padding:2px 6px;border-radius:4px;font-size:.82rem">${v.plate}</code></td>
      <td>${v.brand || '—'}</td>
      <td>${v.model}</td>
      <td>${typeBadge(v.type)}</td>
      <td style="font-size:.8rem">${v.sector || '—'}</td>
      <td>${v.year || '—'}</td>
      <td>${v.fuel_type || '—'}</td>
      <td>${v.tank_capacity ? v.tank_capacity + ' L' : '—'}</td>
      <td>${v.location || '—'}</td>
      <td><span class="badge ${v.ownership === 'PROPRIO' ? 'b-signed' : 'b-pending'}">${v.ownership || '—'}</span></td>
      <td><span class="badge ${v.status === 'Ativo' ? 'b-ativo' : 'b-inativo'}">${v.status || 'Ativo'}</span></td>
      <td>${v.km ? Number(v.km).toLocaleString('pt-BR') : '—'}</td>
      <td>${SESSION.isSup ? `
        <div style="display:flex;gap:4px">
          <button class="btn btn-outline btn-xs" onclick="openEditVeh('${v.plate}')" title="Editar">✏️</button>
          <button class="btn btn-danger btn-xs" onclick="delVeh('${v.plate}')">🗑️</button>
        </div>` : '—'}</td>
    </tr>`).join('');
  setHTML('tb-vehs', rows || emptyRow(14, 'Nenhum veículo encontrado'));
}

function openNewVeh() {
  $('nv-modal-title').textContent = '🚗 Adicionar Veículo / Equipamento';
  $('nv-pl').disabled = false;
  $('nv-pl').value = ''; $('nv-eq').value = ''; $('nv-br').value = '';
  $('nv-md').value = ''; $('nv-yr').value = ''; $('nv-co').value = '';
  $('nv-tk').value = ''; $('nv-cs').value = ''; $('nv-lc').value = '';
  $('nv-ls').value = '';
  $('nv-pl').dataset.editPlate = '';
  openModal('m-nv');
}

function openEditVeh(plate) {
  const v = DATA.vehicles.find(x => x.plate === plate);
  if (!v) return;
  $('nv-modal-title').textContent = `✏️ Editar — ${plate}`;
  $('nv-pl').value = v.plate; $('nv-pl').disabled = true; // placa não muda
  $('nv-pl').dataset.editPlate = plate;
  $('nv-eq').value = v.equipment_id || '';
  $('nv-br').value = v.brand || '';
  $('nv-md').value = v.model || '';
  $('nv-tp').value = v.type || '4X4';
  $('nv-se').value = v.sector || 'OPERAÇÃO';
  $('nv-yr').value = v.year || '';
  $('nv-co').value = v.color || '';
  $('nv-ft').value = v.fuel_type || 'DIESEL';
  $('nv-tk').value = v.tank_capacity || '';
  $('nv-cs').value = v.avg_consumption || '';
  $('nv-lc').value = v.location || '';
  $('nv-ow').value = v.ownership || 'PROPRIO';
  $('nv-ls').value = v.lessor || '';
  openModal('m-nv');
}

async function saveVeh() {
  const editPlate = $('nv-pl').dataset.editPlate;
  const plate = editPlate || $('nv-pl').value.trim().toUpperCase();
  const model = $('nv-md').value.trim();
  if (!plate || !model) return notify('Placa e modelo são obrigatórios', 'warning');

  const body = {
    equipment_id: $('nv-eq').value.trim(), brand: $('nv-br').value.trim(),
    model, type: $('nv-tp').value, sector: $('nv-se').value,
    year: $('nv-yr').value, color: $('nv-co').value,
    fuel_type: $('nv-ft').value,
    tank_capacity: parseFloat($('nv-tk').value) || null,
    avg_consumption: parseFloat($('nv-cs').value) || null,
    location: $('nv-lc').value, ownership: $('nv-ow').value,
    lessor: $('nv-ls').value
  };

  loading(true);
  const res = editPlate
    ? await PUT(`/vehicles/${editPlate}`, body)
    : await POST('/vehicles', { plate, ...body });

  if (res?.success) {
    notify(editPlate ? `Veículo ${plate} atualizado!` : 'Veículo cadastrado!');
    closeModal('m-nv');
    const vehs = await GET('/vehicles');
    if (vehs) DATA.vehicles = vehs;
    renderVehicles();
    populateFormSelects();
  }
  loading(false);
}

async function delVeh(plate) {
  if (!confirm(`Excluir veículo ${plate}?`)) return;
  await DEL(`/vehicles/${plate}`);
  const vehs = await GET('/vehicles');
  if (vehs) DATA.vehicles = vehs;
  renderVehicles();
  notify('Veículo removido', 'warning');
}

// ══════════════════════════════════════════════════
// OPERADORES DE BOMBONA
// ══════════════════════════════════════════════════
let OPERATORS_DATA = [];

async function renderOperators() {
  if (!SESSION.isSup) return;
  const list = await GET('/operators');
  if (!list) return;
  OPERATORS_DATA = list;

  const rows = list.map(op => {
    const firstName = op.name.split(' ')[0].substring(0, 3).toUpperCase();
    const senha = firstName + 'EMPRESA';
    return `<tr>
      <td><code style="background:#F1F5F9;padding:2px 8px;border-radius:4px">${op.matricula}</code></td>
      <td><b>${op.name}</b></td>
      <td>${op.bombona_name ? `🛢️ ${op.bombona_name}` : '<span style="color:var(--text3)">—</span>'}</td>
      <td><code style="color:var(--orange);font-weight:700">${senha}</code></td>
      <td><span class="badge ${op.active ? 'b-signed' : 'b-inativo'}">${op.active ? '✅ Ativo' : '⛔ Inativo'}</span></td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="btn btn-xs ${op.active ? 'btn-warning' : 'btn-success'}" onclick="toggleOperator(${op.id},${op.active})">${op.active ? '⛔ Desativar' : '✅ Ativar'}</button>
          <button class="btn btn-outline btn-xs" onclick="resetOperatorPassword(${op.id},'${op.name}')" title="Resetar senha">🔑</button>
          <button class="btn btn-danger btn-xs" onclick="deleteOperator(${op.id})">🗑️</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  setHTML('tb-operators', rows || emptyRow(6, 'Nenhum operador cadastrado'));
}

function openNewOperator() {
  $('op-new-matricula').value = '';
  $('op-new-name').value = '';
  $('op-senha-preview').style.display = 'none';
  openModal('m-operator');

  // Preview de senha em tempo real
  const nameInput = $('op-new-name');
  nameInput.oninput = () => {
    const name = nameInput.value.trim().toUpperCase();
    if (name.length >= 1) {
      const prefix = name.split(' ')[0].substring(0, 3);
      const senha  = prefix + 'EMPRESA';
      $('op-senha-val').textContent = senha;
      $('op-senha-preview').style.display = 'block';
    } else {
      $('op-senha-preview').style.display = 'none';
    }
  };
}

async function saveOperator() {
  const matricula = $('op-new-matricula').value.trim().toUpperCase();
  const name      = $('op-new-name').value.trim().toUpperCase();
  if (!matricula) return notify('Informe a matrícula', 'warning');
  if (!name)      return notify('Informe o nome completo', 'warning');
  loading(true);
  const res = await POST('/operators', { matricula, name });
  if (res?.success) {
    notify(`✅ Operador cadastrado! Senha: ${res.password}`, 'success');
    closeModal('m-operator');
    renderOperators();
  }
  loading(false);
}

async function toggleOperator(id, active) {
  const res = await PUT(`/operators/${id}`, { active: !active });
  if (res?.success) {
    renderOperators();
    notify(active ? 'Operador desativado' : 'Operador ativado', active ? 'warning' : 'success');
  }
}

async function resetOperatorPassword(id, name) {
  if (!confirm(`Resetar senha de ${name} para o padrão?`)) return;
  const res = await POST(`/operators/${id}/reset-password`, {});
  if (res?.success) notify(`🔑 Senha resetada: ${res.password}`, 'success');
}

async function deleteOperator(id) {
  if (!confirm('Excluir este operador permanentemente?')) return;
  const res = await DEL(`/operators/${id}`);
  if (res?.success) { renderOperators(); notify('Operador removido', 'warning'); }
}

// ══════════════════════════════════════════════════
// POSTOS
// ══════════════════════════════════════════════════
function renderStations() {
  const cityF   = $('st-filter-city')?.value || '';
  const activeF = $('st-filter-active')?.value || '';
  let list = DATA.stations;
  if (cityF)   list = list.filter(s => s.city === cityF);
  if (activeF !== '') list = list.filter(s => String(s.active) === activeF);

  // Popula filtro de cidades
  const citySel = $('st-filter-city');
  if (citySel) {
    const cities = [...new Set(DATA.stations.map(s => s.city))].sort();
    const prev = citySel.value;
    citySel.innerHTML = '<option value="">Todas as cidades</option>';
    cities.forEach(c => citySel.innerHTML += `<option ${c===prev?'selected':''}>${c}</option>`);
  }

  const rows = list.map(s => `<tr>
    <td><b>${s.name}</b></td>
    <td>${s.city}</td>
    <td><span class="badge ${s.active?'b-signed':'b-inativo'}">${s.active?'✅ Ativo':'⛔ Inativo'}</span></td>
    <td>
      <div style="display:flex;gap:4px">
        <button class="btn btn-outline btn-xs" onclick="openEditStation(${s.id})">✏️</button>
        <button class="btn btn-xs ${s.active?'btn-warning':'btn-success'}" onclick="toggleStation(${s.id},${s.active})">${s.active?'⛔ Desativar':'✅ Ativar'}</button>
        <button class="btn btn-danger btn-xs" onclick="deleteStation(${s.id})">🗑️</button>
      </div>
    </td>
  </tr>`).join('');
  setHTML('tb-stations', rows || emptyRow(4, 'Nenhum posto cadastrado'));
}

function openNewStation() {
  $('station-modal-title').textContent = '⛽ Novo Posto';
  $('st-id').value = '';
  $('st-name').value = '';
  $('st-city').value = '';
  // Popula datalist de cidades existentes
  const dl = $('cities-list');
  if (dl) {
    const cities = [...new Set(DATA.stations.map(s => s.city))].sort();
    dl.innerHTML = cities.map(c => `<option value="${c}">`).join('');
  }
  openModal('m-station');
}

function openEditStation(id) {
  const s = DATA.stations.find(x => x.id === id);
  if (!s) return;
  $('station-modal-title').textContent = '✏️ Editar Posto';
  $('st-id').value = s.id;
  $('st-name').value = s.name;
  $('st-city').value = s.city;
  const dl = $('cities-list');
  if (dl) {
    const cities = [...new Set(DATA.stations.map(x => x.city))].sort();
    dl.innerHTML = cities.map(c => `<option value="${c}">`).join('');
  }
  openModal('m-station');
}

async function saveStation() {
  const id   = $('st-id').value;
  const name = $('st-name').value.trim();
  const city = $('st-city').value.trim();
  if (!name) return notify('Informe o nome do posto', 'warning');
  if (!city) return notify('Informe a cidade', 'warning');
  loading(true);
  const res = id
    ? await PUT(`/stations/${id}`, { name, city })
    : await POST('/stations', { name, city });
  if (res?.success) {
    notify(id ? 'Posto atualizado!' : 'Posto cadastrado!');
    closeModal('m-station');
    const stations = await GET('/stations');
    if (stations) DATA.stations = stations;
    renderStations();
    populateFormSelects();
  }
  loading(false);
}

async function toggleStation(id, active) {
  const res = await PUT(`/stations/${id}`, { active: !active });
  if (res?.success) {
    const stations = await GET('/stations');
    if (stations) DATA.stations = stations;
    renderStations();
    populateFormSelects();
    notify(active ? 'Posto desativado' : 'Posto ativado', active ? 'warning' : 'success');
  }
}

async function deleteStation(id) {
  if (!confirm('Excluir este posto permanentemente?')) return;
  const res = await DEL(`/stations/${id}`);
  if (res?.success) {
    const stations = await GET('/stations');
    if (stations) DATA.stations = stations;
    renderStations();
    populateFormSelects();
    notify('Posto removido', 'warning');
  }
}

// ══════════════════════════════════════════════════
// PREÇOS
// ══════════════════════════════════════════════════
function renderPrices() {
  const rows = Object.entries(DATA.prices).map(([t, p]) => `
    <tr>
      <td><b>${t}</b></td>
      <td style="font-size:1.1rem;font-weight:700;color:var(--green)">R$ ${Number(p).toFixed(2)}</td>
      <td style="color:var(--muted);font-size:.8rem">${new Date().toLocaleDateString('pt-BR')}</td>
      <td>${SESSION.isSup ? `<button class="btn btn-outline btn-xs" onclick="openPrices()">✏️ Editar</button>` : '—'}</td>
    </tr>`).join('');
  setHTML('tb-prices', rows || emptyRow(4, 'Nenhum preço cadastrado'));
}

function openPrices() {
  const body = $('prices-body');
  body.innerHTML = '<div class="form-grid">' + FUEL_TYPES.map(t => `
    <div class="fg">
      <label>${t}</label>
      <div style="position:relative">
        <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);font-weight:700">R$</span>
        <input type="number" id="pr-${t.replace(/\s/g,'_')}" step="0.01" min="0"
          value="${DATA.prices[t] || ''}" style="padding-left:36px" placeholder="0.00">
      </div>
    </div>`).join('') + '</div>';
  openModal('m-prices');
}

async function savePrices() {
  const updated = {};
  FUEL_TYPES.forEach(t => {
    const v = parseFloat($(`pr-${t.replace(/\s/g,'_')}`)?.value);
    if (v > 0) updated[t] = v;
  });
  loading(true);
  const res = await PUT('/fuel-prices', updated);
  if (res?.success) {
    Object.assign(DATA.prices, updated);
    notify('Preços atualizados!');
    closeModal('m-prices');
    renderPrices();
  }
  loading(false);
}

// ══════════════════════════════════════════════════
// CONSUMO
// ══════════════════════════════════════════════════
let CONS_DATA = [];
let BOMB_CONS_DATA = [];

async function loadConsumption() {
  loading(true);
  const [data, bombData] = await Promise.all([
    GET('/fuel-consumption'),
    GET('/bombona-consumption')
  ]);
  loading(false);
  CONS_DATA = data || [];
  BOMB_CONS_DATA = bombData || [];

  // Popula filtro de localidade (inclui localidades das bombonas também)
  const locs = [...new Set([
    ...CONS_DATA.map(d => d.location),
    ...BOMB_CONS_DATA.map(d => d.location)
  ].filter(Boolean))].sort();
  const locSel = $('cons-loc');
  if (locSel) {
    locSel.innerHTML = '<option value="">Todas localidades</option>';
    locs.forEach(l => locSel.innerHTML += `<option>${l}</option>`);
  }

  renderConsumption(CONS_DATA);
  renderBombonaConsumption(BOMB_CONS_DATA);
}

function filterConsumption() {
  const loc  = $('cons-loc')?.value || '';
  const type = $('cons-type')?.value || '';
  const perf = $('cons-perf')?.value || '';
  let data = CONS_DATA;
  if (loc)  data = data.filter(d => (d.location || '') === loc);
  if (type) data = data.filter(d => (d.vehicle_type || '').toUpperCase() === type.toUpperCase());
  if (perf === 'ok')  data = data.filter(d => d.avg_consumption >= 8);
  if (perf === 'med') data = data.filter(d => d.avg_consumption >= 6 && d.avg_consumption < 8);
  if (perf === 'bad') data = data.filter(d => d.avg_consumption < 6);
  renderConsumption(data);
}

function switchConsTab(tab) {
  ['veh','loc','drv','bomb'].forEach(t => {
    $(`tab-${t}`)?.classList.toggle('active', t === tab);
    $(`cons-panel-${t}`)?.classList.toggle('hidden', t !== tab);
  });
}

function renderConsumption(data) {
  // Stats
  const good = data.filter(d => d.avg_consumption >= 8).length;
  const ok   = data.filter(d => d.avg_consumption >= 6 && d.avg_consumption < 8).length;
  const bad  = data.filter(d => d.avg_consumption < 6).length;
  // totalL calculado dentro do bloco vehMap (por veículo único)
  // mantido aqui como fallback se data vazio
  const _totalLFallback = data.reduce((s, d) => s + (parseFloat(d.liters_used)||0), 0);
  const _totalLBombFallback = BOMB_CONS_DATA.reduce((s, d) => s + parseFloat(d.total_transferred||0), 0);
  // Stats agora calculados por veículo único dentro do bloco vehMap abaixo
  // (mantido aqui só para o caso de data estar vazio antes de chegar lá)
  const _veiculosDistintosFallback = new Set(data.map(d => d.plate).filter(Boolean)).size;
  setHTML('cons-stats', `
    <div class="sc signed"><span class="si">🟢</span><span class="sn">${good}</span><span class="sl">Excelente (≥8 km/L)</span></div>
    <div class="sc completed"><span class="si">🟡</span><span class="sn">${ok}</span><span class="sl">Bom (6–8 km/L)</span></div>
    <div class="sc rejected"><span class="si">🔴</span><span class="sn">${bad}</span><span class="sl">Atenção (&lt;6 km/L)</span></div>
    <div class="sc total"><span class="si">⛽</span><span class="sn">${totalL.toFixed(0)}</span><span class="sl">Litros c/ KM ⓘ</span></div>
    <div class="sc total"><span class="si">🛢️</span><span class="sn">${totalLBomb.toFixed(0)}</span><span class="sl">Litros (Bombonas)</span></div>
    <div class="sc total"><span class="si">🚗</span><span class="sn">${veiculosDistintos}</span><span class="sl">Veículos com Dados</span></div>`);

  // ── Aba Veículo: agrupa intervalos por placa ─────────────────────────────
  // Monta 1 linha resumo por veículo com média ACUMULADA (km_total / litros_total)
  // que é a média ponderada real — não média aritmética de médias.
  // Ao clicar na linha, expande o histórico de intervalos inline.
  const vehMap = {};
  data.forEach(d => {
    const p = d.plate;
    if (!vehMap[p]) {
      const vRef = DATA.vehicles.find(v => v.plate === p);
      vehMap[p] = {
        plate: p, vehicle: d.vehicle, type: d.vehicle_type, location: d.location,
        equipId: vRef?.equipment_id || '—',
        km_total: 0, litros_total: 0, custo_total: 0,
        ultimo_km: 0, ultimo_abast: '', ultimo_driver: d.driver,
        intervalos: []
      };
    }
    const v = vehMap[p];
    v.km_total     += parseFloat(d.km_driven || 0);
    v.litros_total += parseFloat(d.liters_used || 0);
    v.custo_total  += parseFloat((d.real_value || '').toString().replace(/[^\d.]/g, '')) || 0;
    if (!v.ultimo_abast || d.current_date > v.ultimo_abast) {
      v.ultimo_abast  = d.current_date;
      v.ultimo_km     = d.current_km;
      v.ultimo_driver = d.driver;
    }
    v.intervalos.push(d);
  });

  // Ordena intervalos de cada veículo: mais recente primeiro
  Object.values(vehMap).forEach(v => {
    v.intervalos.sort((a, b) => b.current_date > a.current_date ? 1 : -1);
  });

  // Ordena veículos por média acumulada (pior primeiro para chamar atenção)
  const vehList = Object.values(vehMap).sort((a, b) => {
    const ma = a.km_total > 0 && a.litros_total > 0 ? a.km_total / a.litros_total : 999;
    const mb = b.km_total > 0 && b.litros_total > 0 ? b.km_total / b.litros_total : 999;
    return ma - mb; // piores primeiro
  });

  // Recalcula good/ok/bad por VEÍCULO (média acumulada), não por intervalo
  let goodV = 0, okV = 0, badV = 0;
  vehList.forEach(v => {
    const m = v.km_total > 0 && v.litros_total > 0 ? v.km_total / v.litros_total : 0;
    if (m >= 8) goodV++; else if (m >= 6) okV++; else if (m > 0) badV++;
  });
  // Atualiza os cards com contagem por veículo
  const veiculosDistintos = vehList.length;
  const totalL    = vehList.reduce((s, v) => s + v.litros_total, 0);
  const totalLBomb = BOMB_CONS_DATA.reduce((s, d) => s + parseFloat(d.total_transferred || 0), 0);
  setHTML('cons-stats', `
    <div class="sc signed"><span class="si">🟢</span><span class="sn">\${goodV}</span><span class="sl">Excelente (≥8 km/L)</span></div>
    <div class="sc completed"><span class="si">🟡</span><span class="sn">\${okV}</span><span class="sl">Bom (6–8 km/L)</span></div>
    <div class="sc rejected"><span class="si">🔴</span><span class="sn">\${badV}</span><span class="sl">Atenção (&lt;6 km/L)</span></div>
    <div class="sc total"><span class="si">⛽</span><span class="sn">\${totalL.toFixed(0)}</span><span class="sl">Litros c/ KM ⓘ</span></div>
    <div class="sc total"><span class="si">🛢️</span><span class="sn">\${totalLBomb.toFixed(0)}</span><span class="sl">Litros (Bombonas)</span></div>
    <div class="sc total"><span class="si">🚗</span><span class="sn">\${veiculosDistintos}</span><span class="sl">Veículos com Dados</span></div>`);

  const vehRows = vehList.map(v => {
    const media  = v.km_total > 0 && v.litros_total > 0 ? (v.km_total / v.litros_total).toFixed(1) : null;
    const color  = media >= 8 ? 'var(--green)' : media >= 6 ? 'var(--yellow)' : 'var(--red)';
    const perf   = media >= 8 ? '🟢 Excelente' : media >= 6 ? '🟡 Bom' : media ? '🔴 Atenção' : '—';
    const cpk    = v.km_total > 0 && v.custo_total > 0 ? (v.custo_total / v.km_total).toFixed(3) : null;
    const nInt   = v.intervalos.length;
    // Linha resumo do veículo
    const resumoRow = `<tr class="veh-resumo-row" style="cursor:pointer" onclick="toggleVehDetalhes('\${v.plate}', this)">
      <td><b style="color:var(--orange)">\${v.equipId}</b></td>
      <td><code>\${v.plate}</code></td>
      <td style="font-size:.82rem">\${(v.vehicle || '').substring(0,22)}</td>
      <td>\${v.type ? typeBadge(v.type) : '—'}</td>
      <td>\${v.location || '—'}</td>
      <td style="font-size:.82rem">\${shortName(v.ultimo_driver)}</td>
      <td style="font-size:.8rem">\${fmtDate(v.ultimo_abast)}</td>
      <td>\${v.ultimo_km ? Number(v.ultimo_km).toLocaleString('pt-BR') + ' km' : '—'}</td>
      <td style="font-weight:700">\${v.km_total > 0 ? v.km_total.toLocaleString('pt-BR') + ' km' : '—'}</td>
      <td style="font-weight:700">\${v.litros_total.toFixed(0)} L</td>
      <td style="font-size:1.15rem;font-weight:800;color:\${color}">\${media ? media + ' km/L' : '—'}</td>
      <td>\${perf}</td>
      <td style="color:var(--text3)">\${cpk ? 'R$ ' + cpk + '/km' : '—'}</td>
      <td style="font-weight:700;color:var(--green)">\${v.custo_total > 0 ? v.custo_total.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) : '—'}</td>
      <td style="color:var(--text3);font-size:.75rem;white-space:nowrap">\${nInt} abast. ▶</td>
    </tr>`;

    // Linhas de detalhe (ocultas, expandem ao clicar)
    const detalheRows = v.intervalos.map((d, i) => {
      const mc = d.avg_consumption >= 8 ? 'var(--green)' : d.avg_consumption >= 6 ? 'var(--yellow)' : d.avg_consumption ? 'var(--red)' : 'var(--text3)';
      return `<tr class="veh-detalhe-row veh-det-\${v.plate.replace(/[^a-zA-Z0-9]/g,'_')}" style="display:none;background:rgba(255,255,255,0.03)">
        <td colspan="2" style="font-size:.72rem;color:var(--text3);padding-left:28px">↳ Abast. \${i+1}/\${nInt}</td>
        <td colspan="2" style="font-size:.78rem">\${fmtDate(d.current_date)}</td>
        <td colspan="2" style="font-size:.78rem">\${shortName(d.driver)}</td>
        <td style="font-size:.78rem">\${fmtDate(d.previous_date) || '—'}</td>
        <td style="font-size:.78rem">\${d.previous_km ? Number(d.previous_km).toLocaleString('pt-BR') + ' km' : '—'} → \${d.current_km ? Number(d.current_km).toLocaleString('pt-BR') + ' km' : '—'}</td>
        <td style="font-size:.78rem">\${d.km_driven ? Number(d.km_driven).toLocaleString('pt-BR') + ' km' : '—'}</td>
        <td style="font-size:.78rem">\${parseFloat(d.liters_used || 0).toFixed(1)} L</td>
        <td style="font-weight:700;color:\${mc}">\${d.avg_consumption ? d.avg_consumption + ' km/L' : '—'}</td>
        <td colspan="2" style="font-size:.78rem">\${d.gas_station || '—'}</td>
        <td style="font-size:.78rem;color:var(--green)">\${d.real_value || '—'}</td>
        <td></td>
      </tr>`;
    }).join('');

    return resumoRow + detalheRows;
  }).join('');

  setHTML('tb-cons-veh', vehRows || emptyRow(15, 'Nenhum dado. Realize abastecimentos com KM registrado.'));

  // Aba Localidade — agrupa por localidade (location vem da API)
  const byLoc = {};
  data.forEach(d => {
    const loc = d.location || 'Sem localidade';
    if (!byLoc[loc]) byLoc[loc] = { veiculos: new Set(), km: 0, litros: 0, good: 0, ok: 0, bad: 0 };
    byLoc[loc].veiculos.add(d.plate);
    byLoc[loc].km     += parseFloat(d.km_driven || 0);
    byLoc[loc].litros += parseFloat(d.liters_used || 0);
    if (d.avg_consumption >= 8) byLoc[loc].good++;
    else if (d.avg_consumption >= 6) byLoc[loc].ok++;
    else byLoc[loc].bad++;
  });
  // Custo por localidade — usa real_value da conclusão (campo já vem do fuel-consumption)
  const locCustoReal = {};
  data.forEach(d => {
    const loc = d.location || 'Sem localidade';
    if (!locCustoReal[loc]) locCustoReal[loc] = 0;
    // real_value vem da requisição concluída — ex: "R$ 334.50"
    // parseFloat para extrair o número
    const rv = parseFloat((d.real_value || '').toString().replace(/[^\d.]/g, '')) || 0;
    locCustoReal[loc] += rv;
  });

  const locRows = Object.entries(byLoc).sort((a,b) => b[1].litros - a[1].litros).map(([loc, d]) => {
    const media = d.litros > 0 ? (d.km / d.litros).toFixed(1) : '—';
    const custo = (locCustoReal[loc] || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
    const mediaColor = parseFloat(media) >= 8 ? 'var(--green)' : parseFloat(media) >= 6 ? 'var(--yellow)' : 'var(--red)';
    return `<tr>
      <td><b style="color:var(--text)">${loc}</b></td>
      <td><b style="color:var(--orange)">${d.veiculos.size}</b></td>
      <td>${d.km.toLocaleString('pt-BR')} km</td>
      <td>${d.litros.toFixed(1)} L</td>
      <td style="font-size:1.1rem;font-weight:800;color:${mediaColor}">${media} km/L</td>
      <td><span class="badge b-signed">🟢 ${d.good}</span></td>
      <td><span class="badge b-pending">🟡 ${d.ok}</span></td>
      <td><span class="badge b-rejected">🔴 ${d.bad}</span></td>
      <td style="font-weight:700;color:var(--green)">${custo}</td>
    </tr>`;
  }).join('');
  setHTML('tb-cons-loc', locRows || emptyRow(9, 'Nenhum dado por localidade disponível.'));

  // Aba Motorista — agrupa abastecimentos por motorista
  // Aba Motorista — usa CONS_DATA como fonte única para garantir que
  // km e litros estejam sempre no mesmo intervalo (entre dois abastecimentos consecutivos)
  // Evita misturar litros de abastecimentos sem KM no cálculo de km/L
  const byDrv = {};
  data.forEach(d => {
    if (!d.driver) return;
    const drv = d.driver;
    if (!byDrv[drv]) byDrv[drv] = { count:0, litros:0, km:0, custo:0, veiculos:new Set() };
    byDrv[drv].count++;
    byDrv[drv].litros += parseFloat(d.liters_used || 0);
    byDrv[drv].km     += parseFloat(d.km_driven || 0);
    // custo real da conclusão
    byDrv[drv].custo  += parseFloat((d.real_value || '').toString().replace(/[^\d.]/g, '')) || 0;
    if (d.vehicle) byDrv[drv].veiculos.add(d.vehicle);
  });
  const drvRows = Object.entries(byDrv).sort((a,b) => b[1].custo - a[1].custo).map(([drv, d]) => {
    const media = d.litros > 0 && d.km > 0 ? (d.km / d.litros).toFixed(1) : '—';
    const perf  = parseFloat(media) >= 8 ? '🟢 Excelente' : parseFloat(media) >= 6 ? '🟡 Bom' : media === '—' ? '—' : '🔴 Atenção';
    const color = parseFloat(media) >= 8 ? 'var(--green)' : parseFloat(media) >= 6 ? 'var(--yellow)' : 'var(--red)';
    const cpk   = d.km > 0 && d.custo > 0 ? (d.custo / d.km).toFixed(3) : '—';
    return `<tr>
      <td><b>${shortName(drv)}</b><br><small style="color:var(--text3);font-size:.72rem">${drv}</small></td>
      <td><b style="color:var(--orange)">${d.count}</b></td>
      <td>${d.litros.toFixed(1)} L</td>
      <td>${d.km > 0 ? d.km.toLocaleString('pt-BR') + ' km' : '—'}</td>
      <td style="font-size:1.1rem;font-weight:800;color:${color}">${media}${media !== '—' ? ' km/L' : ''}</td>
      <td style="font-size:.82rem">${[...d.veiculos].slice(0,3).join(', ')}${d.veiculos.size > 3 ? ` +${d.veiculos.size-3}` : ''}</td>
      <td>${perf}</td>
      <td style="font-weight:700;color:var(--green)">${d.custo > 0 ? d.custo.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) : '—'}</td>
      <td style="color:var(--text3)">${cpk !== '—' ? 'R$ '+cpk+'/km' : '—'}</td>
    </tr>`;
  }).join('');
  setHTML('tb-cons-drv', drvRows || emptyRow(7, 'Nenhum abastecimento concluído registrado.'));

  // Gráficos
  renderConsCharts(data);
}

function renderBombonaConsumption(bombonas) {
  // Ordena por total transferido (mais consumidas primeiro)
  const sorted = [...bombonas].sort((a,b) => parseFloat(b.total_transferred) - parseFloat(a.total_transferred));

  // Apenas bombonas com transferências para os gráficos
  const comTransf = sorted.filter(b => parseFloat(b.total_transferred || 0) > 0);

  const rows = sorted.map(b => {
    const pct      = b.capacity_liters > 0 ? (parseFloat(b.current_liters) / parseFloat(b.capacity_liters) * 100) : 0;
    const pctColor = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
    const statusBg = b.status === 'Ativa' ? 'b-signed' : 'b-rejected';
    const total30  = parseFloat(b.transferred_30d || 0);
    const total7   = parseFloat(b.transferred_7d || 0);
    const totalAll = parseFloat(b.total_transferred || 0);
    return `<tr>
      <td><b style="color:var(--orange)">${b.name}</b></td>
      <td>${b.fuel_type}</td>
      <td>${b.location || '—'}</td>
      <td style="font-size:.82rem">${shortName(b.responsible_driver)}</td>
      <td><span class="badge ${statusBg}">${b.status}</span></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;background:rgba(255,255,255,0.08);border-radius:4px;height:8px;min-width:60px">
            <div style="width:${Math.min(pct,100).toFixed(0)}%;height:8px;border-radius:4px;background:${pctColor};transition:width .3s"></div>
          </div>
          <span style="font-size:.82rem;white-space:nowrap;color:${pctColor}">${parseFloat(b.current_liters).toFixed(0)}/${parseFloat(b.capacity_liters).toFixed(0)} L</span>
        </div>
      </td>
      <td><b style="color:var(--orange)">${totalAll.toFixed(0)} L</b></td>
      <td>${total30.toFixed(0)} L</td>
      <td>${total7.toFixed(0)} L</td>
      <td><b style="color:var(--text2)">${b.transfer_count || 0}</b></td>
      <td>${b.last_transfer_date ? fmtDate(b.last_transfer_date) : '—'}</td>
    </tr>`;
  }).join('');

  const emptyMsg = comTransf.length === 0
    ? emptyRow(11, 'Nenhuma bombona com transferências registradas.')
    : '';
  setHTML('tb-cons-bomb', rows || emptyMsg);

  // Gráficos — só passa bombonas que têm transferências
  renderBombonaConsCharts(comTransf);
}

// ══════════════════════════════════════════════════
// GRÁFICOS — Chart.js
// ══════════════════════════════════════════════════
const CHARTS = {}; // cache de instâncias

const CHART_COLORS = {
  orange:  'rgba(247,147,30,0.85)',
  orange2: 'rgba(247,147,30,0.35)',
  green:   'rgba(34,197,94,0.85)',
  green2:  'rgba(34,197,94,0.35)',
  red:     'rgba(239,68,68,0.85)',
  red2:    'rgba(239,68,68,0.35)',
  yellow:  'rgba(245,158,11,0.85)',
  blue:    'rgba(59,130,246,0.85)',
  purple:  'rgba(168,85,247,0.85)',
  teal:    'rgba(20,184,166,0.85)',
  pink:    'rgba(236,72,153,0.85)',
};

const PALETTE = [
  '#F7931E','#22C55E','#3B82F6','#A855F7','#EF4444',
  '#F59E0B','#14B8A6','#EC4899','#6366F1','#84CC16',
];

function makeChart(id, type, data, extraOpts = {}) {
  if (typeof Chart === 'undefined') { console.warn('Chart.js não carregado ainda'); return; }
  const canvas = $(id);
  if (!canvas) { console.warn('Canvas não encontrado:', id); return; }
  if (CHARTS[id]) { try { CHARTS[id].destroy(); } catch(e){} delete CHARTS[id]; }

  // Dados vazios — mostra placeholder
  const hasData = data.datasets?.some(ds => ds.data?.some(v => parseFloat(v) > 0));
  if (!hasData) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.height = 80;
    ctx.fillStyle = '#444';
    ctx.font = '13px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem dados suficientes', canvas.width / 2, 44);
    return;
  }

  const baseOpts = {
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 500 },
    plugins: {
      legend: { labels: { color: '#AAAAAA', font: { size: 12 }, padding: 14, boxWidth: 14 } },
      tooltip: {
        backgroundColor: '#222222', borderColor: 'rgba(247,147,30,0.3)', borderWidth: 1,
        titleColor: '#F0F0F0', bodyColor: '#AAAAAA', padding: 10,
      }
    },
    scales: {
      x: { ticks: { color: '#666666', font:{size:11} }, grid: { color: 'rgba(255,255,255,0.04)' } },
      y: { ticks: { color: '#666666', font:{size:11} }, grid: { color: 'rgba(255,255,255,0.07)' }, beginAtZero: true }
    }
  };
  if (type === 'doughnut' || type === 'pie') delete baseOpts.scales;

  // Deep merge extraOpts
  const merged = deepMerge(baseOpts, extraOpts);
  try {
    CHARTS[id] = new Chart(canvas, { type, data, options: merged });
  } catch(e) { console.warn('Chart error:', id, e.message); }
}

function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ── Gráficos da tela de Consumo ──────────────────
function renderConsCharts(data) {
  // 1. Litros por Localidade (bar)
  const byLoc = {};
  data.forEach(d => {
    const veh = DATA.vehicles.find(v => v.plate === d.plate);
    const loc = d.location || veh?.location || 'Outros';
    byLoc[loc] = (byLoc[loc] || 0) + parseFloat(d.liters_used || 0);
  });
  const locLabels = Object.keys(byLoc).sort((a,b) => byLoc[b]-byLoc[a]).slice(0,10);
  makeChart('chart-cons-loc', 'bar', {
    labels: locLabels,
    datasets: [{ label:'Litros', data: locLabels.map(l => byLoc[l].toFixed(1)),
      backgroundColor: PALETTE, borderRadius: 6, borderSkipped: false }]
  }, { plugins: { legend: { display: false } } });

  // 2. Performance da Frota (doughnut)
  const good = data.filter(d => d.avg_consumption >= 8).length;
  const ok   = data.filter(d => d.avg_consumption >= 6 && d.avg_consumption < 8).length;
  const bad  = data.filter(d => d.avg_consumption < 6).length;
  makeChart('chart-cons-perf', 'doughnut', {
    labels: ['🟢 Excelente (≥8)', '🟡 Bom (6–8)', '🔴 Atenção (<6)'],
    datasets: [{ data: [good, ok, bad],
      backgroundColor: [CHART_COLORS.green, CHART_COLORS.yellow, CHART_COLORS.red],
      borderColor: '#111111', borderWidth: 3, hoverOffset: 8 }]
  });

  // 3. Top veículos por km/L (horizontal bar) — label: Modelo (Placa)
  const top = [...data].sort((a,b) => b.avg_consumption - a.avg_consumption).slice(0,10);
  makeChart('chart-cons-veh', 'bar', {
    labels: top.map(d => {
      const veh = DATA.vehicles.find(v => v.plate === d.plate);
      const modelo = (veh?.model || d.vehicle || '').replace(/ - .*/,'').substring(0,18);
      return `${modelo} (${d.plate})`;
    }),
    datasets: [{ label:'km/L', data: top.map(d => d.avg_consumption),
      backgroundColor: top.map(d => d.avg_consumption >= 8 ? CHART_COLORS.green : d.avg_consumption >= 6 ? CHART_COLORS.yellow : CHART_COLORS.red),
      borderRadius: 6, borderSkipped: false }]
  }, {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: { ticks:{color:'#666'}, grid:{color:'rgba(255,255,255,0.07)'} }, y: { ticks:{color:'#AAA',font:{size:11}}, grid:{color:'rgba(255,255,255,0.04)'} } }
  });

  // 4. Top motoristas por litros (bar)
  // Gráfico Motorista — usa CONS_DATA (mesma fonte da tabela) para consistência
  const byDrvChart = {};
  data.forEach(d => {
    if (!d.driver) return;
    const n = shortName(d.driver);
    byDrvChart[n] = (byDrvChart[n] || 0) + parseFloat(d.liters_used || 0);
  });
  const drvLabels = Object.keys(byDrvChart).sort((a,b) => byDrvChart[b]-byDrvChart[a]).slice(0,10);
  makeChart('chart-cons-drv', 'bar', {
    labels: drvLabels,
    datasets: [{ label:'Litros', data: drvLabels.map(l => byDrvChart[l].toFixed(1)),
      backgroundColor: PALETTE, borderRadius: 6, borderSkipped: false }]
  }, {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: { ticks:{color:'#666'}, grid:{color:'rgba(255,255,255,0.07)'} }, y: { ticks:{color:'#AAA',font:{size:11}}, grid:{color:'rgba(255,255,255,0.04)'} } }
  });
}

// ── Gráficos de Bombonas (aba Consumo) ───────────
function renderBombonaConsCharts(bombonas) {
  if (!bombonas.length) return; // sem dados, não tenta renderizar

  // 1. Top bombonas por total transferido (bar horizontal)
  const top = bombonas.slice(0, 10);
  makeChart('chart-bomb-total', 'bar', {
    labels: top.map(b => b.name),
    datasets: [{ label:'Litros Transferidos', data: top.map(b => parseFloat(b.total_transferred||0)),
      backgroundColor: PALETTE, borderRadius: 6, borderSkipped: false }]
  }, {
    indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw.toFixed(1)} L` } } },
    scales: { x: { ticks:{color:'#666'}, grid:{color:'rgba(255,255,255,0.07)'} }, y: { ticks:{color:'#AAA',font:{size:11}}, grid:{color:'rgba(255,255,255,0.04)'} } }
  });

  // 2. Saldo atual vs capacidade (bar agrupado)
  makeChart('chart-bomb-saldo', 'bar', {
    labels: bombonas.map(b => b.name),
    datasets: [
      { label:'Saldo Atual (L)', data: bombonas.map(b => parseFloat(b.current_liters||0)),
        backgroundColor: bombonas.map(b => {
          const pct = b.capacity_liters > 0 ? parseFloat(b.current_liters)/parseFloat(b.capacity_liters) : 0;
          return pct > 0.5 ? CHART_COLORS.green : pct > 0.2 ? CHART_COLORS.yellow : CHART_COLORS.red;
        }),
        borderRadius: 4, borderSkipped: false },
      { label:'Capacidade Total (L)', data: bombonas.map(b => parseFloat(b.capacity_liters||0)),
        backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 4, borderSkipped: false }
    ]
  }, {
    plugins: { legend: { labels: { color:'#AAA', font:{size:11} } }, tooltip: { callbacks: { label: ctx => `${ctx.raw.toFixed(0)} L` } } },
    scales: { x: { stacked: false, ticks:{color:'#666'}, grid:{color:'rgba(255,255,255,0.07)'} }, y: { ticks:{color:'#AAA',font:{size:11}}, grid:{color:'rgba(255,255,255,0.04)'} } }
  });

  // 3. Consumo 30d vs 7d (bar agrupado)
  makeChart('chart-bomb-period', 'bar', {
    labels: top.map(b => b.name),
    datasets: [
      { label:'Últimos 30 dias (L)', data: top.map(b => parseFloat(b.transferred_30d||0)),
        backgroundColor: CHART_COLORS.orange, borderRadius: 4, borderSkipped: false },
      { label:'Últimos 7 dias (L)',  data: top.map(b => parseFloat(b.transferred_7d||0)),
        backgroundColor: CHART_COLORS.blue,   borderRadius: 4, borderSkipped: false }
    ]
  }, {
    plugins: { legend: { labels: { color:'#AAA', font:{size:11} } }, tooltip: { callbacks: { label: ctx => `${ctx.raw.toFixed(1)} L` } } },
    scales: { x: { ticks:{color:'#666'}, grid:{color:'rgba(255,255,255,0.07)'} }, y: { ticks:{color:'#AAA',font:{size:11}}, grid:{color:'rgba(255,255,255,0.04)'} } }
  });

  // 4. N° de transferências por bombona (doughnut)
  makeChart('chart-bomb-count', 'doughnut', {
    labels: bombonas.map(b => b.name),
    datasets: [{ data: bombonas.map(b => parseInt(b.transfer_count||0)),
      backgroundColor: PALETTE.slice(0, bombonas.length),
      borderColor: '#111111', borderWidth: 3, hoverOffset: 8 }]
  });
}

// ── Histórico de Saldo de Bombona ─────────────────
async function openBombonaHistory(bombonaId, bombonaName) {
  loading(true);
  const data = await GET(`/bombona-saldo-history/${bombonaId}`);
  loading(false);
  if (!data) return notify('Erro ao carregar histórico', 'error');

  const rows = data.map(h => {
    const variacao = h.variacao >= 0
      ? `<span style="color:var(--green)">+${h.variacao.toFixed(1)} L</span>`
      : `<span style="color:var(--red)">${h.variacao.toFixed(1)} L</span>`;
    const tipoColor = h.tipo.includes('ABASTECIMENTO') ? 'b-signed' : 'b-pending';
    return `<tr>
      <td>${fmtDateTime(h.created_at)}</td>
      <td><span class="badge ${tipoColor}" style="font-size:.7rem">${h.tipo}</span></td>
      <td>${h.saldo_anterior.toFixed(0)} L</td>
      <td>${variacao}</td>
      <td><b>${h.saldo_novo.toFixed(0)} L</b></td>
      <td style="font-size:.78rem">${h.referencia || '—'}</td>
      <td style="font-size:.78rem">${shortName(h.actor) || '—'}</td>
    </tr>`;
  }).join('');

  $('v-title').textContent = `📊 Histórico de Saldo — ${bombonaName}`;
  setHTML('v-body', `
    <div style="margin-bottom:12px;font-size:.85rem;color:var(--text3)">Evolução do saldo ao longo do tempo</div>
    <div class="tw"><table>
      <thead><tr>
        <th>Data/Hora</th><th>Tipo</th><th>Saldo Anterior</th><th>Variação</th>
        <th>Saldo Novo</th><th>Referência</th><th>Responsável</th>
      </tr></thead>
      <tbody>${rows || emptyRow(7, 'Nenhum histórico registrado ainda.')}</tbody>
    </table></div>`);
  $('v-pdf')?.classList.add('hidden');
  openModal('m-view');
}
function renderReportCharts(data) {
  $('rp-charts')?.classList.remove('hidden');

  // 1. Requisições por dia (line)
  const byDay = {};
  data.forEach(r => {
    const d = (r.date || '').split('T')[0];
    if (d) byDay[d] = (byDay[d] || 0) + 1;
  });
  const dayKeys = Object.keys(byDay).sort().slice(-30); // últimos 30 dias
  makeChart('chart-rp-timeline', 'line', {
    labels: dayKeys.map(d => fmtDate(d)),
    datasets: [{ label:'Requisições', data: dayKeys.map(k => byDay[k]),
      borderColor: CHART_COLORS.orange, backgroundColor: CHART_COLORS.orange2,
      fill: true, tension: 0.4, pointBackgroundColor: CHART_COLORS.orange,
      pointRadius: 4, pointHoverRadius: 7 }]
  });

  // 2. Status (doughnut)
  const statusCount = { pending:0, signed:0, completed:0, rejected:0 };
  data.forEach(r => { if (statusCount[r.status] !== undefined) statusCount[r.status]++; });
  makeChart('chart-rp-status', 'doughnut', {
    labels: ['⏳ Pendente','✅ Aprovada','✔️ Concluída','❌ Rejeitada'],
    datasets: [{ data: [statusCount.pending, statusCount.signed, statusCount.completed, statusCount.rejected],
      backgroundColor: [CHART_COLORS.yellow, CHART_COLORS.green, CHART_COLORS.blue, CHART_COLORS.red],
      borderColor: '#111111', borderWidth: 3, hoverOffset: 8 }]
  });

  // 3. Top motoristas por litros (bar horizontal) — limpa campo TEXT "50.0 L"
  const byDrv = {};
  data.filter(r => r.status === 'completed' && r.fuel_method !== 'bombona').forEach(r => {
    const n = shortName(r.driver);
    // Extrai número do campo TEXT "50.0 L", "50 L", etc.
    const l = parseFloat((r.liters||'').replace(/[^\d.]/g,'')) || 0;
    byDrv[n] = (byDrv[n] || 0) + l;
  });
  const drvKeys = Object.keys(byDrv).sort((a,b) => byDrv[b]-byDrv[a]).slice(0,10);
  makeChart('chart-rp-drivers', 'bar', {
    labels: drvKeys,
    datasets: [{ label:'Litros', data: drvKeys.map(k => byDrv[k].toFixed(1)),
      backgroundColor: PALETTE, borderRadius: 6, borderSkipped: false }]
  }, {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { x: { ticks:{color:'#666'}, grid:{color:'rgba(255,255,255,0.07)'} }, y: { ticks:{color:'#AAA',font:{size:11}}, grid:{color:'rgba(255,255,255,0.04)'} } }
  });

  // 4. Por combustível (pie)
  const byFuel = {};
  data.forEach(r => { const f = r.fuel_type||'Outros'; byFuel[f] = (byFuel[f]||0)+1; });
  const fuelKeys = Object.keys(byFuel);
  makeChart('chart-rp-fuel', 'pie', {
    labels: fuelKeys,
    datasets: [{ data: fuelKeys.map(k => byFuel[k]),
      backgroundColor: PALETTE.slice(0, fuelKeys.length),
      borderColor: '#111111', borderWidth: 3, hoverOffset: 6 }]
  });

  // 5. Por cidade (bar)
  const byCity = {};
  data.forEach(r => { const c = r.city||'Outros'; byCity[c] = (byCity[c]||0)+1; });
  const cityKeys = Object.keys(byCity).sort((a,b) => byCity[b]-byCity[a]).slice(0,10);
  makeChart('chart-rp-city', 'bar', {
    labels: cityKeys,
    datasets: [{ label:'Requisições', data: cityKeys.map(k => byCity[k]),
      backgroundColor: cityKeys.map((_,i) => PALETTE[i % PALETTE.length]),
      borderRadius: 6, borderSkipped: false }]
  }, { plugins: { legend: { display: false } } });

  // 6. Custo por semana (bar — soma valores reais)
  const byWeek = {};
  data.filter(r => r.real_value).forEach(r => {
    const d = new Date(r.date);
    const start = new Date(d); start.setDate(d.getDate() - d.getDay());
    const wk = start.toISOString().split('T')[0];
    const val = parseFloat((r.real_value||'').replace(/[^\d.,]/g,'').replace(',','.')) || 0;
    byWeek[wk] = (byWeek[wk]||0) + val;
  });
  const wkKeys = Object.keys(byWeek).sort().slice(-10);
  makeChart('chart-rp-cost', 'bar', {
    labels: wkKeys.map(d => `Sem. ${fmtDate(d)}`),
    datasets: [{ label:'Custo (R$)', data: wkKeys.map(k => byWeek[k].toFixed(2)),
      backgroundColor: CHART_COLORS.orange2,
      borderColor: CHART_COLORS.orange,
      borderWidth: 2, borderRadius: 6, borderSkipped: false }]
  }, {
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => `R$ ${Number(ctx.raw).toLocaleString('pt-BR', {minimumFractionDigits:2})}` } }
    }
  });
}

// ══════════════════════════════════════════════════
// RELATÓRIO MENSAL CONSOLIDADO + CPK
// ══════════════════════════════════════════════════
let RELATORIO_MENSAL_DATA = null;

async function gerarRelatorioMensal() {
  const ano = $('rm-ano')?.value || new Date().getFullYear();
  const mes = $('rm-mes')?.value || (new Date().getMonth() + 1);
  loading(true);
  const data = await GET(`/relatorio-mensal?ano=${ano}&mes=${mes}`);
  loading(false);
  if (!data) return;
  RELATORIO_MENSAL_DATA = data;

  const nomeMes = new Date(ano, mes-1, 1).toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
  const g = data.geral;

  // Cards de totais — FIX: separar frota e bombona
  const custoFrota  = parseFloat(g.custo_frota||g.custo_total||0);
  const custoBomb   = parseFloat(g.custo_bombona||0);
  const litrosFrota = parseFloat(g.litros_total||0);
  const litrosBomb  = parseFloat(g.litros_bombona_abastecida||0);
  setHTML('rm-cards', `
    <div class="sc total"><span class="si">💰</span>
      <span class="sn" style="font-size:.9rem">${(custoFrota+custoBomb).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</span>
      <span class="sl">Custo Total</span>
      <span style="font-size:.68rem;color:var(--text3);display:block;margin-top:2px">Frota: ${custoFrota.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} · Bombonas: ${custoBomb.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</span>
    </div>
    <div class="sc signed"><span class="si">⛽</span>
      <span class="sn">${litrosFrota.toFixed(0)} L</span>
      <span class="sl">Litros Frota (posto)</span>
      ${litrosBomb > 0 ? `<span style="font-size:.68rem;color:var(--text3);display:block;margin-top:2px">+ ${litrosBomb.toFixed(0)} L abastecidos em bombonas</span>` : ''}
    </div>
    <div class="sc completed"><span class="si">✔️</span><span class="sn">${g.total_abastecimentos||0}</span><span class="sl">Abastecimentos</span></div>
    <div class="sc pending"><span class="si">🚗</span><span class="sn">${g.veiculos_abastecidos||0}</span><span class="sl">Veículos (posto)</span></div>
    <div class="sc total"><span class="si">👤</span><span class="sn">${g.motoristas_ativos||0}</span><span class="sl">Motoristas Ativos</span></div>
    <div class="sc rejected"><span class="si">❌</span><span class="sn">${g.total_rejeitados||0}</span><span class="sl">Rejeitadas</span></div>
  `);

  // Tabela por localidade
  const locRows = data.por_localidade.map(l => `
    <tr>
      <td><b>${l.localidade}</b></td>
      <td>${parseInt(l.abastecimentos)}</td>
      <td>${parseFloat(l.litros).toFixed(0)} L</td>
      <td style="font-weight:700;color:var(--orange)">${parseFloat(l.custo).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
      <td>${parseFloat(l.custo) > 0 && g.custo_total > 0 ? ((parseFloat(l.custo)/parseFloat(g.custo_total))*100).toFixed(1)+'%' : '—'}</td>
    </tr>`).join('');
  setHTML('rm-tb-loc', locRows || emptyRow(5,'Sem dados'));

  // Tabela por combustível
  const fuelRows = data.por_combustivel.map(f => `
    <tr>
      <td><b>${f.combustivel}</b></td>
      <td>${parseInt(f.abastecimentos)}</td>
      <td>${parseFloat(f.litros).toFixed(0)} L</td>
      <td>${f.preco_medio ? 'R$ '+parseFloat(f.preco_medio).toFixed(3) : '—'}</td>
      <td style="font-weight:700;color:var(--orange)">${parseFloat(f.custo).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
    </tr>`).join('');
  setHTML('rm-tb-fuel', fuelRows || emptyRow(5,'Sem dados'));

  // Tabela por veículo com CPK
  const vehRows = data.por_veiculo.map(v => {
    const cpk = v.cpk ? `R$ ${parseFloat(v.cpk).toFixed(3)}/km` : '—';
    const media = v.media_kml ? `${parseFloat(v.media_kml).toFixed(1)} km/L` : '—';
    const cpkColor = v.cpk ? (v.cpk < 0.5 ? 'var(--green)' : v.cpk < 1.0 ? 'var(--yellow)' : 'var(--red)') : 'var(--text3)';
    return `<tr>
      <td><code>${v.plate}</code></td>
      <td style="font-size:.82rem">${(v.vehicle||v.model||'—').replace('BOMBONA — ','').substring(0,30)}</td>
      <td>${parseInt(v.abastecimentos)}</td>
      <td>${parseFloat(v.litros).toFixed(0)} L</td>
      <td>${v.km_percorrido ? Number(v.km_percorrido).toLocaleString('pt-BR')+' km' : '—'}</td>
      <td>${media}</td>
      <td style="font-weight:700;color:${cpkColor}">${cpk}</td>
      <td style="font-weight:700;color:var(--orange)">${parseFloat(v.custo).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
    </tr>`;
  }).join('');
  setHTML('rm-tb-veh', vehRows || emptyRow(8,'Sem dados de veículos com KM registrado'));

  // Tabela por motorista
  const drvRows = data.por_motorista.map(d => `
    <tr>
      <td>${shortName(d.motorista)}</td>
      <td>${parseInt(d.abastecimentos)}</td>
      <td>${parseFloat(d.litros).toFixed(0)} L</td>
      <td style="font-weight:700;color:var(--orange)">${parseFloat(d.custo).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
    </tr>`).join('');
  setHTML('rm-tb-drv', drvRows || emptyRow(4,'Sem dados'));

  // Gráfico custo por localidade
  const locs = data.por_localidade.slice(0,8);
  makeChart('chart-rm-loc', 'bar', {
    labels: locs.map(l => l.localidade),
    datasets: [{ label:'Custo (R$)', data: locs.map(l => parseFloat(l.custo)),
      backgroundColor: PALETTE, borderRadius:6, borderSkipped:false }]
  }, { plugins:{ legend:{display:false}, tooltip:{callbacks:{label: ctx=>`R$ ${Number(ctx.raw).toLocaleString('pt-BR',{minimumFractionDigits:2})}`}} } });

  // Gráfico litros por combustível (pie)
  makeChart('chart-rm-fuel', 'doughnut', {
    labels: data.por_combustivel.map(f => f.combustivel),
    datasets: [{ data: data.por_combustivel.map(f => parseFloat(f.litros)),
      backgroundColor: PALETTE, borderColor:'#111', borderWidth:3, hoverOffset:8 }]
  });

  $('rm-results')?.classList.remove('hidden');
  $('rm-titulo').textContent = `📊 Relatório — ${nomeMes}`;
}

function exportRelatorioMensal() {
  if (!RELATORIO_MENSAL_DATA) return notify('Gere o relatório primeiro', 'warning');
  const d = RELATORIO_MENSAL_DATA;
  const wb = typeof XLSX !== 'undefined' ? XLSX.utils.book_new() : null;
  if (!wb) return notify('SheetJS não carregado', 'error');

  // Aba Geral
  const geral = [
    ['RELATÓRIO MENSAL DE ABASTECIMENTO'],
    [`Período: ${d.periodo.inicio} a ${d.periodo.fim}`],
    [],
    ['Indicador','Valor'],
    ['Custo Total (Frota + Bombona)',(parseFloat(d.geral.custo_frota||d.geral.custo_total||0)+parseFloat(d.geral.custo_bombona||0)).toFixed(2)],
    ['Custo Frota (posto)',parseFloat(d.geral.custo_frota||d.geral.custo_total||0).toFixed(2)],
    ['Custo Bombonas (abastecimento)',parseFloat(d.geral.custo_bombona||0).toFixed(2)],
    ['Litros Frota (posto)',parseFloat(d.geral.litros_total||0).toFixed(0)],
    ['Litros Abastecidos em Bombonas',parseFloat(d.geral.litros_bombona_abastecida||0).toFixed(0)],
    ['Abastecimentos',d.geral.total_abastecimentos],
    ['Veículos Abastecidos',d.geral.veiculos_abastecidos],
    ['Motoristas Ativos',d.geral.motoristas_ativos],
    ['Rejeitados',d.geral.total_rejeitados],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(geral), 'Resumo');

  // Aba Por Localidade
  const locData = [['Localidade','Abastecimentos','Litros','Custo R$','% do Total'],
    ...d.por_localidade.map(l=>[l.localidade,l.abastecimentos,parseFloat(l.litros).toFixed(0),parseFloat(l.custo).toFixed(2),(parseFloat(l.custo)/parseFloat(d.geral.custo_total)*100).toFixed(1)+'%'])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(locData), 'Por Localidade');

  // Aba Por Veículo CPK
  const vehData = [['Placa','Veículo','Abastecimentos','Litros','KM Percorrido','Média km/L','CPK R$/km','Custo R$'],
    ...d.por_veiculo.map(v=>[v.plate,v.vehicle||v.model||'',v.abastecimentos,parseFloat(v.litros).toFixed(0),v.km_percorrido||'',v.media_kml||'',v.cpk||'',parseFloat(v.custo).toFixed(2)])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vehData), 'Por Veículo CPK');

  // Aba Por Motorista
  const drvData = [['Motorista','Abastecimentos','Litros','Custo R$'],
    ...d.por_motorista.map(m=>[m.motorista,m.abastecimentos,parseFloat(m.litros).toFixed(0),parseFloat(m.custo).toFixed(2)])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(drvData), 'Por Motorista');

  XLSX.writeFile(wb, `relatorio_mensal_${d.periodo.ano}_${String(d.periodo.mes).padStart(2,'0')}.xlsx`);
}
function populateReportDrivers() {
  const sel = $('rp-drv');
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos os motoristas</option>';
  DRIVERS.forEach(d => sel.innerHTML += `<option value="${d}">${d}</option>`);
}

async function genReport() {
  const start = $('rp-s').value;
  const end   = $('rp-e').value;
  const drv   = $('rp-drv').value;
  const st    = $('rp-st').value;

  let qs = '';
  if (start) qs += `&startDate=${start}`;
  if (end)   qs += `&endDate=${end}`;
  if (drv)   qs += `&driver=${encodeURIComponent(drv)}`;
  if (st)    qs += `&status=${st}`;

  loading(true);
  const data = await GET(`/requests?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  REPORT_DATA = data;

  // Stats
  $('rp-stats').classList.remove('hidden');
  $('rp-tbl').classList.remove('hidden');
  $('rp-total').textContent = data.length;
  $('rp-aprov').textContent = data.filter(r => r.status === 'signed').length;
  $('rp-comp').textContent  = data.filter(r => r.status === 'completed').length;
  $('rp-rej').textContent   = data.filter(r => r.status === 'rejected').length;

  const rows = data.map(r => `<tr>
    <td><code style="font-size:.75rem">${r.id}</code></td>
    <td>${shortName(r.driver)}</td>
    <td style="font-size:.82rem">${r.vehicle || '—'}</td>
    <td>${r.city || '—'}</td>
    <td>${r.fuel_type || '—'}</td>
    <td>${statusBadge(r.status)}</td>
    <td>${fmtDateTime(r.date)}</td>
    <td>${r.real_value || r.estimated_value || '—'}</td>
  </tr>`).join('');
  setHTML('tb-rp', rows || emptyRow(8, 'Nenhum resultado'));
  renderReportCharts(data);
  notify(`${data.length} registros encontrados`);
}

// ══════════════════════════════════════════════════
// EXPORT EXCEL
// ══════════════════════════════════════════════════
// RELATÓRIO TRANSFERÊNCIAS DE BOMBONAS
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// AUDITORIA
// ══════════════════════════════════════════════════
let AUDIT_DATA = [];

async function loadAudit() {
  loading(true);
  const data = await GET('/audit?limit=300');
  if (data) { AUDIT_DATA = data; renderAudit(); }
  loading(false);
}

function renderAudit() {
  const actorF  = ($('aud-actor')?.value || '').toLowerCase();
  const actionF = $('aud-action')?.value || '';

  let list = AUDIT_DATA;
  if (actorF)  list = list.filter(a => (a.actor||'').toLowerCase().includes(actorF));
  if (actionF) list = list.filter(a => (a.action||'').includes(actionF));

  const actionIcon = {
    'APROVAÇÃO':'✅', 'REJEIÇÃO':'❌', 'CONCLUSÃO':'✔️',
    'ANULAÇÃO':'🚫', 'EXCLUSÃO':'🗑️', 'ATUALIZAÇÃO DE VALORES':'📝',
    'EDIÇÃO DE POSTO':'✏️'
  };

  const rows = list.map(a => {
    const icon = Object.entries(actionIcon).find(([k]) => a.action.includes(k))?.[1] || '🔸';
    const det  = a.details ? Object.entries(a.details)
      .filter(([,v]) => v)
      .map(([k,v]) => `<span style="color:var(--text3)">${k}:</span> ${v}`)
      .join(' &nbsp;|&nbsp; ')
      : '—';
    return `<tr>
      <td style="font-size:.8rem;white-space:nowrap">${fmtDateTime(a.created_at)}</td>
      <td><span class="badge" style="background:rgba(247,147,30,0.15);color:var(--orange);font-size:.75rem">${icon} ${a.action}</span></td>
      <td><b>${shortName(a.actor)}</b></td>
      <td><code style="background:#F1F5F9;padding:2px 6px;border-radius:4px;font-size:.78rem">${a.entity_id||'—'}</code></td>
      <td style="font-size:.78rem;color:var(--text3)">${det}</td>
    </tr>`;
  }).join('');

  setHTML('tb-audit', rows || emptyRow(5, 'Nenhum registro de auditoria'));
}

// ══════════════════════════════════════════════════
// RELATÓRIO TRANSFERÊNCIAS DE BOMBONAS
// ══════════════════════════════════════════════════
function renderTransferRecords() {
  const start = $('tr-start')?.value || '';
  const end   = $('tr-end')?.value   || '';

  let list = [...DATA.transfers].sort((a,b) => new Date(b.date||b.created_at) - new Date(a.date||a.created_at));
  if (start) list = list.filter(t => (t.date||t.created_at||'') >= start);
  if (end)   list = list.filter(t => (t.date||t.created_at||'') <= end + 'T23:59:59');

  // Totais
  const totalL = list.reduce((s,t) => s + parseFloat(t.liters||0), 0);

  const rows = list.map(t => {
    const bomb = DATA.bombonas.find(b => b.id == t.bombona_id);
    const photos = (t.photos || []);
    const photoLinks = photos.map(p =>
      `<a class="sp-link" href="${p.sharepoint_url}" target="_blank">📷</a>`
    ).join(' ') || '—';
    return `<tr>
      <td>${fmtDateTime(t.date||t.created_at)}</td>
      <td>${t.driver||'—'}</td>
      <td><b>${bomb?.name || '—'}</b></td>
      <td>${bomb?.fuel_type || '—'}</td>
      <td><b>${parseFloat(t.liters||0).toFixed(1)} L</b></td>
      <td>${t.vehicle_model||'—'}</td>
      <td>${t.vehicle_plate||'—'}</td>
      <td>${bomb?.location||'—'}</td>
      <td>${photoLinks}</td>
    </tr>`;
  }).join('');

  setHTML('tb-transfer-records', rows || emptyRow(9, 'Nenhuma transferência encontrada'));

  // Append totals row
  if (list.length > 0) {
    const tbody = $('tb-transfer-records');
    if (tbody) tbody.innerHTML += `<tr style="border-top:2px solid var(--orange);font-weight:700">
      <td colspan="4" style="text-align:right;color:var(--text3)">TOTAL (${list.length} registros)</td>
      <td style="color:var(--orange)">${totalL.toFixed(1)} L</td>
      <td colspan="4"></td>
    </tr>`;
  }
}

// ══════════════════════════════════════════════════
// EXPORTAR XLSX (SheetJS)
// ══════════════════════════════════════════════════
function exportXLS(type) {
  let headers, rows, filename, sheetName;

  const statusPT = { pending:'Pendente', signed:'Aprovada', completed:'Concluída', rejected:'Rejeitada', voided:'🚫 Anulada' };
  const fmtVal = v => v || '';
  const fmtDT  = d => d ? fmtDateTime(d) : '';

  if (type === 'req') {
    sheetName = 'Requisições';
    filename  = `requisicoes_${today()}.xlsx`;
    headers   = ['ID','Motorista','Placa','Veículo','KM/Horímetro','Cidade','Posto','Combustível','Método','Status','Data/Hora','Supervisor','Valor Real','Litros','Preço/L','Observações'];
    rows = DATA.requests.filter(r => r.status !== 'voided').map(r => [
      r.id, r.driver, r.plate, r.vehicle,
      r.km ? `${Number(r.km).toLocaleString('pt-BR')} km` : r.horimetre || '—',
      r.city, r.gas_station,
      r.fuel_type, r.fuel_method, statusPT[r.status]||r.status,
      fmtDT(r.date), r.supervisor, r.real_value,
      r.liters, r.price_per_liter ? `R$ ${Number(r.price_per_liter).toFixed(2)}` : '', r.notes
    ]);
  } else if (type === 'fuel') {
    sheetName = 'Abastecimentos';
    filename  = `abastecimentos_${today()}.xlsx`;
    headers   = ['Requisição','Motorista','Placa','Veículo','KM/Horímetro','Posto','Combustível','Litros','Preço/L','Total','Status','Data/Hora'];
    rows = DATA.fuelRecords.map(r => {
      const req = DATA.requests.find(x => x.id === r.request_id);
      return [
        r.request_id, r.driver, r.plate || req?.plate || '—', r.vehicle,
        req?.km ? `${Number(req.km).toLocaleString('pt-BR')} km` : req?.horimetre || '—',
        r.gas_station, r.fuel_type, r.liters,
        r.price_per_liter ? `R$ ${Number(r.price_per_liter).toFixed(2)}` : '',
        r.real_value, statusPT[r.status]||r.status, fmtDT(r.date)
      ];
    });
  } else if (type === 'transfers') {
    sheetName = 'Transferências Bombonas';
    filename  = `transferencias_bombonas_${today()}.xlsx`;
    headers   = ['ID','Data','Responsável','Bombona','Combustível','Litros Transferidos','Veículo','Placa','Localidade','Notas'];
    rows = DATA.transfers.map(t => {
      const bomb = DATA.bombonas.find(b => b.id == t.bombona_id);
      return [
        t.id, fmtDT(t.date), t.driver, bomb?.name || t.bombona_id,
        bomb?.fuel_type || '—', parseFloat(t.liters||0).toFixed(1),
        t.vehicle_model || '—', t.vehicle_plate || '—',
        bomb?.location || '—', t.notes || ''
      ];
    });
  } else if (type === 'rep') {
    sheetName = 'Relatório';
    filename  = `relatorio_${today()}.xlsx`;
    headers   = ['ID','Motorista','Placa','Veículo','KM/Horímetro','Cidade','Combustível','Status','Data/Hora','Valor'];
    const data = (REPORT_DATA.length ? REPORT_DATA : DATA.requests).filter(r => r.status !== 'voided');
    rows = data.map(r => [
      r.id, r.driver, r.plate, r.vehicle,
      r.km ? `${Number(r.km).toLocaleString('pt-BR')} km` : r.horimetre || '—',
      r.city, r.fuel_type, statusPT[r.status]||r.status,
      fmtDT(r.date), r.real_value || r.estimated_value
    ]);
  } else if (type === 'cons') {
    sheetName = 'Consumo';
    filename  = `consumo_${today()}.xlsx`;
    headers   = ['Placa','Veículo','Tipo','Localidade','Motorista','Último Abast.','KM Anterior','KM Atual','KM Rodados','Litros','Média (km/L)','Performance'];
    rows = CONS_DATA.map(d => {
      const veh  = DATA.vehicles.find(v => v.plate === d.plate);
      const perf = d.avg_consumption >= 8 ? 'Excelente' : d.avg_consumption >= 6 ? 'Bom' : 'Atenção';
      return [
        d.plate, d.vehicle, veh?.type||'—', d.location||veh?.location||'—',
        d.driver, fmtDT(d.current_date),
        d.previous_km ? Number(d.previous_km) : '',
        d.current_km  ? Number(d.current_km)  : '',
        d.km_driven   ? Number(d.km_driven)   : '',
        parseFloat(d.liters_used||0).toFixed(1),
        d.avg_consumption, perf
      ];
    });
  } else if (type === 'bombonas') {
    sheetName = 'Bombonas';
    filename  = `bombonas_${today()}.xlsx`;
    headers   = ['ID','Nome','Combustível','Localidade','Responsável','Status','Saldo Atual (L)','Capacidade (L)','% Cheio','Total Transferido (L)','N° Transferências','Última Transferência'];
    rows = BOMB_CONS_DATA.map(b => [
      b.id, b.name, b.fuel_type, b.location || '—', b.responsible_driver,
      b.status,
      parseFloat(b.current_liters||0).toFixed(0),
      parseFloat(b.capacity_liters||0).toFixed(0),
      b.capacity_liters > 0 ? ((parseFloat(b.current_liters)/parseFloat(b.capacity_liters))*100).toFixed(0)+'%' : '—',
      parseFloat(b.total_transferred||0).toFixed(0),
      parseInt(b.transfer_count||0),
      b.last_transfer_date ? fmtDate(b.last_transfer_date) : '—'
    ]);
  } else { return; }

  // Tenta SheetJS; se não disponível, cai em CSV com ponto-e-vírgula
  if (typeof XLSX !== 'undefined') {
    try {
      const wsData = [headers, ...rows];
      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Largura automática das colunas
      ws['!cols'] = headers.map((h, i) => {
        const maxLen = Math.max(h.length, ...rows.map(r => String(r[i]||'').length));
        return { wch: Math.min(Math.max(maxLen + 2, 10), 50) };
      });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      XLSX.writeFile(wb, filename);
      notify(`✅ ${filename} exportado!`);
      return;
    } catch(e) {
      console.warn('SheetJS falhou, usando CSV:', e.message);
    }
  }
  // Fallback: CSV com ponto-e-vírgula (abre corretamente no Excel BR)
  const escape = v => `"${String(v===null||v===undefined?'':v).replace(/"/g,'""')}"`;
  const lines  = [headers, ...rows].map(row => row.map(escape).join(';'));
  const blob   = new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8;' });
  const url    = URL.createObjectURL(blob);
  const csvName = filename.replace('.xlsx', '.csv');
  const a = document.createElement('a'); a.href = url; a.download = csvName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  notify(`✅ ${csvName} exportado! (abra normalmente no Excel)`);
}

// ══════════════════════════════════════════════════
// FOTOS — COMPRESSÃO (deixa upload rápido no campo)
// ══════════════════════════════════════════════════
// Fotos de câmera de celular costumam vir com 3-12MB. Isso é o principal
// motivo do upload ficar lento/travando em conexões fracas no campo.
// Aqui comprimimos no próprio celular (canvas) ANTES de enviar — reduz o
// arquivo em geral para 150-400KB sem perda visual perceptível para o
// propósito (comprovante/leitura de painel/cupom).
const PHOTO_MAX_DIM = 1600;   // maior lado da imagem, em pixels
const PHOTO_QUALITY = 0.72;   // qualidade JPEG
const PHOTO_SKIP_BELOW = 280 * 1024; // arquivos já pequenos não precisam comprimir

async function compressImage(file) {
  if (!file || !file.type?.startsWith('image/')) return file;
  if (file.size <= PHOTO_SKIP_BELOW) return file;

  try {
    // createImageBitmap com imageOrientation:'from-image' já corrige a
    // rotação EXIF automaticamente (suportado nos navegadores atuais).
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bitmap = await createImageBitmap(file);
    }

    const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
    if (!blob) return file;

    // Se por algum motivo a "compressão" ficou maior que o original, mantém o original
    if (blob.size >= file.size) return file;

    const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (e) {
    console.warn('Compressão de imagem falhou, enviando original:', e.message);
    return file; // nunca bloqueia o fluxo por falha de compressão
  }
}

function fmtKB(bytes) { return (bytes / 1024).toFixed(0) + 'KB'; }

// ══════════════════════════════════════════════════
// FOTOS — PREVIEW
// ══════════════════════════════════════════════════
// ── Foto Upload ────────────────────────────────────
// ── Armazém de arquivos independente do input[type=file] ─────────────
// Em vários navegadores/webviews mobile (in-app browser do WhatsApp,
// Samsung Internet, WebViews antigas) reatribuir `input.files` via
// DataTransfer nem sempre "gruda" de forma confiável — a pré-visualização
// pode renderizar normalmente e mesmo assim o input ficar com .files
// vazio no momento do envio. Para não depender só do input, guardamos
// o arquivo (já comprimido) num mapa em memória e usamos ele como fonte
// de verdade na hora de montar o FormData.
const PU_FILES = {};

function getPUFile(inputId) {
  const inp = $(inputId);
  const fromInput = inp?.files?.[0];
  if (fromInput) return fromInput;
  return PU_FILES[inputId] || null;
}

async function previewPU(input, puId) {
  const pu = $(puId);
  const original = input.files[0];
  if (!pu || !original) return;

  pu.classList.add('pu-ok');
  pu.classList.add('pu-busy');
  pu.querySelectorAll('.pu-label, .pu-btns, img').forEach(el => el.remove());
  const lbl = document.createElement('div');
  lbl.className = 'pu-label';
  lbl.style.color = 'var(--navy)';
  lbl.textContent = '⏳ Otimizando foto...';
  pu.appendChild(lbl);

  const originalSize = original.size;
  const compressed = await compressImage(original);

  // Guarda o arquivo final (comprimido ou original) na fonte de verdade
  // independente do input — assim o envio nunca depende só do estado
  // do input[type=file], que pode ser perdido silenciosamente em alguns
  // navegadores mobile.
  PU_FILES[input.id] = compressed;

  // Também tenta atualizar o input nativamente (mantém compatibilidade
  // com qualquer outro código que ainda leia input.files diretamente).
  // Isso pode falhar silenciosamente em navegadores mais antigos — não é
  // mais crítico, já que PU_FILES é a fonte de verdade agora.
  try {
    if (compressed !== original) {
      const dt = new DataTransfer();
      dt.items.add(compressed);
      input.files = dt.files;
    }
  } catch (e) {
    console.warn('Não foi possível reatribuir input.files, usando PU_FILES como backup:', e?.message);
  }

  const reader = new FileReader();
  reader.onload = e => {
    pu.classList.remove('pu-busy');
    pu.querySelectorAll('.pu-label, img').forEach(el => el.remove());
    const img = document.createElement('img');
    img.src = e.target.result;
    img.alt = 'preview';
    img.style.cssText = 'max-width:100%;max-height:100px;border-radius:8px';
    const finalLbl = document.createElement('div');
    finalLbl.className = 'pu-label';
    finalLbl.style.color = 'var(--green)';
    const reduced = compressed !== original;
    finalLbl.textContent = reduced
      ? `✅ ${fmtKB(originalSize)} → ${fmtKB(compressed.size)}`
      : `✅ ${compressed.name}`;
    pu.appendChild(img);
    pu.appendChild(finalLbl);
  };
  reader.onerror = () => { pu.classList.remove('pu-busy'); };
  reader.readAsDataURL(compressed);
}

function triggerCamera(inputId) {
  const inp = $(inputId);
  if (!inp) return;
  inp.setAttribute('capture', 'environment');
  inp.setAttribute('accept', 'image/*');
  inp.click();
}

function triggerGallery(inputId) {
  const inp = $(inputId);
  if (!inp) return;
  inp.removeAttribute('capture');
  inp.setAttribute('accept', 'image/*');
  inp.click();
}

function initPU(puId, inputId, placeholder) {
  const pu = $(puId);
  if (!pu) return;
  pu.classList.remove('pu-ok');

  // Salva o input ANTES de mexer no DOM
  const inp = pu.querySelector('input[type=file]') || $(inputId);

  // Remove apenas elementos visuais — NUNCA o input
  Array.from(pu.children).forEach(child => {
    if (child.tagName !== 'INPUT') child.remove();
  });

  // Recria label visual
  const span = document.createElement('span');
  span.className = 'pu-label';
  span.textContent = placeholder || '📷 Toque para adicionar foto';
  pu.appendChild(span);

  // Garante que o input está dentro do label
  if (inp && inp.parentElement !== pu) {
    pu.appendChild(inp);
  }
}

function resetPU(puId, inputId, placeholder) {
  // Tenta limpar o valor do input de forma segura
  const inp = $(inputId) || $(puId)?.querySelector('input[type=file]');
  if (inp) {
    try { inp.value = ''; } catch(e) {}
  }
  delete PU_FILES[inputId];
  initPU(puId, inputId, placeholder);
}

// ── Drag & drop nas áreas de foto ─────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.pu').forEach(pu => {
    pu.addEventListener('dragover', e => { e.preventDefault(); pu.classList.add('over'); });
    pu.addEventListener('dragleave', () => pu.classList.remove('over'));
    pu.addEventListener('drop', e => {
      e.preventDefault(); pu.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (!file || !file.type.startsWith('image/')) return notify('Arquivo inválido', 'error');
      const inputId = pu.id.replace('pu-', 'f-');
      const inp = $(inputId);
      if (!inp) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      previewPU(inp, pu.id);
    });
  });
});

// ══════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════
function openModal(id) { $(id)?.classList.add('open'); }
function closeModal(id) { $(id)?.classList.remove('open'); }
function closeOverlay(id) { closeModal(id); }
function close(id) { closeModal(id); } // compatibilidade

// Close on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('overlay')) {
    e.target.classList.remove('open');
  }
});
// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
});

// ══════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════
function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="empty" style="padding:28px"><div class="ico" style="font-size:2rem">📭</div><div style="color:var(--muted);font-size:.875rem">${msg}</div></td></tr>`;
}

// ── INIT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  populateDriverSelect();
  // Sidebar responsive toggle
  document.querySelector('.sb-head')?.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      const sb = document.querySelector('.sidebar');
      if (sb?.classList.contains('open')) closeSidebarMobile();
      else openSidebarMobile();
    }
  });
  // Hamburger button
  document.querySelector('.hamburger')?.addEventListener('click', () => {
    const sb = document.querySelector('.sidebar');
    if (sb?.classList.contains('open')) closeSidebarMobile();
    else openSidebarMobile();
  });
  // Processa retorno do redirect Microsoft (mobile)
  handleMsalRedirectResult().catch(e => console.warn('redirect result:', e));

  // Inicializa todas as áreas de foto com botões câmera/galeria
  const puMap = {
    'pu-hori':       ['f-hori',       '📷 Foto do painel do veículo'],
    'pu-veh':        ['f-veh',        '📷 Foto da placa do veículo'],
    'pu-dp-pump':    ['dp-f-pump',    '📷 Foto da bomba / bico'],
    'pu-dp-receipt': ['dp-f-receipt', '📷 Foto do cupom fiscal'],
    'pu-dp-panel':   ['dp-f-panel',   '📷 Foto do painel / carote'],
    'pu-tf1':        ['tf-f1',        '📷 Foto antes'],
    'pu-tf2':        ['tf-f2',        '📷 Foto depois'],
    'pu-tf3':        ['tf-f3',        '📷 Foto do veículo'],
  };
  Object.entries(puMap).forEach(([puId, [inputId, label]]) => initPU(puId, inputId, label));
});

// ══════════════════════════════════════════════════
// RELATÓRIO POR VEÍCULO
// ══════════════════════════════════════════════════
let REL_VEH_DATA = null;

async function gerarRelatorioVeiculo() {
  const inicio    = $('rv-inicio')?.value || '';
  const fim       = $('rv-fim')?.value || '';
  const plate     = $('rv-plate')?.value || '';
  const fuel_type = $('rv-fuel')?.value || '';

  let qs = '';
  if (inicio)    qs += `&inicio=${inicio}`;
  if (fim)       qs += `&fim=${fim}`;
  if (plate)     qs += `&plate=${encodeURIComponent(plate)}`;
  if (fuel_type) qs += `&fuel_type=${encodeURIComponent(fuel_type)}`;

  loading(true);
  const data = await GET(`/relatorio-veiculo?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  REL_VEH_DATA = data;

  renderRelVeiculoTabela(data);
  renderRelVeiculoCharts(data);
  $('rv-results')?.classList.remove('hidden');
}

function renderRelVeiculoTabela(data) {
  const { por_veiculo, trans_veiculo } = data;

  // Mapa de litros de bombona por placa
  const transMap = {}; // plate -> { litros, type, location, vehicle }
  (trans_veiculo || []).forEach(t => {
    if (!transMap[t.plate]) transMap[t.plate] = { litros: 0, type: t.type, location: t.location, vehicle: t.vehicle };
    transMap[t.plate].litros += parseFloat(t.litros_bombona || 0);
  });

  // Mapa de placas que já aparecem em por_veiculo
  const placasPostos = new Set(por_veiculo.map(v => v.plate));

  // Veículos que só receberam via bombona (não estão em por_veiculo)
  const soBombona = Object.entries(transMap)
    .filter(([plate]) => !placasPostos.has(plate))
    .map(([plate, t]) => ({
      plate,
      vehicle: t.vehicle || plate,
      model: t.vehicle || '',
      type: t.type || null,
      location: t.location || null,
      abastecimentos: 0,
      litros_posto: 0,
      custo_posto: 0,
      km_percorrido: null,
      _soBombona: true
    }));

  const todos = [...por_veiculo, ...soBombona];

  const rows = todos.map(v => {
    const litrosBomb  = transMap[v.plate]?.litros || 0;
    const litrosPosto = parseFloat(v.litros_posto || 0);
    const litrosTotal = litrosPosto + litrosBomb;
    const custoTotal  = parseFloat(v.custo_posto || 0);
    const km = v.km_percorrido ? parseFloat(v.km_percorrido) : 0;
    const media = km > 0 && litrosTotal > 0
      ? (km / litrosTotal).toFixed(1) : '—';
    const cpk = km > 0 && custoTotal > 0
      ? (custoTotal / km).toFixed(3) : '—';
    const mediaColor = parseFloat(media) >= 8 ? 'var(--green)' : parseFloat(media) >= 6 ? 'var(--yellow)' : 'var(--red)';
    const cpkColor   = parseFloat(cpk) < 0.5 ? 'var(--green)' : parseFloat(cpk) < 1.0 ? 'var(--yellow)' : 'var(--red)';
    const soloTag    = v._soBombona ? '<span style="font-size:.65rem;background:rgba(167,139,250,0.2);color:#A78BFA;padding:1px 5px;border-radius:4px;margin-left:4px">só bombona</span>' : '';
    // Média por abastecimento (litros e R$) — não depende de KM, funciona pra
    // qualquer veículo/equipamento, inclusive os que não rodam km (geradores etc.)
    const medLitros = v.media_litros_abastecimento != null ? parseFloat(v.media_litros_abastecimento).toFixed(1) : (v.abastecimentos > 0 ? (litrosPosto/v.abastecimentos).toFixed(1) : '—');
    const medCusto  = v.media_custo_abastecimento  != null ? parseFloat(v.media_custo_abastecimento)  : (v.abastecimentos > 0 ? custoTotal/v.abastecimentos : null);
    const precoMed  = v.preco_medio ? `R$ ${parseFloat(v.preco_medio).toFixed(3)}` : '—';
    return `<tr>
      <td><code>${v.plate}</code>${soloTag}</td>
      <td style="font-size:.82rem">${(v.model || v.vehicle || '').substring(0,25)}</td>
      <td>${v.type ? typeBadge(v.type) : '—'}</td>
      <td>${v.location || '—'}</td>
      <td>${v.abastecimentos || 0}</td>
      <td style="font-weight:700">${v.abastecimentos ? medLitros + ' L' : '—'}</td>
      <td style="font-weight:700;color:var(--green)">${medCusto != null ? medCusto.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) : '—'}</td>
      <td>${precoMed}</td>
      <td style="font-weight:700">${litrosPosto.toFixed(0)} L</td>
      <td style="color:#A78BFA;font-weight:700">${litrosBomb.toFixed(0)} L</td>
      <td style="font-weight:800;color:var(--orange)">${litrosTotal.toFixed(0)} L</td>
      <td>${km > 0 ? Number(km).toLocaleString('pt-BR') + ' km' : '—'}</td>
      <td style="font-weight:800;color:${mediaColor}">${media}${media !== '—' ? ' km/L' : ''}</td>
      <td style="font-weight:700;color:${cpkColor}">${cpk !== '—' ? 'R$ '+cpk+'/km' : '—'}</td>
      <td style="font-weight:700;color:var(--green)">${custoTotal.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
    </tr>`;
  }).join('');
  setHTML('tb-rv-veiculo', rows || emptyRow(15, 'Nenhum dado encontrado para o período selecionado'));

  // Totais
  const totalPosto = por_veiculo.reduce((s,v)=>s+parseFloat(v.litros_posto||0),0);
  const totalBomb  = Object.values(transMap).reduce((s,t)=>s+t.litros,0);
  const totalCusto = por_veiculo.reduce((s,v)=>s+parseFloat(v.custo_posto||0),0);
  const totalAbast = por_veiculo.reduce((s,v)=>s+parseInt(v.abastecimentos||0),0);
  const totalVeics = new Set([...por_veiculo.map(v=>v.plate), ...Object.keys(transMap)]).size;
  // Média geral por abastecimento (frota toda), pra dar o número "quanto um carro
  // costuma gastar por vez" numa olhada rápida, sem abrir a tabela.
  const medGeralL = totalAbast > 0 ? (totalPosto/totalAbast).toFixed(1) : '—';
  const medGeralR = totalAbast > 0 ? (totalCusto/totalAbast) : null;
  setHTML('rv-totais', `
    <span>Veículos: <b style="color:var(--orange)">${totalVeics}</b></span>
    <span>Litros em posto: <b style="color:var(--orange)">${totalPosto.toFixed(0)} L</b></span>
    <span>Litros de bombona: <b style="color:#A78BFA">${totalBomb.toFixed(0)} L</b></span>
    <span>Total combustível: <b style="color:var(--orange)">${(totalPosto+totalBomb).toFixed(0)} L</b></span>
    <span>Custo (posto): <b style="color:var(--green)">${totalCusto.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</b></span>
    <span>Média por abastecimento (frota): <b style="color:var(--orange)">${medGeralL} L</b> / <b style="color:var(--green)">${medGeralR!=null?medGeralR.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}):'—'}</b></span>
  `);
}

function renderRelVeiculoCharts(data) {
  const { por_veiculo, semanal_posto, semanal_bombona, trans_veiculo } = data;

  const transMap = {};
  (trans_veiculo || []).forEach(t => {
    transMap[t.plate] = (transMap[t.plate] || 0) + parseFloat(t.litros_bombona || 0);
  });

  // 1. Top veículos por custo (bar horizontal)
  const top10 = [...por_veiculo].sort((a,b) => parseFloat(b.custo_posto)-parseFloat(a.custo_posto)).slice(0,10);
  makeChart('chart-rv-custo', 'bar', {
    labels: top10.map(v => `${v.plate}`),
    datasets: [
      { label:'Custo Posto (R$)', data: top10.map(v => parseFloat(v.custo_posto||0).toFixed(2)),
        backgroundColor: CHART_COLORS.orange, borderRadius:4, borderSkipped:false },
    ]
  }, { indexAxis:'y', plugins:{ legend:{display:false}, tooltip:{callbacks:{label: ctx=>`R$ ${Number(ctx.raw).toLocaleString('pt-BR',{minimumFractionDigits:2})}`}} },
      scales:{x:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.07)'}},y:{ticks:{color:'#AAA',font:{size:11}},grid:{color:'rgba(255,255,255,0.04)'}}} });

  // 2. Top veículos por total litros (posto + bombona)
  const top10L = [...por_veiculo].sort((a,b) => {
    const la = parseFloat(a.litros_posto||0) + (transMap[a.plate]||0);
    const lb = parseFloat(b.litros_posto||0) + (transMap[b.plate]||0);
    return lb - la;
  }).slice(0,10);
  makeChart('chart-rv-litros', 'bar', {
    labels: top10L.map(v => v.plate),
    datasets: [
      { label:'Posto (L)',   data: top10L.map(v => parseFloat(v.litros_posto||0).toFixed(1)), backgroundColor: CHART_COLORS.orange, borderRadius:4, borderSkipped:false },
      { label:'Bombona (L)',data: top10L.map(v => (transMap[v.plate]||0).toFixed(1)),          backgroundColor: 'rgba(167,139,250,0.8)', borderRadius:4, borderSkipped:false },
    ]
  }, { plugins:{legend:{labels:{color:'#AAA',font:{size:11}}}},
      scales:{x:{stacked:true,ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.07)'}},y:{stacked:true,ticks:{color:'#AAA',font:{size:11}},grid:{color:'rgba(255,255,255,0.04)'}}} });

  // 3. Consumo semanal (linha) — agrega todos os veículos
  const semMap = {};
  (semanal_posto || []).forEach(s => { semMap[s.semana] = (semMap[s.semana]||0)+parseFloat(s.litros||0); });
  const semBombMap = {};
  (semanal_bombona || []).forEach(s => { semBombMap[s.semana] = (semBombMap[s.semana]||0)+parseFloat(s.litros_bombona||0); });
  const semanas = [...new Set([...Object.keys(semMap), ...Object.keys(semBombMap)])].sort().slice(-16);
  makeChart('chart-rv-semanal', 'line', {
    labels: semanas.map(s => `Sem. ${fmtDate(s)}`),
    datasets: [
      { label:'Litros Posto', data: semanas.map(s => (semMap[s]||0).toFixed(1)),
        borderColor: CHART_COLORS.orange, backgroundColor: CHART_COLORS.orange2, fill:true, tension:0.3, pointRadius:3 },
      { label:'Litros Bombona', data: semanas.map(s => (semBombMap[s]||0).toFixed(1)),
        borderColor: 'rgba(167,139,250,0.9)', backgroundColor: 'rgba(167,139,250,0.2)', fill:true, tension:0.3, pointRadius:3 },
    ]
  });

  // 4. km/L por veículo (bar)
  const comKm = por_veiculo.filter(v => v.km_percorrido > 0).slice(0,10);
  makeChart('chart-rv-media', 'bar', {
    labels: comKm.map(v => v.plate),
    datasets: [{ label:'km/L', data: comKm.map(v => {
      const litT = parseFloat(v.litros_posto||0) + (transMap[v.plate]||0);
      return litT > 0 ? (parseFloat(v.km_percorrido)/litT).toFixed(1) : 0;
    }),
      backgroundColor: comKm.map(v => {
        const litT = parseFloat(v.litros_posto||0) + (transMap[v.plate]||0);
        const m = litT > 0 ? parseFloat(v.km_percorrido)/litT : 0;
        return m >= 8 ? CHART_COLORS.green : m >= 6 ? CHART_COLORS.yellow : CHART_COLORS.red;
      }), borderRadius:4, borderSkipped:false }]
  }, { plugins:{legend:{display:false}}, indexAxis:'y',
      scales:{x:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.07)'}},y:{ticks:{color:'#AAA',font:{size:11}},grid:{color:'rgba(255,255,255,0.04)'}}} });
}

// Detalhe semanal de veículo específico
function renderRelVeiculoSemanal() {
  if (!REL_VEH_DATA) return;
  const plate = $('rv-plate')?.value;
  const { semanal_posto, semanal_bombona, historico } = REL_VEH_DATA;

  const semPosto = (semanal_posto || []).filter(s => !plate || s.plate === plate);
  const semBomb  = (semanal_bombona || []).filter(s => !plate || s.plate === plate);

  // Agrupa por semana
  const semMap = {};
  semPosto.forEach(s => {
    if (!semMap[s.semana]) semMap[s.semana] = { semana:s.semana, litros_posto:0, custo_posto:0, litros_bomb:0, abast:0 };
    semMap[s.semana].litros_posto += parseFloat(s.litros||0);
    semMap[s.semana].custo_posto  += parseFloat(s.custo||0);
    semMap[s.semana].abast        += parseInt(s.abastecimentos||0);
  });
  semBomb.forEach(s => {
    if (!semMap[s.semana]) semMap[s.semana] = { semana:s.semana, litros_posto:0, custo_posto:0, litros_bomb:0, abast:0 };
    semMap[s.semana].litros_bomb += parseFloat(s.litros_bombona||0);
  });

  const semanas = Object.values(semMap).sort((a,b) => a.semana < b.semana ? -1 : 1);
  const semRows = semanas.map(s => `<tr>
    <td>Semana ${fmtDate(s.semana)}</td>
    <td>${s.abast}</td>
    <td>${s.litros_posto.toFixed(0)} L</td>
    <td style="color:#A78BFA">${s.litros_bomb.toFixed(0)} L</td>
    <td style="font-weight:700;color:var(--orange)">${(s.litros_posto+s.litros_bomb).toFixed(0)} L</td>
    <td style="font-weight:700;color:var(--green)">${s.custo_posto.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
  </tr>`).join('');
  setHTML('tb-rv-semanal', semRows || emptyRow(6,'Nenhum dado semanal'));

  // Histórico detalhado
  const histRows = (historico || []).map(h => `<tr>
    <td style="font-size:.8rem">${fmtDate(h.date)}</td>
    <td><span class="badge" style="background:${h.tipo==='BOMBONA'?'rgba(167,139,250,0.2)':'rgba(247,147,30,0.2)'};color:${h.tipo==='BOMBONA'?'#A78BFA':'var(--orange)'};font-size:.7rem">${h.tipo}</span></td>
    <td style="font-size:.82rem">${shortName(h.driver)}</td>
    <td style="font-size:.82rem">${h.gas_station || '—'}</td>
    <td style="font-size:.82rem">${h.city || '—'}</td>
    <td>${h.fuel_type || '—'}</td>
    <td style="font-weight:700">${h.liters ? parseFloat(h.liters).toFixed(1)+' L' : '—'}</td>
    <td>${h.price_per_liter ? 'R$ '+Number(h.price_per_liter).toFixed(2) : '—'}</td>
    <td style="font-weight:700;color:var(--green)">${h.real_value || '—'}</td>
    <td>${h.km ? Number(h.km).toLocaleString('pt-BR')+' km' : '—'}</td>
    <td style="font-weight:700;color:var(--orange)" title="${h.km_rodado != null ? `Conferência: ${Number(h.km_anterior).toLocaleString('pt-BR')} km (${fmtDate(h.data_km_anterior)}) → ${Number(h.km).toLocaleString('pt-BR')} km (${fmtDate(h.date)}) = ${Number(h.km_rodado).toLocaleString('pt-BR')} km` : 'Sem abastecimento anterior com KM válido pra comparar'}">${h.km_rodado != null ? Number(h.km_rodado).toLocaleString('pt-BR')+' km ℹ️' : '—'}</td>
  </tr>`).join('');
  setHTML('tb-rv-historico', histRows || emptyRow(11,'Selecione um veículo para ver o histórico detalhado'));
}

// ══════════════════════════════════════════════════
// AUDITORIA DE LITROS
// ══════════════════════════════════════════════════
let AL_DATA = null;

async function gerarAuditoriaLitros() {
  const inicio = $('al-inicio')?.value || '';
  const fim    = $('al-fim')?.value || '';
  const plate  = $('al-plate')?.value || '';

  let qs = '';
  if (inicio) qs += `&inicio=${inicio}`;
  if (fim)    qs += `&fim=${fim}`;
  if (plate)  qs += `&plate=${encodeURIComponent(plate)}`;

  loading(true);
  const data = await GET(`/auditoria-litros?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  AL_DATA = data;

  renderAuditoriaLitros(data);
  $('al-results')?.classList.remove('hidden');
}

const ALERTA_LABELS = {
  TANQUE_ESTOURADO:   { icone: '⛽', cor: '#ef4444', label: 'Acima da capacidade do tanque' },
  KM_VOLTOU:          { icone: '↩️', cor: '#ef4444', label: 'Odômetro voltou pra trás' },
  CHEIO_SEM_RODAR:    { icone: '🅿️', cor: '#f59e0b', label: 'Encheu e quase não rodou' },
  CONSUMO_MUITO_ABAIXO: { icone: '📉', cor: '#f59e0b', label: 'Consumo muito abaixo da média do carro' },
  MESMO_DIA:          { icone: '🔁', cor: '#3b82f6', label: 'Mais de um abastecimento no dia' },
  BOMBONA_SEM_KM:      { icone: '🛢️', cor: '#a78bfa', label: 'Bombona grande sem checagem de km' }
};

function renderAuditoriaLitros(data) {
  const filtro = $('al-filtro')?.value || '';
  const lista = filtro === 'alertas'
    ? data.abastecimentos.filter(a => a.alertas.length > 0)
    : data.abastecimentos;

  const totalLitros = data.abastecimentos.reduce((s,a)=>s+a.liters,0);
  const totalBomb   = data.abastecimentos.filter(a=>a.tipo==='BOMBONA').reduce((s,a)=>s+a.liters,0);
  const totalCusto  = data.abastecimentos.reduce((s,a)=>s+a.custo,0);
  const totalAbast  = data.abastecimentos.length;
  const comAlerta   = data.abastecimentos.filter(a=>a.alertas.length>0).length;

  setHTML('al-totais', `
    <span>Eventos (posto+bombona): <b style="color:var(--orange)">${totalAbast}</b></span>
    <span>Litros: <b style="color:var(--orange)">${totalLitros.toFixed(0)} L</b></span>
    <span>— dos quais bombona: <b style="color:#A78BFA">${totalBomb.toFixed(0)} L</b></span>
    <span>Custo (posto): <b style="color:var(--green)">${totalCusto.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</b></span>
    <span>Média por evento: <b style="color:var(--orange)">${totalAbast>0?(totalLitros/totalAbast).toFixed(1):0} L</b></span>
    <span>Eventos com alerta: <b style="color:${comAlerta>0?'#ef4444':'var(--green)'}">${comAlerta}</b></span>
  `);

  // Ranking de veículos
  const rankRows = data.por_veiculo.slice(0,30).map(v => `<tr>
    <td><code>${v.plate}</code></td>
    <td style="font-size:.82rem">${(v.model||v.vehicle||'').substring(0,25)}</td>
    <td>${v.location || '—'}</td>
    <td>${v.abastecimentos}</td>
    <td style="font-weight:700">${v.litros_total.toFixed(0)} L</td>
    <td style="color:#A78BFA">${v.litros_bombona_total ? v.litros_bombona_total.toFixed(0)+' L' : '—'}</td>
    <td style="font-weight:700;color:var(--green)">${v.custo_total.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
    <td style="font-weight:800;color:${v.alertas_total>0?'#ef4444':'var(--green)'}">${v.alertas_total>0?'🚨 '+v.alertas_total:'✅ 0'}</td>
  </tr>`).join('');
  setHTML('tb-al-ranking', rankRows || emptyRow(8,'Nenhum dado encontrado'));

  // Tabela completa, evento por evento (posto ou bombona)
  const rows = lista.map(a => {
    const alertasHtml = a.alertas.length
      ? a.alertas.map(al => {
          const info = ALERTA_LABELS[al.tipo] || { icone:'⚠️', cor:'#f59e0b', label: al.tipo };
          return `<span title="${al.msg}" style="display:inline-block;background:${info.cor}22;color:${info.cor};border:1px solid ${info.cor}55;padding:1px 6px;border-radius:4px;font-size:.68rem;margin:1px">${info.icone} ${info.label}</span>`;
        }).join(' ')
      : '<span style="color:var(--text3);font-size:.75rem">—</span>';
    const consumo = a.consumo_kml ? `${a.consumo_kml} km/L` : '—';
    const consumoColor = a.media_carro_kml && a.consumo_kml
      ? (a.consumo_kml < a.media_carro_kml * 0.7 ? '#ef4444' : a.consumo_kml < a.media_carro_kml * 0.9 ? '#f59e0b' : 'var(--green)')
      : 'var(--text3)';
    const tipoTag = a.tipo === 'BOMBONA'
      ? '<span class="badge" style="background:rgba(167,139,250,0.2);color:#A78BFA;font-size:.7rem">🛢️ Bombona</span>'
      : '<span class="badge" style="background:rgba(247,147,30,0.2);color:var(--orange);font-size:.7rem">⛽ Posto</span>';
    return `<tr style="${a.alertas.length ? 'background:rgba(239,68,68,0.04)' : ''}">
      <td style="font-size:.8rem">${fmtDate(a.date)}</td>
      <td><code>${a.plate}</code></td>
      <td>${tipoTag}</td>
      <td style="font-size:.82rem">${(a.model||a.vehicle||'').substring(0,22)}</td>
      <td style="font-size:.82rem">${shortName(a.driver)}</td>
      <td style="font-size:.82rem">${a.gas_station || '—'}</td>
      <td style="font-weight:700">${a.liters.toFixed(1)} L</td>
      <td style="font-size:.8rem;color:var(--text3)" title="Soma de tudo (posto+bombona) desde o checkpoint de KM anterior">${a.litros_intervalo.toFixed(1)} L no intervalo</td>
      <td>${a.price_per_liter ? 'R$ '+Number(a.price_per_liter).toFixed(2) : '—'}</td>
      <td style="font-weight:700;color:var(--green)">${a.custo > 0 ? a.custo.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}) : '—'}</td>
      <td style="font-weight:700;color:var(--orange)" title="${a.km_rodado != null ? `Conferência: ${Number(a.km_anterior).toLocaleString('pt-BR')} km (${fmtDate(a.data_km_anterior)}) → ${Number(a.km).toLocaleString('pt-BR')} km (${fmtDate(a.date)}) = ${Number(a.km_rodado).toLocaleString('pt-BR')} km` : 'Sem checkpoint de KM anterior pra comparar'}">${a.km_rodado != null ? Number(a.km_rodado).toLocaleString('pt-BR')+' km ℹ️' : '—'}</td>
      <td style="font-weight:700;color:${consumoColor}">${consumo}</td>
      <td style="font-size:.8rem;color:var(--text3)">${a.media_carro_kml ? a.media_carro_kml+' km/L' : '—'}</td>
      <td>${alertasHtml}</td>
    </tr>`;
  }).join('');
  setHTML('tb-al-abast', rows || emptyRow(14, 'Nenhum evento encontrado para o filtro selecionado'));
}

function exportAuditoriaLitros() {
  if (!AL_DATA) return notify('Gere a auditoria primeiro', 'warning');
  const filtro = $('al-filtro')?.value || '';
  const lista = filtro === 'alertas'
    ? AL_DATA.abastecimentos.filter(a => a.alertas.length > 0)
    : AL_DATA.abastecimentos;

  const headers = ['Data','Placa','Tipo','Veículo','Motorista','Posto/Bombona','Cidade','Litros (evento)','Litros no Intervalo','Preço/L','Custo','KM Odômetro','KM Rodado','Consumo km/L','Média do Carro km/L','Alertas'];
  const rows = lista.map(a => [
    a.date, a.plate, a.tipo, a.model||a.vehicle||'', a.driver, a.gas_station||'', a.city||'',
    a.liters.toFixed(1), a.litros_intervalo.toFixed(1),
    a.price_per_liter?Number(a.price_per_liter).toFixed(2):'', a.custo.toFixed(2),
    a.km||'', a.km_rodado??'', a.consumo_kml||'', a.media_carro_kml||'',
    a.alertas.map(al => (ALERTA_LABELS[al.tipo]?.label || al.tipo)).join('; ')
  ]);
  _exportXLSRaw(headers, rows, 'Auditoria de Litros', `auditoria_litros_${today()}.xlsx`);
}

// ══════════════════════════════════════════════════
// KM RODADO (aba dedicada)
// ══════════════════════════════════════════════════
let KR_DATA = null;

async function gerarKmRodado() {
  const inicio = $('kr-inicio')?.value || '';
  const fim    = $('kr-fim')?.value || '';
  const plate  = $('kr-plate')?.value || '';
  const driver = $('kr-driver')?.value || '';
  const station = $('kr-station')?.value || '';

  let qs = '';
  if (inicio)  qs += `&inicio=${inicio}`;
  if (fim)     qs += `&fim=${fim}`;
  if (plate)   qs += `&plate=${encodeURIComponent(plate)}`;
  if (driver)  qs += `&driver=${encodeURIComponent(driver)}`;
  if (station) qs += `&gas_station=${encodeURIComponent(station)}`;

  loading(true);
  const data = await GET(`/km-rodado?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  KR_DATA = data;

  renderKmRodado(data);
  $('kr-results')?.classList.remove('hidden');
}

function renderKmRodado(data) {
  const totalEventos = data.eventos.length;
  const totalKm = data.por_veiculo.reduce((s,v)=>s+v.km_total,0);
  const totalVeics = data.por_veiculo.length;

  setHTML('kr-totais', `
    <span>Veículos: <b style="color:var(--orange)">${totalVeics}</b></span>
    <span>Eventos: <b style="color:var(--orange)">${totalEventos}</b></span>
    <span>KM Rodado (total): <b style="color:var(--green)">${totalKm.toLocaleString('pt-BR')} km</b></span>
  `);

  // Resumo por veículo
  const vehRows = data.por_veiculo.map(v => `<tr>
    <td><code>${v.plate}</code></td>
    <td style="font-size:.82rem">${(v.model||v.vehicle||'').substring(0,25)}</td>
    <td>${v.location || '—'}</td>
    <td>${v.eventos}</td>
    <td>${v.km_min != null ? Number(v.km_min).toLocaleString('pt-BR')+' km' : '—'}</td>
    <td>${v.km_max != null ? Number(v.km_max).toLocaleString('pt-BR')+' km' : '—'}</td>
    <td style="font-weight:800;color:var(--orange)">${v.km_total.toLocaleString('pt-BR')} km</td>
  </tr>`).join('');
  setHTML('tb-kr-veiculo', vehRows || emptyRow(7,'Nenhum dado encontrado'));

  // Todos os eventos
  const evRows = data.eventos.map(e => {
    const tipoTag = e.tipo === 'BOMBONA'
      ? '<span class="badge" style="background:rgba(167,139,250,0.2);color:#A78BFA;font-size:.7rem">🛢️ Bombona</span>'
      : '<span class="badge" style="background:rgba(247,147,30,0.2);color:var(--orange);font-size:.7rem">⛽ Posto</span>';
    const kmTitle = e.km_rodado != null
      ? `Conferência: ${Number(e.km_anterior).toLocaleString('pt-BR')} km (${fmtDate(e.data_km_anterior)}) → ${Number(e.km).toLocaleString('pt-BR')} km (${fmtDate(e.date)}) = ${Number(e.km_rodado).toLocaleString('pt-BR')} km`
      : 'Sem checkpoint de KM anterior pra comparar';
    return `<tr>
      <td style="font-size:.8rem">${fmtDate(e.date)}</td>
      <td><code>${e.plate}</code></td>
      <td style="font-size:.82rem">${(e.model||e.vehicle||'').substring(0,22)}</td>
      <td>${tipoTag}</td>
      <td style="font-size:.82rem">${shortName(e.driver)}</td>
      <td style="font-size:.82rem">${e.gas_station || '—'}</td>
      <td>${e.km ? Number(e.km).toLocaleString('pt-BR')+' km' : '—'}</td>
      <td style="font-weight:700;color:var(--orange)" title="${kmTitle}">${e.km_rodado != null ? Number(e.km_rodado).toLocaleString('pt-BR')+' km ℹ️' : '—'}</td>
    </tr>`;
  }).join('');
  setHTML('tb-kr-eventos', evRows || emptyRow(8,'Nenhum evento encontrado para o filtro selecionado'));
}

function exportKmRodado() {
  if (!KR_DATA) return notify('Gere o relatório primeiro', 'warning');
  const headers = ['Data','Placa','Veículo','Tipo','Motorista','Posto/Bombona','KM Odômetro','KM Anterior','Data KM Anterior','KM Rodado'];
  const rows = KR_DATA.eventos.map(e => [
    e.date, e.plate, e.model||e.vehicle||'', e.tipo, e.driver, e.gas_station||'',
    e.km||'', e.km_anterior??'', e.data_km_anterior||'', e.km_rodado??''
  ]);
  _exportXLSRaw(headers, rows, 'KM Rodado', `km_rodado_${today()}.xlsx`);
}

// ══════════════════════════════════════════════════
// RELATÓRIO POR POSTO
// ══════════════════════════════════════════════════
let REL_POSTO_DATA = null;

async function gerarRelatorioPosto() {
  const inicio      = $('rp2-inicio')?.value || '';
  const fim         = $('rp2-fim')?.value || '';
  const gas_station = $('rp2-posto')?.value || '';
  const fuel_type   = $('rp2-fuel')?.value || '';

  let qs = '';
  if (inicio)      qs += `&inicio=${inicio}`;
  if (fim)         qs += `&fim=${fim}`;
  if (gas_station) qs += `&gas_station=${encodeURIComponent(gas_station)}`;
  if (fuel_type)   qs += `&fuel_type=${encodeURIComponent(fuel_type)}`;

  loading(true);
  const data = await GET(`/relatorio-posto?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  REL_POSTO_DATA = data;

  renderRelatorioPosto(data);
  $('rp2-results')?.classList.remove('hidden');
}

function renderRelatorioPosto(data) {
  const { por_posto, semanal } = data;

  // Agrupa por posto (somando combustíveis)
  const postoAgg = {};
  por_posto.forEach(p => {
    const key = p.gas_station || 'Desconhecido';
    if (!postoAgg[key]) postoAgg[key] = { name: key, city: p.city, litros:0, custo:0, abast:0, veic:0, mot:0, combustiveis:{} };
    postoAgg[key].litros += parseFloat(p.litros||0);
    postoAgg[key].custo  += parseFloat(p.custo||0);
    postoAgg[key].abast  += parseInt(p.abastecimentos||0);
    postoAgg[key].veic   = Math.max(postoAgg[key].veic, parseInt(p.veiculos_distintos||0));
    postoAgg[key].mot    = Math.max(postoAgg[key].mot, parseInt(p.motoristas_distintos||0));
    postoAgg[key].combustiveis[p.fuel_type] = (postoAgg[key].combustiveis[p.fuel_type]||0) + parseFloat(p.litros||0);
  });

  const postos = Object.values(postoAgg).sort((a,b) => b.custo - a.custo);

  const rows = postos.map(p => {
    const fuels = Object.entries(p.combustiveis).map(([f,l])=>`${f}: ${l.toFixed(0)}L`).join(' · ');
    const pml = p.litros > 0 ? (p.custo/p.litros).toFixed(2) : '—';
    return `<tr>
      <td><b>${p.name}</b></td>
      <td>${p.city || '—'}</td>
      <td>${p.abast}</td>
      <td style="font-weight:700;color:var(--orange)">${p.litros.toFixed(0)} L</td>
      <td style="font-size:.78rem;color:var(--text3)">${fuels}</td>
      <td>${pml !== '—' ? 'R$ '+pml : '—'}</td>
      <td>${p.veic}</td>
      <td>${p.mot}</td>
      <td style="font-weight:700;color:var(--green)">${p.custo.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
    </tr>`;
  }).join('');
  setHTML('tb-rp2-posto', rows || emptyRow(9,'Nenhum dado encontrado'));

  // Por combustível detalhado
  const fuelRows = por_posto.map(p => `<tr>
    <td>${p.gas_station || '—'}</td>
    <td>${p.city || '—'}</td>
    <td>${p.fuel_type || '—'}</td>
    <td>${p.abastecimentos}</td>
    <td style="font-weight:700">${parseFloat(p.litros||0).toFixed(0)} L</td>
    <td>${p.preco_medio ? 'R$ '+parseFloat(p.preco_medio).toFixed(3) : '—'}</td>
    <td style="font-weight:700;color:var(--green)">${parseFloat(p.custo||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</td>
  </tr>`).join('');
  setHTML('tb-rp2-fuel', fuelRows || emptyRow(7,'Nenhum dado'));

  // Gráficos
  const top8 = postos.slice(0,8);
  makeChart('chart-rp2-custo', 'bar', {
    labels: top8.map(p => p.name.replace('Posto ','').substring(0,20)),
    datasets: [{ label:'Custo (R$)', data: top8.map(p => p.custo.toFixed(2)),
      backgroundColor: PALETTE, borderRadius:6, borderSkipped:false }]
  }, { indexAxis:'y', plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`R$ ${Number(ctx.raw).toLocaleString('pt-BR',{minimumFractionDigits:2})}`}}},
      scales:{x:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.07)'}},y:{ticks:{color:'#AAA',font:{size:11}},grid:{color:'rgba(255,255,255,0.04)'}}} });

  makeChart('chart-rp2-litros', 'doughnut', {
    labels: top8.map(p => p.name.substring(0,20)),
    datasets: [{ data: top8.map(p => p.litros.toFixed(0)),
      backgroundColor: PALETTE, borderColor:'#111', borderWidth:3, hoverOffset:8 }]
  });

  // Semanal geral
  const semMap = {};
  (semanal||[]).forEach(s => { semMap[s.semana] = (semMap[s.semana]||0)+parseFloat(s.custo||0); });
  const semanas = Object.keys(semMap).sort().slice(-12);
  makeChart('chart-rp2-semanal', 'line', {
    labels: semanas.map(s=>`Sem. ${fmtDate(s)}`),
    datasets:[{ label:'Custo (R$)', data: semanas.map(s=>semMap[s].toFixed(2)),
      borderColor:CHART_COLORS.orange, backgroundColor:CHART_COLORS.orange2,
      fill:true, tension:0.4, pointRadius:3 }]
  }, { plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`R$ ${Number(ctx.raw).toLocaleString('pt-BR',{minimumFractionDigits:2})}`}}} });
}

// ══════════════════════════════════════════════════
// RELATÓRIO UNIFICADO BOMBONAS (entrada + saída)
// ══════════════════════════════════════════════════
let REL_BOMB_DATA = null;

async function gerarRelatorioBombona() {
  const inicio      = $('rb-inicio')?.value || '';
  const fim         = $('rb-fim')?.value || '';
  const bombona_id  = $('rb-bombona')?.value || '';
  const operator_id = $('rb-operador')?.value || '';

  let qs = '';
  if (inicio)      qs += `&inicio=${inicio}`;
  if (fim)         qs += `&fim=${fim}`;
  if (bombona_id)  qs += `&bombona_id=${bombona_id}`;
  if (operator_id) qs += `&operator_id=${operator_id}`;

  loading(true);
  const data = await GET(`/relatorio-bombona?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  REL_BOMB_DATA = data;

  renderRelatorioBombona(data);
  $('rb-results')?.classList.remove('hidden');
}

function renderRelatorioBombona(data) {
  const { bombonas, movimentos, historico_saldo } = data;

  // Resumo por bombona
  const bRows = bombonas.map(b => {
    const pct = b.capacity_liters > 0 ? (parseFloat(b.current_liters)/parseFloat(b.capacity_liters)*100).toFixed(0) : 0;
    const pctColor = pct >= 40 ? 'var(--green)' : pct >= 20 ? 'var(--yellow)' : 'var(--red)';
    return `<tr>
      <td><b>${b.name}</b></td>
      <td>${b.fuel_type}</td>
      <td>${b.location || '—'}</td>
      <td>
        <div>${shortName(b.responsible_driver)}</div>
        ${b.operator_name ? `<small style="color:var(--text3);font-size:.72rem">${b.operator_name} · ${b.operator_matricula||''}</small>` : ''}
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;background:rgba(255,255,255,0.08);border-radius:4px;height:8px;min-width:60px">
            <div style="width:${Math.min(pct,100)}%;height:8px;border-radius:4px;background:${pctColor}"></div>
          </div>
          <span style="color:${pctColor};font-size:.82rem;white-space:nowrap">${parseFloat(b.current_liters).toFixed(0)}/${parseFloat(b.capacity_liters).toFixed(0)} L</span>
        </div>
      </td>
      <td style="color:var(--green);font-weight:700">+${parseFloat(b.total_entradas||0).toFixed(0)} L</td>
      <td style="color:var(--red);font-weight:700">-${parseFloat(b.total_saidas||0).toFixed(0)} L</td>
      <td style="font-weight:800;color:var(--orange)">${(parseFloat(b.total_entradas||0)-parseFloat(b.total_saidas||0)).toFixed(0)} L</td>
      <td>${b.qtd_entradas}</td>
      <td>${b.qtd_saidas}</td>
    </tr>`;
  }).join('');
  setHTML('tb-rb-resumo', bRows || emptyRow(10,'Nenhuma bombona encontrada'));

  // Movimentações detalhadas
  const movRows = (movimentos||[]).map(m => {
    const isEntrada = m.tipo === 'ENTRADA';
    return `<tr>
      <td style="font-size:.8rem">${fmtDate(m.date)}</td>
      <td><b>${m.bombona_name || '—'}</b></td>
      <td>${m.fuel_type || '—'}</td>
      <td>${m.location || '—'}</td>
      <td><span class="badge" style="background:${isEntrada?'rgba(34,197,94,0.15)':'rgba(239,68,68,0.15)'};color:${isEntrada?'var(--green)':'var(--red)'};font-size:.72rem">${isEntrada?'⬆ ENTRADA':'⬇ SAÍDA'}</span></td>
      <td style="font-weight:700;color:${isEntrada?'var(--green)':'var(--red)'}">${isEntrada?'+':''}${isEntrada?parseFloat(m.liters).toFixed(0):'-'+parseFloat(m.liters).toFixed(0)} L</td>
      <td>${shortName(m.driver)}</td>
      <td>${m.vehicle_plate ? `<b>${m.vehicle_plate}</b> ${m.vehicle_model||''}` : isEntrada ? '— (entrada)' : '— (saída direta)'}</td>
      <td style="font-size:.78rem">${m.notes || '—'}</td>
      <td style="font-size:.78rem">${shortName(m.registered_by) || '—'}</td>
    </tr>`;
  }).join('');
  setHTML('tb-rb-movimentos', movRows || emptyRow(10,'Nenhuma movimentação no período'));

  // Semanal (gráfico entradas vs saídas)
  const semMap = {};
  (historico_saldo||[]).forEach(s => {
    if (!semMap[s.semana]) semMap[s.semana] = { entradas:0, saidas:0 };
    semMap[s.semana].entradas += parseFloat(s.entradas||0);
    semMap[s.semana].saidas   += parseFloat(s.saidas||0);
  });
  const semanas = Object.keys(semMap).sort().slice(-12);
  makeChart('chart-rb-semanal', 'bar', {
    labels: semanas.map(s=>`Sem. ${fmtDate(s)}`),
    datasets:[
      { label:'Entradas (L)', data:semanas.map(s=>semMap[s].entradas.toFixed(1)), backgroundColor:CHART_COLORS.green, borderRadius:4, borderSkipped:false },
      { label:'Saídas (L)',   data:semanas.map(s=>semMap[s].saidas.toFixed(1)),   backgroundColor:CHART_COLORS.red,   borderRadius:4, borderSkipped:false },
    ]
  }, { plugins:{legend:{labels:{color:'#AAA',font:{size:11}}}},
      scales:{x:{ticks:{color:'#666'},grid:{color:'rgba(255,255,255,0.07)'}},y:{ticks:{color:'#AAA',font:{size:11}},grid:{color:'rgba(255,255,255,0.04)'}}} });

  // Pizza saldo x saído
  const totalEnt = bombonas.reduce((s,b)=>s+parseFloat(b.total_entradas||0),0);
  const totalSai = bombonas.reduce((s,b)=>s+parseFloat(b.total_saidas||0),0);
  const totalAtl = bombonas.reduce((s,b)=>s+parseFloat(b.current_liters||0),0);
  makeChart('chart-rb-pizza', 'doughnut', {
    labels:['Saído para veículos/campo (L)','Saldo atual (L)'],
    datasets:[{ data:[totalSai.toFixed(0), totalAtl.toFixed(0)],
      backgroundColor:[CHART_COLORS.orange, CHART_COLORS.green], borderColor:'#111', borderWidth:3, hoverOffset:8 }]
  });

  // Totais
  setHTML('rb-totais', `
    <span>Bombona(s): <b style="color:var(--orange)">${bombonas.length}</b></span>
    <span>Total entradas: <b style="color:var(--green)">+${totalEnt.toFixed(0)} L</b></span>
    <span>Total saídas: <b style="color:var(--red)">-${totalSai.toFixed(0)} L</b></span>
    <span>Saldo atual: <b style="color:var(--orange)">${totalAtl.toFixed(0)} L</b></span>
  `);
}

// Popula selects dos novos relatórios
function populateRelatorioSelects() {
  // Placa dos veículos — sempre repopula (dados podem ter mudado)
  const rvPlate = $('rv-plate');
  if (rvPlate) {
    rvPlate.innerHTML = '<option value="">Todos os veículos</option>';
    DATA.vehicles.filter(v => v.status === 'Ativo').sort((a,b)=>a.plate>b.plate?1:-1).forEach(v => {
      rvPlate.innerHTML += `<option value="${v.plate}">${v.plate} — ${v.model}</option>`;
    });
  }
  const alPlate = $('al-plate');
  if (alPlate) {
    alPlate.innerHTML = '<option value="">Todos os veículos</option>';
    DATA.vehicles.filter(v => v.status === 'Ativo').sort((a,b)=>a.plate>b.plate?1:-1).forEach(v => {
      alPlate.innerHTML += `<option value="${v.plate}">${v.plate} — ${v.model}</option>`;
    });
  }
  const krPlate = $('kr-plate');
  if (krPlate) {
    krPlate.innerHTML = '<option value="">Todos os veículos</option>';
    DATA.vehicles.filter(v => v.status === 'Ativo').sort((a,b)=>a.plate>b.plate?1:-1).forEach(v => {
      krPlate.innerHTML += `<option value="${v.plate}">${v.plate} — ${v.model}</option>`;
    });
  }
  const krDriver = $('kr-driver');
  if (krDriver) {
    krDriver.innerHTML = '<option value="">Todos os motoristas</option>';
    [...DRIVERS].sort().forEach(d => { krDriver.innerHTML += `<option value="${d}">${d}</option>`; });
  }
  const krStation = $('kr-station');
  if (krStation) {
    krStation.innerHTML = '<option value="">Todos</option>';
    DATA.stations.filter(s=>s.active).forEach(s => { krStation.innerHTML += `<option value="${s.name}">${s.name} — ${s.city}</option>`; });
    (DATA.bombonas || []).forEach(b => { krStation.innerHTML += `<option value="${b.name}">🛢️ ${b.name}</option>`; });
  }
  // Postos
  const rp2Posto = $('rp2-posto');
  if (rp2Posto) {
    rp2Posto.innerHTML = '<option value="">Todos os postos</option>';
    DATA.stations.filter(s=>s.active).forEach(s => {
      rp2Posto.innerHTML += `<option value="${s.name}">${s.name} — ${s.city}</option>`;
    });
  }
  // Bombonas
  const rbBomb = $('rb-bombona');
  if (rbBomb) {
    rbBomb.innerHTML = '<option value="">Todas as bombonas</option>';
    DATA.bombonas.forEach(b => {
      rbBomb.innerHTML += `<option value="${b.id}">${b.name} — ${b.location||'—'}</option>`;
    });
  }
  // Operadores (novo filtro para relatório de bombonas)
  const rbOp = $('rb-operador');
  if (rbOp) {
    rbOp.innerHTML = '<option value="">Todos os operadores</option>';
    (DATA.operators || []).forEach(op => {
      rbOp.innerHTML += `<option value="${op.id}">${op.name} (${op.matricula})</option>`;
    });
  }
}

// Export do relatório por veículo
function exportRelVeiculo() {
  if (!REL_VEH_DATA) return notify('Gere o relatório primeiro', 'warning');
  const { por_veiculo, trans_veiculo } = REL_VEH_DATA;
  const transMap = {};
  (trans_veiculo||[]).forEach(t => { transMap[t.plate] = (transMap[t.plate]||0) + parseFloat(t.litros_bombona||0); });

  const headers = ['Placa','Modelo','Tipo','Localidade','Abastecimentos','Méd. L/Abast.','Méd. R$/Abast.','Preço Médio','Litros Posto','Litros Bombona','Total Litros','KM Rodados','Média km/L','CPK R$/km','Custo Total'];
  const rows = por_veiculo.map(v => {
    const lb = transMap[v.plate]||0;
    const lt = parseFloat(v.litros_posto||0)+lb;
    const m = v.km_percorrido>0&&lt>0?(parseFloat(v.km_percorrido)/lt).toFixed(1):'';
    const cpk = v.km_percorrido>0&&v.custo_posto>0?(parseFloat(v.custo_posto)/parseFloat(v.km_percorrido)).toFixed(3):'';
    const medL = v.media_litros_abastecimento!=null?parseFloat(v.media_litros_abastecimento).toFixed(1):'';
    const medR = v.media_custo_abastecimento!=null?parseFloat(v.media_custo_abastecimento).toFixed(2):'';
    const pm = v.preco_medio?parseFloat(v.preco_medio).toFixed(3):'';
    return [v.plate,v.model||v.vehicle||'',v.type||'',v.location||'',v.abastecimentos,
      medL,medR,pm,
      parseFloat(v.litros_posto||0).toFixed(0),lb.toFixed(0),lt.toFixed(0),
      v.km_percorrido||'',m,cpk,parseFloat(v.custo_posto||0).toFixed(2)];
  });
  _exportXLSRaw(headers, rows, 'Por Veículo', `relatorio_veiculo_${today()}.xlsx`);
}

function exportRelatorioPosto() {
  if (!REL_POSTO_DATA) return notify('Gere o relatório primeiro', 'warning');
  const { por_posto } = REL_POSTO_DATA;
  const headers = ['Posto','Cidade','Combustível','Abastecimentos','Litros','Preço Médio','Custo Total','Veículos','Motoristas'];
  const rows = por_posto.map(p => [p.gas_station||'',p.city||'',p.fuel_type||'',p.abastecimentos,
    parseFloat(p.litros||0).toFixed(0),p.preco_medio?parseFloat(p.preco_medio).toFixed(3):'',
    parseFloat(p.custo||0).toFixed(2),p.veiculos_distintos,p.motoristas_distintos]);
  _exportXLSRaw(headers, rows, 'Por Posto', `relatorio_posto_${today()}.xlsx`);
}

function exportRelatorioBombona() {
  if (!REL_BOMB_DATA) return notify('Gere o relatório primeiro', 'warning');
  const { movimentos } = REL_BOMB_DATA;
  const headers = ['Data','Bombona','Combustível','Localidade','Tipo','Litros','Responsável','Placa Veículo','Veículo','Registrado Por','Notas'];
  const rows = movimentos.map(m => [m.date||'',m.bombona_name||'',m.fuel_type||'',m.location||'',m.tipo,
    parseFloat(m.liters||0).toFixed(0),m.driver||'',m.vehicle_plate||'',m.vehicle_model||'',m.registered_by||'',m.notes||'']);
  _exportXLSRaw(headers, rows, 'Movimentações', `relatorio_bombonas_${today()}.xlsx`);
}

function _exportXLSRaw(headers, rows, sheetName, filename) {
  if (typeof XLSX !== 'undefined') {
    try {
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = headers.map((h,i) => ({ wch: Math.min(Math.max(String(h).length, ...rows.map(r=>String(r[i]||'').length)) + 2, 45) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      XLSX.writeFile(wb, filename);
      notify(`✅ ${filename} exportado!`);
      return;
    } catch(e) { console.warn('SheetJS falhou:', e.message); }
  }
  const lines = [headers, ...rows].map(r => r.map(v=>`"${String(v===null||v===undefined?'':v).replace(/"/g,'""')}"`).join(';'));
  const blob = new Blob(['\uFEFF'+lines.join('\r\n')], { type:'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = filename.replace('.xlsx','.csv');
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  notify(`✅ ${a.download} exportado!`);
}

// ══════════════════════════════════════════════════
// RELATÓRIO POR LOCALIDADE
// ══════════════════════════════════════════════════
let REL_LOC_DATA = null;

async function gerarRelatorioLocalidade() {
  const inicio    = $('rl-inicio')?.value || '';
  const fim       = $('rl-fim')?.value || '';
  const cidade    = $('rl-cidade')?.value || '';
  const fuel_type = $('rl-fuel')?.value || '';

  let qs = '';
  if (inicio)    qs += `&inicio=${inicio}`;
  if (fim)       qs += `&fim=${fim}`;
  if (cidade)    qs += `&cidade=${encodeURIComponent(cidade)}`;
  if (fuel_type) qs += `&fuel_type=${encodeURIComponent(fuel_type)}`;

  loading(true);
  const data = await GET(`/relatorio-localidade?${qs.slice(1)}`);
  loading(false);
  if (!data) return;
  REL_LOC_DATA = data;

  renderRelLocalidade(data);
  $('rl-results')?.classList.remove('hidden');
}

function renderRelLocalidade(data) {
  const { resumo, bombona, semanal, veiculos, postos, combustiveis, historico } = data;

  // ── Mescla resumo posto + bombona por cidade ─────────────────────────────
  const bombMap = {};
  (bombona || []).forEach(b => {
    bombMap[b.cidade] = (bombMap[b.cidade] || 0) + parseFloat(b.litros_bombona || 0);
  });

  // Cidades únicas (posto + bombona)
  const cidadesSet = new Set([
    ...resumo.map(r => r.cidade),
    ...bombona.map(b => b.cidade)
  ]);

  // Cards de totais gerais
  const totalLitrosPosto = resumo.reduce((s, r) => s + parseFloat(r.litros_posto || 0), 0);
  const totalLitrosBomb  = bombona.reduce((s, b) => s + parseFloat(b.litros_bombona || 0), 0);
  const totalCusto       = resumo.reduce((s, r) => s + parseFloat(r.custo_posto || 0), 0);
  const totalVeics       = new Set(resumo.flatMap(r => [])).size; // contado por cidade abaixo

  setHTML('rl-totais', `
    <span>Cidades: <b style="color:var(--orange)">${cidadesSet.size}</b></span>
    <span>Litros em posto: <b style="color:var(--orange)">${totalLitrosPosto.toFixed(0)} L</b></span>
    <span>Litros de bombona: <b style="color:#A78BFA">${totalLitrosBomb.toFixed(0)} L</b></span>
    <span>Total combustível: <b style="color:var(--orange)">${(totalLitrosPosto + totalLitrosBomb).toFixed(0)} L</b></span>
    <span>Custo total (posto): <b style="color:var(--green)">${totalCusto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</b></span>
  `);

  // ── Tabela resumo por cidade ─────────────────────────────────────────────
  // Constrói mapa de dados de bombona por cidade (mais detalhe)
  const bombDetalheMap = {};
  (bombona || []).forEach(b => { bombDetalheMap[b.cidade] = b; });

  const resumoMap = {};
  (resumo || []).forEach(r => { resumoMap[r.cidade] = r; });

  const todasCidades = [...cidadesSet].sort();
  const resRows = todasCidades.map(cidade => {
    const r  = resumoMap[cidade] || {};
    const bd = bombDetalheMap[cidade] || {};
    const lp = parseFloat(r.litros_posto || 0);
    const lb = parseFloat(bd.litros_bombona || 0);
    const lt = lp + lb;
    const cu = parseFloat(r.custo_posto || 0);
    return `<tr style="cursor:pointer" onclick="filtrarCidadeDetalhe('${cidade.replace(/'/g,"\\'")}')">
      <td><b>${cidade}</b></td>
      <td>${r.abastecimentos_posto || 0}</td>
      <td>${r.veiculos_distintos || bd.veiculos_distintos_bomb || 0}</td>
      <td>${r.motoristas_distintos || bd.motoristas_distintos_bomb || 0}</td>
      <td style="font-weight:700">${lp.toFixed(0)} L</td>
      <td style="font-weight:700;color:#A78BFA">${lb.toFixed(0)} L</td>
      <td style="font-weight:800;color:var(--orange)">${lt.toFixed(0)} L</td>
      <td>${r.preco_medio ? 'R$ ' + parseFloat(r.preco_medio).toFixed(3) : '—'}</td>
      <td style="font-weight:700;color:var(--green)">${cu.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
      <td style="font-size:.75rem;color:var(--text3)">🔍 ver detalhes</td>
    </tr>`;
  }).join('');
  setHTML('tb-rl-resumo', resRows || emptyRow(10, 'Nenhum dado encontrado'));

  // ── Gráfico 1: litros por cidade (posto + bombona empilhado) ─────────────
  const top8 = todasCidades
    .map(c => ({ c, lp: parseFloat(resumoMap[c]?.litros_posto || 0), lb: parseFloat(bombDetalheMap[c]?.litros_bombona || 0) }))
    .sort((a, b) => (b.lp + b.lb) - (a.lp + a.lb))
    .slice(0, 8);
  makeChart('chart-rl-litros', 'bar', {
    labels: top8.map(x => x.c),
    datasets: [
      { label: 'Posto (L)', data: top8.map(x => x.lp.toFixed(1)), backgroundColor: CHART_COLORS.orange, borderRadius: 4, borderSkipped: false },
      { label: 'Bombona (L)', data: top8.map(x => x.lb.toFixed(1)), backgroundColor: 'rgba(167,139,250,0.8)', borderRadius: 4, borderSkipped: false }
    ]
  }, { plugins: { legend: { labels: { color: '#AAA', font: { size: 11 } } } },
       scales: { x: { stacked: true, ticks: { color: '#AAA', font:{size:10} }, grid: { color: 'rgba(255,255,255,0.07)' } },
                 y: { stacked: true, ticks: { color: '#AAA', font:{size:11} }, grid: { color: 'rgba(255,255,255,0.04)' } } } });

  // ── Gráfico 2: custo por cidade (doughnut) ───────────────────────────────
  const top6custo = [...resumo].sort((a, b) => parseFloat(b.custo_posto) - parseFloat(a.custo_posto)).slice(0, 6);
  makeChart('chart-rl-custo', 'doughnut', {
    labels: top6custo.map(r => r.cidade),
    datasets: [{ data: top6custo.map(r => parseFloat(r.custo_posto || 0).toFixed(2)), backgroundColor: PALETTE, borderColor: '#111', borderWidth: 3, hoverOffset: 8 }]
  });

  // ── Gráfico 3: consumo semanal (agrega todas as cidades) ─────────────────
  const semMap = {};
  (semanal || []).forEach(s => {
    semMap[s.semana] = (semMap[s.semana] || 0) + parseFloat(s.litros || 0);
  });
  const semanas = Object.keys(semMap).sort().slice(-14);
  makeChart('chart-rl-semanal', 'line', {
    labels: semanas.map(s => `Sem. ${fmtDate(s)}`),
    datasets: [{
      label: 'Litros (todas as cidades)', data: semanas.map(s => semMap[s].toFixed(1)),
      borderColor: CHART_COLORS.orange, backgroundColor: CHART_COLORS.orange2, fill: true, tension: 0.35, pointRadius: 3
    }]
  });

  // ── Gráfico 4: preço médio por cidade (horizontal bar) ───────────────────
  const comPreco = [...resumo].filter(r => r.preco_medio > 0).sort((a, b) => parseFloat(b.preco_medio) - parseFloat(a.preco_medio)).slice(0, 8);
  makeChart('chart-rl-preco', 'bar', {
    labels: comPreco.map(r => r.cidade),
    datasets: [{
      label: 'Preço médio R$/L', data: comPreco.map(r => parseFloat(r.preco_medio).toFixed(3)),
      backgroundColor: comPreco.map(r => parseFloat(r.preco_medio) > 7 ? CHART_COLORS.red : parseFloat(r.preco_medio) > 6 ? CHART_COLORS.yellow : CHART_COLORS.green),
      borderRadius: 4, borderSkipped: false
    }]
  }, { indexAxis: 'y', plugins: { legend: { display: false } },
       scales: { x: { ticks: { color: '#666' }, grid: { color: 'rgba(255,255,255,0.07)' } }, y: { ticks: { color: '#AAA', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } } } });

  // ── Tabela veículos por cidade ───────────────────────────────────────────
  const vRows = (veiculos || []).map(v => {
    const media = v.km_percorrido > 0 && v.litros > 0 ? (parseFloat(v.km_percorrido) / parseFloat(v.litros)).toFixed(1) : '—';
    const mc = parseFloat(media) >= 8 ? 'var(--green)' : parseFloat(media) >= 6 ? 'var(--yellow)' : 'var(--red)';
    return `<tr>
      <td><b>${v.cidade}</b></td>
      <td><code>${v.plate}</code></td>
      <td style="font-size:.82rem">${(v.vehicle || '').substring(0, 22)}</td>
      <td>${v.abastecimentos}</td>
      <td style="font-weight:700">${parseFloat(v.litros || 0).toFixed(0)} L</td>
      <td>${v.km_percorrido ? Number(v.km_percorrido).toLocaleString('pt-BR') + ' km' : '—'}</td>
      <td style="font-weight:700;color:${mc}">${media}${media !== '—' ? ' km/L' : ''}</td>
      <td style="font-weight:700;color:var(--green)">${parseFloat(v.custo || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
    </tr>`;
  }).join('');
  setHTML('tb-rl-veiculos', vRows || emptyRow(8, 'Nenhum veículo encontrado'));

  // ── Tabela postos por cidade ─────────────────────────────────────────────
  const postoRows = (postos || []).map(p => `<tr>
    <td><b>${p.cidade}</b></td>
    <td>${p.gas_station}</td>
    <td>${p.abastecimentos}</td>
    <td style="font-weight:700">${parseFloat(p.litros || 0).toFixed(0)} L</td>
    <td>${p.preco_medio ? 'R$ ' + parseFloat(p.preco_medio).toFixed(3) : '—'}</td>
    <td style="font-weight:700;color:var(--green)">${parseFloat(p.custo || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
  </tr>`).join('');
  setHTML('tb-rl-postos', postoRows || emptyRow(6, 'Nenhum posto encontrado'));

  // ── Tabela por combustível ───────────────────────────────────────────────
  const combRows = (combustiveis || []).map(c => `<tr>
    <td><b>${c.cidade}</b></td>
    <td>${c.fuel_type || '—'}</td>
    <td>${c.abastecimentos}</td>
    <td style="font-weight:700">${parseFloat(c.litros || 0).toFixed(0)} L</td>
    <td>${c.preco_medio ? 'R$ ' + parseFloat(c.preco_medio).toFixed(3) : '—'}</td>
    <td style="font-weight:700;color:var(--green)">${parseFloat(c.custo || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
  </tr>`).join('');
  setHTML('tb-rl-comb', combRows || emptyRow(6, 'Nenhum combustível encontrado'));

  // ── Histórico detalhado (só quando filtra por cidade) ───────────────────
  const histRows = (historico || []).map(h => `<tr>
    <td style="font-size:.8rem">${fmtDate(h.date)}</td>
    <td><code>${h.plate || '—'}</code></td>
    <td style="font-size:.82rem">${(h.vehicle || '').substring(0, 20)}</td>
    <td style="font-size:.82rem">${shortName(h.driver)}</td>
    <td style="font-size:.82rem">${h.gas_station || '—'}</td>
    <td>${h.fuel_type || '—'}</td>
    <td style="font-weight:700">${h.liters ? parseFloat(h.liters).toFixed(1) + ' L' : '—'}</td>
    <td>${h.price_per_liter ? 'R$ ' + Number(h.price_per_liter).toFixed(3) : '—'}</td>
    <td style="font-weight:700;color:var(--green)">${h.real_value || '—'}</td>
    <td>${h.km ? Number(h.km).toLocaleString('pt-BR') + ' km' : '—'}</td>
  </tr>`).join('');
  setHTML('tb-rl-historico', histRows || emptyRow(10, 'Selecione uma cidade para ver o histórico'));

  // ── Semanal por cidade (tabela drill-down) ───────────────────────────────
  const cidadeSel = $('rl-cidade')?.value;
  if (cidadeSel) {
    const semCidade = (semanal || []).filter(s => s.cidade === cidadeSel);
    const semRows = semCidade.map(s => `<tr>
      <td>Semana ${fmtDate(s.semana)}</td>
      <td>${s.abastecimentos}</td>
      <td style="font-weight:700">${parseFloat(s.litros || 0).toFixed(0)} L</td>
      <td style="font-weight:700;color:var(--green)">${parseFloat(s.custo || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
    </tr>`).join('');
    setHTML('tb-rl-semanal', semRows || emptyRow(4, 'Nenhum dado semanal'));
    $('rl-semanal-section')?.classList.remove('hidden');
  }
}

// Clique na linha da tabela → filtra pelo select e regera
function filtrarCidadeDetalhe(cidade) {
  const sel = $('rl-cidade');
  if (sel) {
    sel.value = cidade;
    gerarRelatorioLocalidade();
  }
}

// Populate do select de cidades
function populateCidades() {
  const sel = $('rl-cidade');
  if (!sel) return;
  // Extrai cidades únicas de requisições já carregadas
  const cidades = [...new Set(DATA.fuelRecords.map(r => r.city).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todas as cidades</option>';
  cidades.forEach(c => { sel.innerHTML += `<option value="${c}">${c}</option>`; });
}

// Export
function exportRelLocalidade() {
  if (!REL_LOC_DATA) return notify('Gere o relatório primeiro', 'warning');
  const { resumo, bombona } = REL_LOC_DATA;
  const bombMap = {};
  (bombona || []).forEach(b => { bombMap[b.cidade] = parseFloat(b.litros_bombona || 0); });
  const headers = ['Cidade', 'Abastecimentos', 'Veículos', 'Motoristas', 'Litros Posto', 'Litros Bombona', 'Total Litros', 'Preço Médio R$/L', 'Custo Total'];
  const rows = resumo.map(r => {
    const lb = bombMap[r.cidade] || 0;
    return [r.cidade, r.abastecimentos_posto, r.veiculos_distintos, r.motoristas_distintos,
      parseFloat(r.litros_posto || 0).toFixed(0), lb.toFixed(0),
      (parseFloat(r.litros_posto || 0) + lb).toFixed(0),
      r.preco_medio ? parseFloat(r.preco_medio).toFixed(3) : '',
      parseFloat(r.custo_posto || 0).toFixed(2)];
  });
  _exportXLSRaw(headers, rows, 'Por Localidade', `relatorio_localidade_${today()}.xlsx`);
}

// Expande/recolhe as linhas de detalhe de um veículo na tabela de Consumo
function toggleVehDetalhes(plate, trEl) {
  const key = plate.replace(/[^a-zA-Z0-9]/g, '_');
  const rows = document.querySelectorAll(`.veh-det-${key}`);
  if (!rows.length) return;
  const isOpen = rows[0].style.display !== 'none';
  rows.forEach(r => r.style.display = isOpen ? 'none' : 'table-row');
  // Atualiza a seta na última célula da linha resumo
  const lastCell = trEl.querySelector('td:last-child');
  if (lastCell) lastCell.textContent = `${rows.length} abast. ${isOpen ? '▶' : '▼'}`;
}


// ── LANÇAMENTO RETROATIVO ─────────────────────────────────────────────────────
async function openRetroativo() {
  // Popula motoristas
  const drSel = document.getElementById('rt-driver');
  drSel.innerHTML = '<option value="">Selecionar...</option>' +
    DRIVERS.map(d => `<option value="${d}">${d}</option>`).join('');

  // Popula placas (veículos)
  try {
    const veics = await GET('/vehicles');
    const plSel = document.getElementById('rt-plate');
    plSel.innerHTML = '<option value="">Selecionar...</option>' +
      veics.map(v => `<option value="${v.plate}" data-model="${v.model}">${v.plate} — ${v.model}</option>`).join('');
    plSel.onchange = function() {
      const opt = this.options[this.selectedIndex];
      document.getElementById('rt-vehicle').value = opt.dataset.model || '';
    };
  } catch(e) { console.warn('Falha ao carregar veículos retroativo:', e.message); }

  // Popula postos
  try {
    const stations = await GET('/stations');
    const stSel = document.getElementById('rt-station');
    stSel.innerHTML = '<option value="">Selecionar...</option>' +
      stations.filter(s => s.active).map(s => `<option value="${s.name}">${s.name} — ${s.city}</option>`).join('');
  } catch(e) { console.warn('Falha ao carregar postos retroativo:', e.message); }

  // Data padrão: ontem (para forçar o usuário a escolher uma data passada)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  document.getElementById('rt-date').value = yesterday.toISOString().split('T')[0];
  document.getElementById('rt-date').max = yesterday.toISOString().split('T')[0];

  // Limpa campos
  ['rt-city','rt-vehicle','rt-liters','rt-ppl','rt-value','rt-km','rt-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  openModal('m-retroativo');
}

async function submitRetroativo() {
  const driver  = document.getElementById('rt-driver')?.value?.trim();
  const date    = document.getElementById('rt-date')?.value;
  const plate   = document.getElementById('rt-plate')?.value;
  const vehicle = document.getElementById('rt-vehicle')?.value?.trim();
  const value   = document.getElementById('rt-value')?.value?.trim();

  if (!driver)  return alert('Selecione o motorista.');
  if (!date)    return alert('Informe a data.');
  if (!vehicle) return alert('Informe o veículo.');
  if (!value)   return alert('Informe o valor total.');

  // Valida que a data não é futura
  if (new Date(date) >= new Date(new Date().toDateString()))
    return alert('A data deve ser anterior a hoje (retroativo).');

  const btn = document.getElementById('rt-submit-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Lançando...';

  try {
    const body = {
      driver,
      date,
      plate:          plate || null,
      vehicle,
      city:           document.getElementById('rt-city')?.value?.trim() || null,
      gas_station:    document.getElementById('rt-station')?.value || null,
      fuel_type:      document.getElementById('rt-fuel')?.value || 'Diesel S10',
      fuel_method:    document.getElementById('rt-method')?.value || 'tanque',
      liters:         document.getElementById('rt-liters')?.value || null,
      price_per_liter:document.getElementById('rt-ppl')?.value || null,
      real_value:     value,
      estimated_value:value,
      km:             document.getElementById('rt-km')?.value || null,
      notes:          document.getElementById('rt-notes')?.value?.trim() || null,
      supervisor:     SESSION.name || 'Supervisor',
    };

    const res = await POST('/requests/retroativo', body);
    closeModal('m-retroativo');
    showToast(`✅ ${res.id} lançado como Concluído!`, 'success');
    // Recarrega a lista se estiver na tela de requisições ou abastecimentos
    const activeScreen = document.querySelector('.screen.active')?.id || '';
    if (activeScreen === 'screen-requests') {
      const reqs = await GET('/requests' + (SESSION.isSup ? '' : `?driver=${encodeURIComponent(SESSION.name)}`));
      if (reqs) DATA.requests = reqs;
      renderReqs();
    }
    if (activeScreen === 'screen-fuel-records') {
      const fuels = await GET('/fuel-records');
      if (fuels) DATA.fuelRecords = fuels;
      renderFuelRecords();
    }
  } catch(e) {
    notify('Erro: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Lançar como Concluído';
  }
}
