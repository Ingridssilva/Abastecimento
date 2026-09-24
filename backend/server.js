require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Lista de emails autorizados como supervisores ────────────────────────────
// Pode ser movida para o banco futuramente
const SUPERVISOR_EMAILS = [
  'supervisor1@empresaexemplo.com.br',
  'supervisor2@empresaexemplo.com.br',
  'supervisor3@empresaexemplo.com.br',
  'ti@empresaexemplo.com.br',
];

// ── Rota: valida token Azure AD e retorna perfil do usuário ──────────────────
// Frontend envia o access_token Microsoft → backend valida chamando Graph API
app.post('/api/auth/microsoft', express.json(), async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Token não fornecido' });

    // Busca perfil do usuário no Microsoft Graph
    const profile = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const email = (profile.data.mail || profile.data.userPrincipalName || '').toLowerCase();
    const displayName = profile.data.displayName || email;

    // Verifica se é domínio da empresa
    if (!email.endsWith('@empresaexemplo.com.br')) {
      return res.status(403).json({ error: 'Acesso restrito a contas @empresaexemplo.com.br' });
    }

    const isSupervisor = SUPERVISOR_EMAILS.includes(email);
    const token = signSession({ email, name: displayName, isSupervisor });

    res.json({
      success: true,
      email,
      displayName,
      isSupervisor,
      sessionToken: token
    });
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    console.error('Auth Microsoft falhou:', detail);
    res.status(401).json({ error: 'Token inválido ou expirado: ' + detail });
  }
});

const crypto = require('crypto');

// ── Sessões em memória (token → { email, name, isSupervisor, exp }) ──────────
// Para produção robusta, usar Redis ou JWT assinado. Aqui usamos HMAC-SHA256.
// FIX: precisa ser `let` (não `const`) para poder ser substituído pelo valor
// persistido no banco (ver initDB) quando a env var JWT_SECRET não existir.
let JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function signSession(payload) {
  const data = JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600 * 1000 }); // 12h
  const sig  = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64') + '.' + sig;
}

function verifySession(token) {
  try {
    const [dataB64, sig] = token.split('.');
    const data = Buffer.from(dataB64, 'base64').toString();
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(data);
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ── Middleware de autenticação ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  // Quando usado com app.use('/api', ...), req.path NÃO tem o prefixo /api
  const pub = ['/auth/microsoft', '/auth/driver', '/operators/login', '/health', '/ms-diagnostico'];
  if (pub.some(p => req.path.startsWith(p))) return next();

  const token = req.headers['x-session-token'] || req.query._tok;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });

  const session = verifySession(token);
  if (!session) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });

  req.session = session;
  next();
}

// ── Login de motorista (só nome — gera token de 12h) ─────────────────────────
app.post('/api/auth/driver', express.json(), (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
    const token = signSession({ name: name.trim().toUpperCase(), isSupervisor: false, isOperator: false, role: 'driver' });
    res.json({ success: true, sessionToken: token });
  } catch(e) {
    console.error('auth/driver erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Middleware de supervisor ──────────────────────────────────────────────────
function requireSup(req, res, next) {
  if (!req.session?.isSupervisor && !req.session?.isOperator) {
    return res.status(403).json({ error: 'Acesso restrito a supervisores' });
  }
  next();
}
function requireSupOnly(req, res, next) {
  if (!req.session?.isSupervisor) {
    return res.status(403).json({ error: 'Acesso restrito a supervisores' });
  }
  next();
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — aceita qualquer câmera
});

// CORS — aceita frontend local (dev) e mesmo domínio (produção)
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5500';
app.use(cors({
  origin: [FRONTEND_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:5500'],
  credentials: true
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve o frontend a partir da pasta ../frontend (quando em produção conjunta)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Auth middleware global (aplica em todas as rotas /api/*) ─────────────────
app.use('/api', requireAuth);

// ── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10, idleTimeoutMillis: 30000
});

// ── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  const c = await pool.connect();
  try {
    // Cria todas as tabelas em paralelo (muito mais rápido)
    await Promise.all([
      c.query(`CREATE TABLE IF NOT EXISTS vehicles (
        plate TEXT PRIMARY KEY,
        equipment_id TEXT, brand TEXT, model TEXT NOT NULL,
        type TEXT DEFAULT 'VEICULO', sector TEXT, year TEXT,
        color TEXT DEFAULT 'N/A', fuel_type TEXT DEFAULT 'DIESEL',
        tank_capacity REAL, avg_consumption REAL, location TEXT,
        ownership TEXT DEFAULT 'PROPRIO', lessor TEXT, tracker TEXT DEFAULT 'NÃO',
        status TEXT DEFAULT 'Ativo', km BIGINT DEFAULT 0,
        last_fuel TEXT DEFAULT 'Nunca', created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, driver TEXT NOT NULL,
        plate TEXT, vehicle TEXT NOT NULL,
        city TEXT, gas_station TEXT, fuel_type TEXT, fuel_method TEXT,
        fuel_method_qty REAL,
        status TEXT DEFAULT 'pending', date TEXT,
        supervisor TEXT DEFAULT 'Pendente',
        estimated_value TEXT, real_value TEXT,
        price_per_liter REAL, liters TEXT,
        km BIGINT, horimetre TEXT,
        priority TEXT DEFAULT 'normal', notes TEXT,
        pdf_url TEXT, pdf_sharepoint_id TEXT,
        sharepoint_folder TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS request_seq (year INT PRIMARY KEY, last_seq INT DEFAULT 0)`),
      c.query(`CREATE TABLE IF NOT EXISTS request_photos (
        id SERIAL PRIMARY KEY,
        request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
        photo_type TEXT NOT NULL, original_name TEXT,
        sharepoint_url TEXT, sharepoint_item_id TEXT,
        uploaded_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS fuel_records (
        id SERIAL PRIMARY KEY,
        request_id TEXT REFERENCES requests(id) ON DELETE CASCADE,
        driver TEXT NOT NULL, vehicle TEXT NOT NULL,
        gas_station TEXT, fuel_type TEXT,
        estimated_value TEXT, real_value TEXT,
        price_per_liter REAL, liters TEXT,
        status TEXT DEFAULT 'pending', date TEXT, notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS fuel_prices (fuel_type TEXT PRIMARY KEY, price REAL NOT NULL, last_update TIMESTAMPTZ DEFAULT NOW())`),
      c.query(`CREATE TABLE IF NOT EXISTS bombona_operators (
        id SERIAL PRIMARY KEY,
        matricula TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS stations (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL,
        active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS bombonas (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL, fuel_type TEXT NOT NULL,
        capacity_liters REAL NOT NULL, current_liters REAL NOT NULL DEFAULT 0,
        responsible_driver TEXT NOT NULL,
        operator_id INTEGER,
        location TEXT, notes TEXT, status TEXT DEFAULT 'Ativa',
        locked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS bombona_transfers (
        id SERIAL PRIMARY KEY,
        bombona_id INTEGER REFERENCES bombonas(id) ON DELETE CASCADE,
        driver TEXT NOT NULL,
        vehicle_plate TEXT, vehicle_model TEXT,
        liters REAL NOT NULL, notes TEXT, date TEXT NOT NULL,
        sharepoint_folder TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT,
        actor TEXT NOT NULL,
        actor_email TEXT,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
      c.query(`CREATE TABLE IF NOT EXISTS bombona_photos (
        id SERIAL PRIMARY KEY,
        transfer_id INTEGER REFERENCES bombona_transfers(id) ON DELETE CASCADE,
        photo_type TEXT NOT NULL, original_name TEXT,
        sharepoint_url TEXT, sharepoint_item_id TEXT,
        uploaded_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    ]);

    // Migrações rápidas (ADD COLUMN IF NOT EXISTS é idempotente)
    await Promise.all([
      c.query(`ALTER TABLE bombonas ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE`),
      c.query(`ALTER TABLE bombonas ADD COLUMN IF NOT EXISTS operator_id INTEGER`),
      // Remove FK constraint se existir (pode ter sido criada por versão anterior)
      c.query(`ALTER TABLE bombonas DROP CONSTRAINT IF EXISTS bombonas_operator_id_fkey`),
      // Migração: popular operator_id a partir do responsible_driver existente
      c.query(`UPDATE bombonas b SET operator_id = o.id FROM bombona_operators o WHERE b.operator_id IS NULL AND UPPER(b.responsible_driver) = UPPER(o.name)`),
      c.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`),
      // FIX: guardam o "estado anterior" para permitir reverter corretamente ao anular (voided)
      c.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS bombona_creditado REAL DEFAULT 0`),
      c.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS km_before BIGINT`),
      c.query(`ALTER TABLE bombona_transfers ADD COLUMN IF NOT EXISTS registered_by TEXT`),
      // NOVO: km do veículo no momento da transferência — sem isso, transferência
      // de bombona era um "buraco" sem checagem de odômetro na auditoria de litros.
      c.query(`ALTER TABLE bombona_transfers ADD COLUMN IF NOT EXISTS km BIGINT`),
      c.query(`ALTER TABLE bombona_transfers ADD COLUMN IF NOT EXISTS km_before BIGINT`),
      c.query(`CREATE INDEX IF NOT EXISTS idx_req_driver ON requests(driver)`),
      c.query(`CREATE INDEX IF NOT EXISTS idx_req_status ON requests(status)`),
      c.query(`CREATE INDEX IF NOT EXISTS idx_req_date ON requests(date)`),
      c.query(`CREATE INDEX IF NOT EXISTS idx_bomb_driver ON bombonas(responsible_driver)`),
      // Histórico de saldo das bombonas
      c.query(`CREATE TABLE IF NOT EXISTS bombona_saldo_history (
        id SERIAL PRIMARY KEY,
        bombona_id INTEGER REFERENCES bombonas(id) ON DELETE CASCADE,
        saldo_anterior REAL NOT NULL,
        saldo_novo REAL NOT NULL,
        variacao REAL NOT NULL,
        tipo TEXT NOT NULL,
        referencia TEXT,
        actor TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`),
    ]);

    console.log('✅ Tabelas OK');

    // ── FIX: persistência do JWT_SECRET ──────────────────────────────────────
    // Antes: se a env var JWT_SECRET não estivesse configurada, um segredo era
    // gerado em memória a cada início do processo — isso invalida TODAS as sessões
    // ativas a cada deploy/restart no Render. Agora, na ausência da env var, o
    // segredo é gerado uma única vez e persistido em app_config, sendo reaproveitado
    // nos próximos restarts. Recomenda-se ainda assim configurar a env var JWT_SECRET.
    await c.query(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    if (!process.env.JWT_SECRET) {
      const { rows } = await c.query(`SELECT value FROM app_config WHERE key='jwt_secret'`);
      if (rows[0]) {
        JWT_SECRET = rows[0].value;
        console.log('🔐 JWT_SECRET carregado do banco (persistente entre reinícios).');
      } else {
        await c.query(
          `INSERT INTO app_config(key,value) VALUES('jwt_secret',$1) ON CONFLICT(key) DO NOTHING`,
          [JWT_SECRET]
        );
        console.log('🔐 JWT_SECRET gerado e persistido no banco pela primeira vez.');
      }
      console.warn('⚠️ Recomenda-se configurar a variável de ambiente JWT_SECRET no Render por segurança.');
    }

    // Seeds em paralelo (só rodam se tabelas estiverem vazias)
    await Promise.all([seedVehicles(c), seedPrices(c), seedStations(c)]);

  } finally { c.release(); }
}

async function seedStations(c) {
  const { rows } = await c.query('SELECT COUNT(*) FROM stations');

  if (parseInt(rows[0].count) > 0) {
    // ── MIGRAÇÃO BELA TERRA ──────────────────────────────────────────────────
    // Problema: alguém dividiu "Posto Bela Terra" em dois postos novos no banco,
    // mas as requisições históricas continuam com o nome antigo → relatório vazio.
    // Esta migração corrige tudo automaticamente a cada startup.

    // 1. Renomeia o posto genérico "Posto Bela Terra" para o nome Muiraquitã
    //    (só se o Muiraquitã ainda não existir com o nome correto)
    await c.query(`
      UPDATE stations
      SET name = 'Posto Bela Terra Muiraquitã'
      WHERE name = 'Posto Bela Terra'
        AND NOT EXISTS (
          SELECT 1 FROM stations WHERE name = 'Posto Bela Terra Muiraquitã'
        )
    `);

    // 2. Garante que o Santo André existe
    await c.query(`
      INSERT INTO stations(name, city)
      SELECT 'Posto Bela Terra Santo André', 'Santarém'
      WHERE NOT EXISTS (
        SELECT 1 FROM stations WHERE name ILIKE '%Bela Terra Santo Andr%'
      )
    `);

    // 3. Migra requisições históricas com o nome antigo para o Muiraquitã
    const { rowCount } = await c.query(`
      UPDATE requests
      SET gas_station = 'Posto Bela Terra Muiraquitã'
      WHERE gas_station = 'Posto Bela Terra'
    `);
    if (rowCount > 0)
      console.log(`✅ Migração Bela Terra: ${rowCount} requisição(ões) corrigida(s) → "Posto Bela Terra Muiraquitã"`);

    return;
  }

  // Seed inicial (banco vazio)
  const list = [
    ['Posto Amanhecer',                         'Barcarena'],
    ['Nossa Senhora de Nazaré',                 'Curuaí - STM'],
    ['Posto Almeida',                           'Almeirim'],
    ['Posto Bela Terra Muiraquitã',  'Santarém'],
    ['Posto Bela Terra Santo André', 'Santarém'],
    ['Posto Leal 34',                           'Itaituba'],
    ['Posto Castanha',                          'Mojuí dos Campos'],
    ['Posto Petrogás',                          'Almeirim'],
    ['Posto Rebelo e Marinho',                  'Santarém'],
    ['Posto Topázio',                           'Juruti'],
    ['Abastecimento em campo (Bombona)',         'Campo'],
  ];
  for (const [name, city] of list)
    await c.query(`INSERT INTO stations(name,city) VALUES($1,$2)`, [name, city]);
  console.log('✅ Postos inseridos (seed inicial)');
}

// ── Auditoria ──────────────────────────────────────────────────────────────────
async function audit(action, entity, entityId, actor, actorEmail, details) {
  try {
    await pool.query(
      `INSERT INTO audit_log(action,entity,entity_id,actor,actor_email,details) VALUES($1,$2,$3,$4,$5,$6)`,
      [action, entity, entityId, actor || 'Sistema', actorEmail || null, details ? JSON.stringify(details) : null]
    );
  } catch(e) { console.warn('Audit log falhou:', e.message); }
}

// ── Normalização de nomes (remove acentos para comparação) ────────────────────
function normalizeDriver(name) {
  if (!name) return '';
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

// ── Histórico de saldo das bombonas ──────────────────────────────────────────
async function registrarHistoricoBombona(bombonaId, saldoAnterior, saldoNovo, tipo, referencia, actor) {
  try {
    await pool.query(
      `INSERT INTO bombona_saldo_history(bombona_id,saldo_anterior,saldo_novo,variacao,tipo,referencia,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [bombonaId, saldoAnterior, saldoNovo, saldoNovo - saldoAnterior, tipo, referencia || null, actor || 'Sistema']
    );
  } catch(e) { console.warn('Histórico saldo falhou:', e.message); }
}

// ── FIX: helper de transação ───────────────────────────────────────────────
// Garante que operações que tocam mais de uma tabela (ex: requests + fuel_records,
// ou checagem+débito de saldo de bombona) sejam atômicas: ou tudo é gravado, ou nada.
// Use `client.query('... FOR UPDATE')` dentro do callback para travar a linha
// e evitar condição de corrida em leituras seguidas de escrita (check-then-act).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}
async function seedVehicles(c) {
  // [plate, eq_id, brand, model, type, sector, year, color, fuel_type, tank, avg_cons, location, ownership, lessor, tracker]
  const fleet = [
    ['NCF3078','PT01','MITSUBISHI','L200 OUTDOOR','4X4','OFICINA','2004','PRATA','DIESEL',75,10,'SANTARÉM','PROPRIO',null,'NÃO'],
    ['NRP2E59','PT02','MITSUBISHI','L200 TRITON 3.2 D','4X4','OPERAÇÃO','2016','PRATA','DIESEL',90,10,'ITAITUBA','LOCADO',null,'SIM'],
    ['OGI3J31','PT03','MITSUBISHI','L200 TRITON 3.2 D','4X4','OPERAÇÃO','2012','BRANCA','DIESEL',75,10,'SANTARÉM','PROPRIO',null,'NÃO'],
    ['OLI7180','PT04','MITSUBISHI','L200 TRITON GLS D','4X4','OPERAÇÃO','2016','BRANCA','DIESEL',90,10,'SANTARÉM','PROPRIO',null,'SIM'],
    ['PHL2H91','PT05','CHEVROLET','S10 LT','4X4','OFICINA','2017','BRANCA','DIESEL',76,10,'SANTARÉM','PROPRIO',null,'SIM'],
    ['TGM0C73','PT06','TOYOTA','HILUX CDLOWA4SD','4X4','DIRETORIA','2025','PRETA','DIESEL',80,10,'SANTARÉM','PROPRIO',null,'NÃO'],
    ['RXD2B41',null,'MITSUBISHI','TRITON SP OUTD GLS A','4X4','OPERAÇÃO','2023','BRANCA','DIESEL',75,12.5,'SANTARÉM','LOCADO','LOCAY','NÃO'],
    // Caminhões
    ['JJB4E57','CM01','FORD','CARGO 1217','CAMINHÃO','OPERAÇÃO','2002','BRANCA','DIESEL',275,3.5,'SANTARÉM','PROPRIO',null,'NÃO'],
    ['NFW2H74','CM02','FORD','CARGO 1317F','CAMINHÃO','OPERAÇÃO','2002','BRANCA','DIESEL',150,3.5,'SANTARÉM','PROPRIO',null,'NÃO'],
    ['OFP1B78','CM03','VOLKSWAGEM','13.190 CRM 4X2','CAMINHÃO','OPERAÇÃO','2012','BRANCA','DIESEL',275,3.5,'SANTARÉM','LOCADO',null,'SIM'],
    ['QTI4G99','CM04','IVECO','TECTOR 170E29','CAMINHÃO','OPERAÇÃO','2019','BRANCA','DIESEL',275,4.4,'SANTARÉM','LOCADO',null,'SIM'],
    ['QTJ8A19','CM05','IVECO','TECTOR 170E28','CAMINHÃO','OPERAÇÃO','2019','BRANCA','DIESEL',275,4.5,'SANTARÉM','LOCADO',null,'SIM'],
    ['QTJ8B19','CM06','IVECO','TECTOR 170E30','CAMINHÃO','OPERAÇÃO','2019','BRANCA','DIESEL',275,4.5,'SANTARÉM','LOCADO',null,'NÃO'],
    ['SHF6D51','CM07','IVECO','TECTOR 170E21','CAMINHÃO','OPERAÇÃO','2023','BRANCA','DIESEL',275,4,'ITAITUBA','LOCADO',null,'NÃO'],
    ['SHK5E03','CM08','IVECO','TECTOR 170E21','CAMINHÃO','OPERAÇÃO','2023','BRANCA','DIESEL',275,4,'ITAITUBA','LOCADO',null,'SIM'],
    ['TAU9G16','CM09','VOLKSWAGEM','17.210 CRM 4X2','CAMINHÃO','OPERAÇÃO','2024','BRANCA','DIESEL',275,3.5,'SANTARÉM','LOCADO',null,'SIM'],
    ['TAU9G17','CM10','VOLKSWAGEM','17.210 CRM 4X2','CAMINHÃO','OPERAÇÃO','2024','BRANCA','DIESEL',275,3.5,'SANTARÉM','LOCADO',null,'SIM'],
    // Embarcações
    ['FERRYB','FERRYB','SERIE 10 MWM','FERRY BOAT','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','DIESEL',1000,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['BARCBAR1','BARCBAR1','YANMAR 18HP','BALSA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','DIESEL',300,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['BARCBAR2','BARCBAR2','MERCEDES BENZ 330HP','BALSA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','DIESEL',null,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LANCBAR02','LANCBAR02','40HP 4T YAMAHA','LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',24,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LANCBAR03','LANCBAR03','40HP 4T YAMAHA','LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',50,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LANCBAR04','LANCBAR04','60HP 4T YAMAHA','LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',60,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LANCBAR05','LANCBAR05','40HP 2T YAMAHA','LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',24,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LANCBAR06','LANCBAR06','40HP 4T YAMAHA','LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',24,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LANCBAR07','LANCBAR07',null,'LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',24,null,'BARCARENA','LOCADO',null,'NÃO'],
    ['LAN0007','LAN0007','15HP YAMAHA','LANCHA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',24,null,null,'LOCADO',null,'NÃO'],
    ['RABETA10','RABETA10','KAWASHIMA 18HP','RABETA','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','GASOLINA',6.7,null,'BARCARENA','PROPRIO',null,'NÃO'],
    ['BALSA01','BALSA01','HARPIA','FERRY BOAT','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','DIESEL',null,null,'SÃO FRANCISCO','LOCADO',null,'NÃO'],
    ['BALSA02','BALSA02','DONA ZULEIDE','FERRY BOAT','EMBARCAÇÃO','OPERAÇÃO',null,'BRANCA','DIESEL',null,null,'SÃO FRANCISCO','LOCADO',null,'NÃO'],
    // Leve
    ['QVN9H33','CL01','HYUNDAI','HB20','LEVE','ADM','2022','BRANCA','FLEX',50,12.5,'SANTARÉM','LOCADO',null,'NÃO'],
    // Máquinas
    ['RET0001','RET01','CATERPILLAR','416 - Retroescavadeira','RETROESCAVADEIRA','OPERAÇÃO','2025','AMARELA','DIESEL',160,7,'LAGO GRANDE','PROPRIO',null,'NÃO'],
    ['RET0002','RET02','CATERPILLAR','416 - Retroescavadeira','RETROESCAVADEIRA','OPERAÇÃO','2025','AMARELA','DIESEL',160,7,'MOJUI','PROPRIO',null,'NÃO'],
    ['RET0003','RET03','JCB','3CX - Retroescavadeira','RETROESCAVADEIRA','OPERAÇÃO',null,'AMARELA','DIESEL',130,8,'SÃO FRANCISCO','LOCADO',null,'NÃO'],
    ['TRAT01','TRAT01','CASE','FARMALL 80 - Trator','TRATOR','OPERAÇÃO','2025','VERMELHO','DIESEL',140,7,'SANTARÉM','PROPRIO',null,'NÃO'],
    ['TRAT02','TRAT02','CASE','FARMALL 80 - Trator','TRATOR','OPERAÇÃO','2025','VERMELHO','DIESEL',140,7,'SANTARÉM','PROPRIO',null,'NÃO'],
    // Motos
    ['JVE1E37','MT01','YAMAHA','XTZ 125E','MOTO','OPERAÇÃO','2006','PRETA','GASOLINA',11,35,'ALMERIM','PROPRIO',null,'NÃO'],
    ['PHM3F50','MT02','HONDA','NXR160 BROS ESDD','MOTO','OPERAÇÃO','2016','BRANCA','GASOLINA',12,35,'BARCARENA','PROPRIO',null,'NÃO'],
    // Pick-up leve
    ['PHK5D53','PL01','FIAT','STRADA WK CC E','PICK UP','OPERAÇÃO','2016','PRATA','FLEX',58,10.5,'SANTARÉM','PROPRIO',null,'SIM'],
    ['PHL8286','PL02','FIAT','STRADA FREEDOM CD13','PICK UP','OPERAÇÃO','2017','BRANCA','FLEX',55,10.5,'ALMERIM','PROPRIO',null,'SIM'],
    ['PVA2J86','PL03','VOLKSWAGEM','SAVEIRO CS RB MF','PICK UP','OPERAÇÃO','2015','PRATA','FLEX',55,10.5,'SANTARÉM','LOCADO','MARCOS','NÃO'],
    ['TDT0I33','PL04','FIAT','STRADA FREEDOM CD13','PICK UP','OPERAÇÃO','2022','BRANCA','FLEX',55,10.5,'BARCARENA','LOCADO','MOVIDA FROTA','SIM'],
    ['TDT3G89','PL05','FIAT','STRADA FREEDOM CD13','PICK UP','OPERAÇÃO','2022','BRANCA','FLEX',55,10.5,'SANTARÉM','LOCADO','MOVIDA FROTA','SIM'],
    ['TDT3H12','PL06','FIAT','STRADA FREEDOM CD13','PICK UP','OPERAÇÃO','2022','BRANCA','FLEX',55,10.5,'SANTARÉM','LOCADO','MOVIDA FROTA','SIM'],
    ['TDT3H26','PL07','FIAT','STRADA FREEDOM CD13','PICK UP','OPERAÇÃO','2022','BRANCA','FLEX',55,10.5,'SANTARÉM','LOCADO','MOVIDA FROTA','SIM'],
    ['SWC9B15','PL08','VOLKSWAGEM','SAVEIRO CS RB MF','PICK UP','OPERAÇÃO','2025','PRATA','FLEX',55,10.5,'SANTARÉM','LOCADO','MOVIDA RAC','NÃO'],
    ['TLG6D05','PL09','VOLKSWAGEM','SAVEIRO CS RB MF','PICK UP','OPERAÇÃO','2026','BRANCA','GASOLINA',55,10.5,'BARCARENA','LOCADO','MOVIDA RAC','NÃO'],
    ['TJA4J16','PL10','VOLKSWAGEM','SAVEIRO CS RB MF','PICK UP','OPERAÇÃO','2026','BRANCA','GASOLINA',55,10.5,'BARCARENA','LOCADO','MOVIDA RAC','NÃO'],
    // Van
    ['PHB5H65','VAN01','PEUGEOT','BOXER M350LH 2.3','VAN','OPERAÇÃO','2014','BRANCA','DIESEL',80,10,'SANTARÉM','LOCADO',null,'NÃO'],
    // Geradores
    ['GERADOR-LG1',null,'BUFFALO','10HP - Gerador Diesel','GERADOR','OPERAÇÃO',null,'AMARELO','DIESEL',null,null,'LAGO GRANDE','PROPRIO',null,'NÃO'],
    ['GERADOR-LG2',null,'BUFFALO','10HP - Gerador Diesel','GERADOR','OPERAÇÃO',null,'AMARELO','DIESEL',null,null,'LAGO GRANDE','PROPRIO',null,'NÃO'],
    ['GERADOR-LG3',null,'BUFFALO','10HP - Gerador Gasolina','GERADOR','OPERAÇÃO',null,'AMARELO','GASOLINA',null,null,'LAGO GRANDE','PROPRIO',null,'NÃO'],
    // Novos 4x4
    ['QMZ1D40','PT07','TOYOTA','HILUX','4X4','OPERAÇÃO','2024','N/A','DIESEL',80,10.0,'LAGO GRANDE','LOCADO','LOC FROTAS','NÃO'],
    ['PVR2E12','PT08','TOYOTA','HILUX','4X4','OPERAÇÃO','2024','BRANCA','DIESEL',80,10.0,'LAGO GRANDE','LOCADO','LOC FROTAS','NÃO'],
  ];

  const { rows: existing } = await c.query('SELECT COUNT(*) as cnt FROM vehicles');
  if (parseInt(existing[0].cnt) > 0) {
    console.log(`✅ Frota já existe (${existing[0].cnt} veículos) — seed ignorado`);
    return;
  }

  for (const v of fleet) {
    await c.query(
      `INSERT INTO vehicles (plate,equipment_id,brand,model,type,sector,year,color,fuel_type,tank_capacity,avg_consumption,location,ownership,lessor,tracker,status,km,last_fuel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Ativo',0,'Nunca')
       ON CONFLICT (plate) DO NOTHING`,
      v
    );
  }
  console.log(`✅ ${fleet.length} veículos inseridos (seed inicial)`);
}

async function seedPrices(c) {
  const prices = [
    ['Diesel S10',6.69],['Gasolina Comum',6.43],
    ['Gasolina Aditivada',7.18],['Etanol',4.39],['GNV',5.13]
  ];
  for (const [t,p] of prices)
    await c.query(`INSERT INTO fuel_prices(fuel_type,price) VALUES($1,$2) ON CONFLICT(fuel_type) DO NOTHING`,[t,p]);
  console.log('✅ Preços inseridos');
}

// ── MICROSOFT GRAPH / SHAREPOINT ─────────────────────────────────────────────
let _token = null, _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const { MICROSOFT_TENANT_ID: tid, MICROSOFT_CLIENT_ID: cid, MICROSOFT_CLIENT_SECRET: cs } = process.env;
  if (!tid || !cid || !cs) throw new Error('Credenciais Microsoft não configuradas');
  const r = await axios.post(
    `https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`,
    new URLSearchParams({ grant_type:'client_credentials', client_id:cid, client_secret:cs, scope:'https://graph.microsoft.com/.default' }),
    { headers:{ 'Content-Type':'application/x-www-form-urlencoded' } }
  );
  _token = r.data.access_token;
  _tokenExpiry = Date.now() + (r.data.expires_in - 120) * 1000;
  return _token;
}

async function spEnsureFolder(folderPath) {
  const token = await getToken();
  const siteId = process.env.SHAREPOINT_SITE_ID;
  const root = process.env.SHAREPOINT_ROOT_FOLDER || 'Departamento de Frotas/SETOR DE FROTA/SISTEMA ABASTECIMENTO';
  const parts = `${root}/${folderPath}`.split('/').filter(Boolean);
  let parentId = 'root';
  for (const part of parts) {
    try {
      const r = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${parentId}:/${encodeURIComponent(part)}`,
        { headers:{ Authorization:`Bearer ${token}` } }
      );
      parentId = r.data.id;
    } catch {
      const r = await axios.post(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${parentId}/children`,
        { name:part, folder:{}, '@microsoft.graph.conflictBehavior':'rename' },
        { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } }
      );
      parentId = r.data.id;
    }
  }
  return parentId;
}

async function spUpload(buffer, fileName, folderPath) {
  const token = await getToken();
  const siteId = process.env.SHAREPOINT_SITE_ID;
  const folderId = await spEnsureFolder(folderPath);
  const r = await axios.put(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${folderId}:/${encodeURIComponent(fileName)}:/content`,
    buffer,
    { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/octet-stream' } }
  );
  return { itemId: r.data.id, webUrl: r.data.webUrl, name: r.data.name };
}

// ── EMAIL VIA MICROSOFT GRAPH ─────────────────────────────────────────────────
const EMAIL_FROM     = process.env.EMAIL_FROM     || 'TI@empresaexemplo.com.br';
const EMAIL_GESTORES = process.env.EMAIL_GESTORES || 'frotas@empresaexemplo.com.br';

async function sendEmail({ to, subject, body }) {
  try {
    const token = await getToken();
    await axios.post(
      `https://graph.microsoft.com/v1.0/users/${EMAIL_FROM}/sendMail`,
      {
        message: {
          subject,
          body: { contentType: 'HTML', content: body },
          toRecipients: (Array.isArray(to) ? to : [to]).map(addr => ({ emailAddress: { address: addr } }))
        },
        saveToSentItems: false
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`📧 Email enviado para: ${Array.isArray(to)?to.join(', '):to} | ${subject}`);
  } catch (e) {
    const detail = e.response?.data
      ? JSON.stringify(e.response.data, null, 2)
      : e.message;
    console.error('❌ ERRO AO ENVIAR EMAIL:');
    console.error('   FROM:', EMAIL_FROM);
    console.error('   TO:  ', to);
    console.error('   Detalhe:', detail);
  }
}

function emailNovaRequisicao(req) {
  const dtBR = new Date(req.created_at || req.date).toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short' });
  const priorBadge = req.priority === 'emergency' ? '🔴 EMERGÊNCIA' : req.priority === 'urgent' ? '🟡 URGENTE' : '🟢 Normal';
  return {
    to: EMAIL_GESTORES,
    subject: `[AbastRez] Nova Requisição ${req.id} — ${req.driver?.split(' ')[0]} — ${priorBadge}`,
    body: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:10px;overflow:hidden">
        <div style="background:#F7931E;padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:1.4rem">⚡ Empresa Exemplo</h1>
          <p style="color:#fff3e0;margin:6px 0 0;font-size:.9rem">Sistema de Abastecimento — Nova Requisição</p>
        </div>
        <div style="padding:28px;background:#fff">
          <p style="font-size:.95rem;color:#333;margin-bottom:20px">Uma nova requisição de abastecimento foi registrada e aguarda aprovação.</p>
          <table style="width:100%;border-collapse:collapse;font-size:.9rem">
            <tr style="background:#fff8f0"><td style="padding:10px 14px;color:#888;width:38%">ID Requisição</td><td style="padding:10px 14px;font-weight:700;color:#F7931E">${req.id}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Motorista</td><td style="padding:10px 14px;font-weight:600">${req.driver}</td></tr>
            <tr style="background:#fff8f0"><td style="padding:10px 14px;color:#888">Veículo / Placa</td><td style="padding:10px 14px">${req.vehicle || '—'} &nbsp;|&nbsp; <b>${req.plate || '—'}</b></td></tr>
            <tr><td style="padding:10px 14px;color:#888">Combustível</td><td style="padding:10px 14px">${req.fuel_type || '—'}</td></tr>
            <tr style="background:#fff8f0"><td style="padding:10px 14px;color:#888">Cidade / Posto</td><td style="padding:10px 14px">${req.city || '—'} — ${req.gas_station || '—'}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">KM / Horímetro</td><td style="padding:10px 14px">${req.km ? Number(req.km).toLocaleString('pt-BR') + ' km' : req.horimetre || '—'}</td></tr>
            <tr style="background:#fff8f0"><td style="padding:10px 14px;color:#888">Data / Hora</td><td style="padding:10px 14px">${dtBR}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Prioridade</td><td style="padding:10px 14px"><b>${priorBadge}</b></td></tr>
            <tr style="background:#fff8f0"><td style="padding:10px 14px;color:#888">Observações</td><td style="padding:10px 14px;font-style:italic">${req.notes || '—'}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Valor Estimado</td><td style="padding:10px 14px;font-weight:700;color:#22c55e">${req.estimated_value || '—'}</td></tr>
          </table>
          <div style="text-align:center;margin-top:28px">
            <p style="font-size:.85rem;color:#666;margin-bottom:14px">Acesse o sistema para aprovar ou rejeitar esta requisição:</p>
            <a href="${process.env.SYSTEM_URL || 'https://abast-56aa.onrender.com'}" style="background:#F7931E;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.95rem">👉 Acessar Sistema e Aprovar</a>
          </div>
        </div>
        <div style="padding:16px;background:#f0f0f0;text-align:center;font-size:.75rem;color:#999">
          Empresa Exemplo — Sistema de Abastecimento v3.0 &nbsp;|&nbsp; Notificação automática
        </div>
      </div>`
  };
}

function emailStatusAlterado(req, novoStatus) {
  const dtBR = new Date().toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short' });
  const statusMap = {
    signed:    { emoji:'✅', label:'APROVADA', cor:'#22c55e', msg:'Sua requisição foi <b>aprovada</b>! Dirija-se ao posto indicado para realizar o abastecimento.' },
    rejected:  { emoji:'❌', label:'REJEITADA', cor:'#ef4444', msg:'Sua requisição foi <b>rejeitada</b>. Entre em contato com o supervisor para mais informações.' },
    completed: { emoji:'✔️', label:'CONCLUÍDA', cor:'#3b82f6', msg:'O abastecimento foi confirmado e registrado no sistema.' }
  };
  const s = statusMap[novoStatus] || { emoji:'ℹ️', label:novoStatus, cor:'#888', msg:'Status atualizado.' };
  return {
    to: EMAIL_GESTORES,
    subject: `[AbastRez] Requisição ${req.id} — ${s.emoji} ${s.label}`,
    body: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:10px;overflow:hidden">
        <div style="background:${s.cor};padding:24px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:1.4rem">⚡ Empresa Exemplo</h1>
          <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:.9rem">Atualização de Requisição — ${s.emoji} ${s.label}</p>
        </div>
        <div style="padding:28px;background:#fff">
          <p style="font-size:.95rem;color:#333;margin-bottom:20px">${s.msg}</p>
          <table style="width:100%;border-collapse:collapse;font-size:.9rem">
            <tr style="background:#f8f8f8"><td style="padding:10px 14px;color:#888;width:38%">ID Requisição</td><td style="padding:10px 14px;font-weight:700;color:${s.cor}">${req.id}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Motorista</td><td style="padding:10px 14px;font-weight:600">${req.driver}</td></tr>
            <tr style="background:#f8f8f8"><td style="padding:10px 14px;color:#888">Veículo / Placa</td><td style="padding:10px 14px">${req.vehicle || '—'} | <b>${req.plate || '—'}</b></td></tr>
            <tr><td style="padding:10px 14px;color:#888">Combustível</td><td style="padding:10px 14px">${req.fuel_type || '—'}</td></tr>
            <tr style="background:#f8f8f8"><td style="padding:10px 14px;color:#888">Supervisor</td><td style="padding:10px 14px">${req.supervisor || '—'}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Data / Hora</td><td style="padding:10px 14px">${dtBR}</td></tr>
            ${novoStatus==='completed'?`<tr style="background:#f8f8f8"><td style="padding:10px 14px;color:#888">Valor Final</td><td style="padding:10px 14px;font-weight:700;color:#22c55e">${req.real_value || '—'}</td></tr><tr><td style="padding:10px 14px;color:#888">Litros</td><td style="padding:10px 14px">${req.liters || '—'}</td></tr>`:''}
          </table>
        </div>
        <div style="padding:16px;background:#f0f0f0;text-align:center;font-size:.75rem;color:#999">
          Empresa Exemplo — Sistema de Abastecimento v3.0 &nbsp;|&nbsp; Notificação automática
        </div>
      </div>`
  };
}

// ── PDF GENERATOR ─────────────────────────────────────────────────────────────
function makePDF(req, photos = []) {
  return new Promise((res, rej) => {
    const doc = new PDFDocument({ margin:50, size:'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => res(Buffer.concat(chunks)));
    doc.on('error', rej);

    const NAVY = '#1E3A5F', ORANGE = '#F7931E', GRAY = '#F8FAFC', DARK = '#1A202C', MUTED = '#64748B';
    const W = doc.page.width;

    // Header
    doc.rect(0,0,W,105).fill(NAVY);
    doc.fillColor(ORANGE).fontSize(8).font('Helvetica')
       .text('EMPRESA EXEMPLO LTDA', 50, 22, { characterSpacing: 1 });
    doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
       .text('EMPRESA EXEMPLO', 50, 34);
    doc.fontSize(11).font('Helvetica')
       .text('Requisição de Abastecimento', 50, 58);
    doc.fontSize(9).fillColor('rgba(255,255,255,0.7)')
       .text(`Emitido em ${new Date().toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo' })}`, 50, 78);

    // Badge ID
    doc.rect(W-160,15,110,75).fill(ORANGE);
    doc.fillColor('white').fontSize(8).font('Helvetica').text('Nº REQUISIÇÃO', W-155,25);
    doc.fontSize(14).font('Helvetica-Bold').text(req.id, W-155,40);
    // Status
    const sColors = { pending:'#F59E0B',signed:'#10B981',completed:'#3B82F6',rejected:'#EF4444' };
    const sLabels = { pending:'PENDENTE',signed:'APROVADO',completed:'CONCLUÍDO',rejected:'REJEITADO' };
    doc.rect(W-155,65,100,18).fill(sColors[req.status]||'#6B7280');
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text(sLabels[req.status]||req.status.toUpperCase(), W-150,70);

    doc.rect(0,105,W,3).fill(ORANGE);

    let y = 122;
    const section = (title) => {
      doc.rect(50,y,W-100,20).fill(NAVY);
      doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(title,58,y+6);
      y += 26;
    };
    const field = (label, value, x, fy, fw=200) => {
      doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(label,x,fy);
      doc.fillColor(DARK).fontSize(9.5).font('Helvetica-Bold').text(value||'—',x,fy+11,{width:fw,ellipsis:true});
    };

    // Motorista
    section('INFORMAÇÕES DO MOTORISTA');
    doc.rect(50,y,W-100,50).fill(GRAY).stroke('#E2E8F0');
    field('Motorista', req.driver, 60, y+6, 280);
    field('Supervisor', req.supervisor||'Pendente', 360, y+6, 140);
    field('Prioridade', {normal:'Normal',urgent:'Urgente',emergency:'EMERGÊNCIA'}[req.priority]||'Normal', 360, y+28, 140);
    field('Data', fmtBR(req.date), 60, y+28, 140);
    y += 60;

    // Veículo
    section('VEÍCULO / EQUIPAMENTO');
    doc.rect(50,y,W-100,60).fill(GRAY).stroke('#E2E8F0');
    field('Placa / Código', req.plate, 60, y+6, 140);
    field('Modelo', req.vehicle?.replace(/ - .*/,''), 220, y+6, 200);
    field('Cidade', req.city, 430, y+6, 100);
    field('Posto', req.gas_station, 60, y+28, 200);
    field('Método', {tanque:'Tanque Completo',galao:'Galão',bombona:'Bombona'}[req.fuel_method]||'—', 280, y+28, 150);
    field('KM / Horímetro', req.km ? Number(req.km).toLocaleString('pt-BR')+' km' : req.horimetre||'—', 60, y+46, 200);
    y += 70;

    // Abastecimento
    section('DADOS DO ABASTECIMENTO');
    doc.rect(50,y,W-100,70).fill(GRAY).stroke('#E2E8F0');
    field('Combustível', req.fuel_type, 60, y+6, 150);
    field('Litros', req.liters||'A confirmar', 230, y+6, 120);
    field('Preço / Litro', req.price_per_liter ? `R$ ${Number(req.price_per_liter).toFixed(2)}` : 'A confirmar', 370, y+6, 100);
    field('Valor Estimado', req.estimated_value, 60, y+28, 150);
    // Valor total destaque
    const vColor = req.real_value ? '#D1FAE5' : '#FEF3C7';
    doc.rect(60,y+46,W-120,20).fill(vColor).stroke(req.real_value?'#6EE7B7':'#FDE68A');
    doc.fillColor(DARK).fontSize(10).font('Helvetica-Bold')
       .text(`VALOR TOTAL: ${req.real_value||'A definir'}`, 70, y+51);
    y += 82;

    if (req.notes && req.notes !== 'Sem observações') {
      doc.rect(50,y,W-100,26).fill('#FFF7ED').stroke('#FDDCB0');
      doc.fillColor(MUTED).fontSize(8).text('Observações:', 58, y+4);
      doc.fillColor(DARK).fontSize(9).text(req.notes, 58, y+14, {width:W-120,ellipsis:true});
      y += 34;
    }

    // SharePoint
    if (req.sharepoint_folder) {
      doc.rect(50,y,W-100,22).fill('#EFF6FF').stroke('#BFDBFE');
      doc.fillColor('#1D4ED8').fontSize(8).font('Helvetica')
         .text(`☁  Pasta SharePoint: Sistema Abastecimento/${req.sharepoint_folder}`, 58, y+7);
      y += 30;
    }

    // Fotos anexadas (menção)
    if (photos.length) {
      doc.rect(50,y,W-100,22).fill('#F0FDF4').stroke('#BBF7D0');
      doc.fillColor('#065F46').fontSize(8)
         .text(`📷 ${photos.length} foto(s) anexada(s) no SharePoint`, 58, y+7);
      y += 30;
    }

    // Assinaturas
    y = Math.max(y, doc.page.height - 180);
    if (y > doc.page.height - 150) { doc.addPage(); y = 50; }
    section('ASSINATURAS');
    const sw = (W-140)/2;
    doc.rect(50,y,sw,65).stroke('#CBD5E0');
    doc.rect(W-50-sw,y,sw,65).stroke('#CBD5E0');
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
       .text('Assinatura do Motorista', 50+sw/2-40, y+48)
       .text('Assinatura do Supervisor', W-50-sw+sw/2-42, y+48);
    doc.text('Nome: _______________________', 60, y+8);
    doc.text('Nome: _______________________', W-50-sw+10, y+8);
    doc.text('Data: _______________________', 60, y+26);
    doc.text('Data: _______________________', W-50-sw+10, y+26);

    // Footer
    doc.rect(0,doc.page.height-40,W,40).fill(NAVY);
    doc.fillColor('rgba(255,255,255,0.7)').fontSize(7.5).font('Helvetica')
       .text('Empresa Exemplo Ltda  •  Sistema de Gestão de Abastecimento v3.0', 50, doc.page.height-28)
       .text(`Documento gerado automaticamente em ${new Date().toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo' })}`, 50, doc.page.height-16);

    doc.end();
  });
}

function fmtBR(d) {
  if (!d) return '—';
  try { return new Date(d+'T00:00:00').toLocaleDateString('pt-BR'); } catch { return d; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────────

// ── VEÍCULOS ─────────────────────────────────────────────────────────────────
app.get('/api/vehicles', async (req, res) => {
  try {
    let q = 'SELECT * FROM vehicles WHERE 1=1';
    const p = [];
    if (req.query.type)     { p.push(req.query.type);     q += ` AND type=$${p.length}`; }
    if (req.query.location) { p.push(req.query.location); q += ` AND location ILIKE $${p.length}`; }
    q += ' ORDER BY type, equipment_id NULLS LAST, plate';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vehicles', requireSup, async (req, res) => {
  try {
    const { plate,equipment_id,brand,model,type,sector,year,color,fuel_type,tank_capacity,avg_consumption,location,ownership,lessor,tracker } = req.body;
    if (!plate||!model) return res.status(400).json({ error:'Placa e modelo são obrigatórios' });
    await pool.query(
      `INSERT INTO vehicles(plate,equipment_id,brand,model,type,sector,year,color,fuel_type,tank_capacity,avg_consumption,location,ownership,lessor,tracker) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [plate.toUpperCase(),equipment_id,brand,model,type||'VEICULO',sector,year,color||'N/A',fuel_type||'DIESEL',tank_capacity||null,avg_consumption||null,location,ownership||'PROPRIO',lessor,tracker||'NÃO']
    );
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/vehicles/:plate', requireSup, async (req, res) => {
  try {
    await pool.query('DELETE FROM vehicles WHERE plate=$1', [req.params.plate]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/vehicles/:plate', requireSup, async (req, res) => {
  try {
    const { equipment_id,brand,model,type,sector,year,color,fuel_type,tank_capacity,avg_consumption,location,ownership,lessor,status,km } = req.body;
    await pool.query(
      `UPDATE vehicles SET
        equipment_id=COALESCE($1,equipment_id), brand=COALESCE($2,brand), model=COALESCE($3,model),
        type=COALESCE($4,type), sector=COALESCE($5,sector), year=COALESCE($6,year),
        color=COALESCE($7,color), fuel_type=COALESCE($8,fuel_type),
        tank_capacity=COALESCE($9,tank_capacity), avg_consumption=COALESCE($10,avg_consumption),
        location=COALESCE($11,location), ownership=COALESCE($12,ownership),
        lessor=COALESCE($13,lessor), status=COALESCE($14,status), km=COALESCE($15,km)
       WHERE plate=$16`,
      [equipment_id||null,brand||null,model||null,type||null,sector||null,year||null,
       color||null,fuel_type||null,tank_capacity||null,avg_consumption||null,
       location||null,ownership||null,lessor||null,status||null,km||null,
       req.params.plate]
    );
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REQUISIÇÕES ───────────────────────────────────────────────────────────────
app.get('/api/requests', async (req, res) => {
  try {
    let q = `SELECT r.*, COALESCE(json_agg(json_build_object('photo_type',p.photo_type,'sharepoint_url',p.sharepoint_url)) FILTER(WHERE p.id IS NOT NULL),'[]') as photos
             FROM requests r LEFT JOIN request_photos p ON r.id=p.request_id WHERE 1=1`;
    const params = [];
    if (req.query.driver)    { params.push(req.query.driver);    q += ` AND r.driver=$${params.length}`; }
    if (req.query.status)    { params.push(req.query.status);    q += ` AND r.status=$${params.length}`; }
    if (req.query.startDate) { params.push(req.query.startDate); q += ` AND r.date>=$${params.length}`; }
    if (req.query.endDate)   { params.push(req.query.endDate);   q += ` AND r.date<=$${params.length}`; }
    // Sem filtro de data padrão: todas as requisições aparecem, independente da data.
    q += ' GROUP BY r.id ORDER BY COALESCE(r.date, r.created_at::text) DESC LIMIT 5000';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/requests', async (req, res) => {
  try {
    const { id,driver,plate,vehicle,city,gas_station,fuel_type,fuel_method,fuel_method_qty,price_per_liter,liters,bombona_id,date,km,horimetre,priority,notes,estimated_value } = req.body;
    // FIX: geração do ID + os dois INSERTs (requests e fuel_records) agora rodam
    // dentro de uma única transação. Antes, se o segundo INSERT falhasse, a
    // requisição existia em uma tabela mas não na outra, gerando divergência
    // entre o relatório de requisições e o de abastecimentos.
    let reqId;
    await withTransaction(async (client) => {
      const year = new Date().getFullYear();
      await client.query(`INSERT INTO request_seq(year,last_seq) VALUES($1,0) ON CONFLICT(year) DO NOTHING`,[year]);
      const seqRes = await client.query(`UPDATE request_seq SET last_seq=last_seq+1 WHERE year=$1 RETURNING last_seq`,[year]);
      const seq = String(seqRes.rows[0].last_seq).padStart(4,'0');
      reqId = id || `REQ-${year}-${seq}`;
      await client.query(
        `INSERT INTO requests(id,driver,plate,vehicle,city,gas_station,fuel_type,fuel_method,fuel_method_qty,price_per_liter,liters,bombona_id,status,date,supervisor,estimated_value,km,horimetre,priority,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,'Pendente',$14,$15,$16,$17,$18)`,
        [reqId,driver,plate,vehicle,city,gas_station,fuel_type,fuel_method,fuel_method_qty||null,price_per_liter||null,liters||null,bombona_id||null,date,estimated_value||'A definir',km||null,horimetre||null,priority||'normal',notes||null]
      );
      await client.query(
        `INSERT INTO fuel_records(request_id,driver,vehicle,gas_station,fuel_type,estimated_value,status,date,notes) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
        [reqId,driver,vehicle,gas_station,fuel_type,estimated_value||'A definir',date,notes||null]
      );
    });
    // Notificar gestores por email (não bloqueia resposta)
    setImmediate(async () => {
      try {
        const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1',[reqId]);
        if (!rows[0]) return;
        const request = rows[0];
        // PDF Pendente → SharePoint/Pendentes
        try {
          const pdf = await makePDF(request, []);
          const dateStr = new Date().toLocaleDateString('pt-BR').replace(/\//g,'-');
          const driverFolder = (request.driver||'SEM_NOME').replace(/[/\\:*?"<>|]/g,'_');
          const folder = `Pendentes/${driverFolder}/${dateStr}`;
          const spRes = await spUpload(pdf, `${reqId}_Pendente.pdf`, folder);
          await pool.query(`UPDATE requests SET pdf_url=$1, pdf_sharepoint_id=$2, sharepoint_folder=$3 WHERE id=$4`,
            [spRes.webUrl, spRes.itemId, folder, reqId]);
          console.log(`✅ PDF pendente ${reqId} → SharePoint/${folder}`);
        } catch(e) { console.warn('PDF pendente falhou:', e.message); }
        await sendEmail(emailNovaRequisicao(request));
      } catch(e) { console.warn('Email nova req falhou:', e.message); }
    });
    res.json({ success:true, id:reqId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/requests/:id', requireSupOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status,supervisor,real_value,price_per_liter,liters,pdf_url,sharepoint_folder,gas_station,city,regenerate_pdf } = req.body;

    // FIX: toda a leitura+escrita crítica (requests, fuel_records, bombonas, vehicles)
    // agora roda dentro de UMA transação, com FOR UPDATE nas linhas de bombonas/vehicles
    // tocadas. Isso elimina: (1) divergência entre requests/fuel_records se algo falhar
    // no meio; (2) corrida em duplo-clique que poderia encher a bombona duas vezes;
    // (3) e permite reverter de forma segura o crédito de bombona e o KM do veículo
    // quando uma requisição é anulada (voided).
    let prevRow, bombonaAutoFillInfo = null, bombonaReversalInfo = null;

    await withTransaction(async (client) => {
      // Busca e trava a linha da requisição (evita duplo-clique concorrente)
      const { rows: prevRows } = await client.query(
        `SELECT status, plate, km, driver, fuel_method, bombona_id, liters as req_liters,
                fuel_method_qty, bombona_creditado, km_before
         FROM requests WHERE id=$1 FOR UPDATE`,
        [id]
      );
      prevRow = prevRows[0];
      const prevStatus = prevRow?.status;

      await client.query(
        `UPDATE requests SET status=COALESCE($1,status),supervisor=COALESCE($2,supervisor),real_value=COALESCE($3,real_value),price_per_liter=COALESCE($4,price_per_liter),liters=COALESCE($5,liters),pdf_url=COALESCE($6,pdf_url),sharepoint_folder=COALESCE($7,sharepoint_folder),gas_station=COALESCE($9,gas_station),city=COALESCE($10,city),updated_at=NOW() WHERE id=$8`,
        [status,supervisor,real_value,price_per_liter,liters,pdf_url,sharepoint_folder,id,gas_station||null,city||null]
      );
      if (real_value)
        await client.query(`UPDATE fuel_records SET status=$1,real_value=$2,price_per_liter=$3,liters=$4,gas_station=COALESCE($6,gas_station) WHERE request_id=$5`,[status,real_value,price_per_liter,liters,id,gas_station||null]);
      else
        await client.query(`UPDATE fuel_records SET status=$1,gas_station=COALESCE($3,gas_station) WHERE request_id=$2`,[status,id,gas_station||null]);

      // ── AUTO-ABASTECER BOMBONA ao aprovar ──────────────────────────────────
      // Só enche se estava em 'pending' antes — evita encher 2x em clique duplo.
      // FIX: SELECT ... FOR UPDATE trava a linha da bombona, e como prevRow também
      // foi travado com FOR UPDATE acima, dois PUTs concorrentes para o mesmo id
      // não podem mais duplicar o crédito.
      if (status === 'signed' && prevStatus === 'pending') {
        if (prevRow && prevRow.fuel_method === 'bombona' && prevRow.bombona_id) {
          const litrosStr = (prevRow.req_liters || '').toString().replace(/[^\d.]/g, '');
          const litrosReq = parseFloat(litrosStr) || parseFloat(prevRow.fuel_method_qty) || 0;
          if (litrosReq > 0) {
            const { rows: bRows } = await client.query('SELECT * FROM bombonas WHERE id=$1 FOR UPDATE', [prevRow.bombona_id]);
            const bomb = bRows[0];
            if (bomb) {
              const saldoAnterior = parseFloat(bomb.current_liters);
              const saldoNovo = Math.min(saldoAnterior + litrosReq, parseFloat(bomb.capacity_liters));
              // FIX: guarda o valor REAL creditado (pode ser menor que litrosReq se
              // a bombona já estava perto da capacidade) para permitir reverter exato
              // caso a requisição seja anulada depois.
              const creditadoReal = saldoNovo - saldoAnterior;
              await client.query(`UPDATE bombonas SET current_liters=$1, updated_at=NOW() WHERE id=$2`, [saldoNovo, bomb.id]);
              await client.query(`UPDATE requests SET bombona_creditado=$1 WHERE id=$2`, [creditadoReal, id]);
              // FIX: antes `rq.driver` vinha undefined (não estava no SELECT anterior),
              // então a transferência sempre aparecia com motorista "Operador".
              await client.query(
                `INSERT INTO bombona_transfers(bombona_id,driver,vehicle_plate,vehicle_model,liters,notes,date,registered_by)
                 VALUES($1,$2,NULL,NULL,$3,$4,$5,$6)`,
                [bomb.id, prevRow.driver || 'Operador', litrosReq, `Abastecimento via Req ${id}`,
                 new Date().toISOString().split('T')[0], supervisor || 'Sistema']
              );
              bombonaAutoFillInfo = { bombonaId: bomb.id, bombonaName: bomb.name, saldoAnterior, saldoNovo };
            }
          }
        }
      }

      // ── AUTO-ATUALIZAR KM DO VEÍCULO ao concluir ───────────────────────────
      // FIX: agora roda dentro da transação com FOR UPDATE na linha do veículo,
      // e grava km_before (o KM anterior) em requests, para permitir reverter
      // corretamente caso esta requisição seja anulada mais tarde.
      if (status === 'completed' && prevRow?.plate && prevRow?.km) {
        const newKm = parseInt(prevRow.km);
        if (newKm > 0) {
          const { rows: vRows } = await client.query('SELECT km FROM vehicles WHERE plate=$1 FOR UPDATE', [prevRow.plate]);
          const currentKm = parseInt(vRows[0]?.km || 0);
          if (newKm > currentKm) {
            const today = new Date().toLocaleDateString('pt-BR');
            await client.query(`UPDATE vehicles SET km=$1, last_fuel=$2 WHERE plate=$3`, [newKm, today, prevRow.plate]);
            await client.query(`UPDATE requests SET km_before=$1 WHERE id=$2`, [currentKm, id]);
            console.log(`✅ KM ${prevRow.plate} atualizado: ${currentKm} → ${newKm} km`);
          }
        }
      }

      // ── REVERSÃO AO ANULAR (voided) ────────────────────────────────────────
      // FIX: antes, anular uma requisição só mudava o status — o saldo da bombona
      // já creditado e o KM do veículo já avançado permaneciam alterados, criando
      // uma inconsistência entre "requisição anulada" (some dos relatórios) e o
      // estado físico do sistema (bombona/veículo já modificados).
      if (status === 'voided' && prevStatus !== 'voided' && prevRow) {
        const creditado = parseFloat(prevRow.bombona_creditado || 0);
        if (creditado > 0 && prevRow.bombona_id) {
          const { rows: bRows } = await client.query('SELECT * FROM bombonas WHERE id=$1 FOR UPDATE', [prevRow.bombona_id]);
          const bomb = bRows[0];
          if (bomb) {
            const saldoAnterior = parseFloat(bomb.current_liters);
            const saldoNovo = Math.max(saldoAnterior - creditado, 0);
            await client.query(`UPDATE bombonas SET current_liters=$1, updated_at=NOW() WHERE id=$2`, [saldoNovo, bomb.id]);
            await client.query(`UPDATE requests SET bombona_creditado=0 WHERE id=$1`, [id]);
            bombonaReversalInfo = { bombonaId: bomb.id, bombonaName: bomb.name, saldoAnterior, saldoNovo, tipo: 'bombona', valor: creditado };
          }
        }
        // Reverte o KM do veículo — só se nenhuma outra requisição concluída
        // avançou o KM depois desta (protege contra sobrescrever um valor mais novo)
        if (prevRow.km_before !== null && prevRow.plate && prevRow.km) {
          const { rows: vRows } = await client.query('SELECT km FROM vehicles WHERE plate=$1 FOR UPDATE', [prevRow.plate]);
          const vKm = parseInt(vRows[0]?.km || 0);
          if (vKm === parseInt(prevRow.km)) {
            await client.query(`UPDATE vehicles SET km=$1 WHERE plate=$2`, [prevRow.km_before, prevRow.plate]);
            await client.query(`UPDATE requests SET km_before=NULL WHERE id=$1`, [id]);
          }
        }
      }
    });

    // Histórico de saldo — gravado após o COMMIT (já não pode mais falhar a transação principal)
    if (bombonaAutoFillInfo)
      await registrarHistoricoBombona(bombonaAutoFillInfo.bombonaId, bombonaAutoFillInfo.saldoAnterior, bombonaAutoFillInfo.saldoNovo, 'ABASTECIMENTO', `Req ${id}`, supervisor || 'Gestor');
    if (bombonaReversalInfo)
      await registrarHistoricoBombona(bombonaReversalInfo.bombonaId, bombonaReversalInfo.saldoAnterior, bombonaReversalInfo.saldoNovo, 'REVERSÃO POR ANULAÇÃO', `Req ${id}`, supervisor || 'Sistema');

    // Gerar PDF e enviar ao SharePoint — mesma pasta do motorista/data
    if (status === 'signed' || status === 'rejected' || status === 'completed') {
      setImmediate(async () => {
        try {
          const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1',[id]);
          if (!rows[0]) return;
          const request = rows[0];
          const { rows: photos } = await pool.query('SELECT * FROM request_photos WHERE request_id=$1',[id]);
          const pdf = await makePDF(request, photos);
          // Usa a mesma pasta onde estão as fotos do motorista
          const dateStr = new Date(request.created_at || request.date).toLocaleDateString('pt-BR').replace(/\//g,'-');
          const driverFolder = (request.driver||'SEM_NOME').replace(/[/\\:*?"<>|]/g,'_');
          const folder = `${driverFolder}/${dateStr}`;
          const pdfLabel = status === 'signed' ? 'Aprovado' : status === 'completed' ? 'Concluido' : 'Rejeitado';
          const pdfName = `${id}_${pdfLabel}.pdf`;
          const spRes = await spUpload(pdf, pdfName, folder);
          await pool.query(`UPDATE requests SET pdf_url=$1, pdf_sharepoint_id=$2, sharepoint_folder=$3 WHERE id=$4`,
            [spRes.webUrl, spRes.itemId, folder, id]);
          console.log(`✅ PDF ${id} (${pdfLabel}) → SharePoint/${folder}/${pdfName}`);
          await sendEmail(emailStatusAlterado(request, status));
        } catch (e) {
          const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
          console.warn(`⚠️ PDF/SP/Email (${status}) falhou:`, detail);
        }
      });
    }
    // Email para rejected (PDF já tratado acima, evita duplicata)
    if (status === 'rejected') {
      // email já enviado no bloco acima
    }

    // Regenerar PDF Aprovado com valores atualizados (sem mudar status)
    if (regenerate_pdf && !status) {
      setImmediate(async () => {
        try {
          const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1', [id]);
          if (!rows[0]) return;
          const request = rows[0];
          const { rows: photos } = await pool.query('SELECT * FROM request_photos WHERE request_id=$1', [id]);
          const pdf = await makePDF(request, photos);
          const dateStr = new Date(request.created_at).toLocaleDateString('pt-BR', { timeZone:'America/Sao_Paulo' }).replace(/\//g,'-');
          const driverFolder = (request.driver||'SEM_NOME').replace(/[/\\:*?"<>|]/g,'_');
          const folder = `${driverFolder}/${dateStr}`;
          const spRes = await spUpload(pdf, `${id}_Aprovado.pdf`, folder);
          await pool.query(`UPDATE requests SET pdf_url=$1,pdf_sharepoint_id=$2 WHERE id=$3`,
            [spRes.webUrl, spRes.itemId, id]);
          console.log(`✅ PDF Aprovado atualizado ${id} → SharePoint`);
        } catch(e) { console.warn('PDF regenerate falhou:', e.message); }
      });
    }

    // Auditoria de status
    if (status) {
      const actionMap = { signed:'APROVAÇÃO', rejected:'REJEIÇÃO', completed:'CONCLUSÃO', voided:'ANULAÇÃO' };
      const act = actionMap[status] || `STATUS → ${status}`;
      audit(act, 'requisição', id, supervisor || 'Sistema', null, { status, real_value, liters });
    }

    if (gas_station && !status) {
      audit('EDIÇÃO DE POSTO', 'requisição', id, supervisor || 'Sistema', null, { gas_station, city });
    }
    if (regenerate_pdf && !status) {
      audit('ATUALIZAÇÃO DE VALORES', 'requisição', id, supervisor || 'Sistema', null, { real_value, liters, price_per_liter });
    }

    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/requests/:id', requireSupOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,driver,status FROM requests WHERE id=$1',[req.params.id]);
    const actor = req.headers['x-actor'] || 'Supervisor';
    await pool.query('DELETE FROM fuel_records WHERE request_id=$1',[req.params.id]);
    await pool.query('DELETE FROM requests WHERE id=$1',[req.params.id]);
    if (rows[0]) audit('EXCLUSÃO', 'requisição', req.params.id, actor, null, { driver: rows[0].driver, status: rows[0].status });
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FOTOS DA REQUISIÇÃO ───────────────────────────────────────────────────────
app.post('/api/requests/:id/photos',
  upload.fields([
    {name:'horimetre',maxCount:1},{name:'vehicle',maxCount:1},
    {name:'pump',maxCount:1},{name:'receipt',maxCount:1},
    {name:'panel_vehicle',maxCount:1},{name:'panel_carote',maxCount:1},
    {name:'extra',maxCount:3}
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1',[id]);
      if (!rows[0]) return res.status(404).json({ error:'Requisição não encontrada' });
      const request = rows[0];
      const dateStr = new Date().toLocaleDateString('pt-BR').replace(/\//g,'-');
      const driverFolder = (request.driver||'SEM_NOME').replace(/[/\\:*?"<>|]/g,'_');

      const nomesFoto = {
        horimetre:'Painel_Veiculo_Inicial', vehicle:'Foto_Placa_Veiculo',
        pump:'Foto_Bomba_Bico', receipt:'Cupom_Fiscal',
        panel_vehicle:'Painel_Veiculo_Pos_Abastecimento', panel_carote:'Carote_Abastecido', extra:'Extra'
      };
      const subfolder = (field) =>
        (field==='pump'||field==='receipt'||field==='panel_vehicle'||field==='panel_carote')
          ? 'Confirmacao_Abastecimento' : 'Requisicao_Inicial';

      // 1. Salva no banco IMEDIATAMENTE (sem esperar SharePoint)
      const filesToUpload = [];
      for (const [field, files] of Object.entries(req.files||{})) {
        for (const file of files) {
          const ext = file.originalname.match(/\.[^.]+$/)?.[0] || '.jpg';
          const nomePT = nomesFoto[field] || field;
          const fileName = `${id}_${nomePT}${ext}`;
          const folder = `${driverFolder}/${dateStr}/${subfolder(field)}`;
          // Salva sem URL do SharePoint por enquanto (será atualizado em background)
          const { rows: insRows } = await pool.query(
            `INSERT INTO request_photos(request_id,photo_type,original_name,sharepoint_url,sharepoint_item_id)
             VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [id, field, fileName, null, null]
          );
          filesToUpload.push({ photoId: insRows[0].id, file, fileName, folder, field });
        }
      }
      await pool.query(`UPDATE requests SET sharepoint_folder=$1 WHERE id=$2`,[`${driverFolder}/${dateStr}`,id]);

      // 2. Responde imediatamente para o cliente
      res.json({ success: true, message: 'Fotos salvas. Upload para SharePoint em andamento.' });

      // 3. Upload para SharePoint em background (não bloqueia a resposta)
      // Em paralelo (Promise.all) em vez de sequencial — com fotos já
      // comprimidas no cliente, isso reduz bastante o tempo total até
      // tudo ficar disponível no SharePoint.
      setImmediate(async () => {
        await Promise.all(filesToUpload.map(async ({ photoId, file, fileName, folder }) => {
          try {
            const spRes = await spUpload(file.buffer, fileName, folder);
            await pool.query(
              `UPDATE request_photos SET sharepoint_url=$1, sharepoint_item_id=$2 WHERE id=$3`,
              [spRes.webUrl, spRes.itemId, photoId]
            );
          } catch(e) {
            console.warn(`SP upload falhou para ${fileName}:`, e.message);
          }
        }));
        // Notifica supervisor após uploads (em background)
        const hasDriverPhotos = filesToUpload.some(f => f.field==='pump' || f.field==='receipt');
        if (hasDriverPhotos) {
          try {
            const { rows: rq } = await pool.query('SELECT * FROM requests WHERE id=$1',[id]);
            if (!rq[0]) return;
            await sendEmail({
              to: EMAIL_GESTORES,
              subject: `[AbastRez] ${rq[0].id} — 📷 Motorista enviou fotos — Aguarda conclusão`,
              body: `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:10px;overflow:hidden">
                  <div style="background:#F7931E;padding:24px;text-align:center">
                    <h1 style="color:#fff;margin:0;font-size:1.4rem">⚡ Empresa Exemplo</h1>
                    <p style="color:#fff3e0;margin:6px 0 0;font-size:.9rem">Fotos do Abastecimento Enviadas</p>
                  </div>
                  <div style="padding:28px;background:#fff">
                    <p style="font-size:.95rem;color:#333;margin-bottom:20px">
                      O motorista <b>${rq[0].driver}</b> enviou as fotos do abastecimento (bomba + cupom fiscal).<br>
                      A requisição <b>${id}</b> está aguardando conclusão pelo supervisor.
                    </p>
                  </div>
                </div>`
            });
          } catch(e) { console.warn('Email notif falhou:', e.message); }
        }
      });

    } catch(e) {
      console.error('Erro no upload de fotos:', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);


// ── DOWNLOAD PDF ──────────────────────────────────────────────────────────────
app.get('/api/requests/:id/pdf', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1',[req.params.id]);
    if (!rows[0]) return res.status(404).json({ error:'Não encontrado' });
    const { rows: photos } = await pool.query('SELECT * FROM request_photos WHERE request_id=$1',[req.params.id]);
    const pdf = await makePDF(rows[0], photos);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${req.params.id}.pdf"`);
    res.send(pdf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REGISTROS DE ABASTECIMENTO ────────────────────────────────────────────────
app.get('/api/fuel-records', async (req, res) => {
  try {
    let q = `SELECT fr.*, r.km, r.horimetre, r.plate, r.city, r.priority, r.pdf_url
             FROM fuel_records fr LEFT JOIN requests r ON fr.request_id=r.id WHERE 1=1`;
    const params = [];
    if (req.query.driver)    { params.push(req.query.driver);    q += ` AND fr.driver=$${params.length}`; }
    if (req.query.status)    { params.push(req.query.status);    q += ` AND fr.status=$${params.length}`; }
    if (req.query.startDate) { params.push(req.query.startDate); q += ` AND fr.date>=$${params.length}`; }
    if (req.query.endDate)   { params.push(req.query.endDate);   q += ` AND fr.date<=$${params.length}`; }
    // Sem filtro de data padrão: todos os abastecimentos aparecem, independente da data.
    q += ' ORDER BY COALESCE(fr.date, fr.created_at::text) DESC LIMIT 5000';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/fuel-records/:id', requireSup, async (req, res) => {
  try {
    const { liters,price_per_liter,real_value,status } = req.body;
    // FIX: esta rota atualizava só fuel_records — hoje o frontend não a chama
    // (só usa GET), mas se algum dia for usada (ou chamada direto via API),
    // fuel_records e requests silenciosamente divergiam. Agora ambas as tabelas
    // são atualizadas juntas, na mesma transação.
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE fuel_records SET liters=$1,price_per_liter=$2,real_value=$3,status=$4 WHERE request_id=$5`,
        [liters,price_per_liter,real_value,status,req.params.id]
      );
      await client.query(
        `UPDATE requests SET liters=COALESCE($1,liters),price_per_liter=COALESCE($2,price_per_liter),real_value=COALESCE($3,real_value),status=COALESCE($4,status),updated_at=NOW() WHERE id=$5`,
        [liters,price_per_liter,real_value,status,req.params.id]
      );
    });
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OPERADORES DE BOMBONA ─────────────────────────────────────────────────────
// Login do operador
app.post('/api/operators/login', async (req, res) => {
  try {
    const { matricula, password } = req.body;
    if (!matricula || !password) return res.status(400).json({ error: 'Matrícula e senha obrigatórios' });
    const { rows } = await pool.query(
      `SELECT o.*, b.id as bombona_id, b.name as bombona_name, b.fuel_type, b.current_liters, b.capacity_liters, b.location
       FROM bombona_operators o
       LEFT JOIN bombonas b ON b.operator_id = o.id AND b.status != 'Inativa'
       WHERE o.matricula=$1 AND o.password=$2 AND o.active=true`,
      [matricula.trim().toUpperCase(), password.trim().toUpperCase()]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Matrícula ou senha inválidos' });
    const op = rows[0];
    const token = signSession({ email: `op:${op.matricula}`, name: op.name, isSupervisor: false, isOperator: true });
    res.json({ success: true, operator: op, sessionToken: token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar operadores
app.get('/api/operators', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, b.name as bombona_name
       FROM bombona_operators o
       LEFT JOIN bombonas b ON b.operator_id = o.id AND b.status != 'Inativa'
       ORDER BY o.name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Criar operador
app.post('/api/operators', requireSupOnly, async (req, res) => {
  try {
    const { matricula, name } = req.body;
    if (!matricula || !name) return res.status(400).json({ error: 'Matrícula e nome obrigatórios' });
    // Senha padrão: 3 primeiras letras do nome (uppercase) + EMPRESA
    const firstName = name.trim().split(' ')[0].toUpperCase();
    const password  = firstName.substring(0, 3) + 'EMPRESA';
    const { rows } = await pool.query(
      `INSERT INTO bombona_operators(matricula,name,password) VALUES($1,$2,$3) RETURNING *`,
      [matricula.trim().toUpperCase(), name.trim().toUpperCase(), password]
    );
    res.json({ success: true, operator: rows[0], password });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Matrícula já cadastrada' });
    res.status(500).json({ error: e.message });
  }
});

// Atualizar operador
app.put('/api/operators/:id', requireSupOnly, async (req, res) => {
  try {
    const { active, name, matricula } = req.body;
    await pool.query(
      `UPDATE bombona_operators SET
        active=COALESCE($1,active), name=COALESCE($2,name), matricula=COALESCE($3,matricula)
       WHERE id=$4`,
      [active!==undefined?active:null, name||null, matricula||null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deletar operador
app.delete('/api/operators/:id', requireSupOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM bombona_operators WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resetar senha do operador
app.post('/api/operators/:id/reset-password', requireSupOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name FROM bombona_operators WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Operador não encontrado' });
    const firstName = rows[0].name.split(' ')[0].toUpperCase();
    const password  = firstName.substring(0, 3) + 'EMPRESA';
    await pool.query('UPDATE bombona_operators SET password=$1 WHERE id=$2', [password, req.params.id]);
    res.json({ success: true, password });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUDITORIA ─────────────────────────────────────────────────────────────────
app.get('/api/audit', requireSupOnly, async (req, res) => {
  try {
    const { limit = 200, entity, action, actor } = req.query;
    let q = `SELECT * FROM audit_log WHERE 1=1`;
    const params = [];
    if (entity) { params.push(entity); q += ` AND entity=$${params.length}`; }
    if (action) { params.push(`%${action}%`); q += ` AND action ILIKE $${params.length}`; }
    if (actor)  { params.push(`%${actor}%`);  q += ` AND actor ILIKE $${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT $${params.length+1}`;
    params.push(parseInt(limit));
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POSTOS ────────────────────────────────────────────────────────────────────
app.get('/api/stations', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM stations ORDER BY city, name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stations', requireSup, async (req, res) => {
  try {
    const { name, city } = req.body;
    if (!name || !city) return res.status(400).json({ error: 'Nome e cidade são obrigatórios' });
    const { rows } = await pool.query(
      `INSERT INTO stations(name,city) VALUES($1,$2) RETURNING *`,
      [name.trim(), city.trim()]
    );
    res.json({ success: true, station: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/stations/:id', requireSup, async (req, res) => {
  try {
    const { name, city, active } = req.body;
    await pool.query(
      `UPDATE stations SET name=COALESCE($1,name), city=COALESCE($2,city), active=COALESCE($3,active) WHERE id=$4`,
      [name||null, city||null, active!==undefined?active:null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/stations/:id', requireSup, async (req, res) => {
  try {
    await pool.query('DELETE FROM stations WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PREÇOS ────────────────────────────────────────────────────────────────────
app.get('/api/fuel-prices', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fuel_prices ORDER BY fuel_type');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/fuel-prices', requireSupOnly, async (req, res) => {
  try {
    for (const [t,p] of Object.entries(req.body))
      await pool.query(`INSERT INTO fuel_prices(fuel_type,price,last_update) VALUES($1,$2,NOW()) ON CONFLICT(fuel_type) DO UPDATE SET price=$2,last_update=NOW()`,[t,p]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BOMBONAS ──────────────────────────────────────────────────────────────────
app.get('/api/bombonas', async (req, res) => {
  try {
    let q = `SELECT b.*,
               COALESCE((SELECT SUM(liters) FROM bombona_transfers WHERE bombona_id=b.id),0) as total_transferred,
               (SELECT COUNT(*) FROM bombona_transfers WHERE bombona_id=b.id) as transfer_count
             FROM bombonas b WHERE 1=1`;
    const p = [];
    if (req.query.driver) { p.push(req.query.driver); q += ` AND b.responsible_driver=$${p.length}`; }
    q += ' ORDER BY b.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bombonas', requireSup, async (req, res) => {
  try {
    const { name,fuel_type,capacity_liters,current_liters,responsible_driver,operator_id,location,notes } = req.body;
    if (!name||!fuel_type||!capacity_liters||(!responsible_driver && !operator_id))
      return res.status(400).json({ error:'Campos obrigatórios: nome, combustível, capacidade, responsável' });

    // Se veio operator_id, buscar o nome do operador para preencher responsible_driver
    let finalDriver = responsible_driver;
    let finalOperatorId = operator_id || null;
    if (operator_id && !responsible_driver) {
      const { rows: opRows } = await pool.query('SELECT name FROM bombona_operators WHERE id=$1', [operator_id]);
      if (opRows[0]) finalDriver = opRows[0].name;
    } else if (responsible_driver && !operator_id) {
      // Tentar encontrar operator_id pelo nome
      const { rows: opRows } = await pool.query('SELECT id FROM bombona_operators WHERE UPPER(name)=UPPER($1)', [responsible_driver]);
      if (opRows[0]) finalOperatorId = opRows[0].id;
    }

    const { rows } = await pool.query(
      `INSERT INTO bombonas(name,fuel_type,capacity_liters,current_liters,responsible_driver,operator_id,location,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name,fuel_type,capacity_liters,current_liters||0,finalDriver,finalOperatorId,location||null,notes||null]
    );
    res.json({ success:true, bombona: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bombonas/:id', requireSup, async (req, res) => {
  try {
    const { name,capacity_liters,current_liters,status,notes,location,locked } = req.body;
    const actor = req.headers['x-actor'] || req.session?.name || 'Gestor';

    // FIX: antes, editar o saldo (current_liters) por aqui mudava o valor mas
    // NUNCA gravava em bombona_saldo_history — diferente do abastecimento manual
    // e da transferência, que sempre registram. Isso fazia o histórico de saldo
    // "pular" sem explicação sempre que alguém editava a bombona diretamente.
    // Agora, se o valor realmente mudar, a mudança é registrada como
    // "AJUSTE MANUAL (EDIÇÃO)".
    let saldoAnterior = null, saldoNovo = null;

    await withTransaction(async (client) => {
      if (current_liters !== undefined && current_liters !== null && current_liters !== '') {
        const { rows } = await client.query('SELECT current_liters FROM bombonas WHERE id=$1 FOR UPDATE', [req.params.id]);
        if (rows[0]) {
          const atual = parseFloat(rows[0].current_liters);
          const novo = parseFloat(current_liters);
          if (!isNaN(novo) && novo !== atual) {
            saldoAnterior = atual;
            saldoNovo = novo;
          }
        }
      }

      await client.query(
        `UPDATE bombonas SET
          name=COALESCE($1,name),
          capacity_liters=COALESCE($2,capacity_liters),
          current_liters=COALESCE($3,current_liters),
          status=COALESCE($4,status),
          notes=COALESCE($5,notes),
          location=COALESCE($6,location),
          locked=COALESCE($7,locked),
          updated_at=NOW()
         WHERE id=$8`,
        [name,capacity_liters,current_liters,status,notes,location,
         locked !== undefined ? locked : null,
         req.params.id]
      );
    });

    if (saldoAnterior !== null)
      await registrarHistoricoBombona(req.params.id, saldoAnterior, saldoNovo, 'AJUSTE MANUAL (EDIÇÃO)', null, actor);

    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bombonas/:id', requireSup, async (req, res) => {
  try {
    await pool.query('DELETE FROM bombonas WHERE id=$1',[req.params.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bombonas/:id/abastecer', requireSup, async (req, res) => {
  try {
    const liters = parseFloat(req.body.liters);
    if (!liters || liters <= 0) return res.status(400).json({ error: 'Informe uma quantidade válida' });
    const actor = req.headers['x-actor'] || 'Gestor';

    // FIX: SELECT ... FOR UPDATE + transação — evita que este abastecimento manual
    // "pise" numa transferência concorrente para a mesma bombona (leitura+escrita
    // deixa de ser dois passos separados sem proteção).
    let saldoAnterior, novo, bombonaId = req.params.id;
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM bombonas WHERE id=$1 FOR UPDATE',[req.params.id]);
      if (!rows[0]) throw Object.assign(new Error('Bombona não encontrada'), { status: 404 });
      const b = rows[0];
      saldoAnterior = parseFloat(b.current_liters);
      novo = Math.min(saldoAnterior + liters, parseFloat(b.capacity_liters));
      await client.query(`UPDATE bombonas SET current_liters=$1,updated_at=NOW() WHERE id=$2`,[novo,req.params.id]);
      await client.query(
        `INSERT INTO bombona_transfers(bombona_id,driver,vehicle_plate,vehicle_model,liters,notes,date,registered_by)
         VALUES($1,$2,NULL,NULL,$3,$4,$5,$6)`,
        [b.id, actor, liters, 'Abastecimento manual pelo gestor',
         new Date().toISOString().split('T')[0], actor]
      );
    });
    await registrarHistoricoBombona(bombonaId, saldoAnterior, novo, 'ABASTECIMENTO MANUAL', null, actor);
    res.json({ success:true, novoSaldo: novo });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── TRANSFERÊNCIAS DE BOMBONA ─────────────────────────────────────────────────
app.get('/api/bombona-transfers', async (req, res) => {
  try {
    let q = `SELECT bt.*,b.name as bombona_name,b.fuel_type as bombona_fuel,
               COALESCE(json_agg(json_build_object('photo_type',bp.photo_type,'sharepoint_url',bp.sharepoint_url)) FILTER(WHERE bp.id IS NOT NULL),'[]') as photos
             FROM bombona_transfers bt JOIN bombonas b ON bt.bombona_id=b.id
             LEFT JOIN bombona_photos bp ON bt.id=bp.transfer_id WHERE 1=1`;
    const p = [];
    if (req.query.bombona_id) { p.push(req.query.bombona_id); q += ` AND bt.bombona_id=$${p.length}`; }
    if (req.query.driver)     { p.push(req.query.driver);     q += ` AND bt.driver=$${p.length}`; }
    q += ' GROUP BY bt.id,b.name,b.fuel_type ORDER BY bt.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bombona-transfers',
  requireSup,
  upload.fields([{name:'photo_before',maxCount:1},{name:'photo_after',maxCount:1},{name:'photo_vehicle',maxCount:1},{name:'photo_extra',maxCount:2}]),
  async (req, res) => {
    try {
      const { bombona_id,vehicle_plate,vehicle_model,liters,notes,date,registered_by,request_id,km } = req.body;
      let driver = req.body.driver;

      // Se veio request_id, busca o motorista correto direto do banco
      // (evita que o frontend mande o supervisor em vez do motorista)
      if (request_id) {
        const { rows: rqRows } = await pool.query('SELECT driver FROM requests WHERE id=$1', [request_id]);
        if (rqRows[0]?.driver) driver = rqRows[0].driver;
      }

      if (!bombona_id||!driver||!liters) return res.status(400).json({ error:'Campos obrigatórios: bombona_id, driver, liters' });
      const litersNum = parseFloat(liters);
      const kmNum = km ? parseInt(km) : null;
      if (km && (!kmNum || kmNum <= 0)) return res.status(400).json({ error:'KM inválido' });

      // FIX: este era o ponto de corrida mais grave do sistema — antes, o SELECT do
      // saldo e a checagem de "saldo suficiente" aconteciam sem travar a linha,
      // então duas transferências quase simultâneas na mesma bombona podiam AMBAS
      // passar na validação e o saldo terminar negativo, sem erro nenhum acusado.
      // Agora tudo roda numa transação com SELECT ... FOR UPDATE: a segunda
      // transferência concorrente espera a primeira terminar e então vê o saldo
      // já atualizado, podendo ser corretamente rejeitada se não houver mais litros.
      let b, transfer, saldoAnteriorTransf, saldoNovoTransf, kmAnteriorVeiculo = null;
      const transferDate = date || new Date().toISOString().split('T')[0];
      await withTransaction(async (client) => {
        const { rows: bRows } = await client.query('SELECT * FROM bombonas WHERE id=$1 FOR UPDATE',[bombona_id]);
        if (!bRows[0]) throw Object.assign(new Error('Bombona não encontrada'), { status: 404 });
        b = bRows[0];
        if (litersNum > parseFloat(b.current_liters))
          throw Object.assign(new Error(`Saldo insuficiente. Disponível: ${parseFloat(b.current_liters).toFixed(1)}L`), { status: 400 });

        const { rows: tRows } = await client.query(
          `INSERT INTO bombona_transfers(bombona_id,driver,vehicle_plate,vehicle_model,liters,notes,date,registered_by,km) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [bombona_id,driver,vehicle_plate||null,vehicle_model||null,litersNum,notes||null,transferDate,registered_by||null,kmNum]
        );
        transfer = tRows[0];
        saldoAnteriorTransf = parseFloat(b.current_liters);
        saldoNovoTransf = saldoAnteriorTransf - litersNum;
        await client.query(`UPDATE bombonas SET current_liters=$1,updated_at=NOW() WHERE id=$2`,[saldoNovoTransf,bombona_id]);

        // ── ATUALIZA KM DO VEÍCULO — mesmo tratamento usado no abastecimento
        // de posto: só avança se o KM informado for maior que o atual, e guarda
        // km_before pra permitir reverter se a transferência for excluída depois.
        if (vehicle_plate && kmNum) {
          const { rows: vRows } = await client.query('SELECT km FROM vehicles WHERE plate=$1 FOR UPDATE', [vehicle_plate]);
          const currentKm = parseInt(vRows[0]?.km || 0);
          kmAnteriorVeiculo = currentKm;
          if (kmNum > currentKm) {
            const hoje = new Date().toLocaleDateString('pt-BR');
            await client.query(`UPDATE vehicles SET km=$1, last_fuel=$2 WHERE plate=$3`, [kmNum, hoje, vehicle_plate]);
            await client.query(`UPDATE bombona_transfers SET km_before=$1 WHERE id=$2`, [currentKm, transfer.id]);
          }
        }
      });
      // FIX: registrar saída no histórico de saldo (fora da transação, após commit)
      await registrarHistoricoBombona(b.id, saldoAnteriorTransf, saldoNovoTransf, 'SAÍDA VEÍCULO', `Transf ${transfer.id} — ${vehicle_plate || 'sem placa'}`, registered_by || driver);

      // Upload fotos — pasta: [motorista]/[data]/Bombonas/[nome_bombona]/Transferencia_[id]
      const dateFolder = new Date(transferDate+'T12:00:00').toLocaleDateString('pt-BR').replace(/\//g,'-');
      const driverFolder = driver.replace(/[/\\:*?"<>|]/g,'_');
      const bombonaFolder = b.name.replace(/[/\\:*?"<>|]/g,'_');
      const folder = `${driverFolder}/${dateFolder}/Bombonas/${bombonaFolder}/Transferencia_${transfer.id}`;

      // Nomes em português
      const nomesFoto = {
        photo_before:  'Foto_Antes',
        photo_after:   'Foto_Depois',
        photo_vehicle: 'Foto_Placa_Veiculo',
        photo_extra:   'Extra'
      };

      const uploaded = [];
      for (const [field, files] of Object.entries(req.files||{})) {
        for (const file of files) {
          try {
            const ext = file.originalname.match(/\.[^.]+$/)?.[0] || '.jpg';
            const nomePT = nomesFoto[field] || field;
            const veiculo = vehicle_plate ? `_${vehicle_plate.replace(/[^A-Z0-9]/gi,'')}` : '';
            const fileName = `BOMBONA_${b.name.replace(/\s+/g,'_')}_${nomePT}${veiculo}${ext}`;
            const spRes = await spUpload(file.buffer, fileName, folder);
            await pool.query(
              `INSERT INTO bombona_photos(transfer_id,photo_type,original_name,sharepoint_url,sharepoint_item_id) VALUES($1,$2,$3,$4,$5)`,
              [transfer.id,field,fileName,spRes.webUrl,spRes.itemId]
            );
            uploaded.push({ type:field, url:spRes.webUrl });
          } catch (e) { uploaded.push({ type:field, error:e.message }); }
        }
      }
      await pool.query(`UPDATE bombona_transfers SET sharepoint_folder=$1 WHERE id=$2`,[folder,transfer.id]);
      res.json({ success:true, transfer, photos:uploaded, novoSaldo: saldoNovoTransf });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  }
);

// ── HISTÓRICO DE SALDO DAS BOMBONAS ──────────────────────────────────────────
app.get('/api/bombona-saldo-history/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.*, b.name as bombona_name
      FROM bombona_saldo_history h
      JOIN bombonas b ON b.id = h.bombona_id
      WHERE h.bombona_id = $1
      ORDER BY h.created_at DESC
      LIMIT 100
    `, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bombona-saldo-history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.*, b.name as bombona_name, b.fuel_type, b.location
      FROM bombona_saldo_history h
      JOIN bombonas b ON b.id = h.bombona_id
      ORDER BY h.created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NORMALIZAR NOMES (corrige acentos entre bombona_operators e bombonas) ─────
app.post('/api/normalizar-drivers', requireSupOnly, async (req, res) => {
  try {
    // Busca todos os operadores e bombonas com nomes que difiram só por acento
    const { rows: ops } = await pool.query('SELECT matricula, name FROM bombona_operators WHERE active=true');
    const updates = [];
    for (const op of ops) {
      const normOp = normalizeDriver(op.name);
      // Atualiza bombonas cujo responsible_driver normalizado bate mas o literal não bate
      const { rows: bombs } = await pool.query(
        `SELECT id, responsible_driver FROM bombonas WHERE responsible_driver != $1`, [op.name]
      );
      for (const b of bombs) {
        if (normalizeDriver(b.responsible_driver) === normOp) {
          await pool.query(`UPDATE bombonas SET responsible_driver=$1 WHERE id=$2`, [op.name, b.id]);
          updates.push({ bombona_id: b.id, de: b.responsible_driver, para: op.name });
        }
      }
    }
    res.json({ success: true, atualizacoes: updates });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RELATÓRIO POR VEÍCULO ─────────────────────────────────────────────────────
app.get('/api/relatorio-veiculo', async (req, res) => {
  try {
    const { plate, inicio, fim, fuel_type } = req.query;
    const params = [];
    let where = `WHERE r.status = 'completed'`;
    if (inicio) { params.push(inicio); where += ` AND r.date >= $${params.length}`; }
    if (fim)    { params.push(fim);    where += ` AND r.date <= $${params.length}`; }
    if (plate)  { params.push(plate);  where += ` AND r.plate = $${params.length}`; }
    if (fuel_type) { params.push(fuel_type); where += ` AND r.fuel_type = $${params.length}`; }

    const safeVal = (col) =>
      `COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(COALESCE(${col},'0'),'R$ ',''),' L',''),'[^0-9.]','','g'),'')::NUMERIC, 0)`;

    // Resumo por veículo (abastecimentos em posto)
    const { rows: porVeiculo } = await pool.query(`
      SELECT
        r.plate,
        r.vehicle,
        v.model, v.type, v.location, v.fuel_type as veh_fuel,
        COUNT(*) as abastecimentos,
        COALESCE(SUM(${safeVal('r.liters')}), 0) as litros_posto,
        COALESCE(SUM(${safeVal('r.real_value')}), 0) as custo_posto,
        -- Média por abastecimento: quanto o carro costuma abastecer e gastar POR VEZ
        -- (é o que responde "quanto em média está usando esse carro", sem depender de KM)
        ROUND((COALESCE(SUM(${safeVal('r.liters')}), 0) / NULLIF(COUNT(*),0))::numeric, 2) as media_litros_abastecimento,
        ROUND((COALESCE(SUM(${safeVal('r.real_value')}), 0) / NULLIF(COUNT(*),0))::numeric, 2) as media_custo_abastecimento,
        MAX(CASE WHEN r.km > 0 THEN r.km ELSE NULL END) - MIN(CASE WHEN r.km > 0 THEN r.km ELSE NULL END) as km_percorrido,
        MAX(CASE WHEN r.km > 0 THEN r.km ELSE NULL END) as km_atual,
        ROUND(AVG(r.price_per_liter)::numeric, 3) as preco_medio,
        COUNT(DISTINCT r.date) as dias_operacao
      FROM requests r
      LEFT JOIN vehicles v ON v.plate = r.plate
      ${where} AND r.plate IS NOT NULL AND r.fuel_method != 'bombona'
      GROUP BY r.plate, r.vehicle, v.model, v.type, v.location, v.fuel_type
      ORDER BY custo_posto DESC
    `, params);

    // Transferências de bombona por veículo — JOIN com vehicles para trazer model/type/location
    const { rows: transVeiculo } = await pool.query(`
      SELECT
        bt.vehicle_plate as plate,
        COALESCE(v.model, bt.vehicle_model) as vehicle,
        v.type, v.location,
        COALESCE(SUM(bt.liters), 0) as litros_bombona,
        COUNT(*) as transfers_bombona
      FROM bombona_transfers bt
      LEFT JOIN vehicles v ON v.plate = bt.vehicle_plate
      WHERE bt.vehicle_plate IS NOT NULL
        AND bt.vehicle_plate != ''
        AND bt.liters > 0
        ${inicio ? `AND bt.date >= '${inicio}'` : ''}
        ${fim    ? `AND bt.date <= '${fim}'`    : ''}
        ${plate  ? `AND bt.vehicle_plate = '${plate}'` : ''}
      GROUP BY bt.vehicle_plate, bt.vehicle_model, v.model, v.type, v.location
    `);

    // Consumo semanal por veículo (últimas 12 semanas ou período)
    const { rows: semanalBruto } = await pool.query(`
      SELECT
        r.plate,
        TO_CHAR(DATE_TRUNC('week', r.date::date), 'YYYY-MM-DD') as semana,
        COALESCE(SUM(${safeVal('r.liters')}), 0) as litros,
        COALESCE(SUM(${safeVal('r.real_value')}), 0) as custo,
        COUNT(*) as abastecimentos
      FROM requests r
      ${where} AND r.plate IS NOT NULL AND r.fuel_method != 'bombona'
      GROUP BY r.plate, DATE_TRUNC('week', r.date::date)
      ORDER BY r.plate, semana
    `, params);

    // Consumo semanal de bombona por veículo
    const { rows: semanalBombona } = await pool.query(`
      SELECT
        bt.vehicle_plate as plate,
        TO_CHAR(DATE_TRUNC('week', bt.date::date), 'YYYY-MM-DD') as semana,
        COALESCE(SUM(bt.liters), 0) as litros_bombona,
        COUNT(*) as transfers
      FROM bombona_transfers bt
      WHERE bt.vehicle_plate IS NOT NULL AND bt.vehicle_plate != '' AND bt.liters > 0
        ${inicio ? `AND bt.date >= '${inicio}'` : ''}
        ${fim    ? `AND bt.date <= '${fim}'`    : ''}
        ${plate  ? `AND bt.vehicle_plate = '${plate}'` : ''}
      GROUP BY bt.vehicle_plate, DATE_TRUNC('week', bt.date::date)
      ORDER BY bt.vehicle_plate, semana
    `);

    // Histórico detalhado de abastecimentos do veículo — agora com KM RODADO
    // de CADA evento individual (posto OU bombona, já que a bombona também
    // pode ter km informado). O checkpoint de km pode vir de qualquer um dos
    // dois tipos; calculado com LAG sobre TODO o histórico do veículo (não só
    // o período filtrado), senão o primeiro evento visível no filtro ficaria
    // sem "km rodado" mesmo tendo um evento anterior fora do período.
    let historico = [];
    if (plate) {
      const histParams = [plate];
      let histExtra = '';
      if (inicio)     { histParams.push(inicio);     histExtra += ` AND date >= $${histParams.length}`; }
      if (fim)        { histParams.push(fim);        histExtra += ` AND date <= $${histParams.length}`; }
      if (fuel_type)  { histParams.push(fuel_type);  histExtra += ` AND fuel_type = $${histParams.length}`; }

      const { rows } = await pool.query(`
        WITH eventos AS (
          SELECT id, date, created_at, driver, gas_station, city, fuel_type,
                 liters, price_per_liter, real_value, km::bigint as km, horimetre, notes, 'POSTO' as tipo
          FROM requests
          WHERE plate = $1 AND fuel_method != 'bombona' AND status = 'completed'
          UNION ALL
          SELECT bt.id::TEXT, bt.date, bt.created_at, bt.driver, b.name as gas_station, b.location as city,
                 b.fuel_type, bt.liters::TEXT as liters, NULL::real as price_per_liter,
                 NULL::text as real_value, bt.km::bigint as km, NULL::text as horimetre, bt.notes, 'BOMBONA' as tipo
          FROM bombona_transfers bt
          JOIN bombonas b ON b.id = bt.bombona_id
          WHERE bt.vehicle_plate = $1
        ),
        com_km AS (
          SELECT *,
                 LAG(NULLIF(km,0)) OVER (ORDER BY date, created_at) as km_anterior,
                 LAG(date) OVER (ORDER BY date, created_at) as data_km_anterior,
                 CASE WHEN km > 0 THEN km - LAG(NULLIF(km,0)) OVER (ORDER BY date, created_at)
                      ELSE NULL END as km_rodado
          FROM eventos
        )
        SELECT id, date, driver, gas_station, city, fuel_type, liters, price_per_liter,
               real_value, km, horimetre, notes, tipo, km_rodado, km_anterior, data_km_anterior
        FROM com_km
        WHERE 1=1 ${histExtra}
        ORDER BY date DESC, created_at DESC
        LIMIT 200
      `, histParams);
      historico = rows;
    }

    res.json({
      por_veiculo: porVeiculo,
      trans_veiculo: transVeiculo,
      semanal_posto: semanalBruto,
      semanal_bombona: semanalBombona,
      historico
    });
  } catch(e) {
    console.error('relatorio-veiculo erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AUDITORIA DE LITROS ────────────────────────────────────────────────────
// Lista TODOS os abastecimentos (posto E bombona, não só médias) com litros,
// km rodado e consumo (km/L) de cada um, comparando com a média HISTÓRICA
// daquele mesmo veículo — pra facilitar achar abastecimento fora do padrão.
//
// Desde que a transferência de bombona passou a aceitar KM opcional, tratamos
// posto e bombona como uma ÚNICA linha do tempo por placa: o "checkpoint" de
// km pode vir de qualquer um dos dois. Entre dois checkpoints (de qualquer
// tipo), somamos TODOS os litros do intervalo (posto + bombona) pra calcular
// o consumo real — senão um carro abastecido via bombona sem km registrado
// escapava da conta.
app.get('/api/auditoria-litros', async (req, res) => {
  try {
    const { plate, inicio, fim } = req.query;
    const platePosto = plate ? `AND r.plate = '${plate.replace(/'/g,"''")}'` : '';
    const plateBomb  = plate ? `AND bt.vehicle_plate = '${plate.replace(/'/g,"''")}'` : '';

    const safeVal = (col) =>
      `COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(COALESCE(${col},'0'),'R$ ',''),' L',''),'[^0-9.]','','g'),'')::NUMERIC, 0)`;

    // Traz TODO o histórico (sem filtro de período) pra calcular km_rodado e a
    // média do carro corretamente, e só filtra pro período pedido depois —
    // senão o 1º evento visível no filtro fica sem comparação com o de antes.
    const { rows } = await pool.query(`
      WITH eventos AS (
        SELECT r.id, r.plate, r.vehicle, r.driver, r.date, r.created_at, r.km::bigint as km,
               'POSTO' as tipo, r.gas_station, r.city, r.fuel_type, r.price_per_liter,
               ${safeVal('r.liters')} as litros,
               ${safeVal('r.real_value')} as custo
        FROM requests r
        WHERE r.status='completed' AND r.fuel_method != 'bombona' AND r.plate IS NOT NULL ${platePosto}
        UNION ALL
        SELECT bt.id::text, bt.vehicle_plate as plate, bt.vehicle_model as vehicle, bt.driver, bt.date, bt.created_at, bt.km::bigint as km,
               'BOMBONA' as tipo, b.name as gas_station, b.location as city, b.fuel_type, NULL::real as price_per_liter,
               bt.liters::numeric as litros,
               0::numeric as custo
        FROM bombona_transfers bt
        JOIN bombonas b ON b.id = bt.bombona_id
        WHERE bt.vehicle_plate IS NOT NULL AND bt.vehicle_plate != '' ${plateBomb}
      ),
      checkpoints AS (
        SELECT *,
          LAG(NULLIF(km,0)) OVER (PARTITION BY plate ORDER BY date, created_at) as km_anterior,
          LAG(date) OVER (PARTITION BY plate ORDER BY date, created_at) as data_km_anterior,
          CASE WHEN km > 0 THEN
            km - LAG(NULLIF(km,0)) OVER (PARTITION BY plate ORDER BY date, created_at)
          ELSE NULL END as km_rodado
        FROM eventos
      ),
      com_intervalo AS (
        SELECT c.*,
          COALESCE((
            SELECT SUM(e2.litros) FROM eventos e2
            WHERE e2.plate = c.plate
              AND e2.date > COALESCE(c.data_km_anterior, '0001-01-01')
              AND e2.date <= c.date
          ), c.litros)::numeric as litros_intervalo
        FROM checkpoints c
      )
      SELECT ci.*, v.tank_capacity, v.model, v.type, v.location,
        CASE WHEN ci.km_rodado > 0 AND ci.litros_intervalo > 0
             THEN ROUND((ci.km_rodado::numeric / ci.litros_intervalo::numeric)::numeric, 2) ELSE NULL END as consumo_kml
      FROM com_intervalo ci
      LEFT JOIN vehicles v ON v.plate = ci.plate
      ORDER BY ci.plate, ci.date, ci.created_at
    `);

    // O driver 'pg' devolve colunas NUMERIC como STRING (não como number), pra
    // não perder precisão. Isso já causou erro (".toFixed is not a function")
    // porque o código abaixo assumia número direto. Normaliza tudo pra Number
    // logo aqui, uma vez só, pra nenhum outro trecho cair na mesma pegadinha.
    rows.forEach(r => {
      r.litros = parseFloat(r.litros) || 0;
      r.custo = parseFloat(r.custo) || 0;
      r.litros_intervalo = parseFloat(r.litros_intervalo) || 0;
      r.consumo_kml = r.consumo_kml != null ? parseFloat(r.consumo_kml) : null;
      r.tank_capacity = r.tank_capacity != null ? parseFloat(r.tank_capacity) : null;
      r.km = r.km != null ? parseInt(r.km) : null;
      r.km_rodado = r.km_rodado != null ? parseInt(r.km_rodado) : null;
      r.km_anterior = r.km_anterior != null ? parseInt(r.km_anterior) : null;
    });

    // Média de consumo (km/L) POR VEÍCULO, usando só checkpoints com km_rodado
    // positivo — é a referência pra sinalizar quando UM evento específico saiu
    // muito fora do padrão daquele mesmo carro.
    const mediaPorPlaca = {};
    rows.forEach(r => {
      if (r.consumo_kml > 0) {
        if (!mediaPorPlaca[r.plate]) mediaPorPlaca[r.plate] = { soma: 0, n: 0 };
        mediaPorPlaca[r.plate].soma += r.consumo_kml;
        mediaPorPlaca[r.plate].n++;
      }
    });

    // Detecta mais de um evento no mesmo dia pra mesma placa (não é proibido —
    // pode ser motorista + reserva — mas vale sinalizar pra conferir)
    const contagemDia = {};
    rows.forEach(r => {
      const k = `${r.plate}|${r.date}`;
      contagemDia[k] = (contagemDia[k] || 0) + 1;
    });

    const auditados = rows
      .filter(r => !inicio || r.date >= inicio)
      .filter(r => !fim || r.date <= fim)
      .map(r => {
        const mediaCarro = mediaPorPlaca[r.plate] && mediaPorPlaca[r.plate].n >= 2
          ? mediaPorPlaca[r.plate].soma / mediaPorPlaca[r.plate].n : null;
        const alertas = [];

        if (r.tank_capacity && r.litros > r.tank_capacity * 1.05) {
          alertas.push({ tipo: 'TANQUE_ESTOURADO', msg: `Recebeu ${r.litros.toFixed(1)} L num tanque de ${r.tank_capacity} L` });
        }
        if (r.km_rodado !== null && r.km_rodado < 0) {
          alertas.push({ tipo: 'KM_VOLTOU', msg: `KM do evento anterior era maior (odômetro voltou ${Math.abs(r.km_rodado)} km)` });
        }
        // Cheio sem rodar: conta TUDO que caiu no intervalo (posto + bombona),
        // não importa qual dos dois trouxe o checkpoint de km.
        if (r.km_rodado !== null && r.km_rodado >= 0 && r.km_rodado <= 3 && r.litros_intervalo >= 8) {
          alertas.push({ tipo: 'CHEIO_SEM_RODAR', msg: `${r.litros_intervalo.toFixed(1)} L no intervalo, mas rodou só ${r.km_rodado} km desde o último checkpoint` });
        }
        if (mediaCarro && r.consumo_kml && r.consumo_kml < mediaCarro * 0.5) {
          alertas.push({ tipo: 'CONSUMO_MUITO_ABAIXO', msg: `Consumo de ${r.consumo_kml} km/L, bem abaixo da média do carro (${mediaCarro.toFixed(1)} km/L)` });
        }
        if (contagemDia[`${r.plate}|${r.date}`] > 1) {
          alertas.push({ tipo: 'MESMO_DIA', msg: `Mais de um evento nesta placa no mesmo dia` });
        }
        // Só dispara pra bombonas SEM km próprio — se ela já tem km, ela é um
        // checkpoint completo como qualquer posto, não precisa de alerta.
        if (r.tipo === 'BOMBONA' && !r.km && r.litros > 5) {
          alertas.push({ tipo: 'BOMBONA_SEM_KM', msg: `Recebeu ${r.litros.toFixed(1)} L de bombona sem informar KM — sem esse dado essa transferência não checa consumo` });
        }

        return {
          id: r.id, plate: r.plate, vehicle: r.vehicle, model: r.model, type: r.type,
          location: r.location, driver: r.driver, date: r.date, tipo: r.tipo,
          gas_station: r.gas_station, city: r.city, fuel_type: r.fuel_type,
          liters: parseFloat(r.litros.toFixed(1)),
          litros_intervalo: parseFloat(r.litros_intervalo.toFixed(1)),
          custo: parseFloat(r.custo.toFixed(2)),
          price_per_liter: r.price_per_liter, km: r.km, km_rodado: r.km_rodado,
          km_anterior: r.km_anterior, data_km_anterior: r.data_km_anterior,
          consumo_kml: r.consumo_kml, media_carro_kml: mediaCarro ? parseFloat(mediaCarro.toFixed(2)) : null,
          tank_capacity: r.tank_capacity, alertas
        };
      });

    // Resumo por veículo — pra ranquear quem tem mais alertas
    const porVeiculoMap = {};
    auditados.forEach(a => {
      if (!porVeiculoMap[a.plate]) {
        porVeiculoMap[a.plate] = {
          plate: a.plate, vehicle: a.vehicle, model: a.model, type: a.type, location: a.location,
          abastecimentos: 0, litros_total: 0, litros_bombona_total: 0, custo_total: 0, alertas_total: 0
        };
      }
      const v = porVeiculoMap[a.plate];
      v.abastecimentos++;
      v.litros_total += a.liters;
      if (a.tipo === 'BOMBONA') v.litros_bombona_total += a.liters;
      v.custo_total += a.custo;
      v.alertas_total += a.alertas.length;
    });

    res.json({
      abastecimentos: auditados.sort((a,b) => b.alertas.length - a.alertas.length || (a.date < b.date ? 1 : -1)),
      por_veiculo: Object.values(porVeiculoMap).sort((a,b) => b.alertas_total - a.alertas_total),
      total_alertas: auditados.reduce((s,a) => s + a.alertas.length, 0)
    });
  } catch(e) {
    console.error('auditoria-litros erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── KM RODADO POR VEÍCULO ─────────────────────────────────────────────────
// Visão dedicada só de KM: cada evento (posto OU bombona, já que ambos podem
// ter km) com o km rodado desde o checkpoint anterior daquele veículo — igual
// a Auditoria de Litros calcula, mas aqui sem alertas de fraude, com filtro
// de motorista e posto/bombona, pra conferência rápida do dia a dia.
app.get('/api/km-rodado', async (req, res) => {
  try {
    const { plate, driver, gas_station, inicio, fim } = req.query;
    const platePosto = plate ? `AND r.plate = '${plate.replace(/'/g,"''")}'` : '';
    const plateBomb  = plate ? `AND bt.vehicle_plate = '${plate.replace(/'/g,"''")}'` : '';

    const { rows } = await pool.query(`
      WITH eventos AS (
        SELECT r.id, r.plate, r.vehicle, r.driver, r.date, r.created_at, r.km::bigint as km,
               'POSTO' as tipo, r.gas_station, r.city, r.fuel_type
        FROM requests r
        WHERE r.status='completed' AND r.fuel_method != 'bombona' AND r.plate IS NOT NULL ${platePosto}
        UNION ALL
        SELECT bt.id::text, bt.vehicle_plate as plate, bt.vehicle_model as vehicle, bt.driver, bt.date, bt.created_at, bt.km::bigint as km,
               'BOMBONA' as tipo, b.name as gas_station, b.location as city, b.fuel_type
        FROM bombona_transfers bt
        JOIN bombonas b ON b.id = bt.bombona_id
        WHERE bt.vehicle_plate IS NOT NULL AND bt.vehicle_plate != '' ${plateBomb}
      ),
      checkpoints AS (
        SELECT *,
          LAG(NULLIF(km,0)) OVER (PARTITION BY plate ORDER BY date, created_at) as km_anterior,
          LAG(date) OVER (PARTITION BY plate ORDER BY date, created_at) as data_km_anterior,
          CASE WHEN km > 0 THEN
            km - LAG(NULLIF(km,0)) OVER (PARTITION BY plate ORDER BY date, created_at)
          ELSE NULL END as km_rodado
        FROM eventos
      )
      SELECT c.*, v.model, v.type, v.location, v.equipment_id
      FROM checkpoints c
      LEFT JOIN vehicles v ON v.plate = c.plate
      ORDER BY c.plate, c.date, c.created_at
    `);

    // Normaliza tipos (pg devolve NUMERIC/BIGINT como string)
    rows.forEach(r => {
      r.km = r.km != null ? parseInt(r.km) : null;
      r.km_anterior = r.km_anterior != null ? parseInt(r.km_anterior) : null;
      r.km_rodado = r.km_rodado != null ? parseInt(r.km_rodado) : null;
    });

    // Filtra por período/motorista/posto DEPOIS de calcular o km_rodado sobre
    // o histórico completo — senão o km rodado do 1º evento visível no filtro
    // ficaria errado (contra um checkpoint que o filtro escondeu).
    const eventos = rows
      .filter(r => !inicio || r.date >= inicio)
      .filter(r => !fim || r.date <= fim)
      .filter(r => !driver || r.driver === driver)
      .filter(r => !gas_station || r.gas_station === gas_station);

    // Resumo por veículo — soma só o km_rodado dos eventos que sobraram no
    // filtro (não do histórico completo, senão o total não bateria com a tabela)
    const porVeiculoMap = {};
    eventos.forEach(e => {
      if (!porVeiculoMap[e.plate]) {
        porVeiculoMap[e.plate] = {
          plate: e.plate, vehicle: e.vehicle, model: e.model, type: e.type,
          location: e.location, equipment_id: e.equipment_id,
          eventos: 0, km_total: 0, km_min: null, km_max: null
        };
      }
      const v = porVeiculoMap[e.plate];
      v.eventos++;
      if (e.km_rodado != null && e.km_rodado >= 0) v.km_total += e.km_rodado;
      if (e.km != null) {
        if (v.km_min === null || e.km < v.km_min) v.km_min = e.km;
        if (v.km_max === null || e.km > v.km_max) v.km_max = e.km;
      }
    });

    res.json({
      eventos: eventos.sort((a,b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      por_veiculo: Object.values(porVeiculoMap).sort((a,b) => b.km_total - a.km_total)
    });
  } catch(e) {
    console.error('km-rodado erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── RELATÓRIO POR POSTO ───────────────────────────────────────────────────────
app.get('/api/relatorio-posto', async (req, res) => {
  try {
    const { gas_station, inicio, fim, fuel_type } = req.query;
    const params = [];
    let where = `WHERE r.status = 'completed'`;
    if (inicio)      { params.push(inicio);      where += ` AND r.date >= $${params.length}`; }
    if (fim)         { params.push(fim);         where += ` AND r.date <= $${params.length}`; }
    if (gas_station) { params.push(gas_station); where += ` AND r.gas_station = $${params.length}`; }
    if (fuel_type)   { params.push(fuel_type);   where += ` AND r.fuel_type = $${params.length}`; }

    const safeVal = (col) =>
      `COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(COALESCE(${col},'0'),'R$ ',''),' L',''),'[^0-9.]','','g'),'')::NUMERIC, 0)`;

    const { rows: porPosto } = await pool.query(`
      SELECT
        r.gas_station,
        r.city,
        r.fuel_type,
        COUNT(*) as abastecimentos,
        COALESCE(SUM(${safeVal('r.liters')}), 0) as litros,
        COALESCE(SUM(${safeVal('r.real_value')}), 0) as custo,
        ROUND(AVG(r.price_per_liter)::numeric, 3) as preco_medio,
        COUNT(DISTINCT r.plate) as veiculos_distintos,
        COUNT(DISTINCT r.driver) as motoristas_distintos
      FROM requests r
      ${where}
      GROUP BY r.gas_station, r.city, r.fuel_type
      ORDER BY custo DESC
    `, params);

    // Evolução semanal por posto
    const { rows: semanal } = await pool.query(`
      SELECT
        r.gas_station,
        TO_CHAR(DATE_TRUNC('week', r.date::date), 'YYYY-MM-DD') as semana,
        COALESCE(SUM(${safeVal('r.liters')}), 0) as litros,
        COALESCE(SUM(${safeVal('r.real_value')}), 0) as custo,
        COUNT(*) as abastecimentos
      FROM requests r
      ${where}
      GROUP BY r.gas_station, DATE_TRUNC('week', r.date::date)
      ORDER BY r.gas_station, semana
    `, params);

    res.json({ por_posto: porPosto, semanal });
  } catch(e) {
    console.error('relatorio-posto erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── RELATÓRIO UNIFICADO BOMBONA ────────────────────────────────────────────────
// Mostra entrada (abastecimento) + saída (transferência) de cada bombona
app.get('/api/relatorio-bombona', async (req, res) => {
  try {
    const { bombona_id, inicio, fim, operator_id } = req.query;
    const params = [];
    let whereT = 'WHERE 1=1';
    let whereH = 'WHERE 1=1';
    let whereB = '1=1'; // filtro para bombonas
    if (bombona_id)  { params.push(bombona_id);  whereT += ` AND bt.bombona_id=$${params.length}`; whereH += ` AND h.bombona_id=$${params.length}`; whereB += ` AND b.id=$${params.length}`; }
    if (operator_id) { params.push(parseInt(operator_id)); whereT += ` AND (SELECT operator_id FROM bombonas WHERE id=bt.bombona_id)=$${params.length}`; whereH += ` AND (SELECT operator_id FROM bombonas WHERE id=h.bombona_id)=$${params.length}`; whereB += ` AND b.operator_id=$${params.length}`; }
    if (inicio) { params.push(inicio); whereT += ` AND bt.date>=$${params.length}`; whereH += ` AND DATE(h.created_at)>=$${params.length}`; }
    if (fim)    { params.push(fim);    whereT += ` AND bt.date<=$${params.length}`; whereH += ` AND DATE(h.created_at)<=$${params.length}`; }

    // Saldo atual + totais — filtra por bombona_id e/ou operator_id se informados
    const bombParamVals = params.filter((_, i) => {
      // pega só os params que fazem parte do whereB (bombona_id e operator_id)
      return i < (bombona_id ? 1 : 0) + (operator_id ? 1 : 0);
    });
    const { rows: bombonas } = await pool.query(`
      SELECT b.*,
        o.name as operator_name,
        o.matricula as operator_matricula,
        COALESCE(SUM(CASE WHEN h.variacao > 0 THEN h.variacao ELSE 0 END),0) as total_entradas,
        COALESCE(SUM(CASE WHEN h.variacao < 0 THEN ABS(h.variacao) ELSE 0 END),0) as total_saidas,
        COUNT(DISTINCT CASE WHEN h.variacao < 0 THEN h.id END) as qtd_saidas,
        COUNT(DISTINCT CASE WHEN h.variacao > 0 THEN h.id END) as qtd_entradas
      FROM bombonas b
      LEFT JOIN bombona_saldo_history h ON h.bombona_id = b.id
      LEFT JOIN bombona_operators o ON o.id = b.operator_id
      WHERE ${whereB}
      GROUP BY b.id, o.name, o.matricula
      ORDER BY b.name
    `, bombParamVals);

    // Movimentações detalhadas (entradas e saídas juntas)
    const { rows: movimentos } = await pool.query(`
      SELECT
        bt.id, bt.date, bt.driver,
        bt.vehicle_plate, bt.vehicle_model, bt.liters,
        bt.notes, bt.registered_by,
        b.name as bombona_name, b.fuel_type, b.location,
        CASE
          WHEN bt.notes ILIKE '%abastecimento%' OR bt.notes ILIKE '%Req%' OR bt.vehicle_plate IS NULL THEN 'ENTRADA'
          ELSE 'SAÍDA'
        END as tipo
      FROM bombona_transfers bt
      JOIN bombonas b ON b.id = bt.bombona_id
      ${whereT}
      ORDER BY bt.date DESC, bt.created_at DESC
      LIMIT 500
    `, params);

    // Saldo histórico semanal
    const { rows: historicoSaldo } = await pool.query(`
      SELECT
        h.bombona_id,
        b.name as bombona_name,
        TO_CHAR(DATE_TRUNC('week', h.created_at), 'YYYY-MM-DD') as semana,
        COALESCE(SUM(CASE WHEN h.variacao > 0 THEN h.variacao ELSE 0 END),0) as entradas,
        COALESCE(SUM(CASE WHEN h.variacao < 0 THEN ABS(h.variacao) ELSE 0 END),0) as saidas,
        MIN(h.saldo_novo) as saldo_min,
        MAX(h.saldo_novo) as saldo_max
      FROM bombona_saldo_history h
      JOIN bombonas b ON b.id = h.bombona_id
      ${whereH}
      GROUP BY h.bombona_id, b.name, DATE_TRUNC('week', h.created_at)
      ORDER BY h.bombona_id, semana
    `, params);

    res.json({ bombonas, movimentos, historico_saldo: historicoSaldo });
  } catch(e) {
    console.error('relatorio-bombona erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── RELATÓRIO POR LOCALIDADE ──────────────────────────────────────────────────
app.get('/api/relatorio-localidade', async (req, res) => {
  try {
    const { cidade, inicio, fim, fuel_type } = req.query;
    const params = [];
    let whereR = `WHERE r.status = 'completed' AND r.fuel_method != 'bombona'`;
    let whereB = `WHERE 1=1`;
    if (inicio)    { params.push(inicio);    whereR += ` AND r.date >= $${params.length}`; whereB += ` AND bt.date >= $${params.length}`; }
    if (fim)       { params.push(fim);       whereR += ` AND r.date <= $${params.length}`; whereB += ` AND bt.date <= $${params.length}`; }
    if (cidade)    { params.push(cidade);    whereR += ` AND r.city = $${params.length}`;  whereB += ` AND b.location = $${params.length}`; }
    if (fuel_type) { params.push(fuel_type); whereR += ` AND r.fuel_type = $${params.length}`; }

    const sv = (col) =>
      `COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(COALESCE(${col},'0'),'R$ ',''),' L',''),'[^0-9.]','','g'),'')::NUMERIC,0)`;

    const [resResumo, resPosto, resBombona, resSemanal, resVeiculos, resPostos, resComb] = await Promise.all([

      // 1. Resumo por cidade (posto + bombona juntos)
      pool.query(`
        SELECT
          r.city as cidade,
          COUNT(DISTINCT r.plate) as veiculos_distintos,
          COUNT(DISTINCT r.driver) as motoristas_distintos,
          COUNT(*) as abastecimentos_posto,
          COALESCE(SUM(${sv('r.liters')}),0) as litros_posto,
          COALESCE(SUM(${sv('r.real_value')}),0) as custo_posto,
          ROUND(AVG(r.price_per_liter)::numeric,3) as preco_medio
        FROM requests r
        ${whereR} AND r.city IS NOT NULL
        GROUP BY r.city
        ORDER BY custo_posto DESC
      `, params),

      // 2. Abastecimentos detalhados em posto (para tabela histórico)
      cidade ? pool.query(`
        SELECT r.id, r.date, r.driver, r.plate, r.vehicle, r.gas_station,
               r.fuel_type, r.liters, r.price_per_liter, r.real_value, r.km, r.notes
        FROM requests r
        ${whereR}
        ORDER BY r.date DESC LIMIT 300
      `, params) : { rows: [] },

      // 3. Bombona: saídas por localidade da bombona (transferências pro campo)
      pool.query(`
        SELECT
          b.location as cidade,
          COUNT(*) as transfers,
          COALESCE(SUM(bt.liters),0) as litros_bombona,
          COUNT(DISTINCT bt.vehicle_plate) as veiculos_distintos_bomb,
          COUNT(DISTINCT bt.driver) as motoristas_distintos_bomb
        FROM bombona_transfers bt
        JOIN bombonas b ON b.id = bt.bombona_id
        ${whereB} AND bt.vehicle_plate IS NOT NULL AND b.location IS NOT NULL AND bt.liters > 0
        GROUP BY b.location
        ORDER BY litros_bombona DESC
      `, params),

      // 4. Consumo semanal por cidade
      pool.query(`
        SELECT
          r.city as cidade,
          TO_CHAR(DATE_TRUNC('week', r.date::date),'YYYY-MM-DD') as semana,
          COALESCE(SUM(${sv('r.liters')}),0) as litros,
          COALESCE(SUM(${sv('r.real_value')}),0) as custo,
          COUNT(*) as abastecimentos
        FROM requests r
        ${whereR} AND r.city IS NOT NULL
        GROUP BY r.city, DATE_TRUNC('week', r.date::date)
        ORDER BY r.city, semana
      `, params),

      // 5. Top veículos por cidade
      pool.query(`
        SELECT
          r.city as cidade,
          r.plate,
          r.vehicle,
          COUNT(*) as abastecimentos,
          COALESCE(SUM(${sv('r.liters')}),0) as litros,
          COALESCE(SUM(${sv('r.real_value')}),0) as custo,
          MAX(CASE WHEN r.km > 0 THEN r.km ELSE NULL END)
            - MIN(CASE WHEN r.km > 0 THEN r.km ELSE NULL END) as km_percorrido
        FROM requests r
        ${whereR} AND r.city IS NOT NULL AND r.plate IS NOT NULL
        GROUP BY r.city, r.plate, r.vehicle
        ORDER BY r.city, custo DESC
      `, params),

      // 6. Postos por cidade (quais postos foram usados)
      pool.query(`
        SELECT
          r.city as cidade,
          r.gas_station,
          COUNT(*) as abastecimentos,
          COALESCE(SUM(${sv('r.liters')}),0) as litros,
          COALESCE(SUM(${sv('r.real_value')}),0) as custo,
          ROUND(AVG(r.price_per_liter)::numeric,3) as preco_medio
        FROM requests r
        ${whereR} AND r.city IS NOT NULL AND r.gas_station IS NOT NULL
        GROUP BY r.city, r.gas_station
        ORDER BY r.city, custo DESC
      `, params),

      // 7. Por tipo de combustível por cidade
      pool.query(`
        SELECT
          r.city as cidade,
          r.fuel_type,
          COUNT(*) as abastecimentos,
          COALESCE(SUM(${sv('r.liters')}),0) as litros,
          COALESCE(SUM(${sv('r.real_value')}),0) as custo,
          ROUND(AVG(r.price_per_liter)::numeric,3) as preco_medio
        FROM requests r
        ${whereR} AND r.city IS NOT NULL
        GROUP BY r.city, r.fuel_type
        ORDER BY r.city, custo DESC
      `, params)
    ]);

    res.json({
      resumo:    resResumo.rows,
      historico: resPosto.rows,
      bombona:   resBombona.rows,
      semanal:   resSemanal.rows,
      veiculos:  resVeiculos.rows,
      postos:    resPostos.rows,
      combustiveis: resComb.rows
    });
  } catch(e) {
    console.error('relatorio-localidade erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── RELATÓRIO MENSAL CONSOLIDADO ─────────────────────────────────────────────
app.get('/api/relatorio-mensal', async (req, res) => {
  try {
    const { ano, mes } = req.query;
    const y = parseInt(ano) || new Date().getFullYear();
    const m = parseInt(mes) || new Date().getMonth() + 1;
    const inicio = `${y}-${String(m).padStart(2,'0')}-01`;
    const fim    = new Date(y, m, 0).toISOString().split('T')[0];

    // Função inline segura: extrai número de texto como 'R$ 1.234,56' ou 'Via Bombona' → 0
    const safeVal = (col) =>
      `COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(REPLACE(COALESCE(${col},'0'),'R$ ',''),' L',''),'[^0-9.]','','g'),'')::NUMERIC, 0)`;

    const [geral, porLocalidade, porCombustivel, porVeiculo, porMotorista] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER(WHERE status='completed') as total_abastecimentos,
          COUNT(*) FILTER(WHERE status='rejected')  as total_rejeitados,
          COUNT(*) FILTER(WHERE status='pending' OR status='signed') as total_pendentes,
          -- FIX: separa custo total (inclui bombona) do custo só frota (exclui bombona)
          COALESCE(SUM(CASE WHEN status='completed' THEN ${safeVal('real_value')} ELSE 0 END),0) as custo_total,
          COALESCE(SUM(CASE WHEN status='completed' AND fuel_method != 'bombona' THEN ${safeVal('real_value')} ELSE 0 END),0) as custo_frota,
          COALESCE(SUM(CASE WHEN status='completed' AND fuel_method = 'bombona' THEN ${safeVal('real_value')} ELSE 0 END),0) as custo_bombona,
          -- FIX: litros_total: frota (consumo direto) vs bombona (estoque)
          COALESCE(SUM(CASE WHEN status='completed' AND fuel_method != 'bombona' THEN ${safeVal('liters')} ELSE 0 END),0) as litros_total,
          COALESCE(SUM(CASE WHEN status='completed' AND fuel_method = 'bombona' THEN ${safeVal('liters')} ELSE 0 END),0) as litros_bombona_abastecida,
          COUNT(DISTINCT driver) FILTER(WHERE status='completed') as motoristas_ativos,
          COUNT(DISTINCT plate) FILTER(WHERE status='completed' AND plate IS NOT NULL AND fuel_method != 'bombona') as veiculos_abastecidos
        FROM requests WHERE date >= $1 AND date <= $2
      `, [inicio, fim]),

      pool.query(`
        SELECT
          city as localidade,
          COUNT(*) FILTER(WHERE status='completed' AND fuel_method != 'bombona') as abastecimentos,
          COALESCE(SUM(CASE WHEN status='completed' AND fuel_method != 'bombona' THEN ${safeVal('real_value')} ELSE 0 END),0) as custo,
          COALESCE(SUM(CASE WHEN status='completed' AND fuel_method != 'bombona' THEN ${safeVal('liters')} ELSE 0 END),0) as litros
        FROM requests WHERE date >= $1 AND date <= $2 AND status='completed' AND city IS NOT NULL
        GROUP BY city ORDER BY custo DESC
      `, [inicio, fim]),

      pool.query(`
        SELECT
          fuel_type as combustivel,
          COUNT(*) as abastecimentos,
          COALESCE(SUM(${safeVal('liters')}),0) as litros,
          COALESCE(SUM(${safeVal('real_value')}),0) as custo,
          ROUND(AVG(price_per_liter)::numeric,3) as preco_medio
        FROM requests WHERE date >= $1 AND date <= $2 AND status='completed'
          AND fuel_method != 'bombona'
        GROUP BY fuel_type ORDER BY custo DESC
      `, [inicio, fim]),

      pool.query(`
        WITH veic AS (
          SELECT
            plate, vehicle,
            COUNT(*) as abastecimentos,
            COALESCE(SUM(${safeVal('liters')}),0) as litros,
            COALESCE(SUM(${safeVal('real_value')}),0) as custo,
            MAX(CASE WHEN km > 0 THEN km ELSE NULL END) - MIN(CASE WHEN km > 0 THEN km ELSE NULL END) as km_percorrido,
            MAX(CASE WHEN km > 0 THEN km ELSE NULL END) as km_atual
          FROM requests WHERE date >= $1 AND date <= $2 AND status='completed' AND plate IS NOT NULL
            AND fuel_method != 'bombona'
          GROUP BY plate, vehicle
        )
        SELECT *,
          CASE WHEN km_percorrido > 0 AND litros > 0
               THEN ROUND((km_percorrido::NUMERIC / litros),2) ELSE NULL END as media_kmL,
          CASE WHEN km_percorrido > 0 AND custo > 0
               THEN ROUND((custo / km_percorrido)::NUMERIC,3) ELSE NULL END as cpk
        FROM veic ORDER BY custo DESC LIMIT 30
      `, [inicio, fim]),

      pool.query(`
        SELECT
          driver as motorista,
          COUNT(*) FILTER(WHERE fuel_method != 'bombona') as abastecimentos,
          COALESCE(SUM(CASE WHEN fuel_method != 'bombona' THEN ${safeVal('liters')} ELSE 0 END),0) as litros,
          COALESCE(SUM(${safeVal('real_value')}),0) as custo
        FROM requests WHERE date >= $1 AND date <= $2 AND status='completed'
        GROUP BY driver ORDER BY custo DESC LIMIT 20
      `, [inicio, fim])
    ]);

    res.json({
      periodo: { ano: y, mes: m, inicio, fim },
      geral: geral.rows[0],
      por_localidade: porLocalidade.rows,
      por_combustivel: porCombustivel.rows,
      por_veiculo: porVeiculo.rows,
      por_motorista: porMotorista.rows
    });
  } catch(e) {
    console.error('Relatório mensal falhou:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CUSTO POR KM (CPK) por veículo ────────────────────────────────────────────
app.get('/api/cpk', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH abast AS (
        SELECT plate, vehicle,
          COUNT(*) as abastecimentos,
          SUM(COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(COALESCE(liters,'0'),' L',''),'[^0-9.]','','g'),'')::NUMERIC,0)) as litros_total,
          SUM(COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(COALESCE(real_value,'0'),'R$ ',''),'[^0-9.]','','g'),'')::NUMERIC,0)) as custo_total,
          MAX(CASE WHEN km > 0 THEN km ELSE NULL END) as km_max,
          MIN(CASE WHEN km > 0 THEN km ELSE NULL END) as km_min,
          MAX(CASE WHEN km > 0 THEN km ELSE NULL END) - MIN(CASE WHEN km > 0 THEN km ELSE NULL END) as km_percorrido
        FROM requests WHERE status='completed' AND plate IS NOT NULL AND km IS NOT NULL AND km > 0
          AND fuel_method != 'bombona'
          AND created_at >= NOW() - INTERVAL '90 days'
        GROUP BY plate, vehicle HAVING COUNT(*) >= 2
      )
      SELECT a.*,
        v.model, v.type, v.location, v.fuel_type,
        CASE WHEN a.km_percorrido > 0 AND a.litros_total > 0
             THEN ROUND((a.km_percorrido::NUMERIC / a.litros_total), 2) ELSE NULL END as media_kmL,
        CASE WHEN a.km_percorrido > 0 AND a.custo_total > 0
             THEN ROUND((a.custo_total / a.km_percorrido)::NUMERIC, 4) ELSE NULL END as cpk,
        CASE WHEN a.km_percorrido > 0 AND a.custo_total > 0
             THEN ROUND((a.custo_total / a.km_percorrido * 100)::NUMERIC, 2) ELSE NULL END as custo_por_100km
      FROM abast a LEFT JOIN vehicles v ON v.plate = a.plate
      ORDER BY custo_total DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/validate-km', async (req, res) => {
  try {
    const { plate, km } = req.query;
    if (!plate || !km) return res.json({ valid: true });
    const { rows } = await pool.query(
      `SELECT km FROM requests WHERE plate=$1 AND km IS NOT NULL AND status='completed'
       ORDER BY created_at DESC LIMIT 1`, [plate]
    );
    const lastKm = rows[0]?.km;
    if (!lastKm) return res.json({ valid: true, lastKm: null });
    const newKm = parseInt(km);
    const valid = newKm >= lastKm;
    res.json({ valid, lastKm, newKm, diff: newKm - lastKm });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTAS DE BOMBONA CRÍTICA (< 20% saldo) ─────────────────────────────────
app.get('/api/bombona-alertas', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, fuel_type, current_liters, capacity_liters, responsible_driver, location,
        ROUND((current_liters/NULLIF(capacity_liters,0)*100)::numeric,1) as pct_saldo
      FROM bombonas
      WHERE status='Ativa' AND capacity_liters > 0
        AND (current_liters/NULLIF(capacity_liters,0)) < 0.2
      ORDER BY (current_liters/NULLIF(capacity_liters,0)) ASC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fuel-consumption', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY plate ORDER BY date DESC, created_at DESC) rn
        FROM requests WHERE status='completed' AND km IS NOT NULL AND km > 0 AND liters IS NOT NULL AND fuel_method != 'bombona'
      )
      SELECT curr.plate, curr.vehicle, curr.driver,
             curr.date as current_date, prev.date as previous_date,
             curr.km::bigint as current_km, prev.km::bigint as previous_km,
             (curr.km - prev.km) as km_driven,
             CAST(REPLACE(REPLACE(curr.liters,' L',''),',','.') AS REAL) as liters_used,
             curr.fuel_type, curr.gas_station, curr.real_value,
             v.location as location, v.type as vehicle_type,
             CASE WHEN (curr.km - prev.km) > 0
                       AND CAST(REPLACE(REPLACE(curr.liters,' L',''),',','.') AS REAL) > 0
                  THEN ROUND(CAST(
                    (curr.km - prev.km)::REAL /
                    CAST(REPLACE(REPLACE(curr.liters,' L',''),',','.') AS REAL)
                  AS NUMERIC), 2)
                  ELSE NULL END as avg_consumption
      FROM ranked curr
      LEFT JOIN ranked prev ON curr.plate = prev.plate AND prev.rn = curr.rn + 1
      LEFT JOIN vehicles v ON curr.plate = v.plate
      WHERE curr.rn >= 1 AND (curr.km - prev.km) > 0
      ORDER BY curr.date DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ESTATÍSTICAS DE BOMBONAS (para aba Consumo) ───────────────────────────────
app.get('/api/bombona-consumption', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id,
        b.name,
        b.fuel_type,
        b.capacity_liters,
        b.current_liters,
        b.responsible_driver,
        b.location,
        b.status,
        COALESCE(SUM(bt.liters), 0)  AS total_transferred,
        COUNT(bt.id)                 AS transfer_count,
        MAX(bt.date)                 AS last_transfer_date,
        COALESCE(SUM(
          CASE WHEN NULLIF(bt.date,'')::date >= CURRENT_DATE - INTERVAL '30 days'
               THEN bt.liters ELSE 0 END
        ), 0) AS transferred_30d,
        COALESCE(SUM(
          CASE WHEN NULLIF(bt.date,'')::date >= CURRENT_DATE - INTERVAL '7 days'
               THEN bt.liters ELSE 0 END
        ), 0) AS transferred_7d
      FROM bombonas b
      LEFT JOIN bombona_transfers bt ON bt.bombona_id = b.id
      GROUP BY b.id, b.name, b.fuel_type, b.capacity_liters, b.current_liters,
               b.responsible_driver, b.location, b.status
      ORDER BY total_transferred DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('bombona-consumption erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [r1, r2, r3, r4, r5] = await Promise.all([
      // Contagens de requisições (30 dias)
      pool.query(`SELECT
        COUNT(*) FILTER(WHERE status='pending') as pending,
        COUNT(*) FILTER(WHERE status='signed') as signed,
        COUNT(*) FILTER(WHERE status='completed') as completed,
        COUNT(*) FILTER(WHERE status='rejected') as rejected,
        COUNT(*) FILTER(WHERE status='pending' AND priority='emergency') as emergency_pending,
        COUNT(*) FILTER(WHERE status='signed' AND updated_at < NOW()-INTERVAL '4 hours') as signed_atrasadas
        FROM requests WHERE created_at >= NOW()-INTERVAL '30 days'`),
      // Bombonas ativas e críticas (saldo < 20%)
      pool.query(`SELECT
        COUNT(*) as total,
        COUNT(*) FILTER(WHERE current_liters/NULLIF(capacity_liters,0) < 0.2) as criticas,
        COUNT(*) FILTER(WHERE current_liters = 0) as vazias
        FROM bombonas WHERE status='Ativa'`),
      // Custo e litros do mês atual
      pool.query(`SELECT
        COALESCE(SUM(COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(COALESCE(real_value,'0'),'R$ ',''),'[^0-9.]','','g'),'')::NUMERIC,0)),0) as custo_mes,
        COUNT(*) as abastecimentos_mes
        FROM requests
        WHERE status='completed'
        AND created_at >= DATE_TRUNC('month', NOW())`),
      // Custo e litros do mês anterior (para comparativo)
      pool.query(`SELECT
        COALESCE(SUM(COALESCE(NULLIF(REGEXP_REPLACE(REPLACE(COALESCE(real_value,'0'),'R$ ',''),'[^0-9.]','','g'),'')::NUMERIC,0)),0) as custo_mes_anterior
        FROM requests
        WHERE status='completed'
        AND created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
        AND created_at < DATE_TRUNC('month', NOW())`),
      // Top 3 bombonas críticas para alerta
      pool.query(`SELECT name, responsible_driver, current_liters, capacity_liters, location,
        ROUND((current_liters/NULLIF(capacity_liters,0)*100)::numeric,0) as pct
        FROM bombonas WHERE status='Ativa' AND capacity_liters > 0
        ORDER BY (current_liters/NULLIF(capacity_liters,0)) ASC LIMIT 3`)
    ]);
    res.json({
      requests: r1.rows[0],
      bombonas: r2.rows[0],
      financeiro: { ...r3.rows[0], custo_mes_anterior: r4.rows[0]?.custo_mes_anterior || 0 },
      bombonas_criticas: r5.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DIAGNÓSTICO MICROSOFT GRAPH ───────────────────────────────────────────────
app.get('/api/ms-diagnostico', requireSupOnly, async (req, res) => {
  const result = { token: false, site: false, drive: false, errors: [] };
  try {
    // 1. Testar autenticação (token)
    const token = await getToken();
    result.token = true;

    // 2. Testar acesso ao site SharePoint
    const siteId = process.env.SHAREPOINT_SITE_ID;
    try {
      const r = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${siteId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      result.site = true;
      result.siteName = r.data.displayName;
    } catch (e) {
      result.errors.push(`Site: ${e.response?.status} — ${JSON.stringify(e.response?.data?.error || e.message)}`);
    }

    // 3. Testar acesso ao drive
    try {
      const r = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      result.drive = true;
      result.driveName = r.data.name;
    } catch (e) {
      result.errors.push(`Drive: ${e.response?.status} — ${JSON.stringify(e.response?.data?.error || e.message)}`);
    }

    res.json(result);
  } catch (e) {
    result.errors.push(`Token: ${e.response?.status || ''} — ${JSON.stringify(e.response?.data || e.message)}`);
    res.status(500).json(result);
  }
});

app.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'OK', ts: new Date() }); }
  catch (e) { res.status(500).json({ status:'ERROR', error: e.message }); }
});

// ── NORMALIZAÇÃO DE VALOR/LITROS (evita divergência de formato no banco) ─────
// BUG CORRIGIDO: o campo "Valor Total" do lançamento retroativo é texto livre
// com placeholder "Ex: R$ 304,95" (formato brasileiro, vírgula decimal), mas
// era salvo cru no banco. O parser dos relatórios (safeVal) só remove o "R$ "
// e caracteres não-numéricos, então "304,95" virava "30495" — inflando o custo
// em ~100x sempre que alguém digitasse no formato sugerido pelo próprio campo.
// Esta função aceita "R$ 304,95", "304,95", "304.95" ou "304" e sempre devolve
// um número JS correto, para gravarmos no formato canônico "R$ 1234.56".
function parseValorBR(input) {
  if (input === null || input === undefined || input === '') return null;
  let s = String(input).trim().replace(/^R\$\s*/i, '').replace(/\s*L$/i, '').trim();
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');
  if (temVirgula && temPonto) {
    // "1.234,56" (BR completo) → remove milhar, vírgula vira ponto
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (temVirgula) {
    // "304,95" → vírgula é decimal
    s = s.replace(',', '.');
  }
  // se só tem ponto, já está em formato JS (ex: "304.95") — não mexe
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── REQUISIÇÃO RETROATIVA (lançamento histórico — já entra como completed) ────
// Exclusivo para supervisores. Não envia email, não gera PDF pendente.
// Usa o ano da `date` para o ID sequencial, mantendo numeração correta.
app.post('/api/requests/retroativo', requireSupOnly, async (req, res) => {
  try {
    let {
      driver, plate, vehicle, city, gas_station,
      fuel_type, fuel_method, liters, price_per_liter,
      real_value, km, horimetre, notes, date, supervisor,
      estimated_value
    } = req.body;

    // Normaliza para o mesmo formato canônico usado pelo fluxo normal de
    // conclusão de requisição ("R$ 1234.56" e "45.5 L"), não importa como
    // o supervisor digitou.
    const litrosNum = parseValorBR(liters);
    const valorNum  = parseValorBR(real_value);
    const estValorNum = estimated_value ? parseValorBR(estimated_value) : valorNum;
    liters = litrosNum !== null ? `${litrosNum.toFixed(1)} L` : null;
    real_value = valorNum !== null ? `R$ ${valorNum.toFixed(2)}` : null;
    estimated_value = estValorNum !== null ? `R$ ${estValorNum.toFixed(2)}` : real_value;
    price_per_liter = price_per_liter ? parseValorBR(price_per_liter) : null;

    // Validações mínimas
    if (!driver || !vehicle || !date)
      return res.status(400).json({ error: 'Campos obrigatórios: driver, vehicle, date' });

    // Usa o ano da DATA RETROATIVA para o ID (ex: data 2026-05-10 → REQ-2026-XXXX)
    const retroDate = new Date(date + 'T12:00:00');
    const year = retroDate.getFullYear();

    // FIX: sequência + INSERT em requests + INSERT em fuel_records + UPDATE de KM
    // agora rodam numa única transação (mesmo motivo do POST /api/requests normal:
    // evitar registro "meio criado" se algo falhar no meio do caminho).
    let reqId;
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO request_seq(year, last_seq) VALUES($1, 0) ON CONFLICT(year) DO NOTHING`,
        [year]
      );
      const seqRes = await client.query(
        `UPDATE request_seq SET last_seq = last_seq + 1 WHERE year = $1 RETURNING last_seq`,
        [year]
      );
      const seq = String(seqRes.rows[0].last_seq).padStart(4, '0');
      reqId = `REQ-${year}-${seq}`;

      // Insere já como completed
      await client.query(
        `INSERT INTO requests (
          id, driver, plate, vehicle, city, gas_station,
          fuel_type, fuel_method, liters, price_per_liter,
          real_value, estimated_value, km, horimetre,
          status, date, supervisor, priority, notes,
          created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,$14,
          'completed',$15,$16,'normal',$17,
          $15::date + TIME '00:00:00', NOW()
        )`,
        [
          reqId, driver, plate || null, vehicle, city || null, gas_station || null,
          fuel_type || null, fuel_method || 'tanque', liters || null, price_per_liter || null,
          real_value || null, estimated_value || real_value || null, km || null, horimetre || null,
          date, supervisor || req.session.name || 'Retroativo', notes || null
        ]
      );

      // Insere fuel_record também como completed
      await client.query(
        `INSERT INTO fuel_records (
          request_id, driver, vehicle, gas_station, fuel_type,
          estimated_value, real_value, price_per_liter, liters,
          status, date, notes, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10,$11,$10::date + TIME '00:00:00')`,
        [
          reqId, driver, vehicle, gas_station || null, fuel_type || null,
          estimated_value || real_value || null, real_value || null,
          price_per_liter || null, liters || null,
          date, notes || null
        ]
      );

      // Atualiza KM do veículo se informado e for maior que o atual (com lock)
      if (plate && km) {
        const newKm = parseInt(km);
        if (newKm > 0) {
          const { rows: vRows } = await client.query('SELECT km FROM vehicles WHERE plate=$1 FOR UPDATE', [plate]);
          const currentKm = parseInt(vRows[0]?.km || 0);
          if (newKm > currentKm) {
            await client.query(
              `UPDATE vehicles SET km=$1, last_fuel=$2 WHERE plate=$3`,
              [newKm, new Date(date).toLocaleDateString('pt-BR'), plate]
            );
          }
        }
      }
    });

    // Auditoria
    audit(
      'LANÇAMENTO RETROATIVO', 'requisição', reqId,
      supervisor || req.session.name || 'Supervisor',
      req.session.email || null,
      { driver, plate, vehicle, date, fuel_type, liters, real_value }
    );

    res.json({ success: true, id: reqId, message: `Requisição retroativa ${reqId} criada como concluída.` });
  } catch (e) {
    console.error('Retroativo falhou:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reset-data', requireSupOnly, async (req, res) => {
  try {
    const c = await pool.connect();
    await seedVehicles(c); await seedPrices(c); c.release();
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (_, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

// Inicia o servidor IMEDIATAMENTE (evita timeout do Render)
// initDB roda em background após o servidor estar escutando
app.listen(PORT, () => {
  console.log(`🚀 Servidor iniciado na porta ${PORT}`);
  // Inicializa banco em background — não bloqueia o startup
  initDB()
    .then(() => console.log('✅ Banco de dados pronto'))
    .catch(e => console.error('❌ Erro no banco:', e.message));
});

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
