require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://christopherrichardson-rgb.github.io'
];

function allowedOrigins() {
  const configured = process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '';
  const origins = configured.split(',').map((origin) => origin.trim()).filter(Boolean);
  return origins.length ? origins : DEFAULT_ALLOWED_ORIGINS;
}

// Middleware
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));
app.use(express.json({ limit: '2mb' }));

// Database Connection
const databaseUrl = process.env.DATABASE_URL || process.env.STORAGE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : new Pool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Initialize Database
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS current_schedule (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        version UUID NOT NULL,
        rows JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS current_safety_badges (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        version UUID NOT NULL,
        badges JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(254) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
        status VARCHAR(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS display_credentials (
        id UUID PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        token_hash VARCHAR(64),
        setup_code_hash VARCHAR(64),
        setup_expires_at TIMESTAMPTZ,
        setup_used_at TIMESTAMPTZ,
        scope VARCHAR(32) NOT NULL CHECK (scope = 'dashboard:read'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMPTZ
      )
    `);
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

let databaseInitialization;
function ensureDatabaseInitialized() {
  if (!databaseInitialization) {
    databaseInitialization = initializeDatabase().catch((err) => {
      databaseInitialization = null;
      throw err;
    });
  }
  return databaseInitialization;
}

app.use(async (req, res, next) => {
  try {
    await ensureDatabaseInitialized();
    return next();
  } catch (err) {
    console.error('Database initialization failed:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
}

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Bearer token required' });
  }

  try {
    const decoded = jwt.verify(match[1], process.env.JWT_SECRET);
    if (!decoded || typeof decoded !== 'object') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (decoded.type === 'bootstrap' || (!decoded.type && decoded.admin === true && !decoded.sub)) {
      req.user = {
        id: null,
        email: process.env.ADMIN_USERNAME,
        role: 'admin',
        status: 'approved',
        bootstrap: true
      };
      return next();
    }
    if (decoded.type === 'display') {
      return res.status(403).json({ error: 'Display credentials are read-only' });
    }

    if (
      decoded.type !== 'account' ||
      typeof decoded.sub !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.sub)
    ) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT id, email, role, status FROM users WHERE id = $1',
      [decoded.sub]
    );
    const user = result.rows[0];
    if (!user || user.status !== 'approved') {
      return res.status(403).json({ error: 'Account access is not approved' });
    }
    req.user = { ...user, bootstrap: false };
    return next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    console.error('Error authenticating request:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

function authenticateAdmin(req, res, next) {
  return authenticate(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.admin = req.user;
    return next();
  });
}

function normaliseDate(value) {
  const input = String(value || '').trim();
  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const ukMatch = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const parts = isoMatch
    ? [Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])]
    : ukMatch
      ? [Number(ukMatch[3]), Number(ukMatch[2]), Number(ukMatch[1])]
      : null;

  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normaliseDateTime(value, fallbackDate) {
  const input = String(value || '').trim();
  const isoMatch = input.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  const timeMatch = input.match(/^(\d{1,2}):(\d{2})$/);
  const match = isoMatch || timeMatch;
  if (!match) return null;

  const date = isoMatch ? normaliseDate(match[1]) : fallbackDate;
  if (!date) return null;
  const hour = Number(isoMatch ? match[2] : match[1]);
  const minute = Number(isoMatch ? match[3] : match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normaliseScheduleRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Each schedule row must be an object');
  }

  const name = String(row.name || '').trim();
  const role = String(row.role || '').trim();
  const location = String(row.location || '').trim();
  const date = normaliseDate(row.date);
  const type = String(row.type || '').trim().toUpperCase();
  const hours = Number(row.hours);

  if (!name || name.length > 255) throw new Error('Each row needs an employee name of 255 characters or fewer');
  if (!role || role.length > 255) throw new Error('Each row needs a core skill of 255 characters or fewer');
  if (!date) throw new Error('Each row needs a valid shift date');
  if (!['DC', 'CDC'].includes(type)) throw new Error('Each row type must be DC or CDC');
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new Error('Each row needs scheduled hours between 0 and 24');
  }

  const start = normaliseDateTime(row.start, date);
  const end = normaliseDateTime(row.end, date);
  if (!start || !end) throw new Error('Each row needs valid start and end times');

  return {
    name,
    location,
    type,
    date,
    start,
    end,
    hours,
    role
  };
}

function normaliseScheduleRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Schedule rows must be an array');
  if (rows.length > 10000) throw new Error('A schedule upload cannot contain more than 10,000 rows');
  return rows.map(normaliseScheduleRow);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const SAFETY_BADGE_FIELDS = ['firstAid', 'fireMarshal', 'workingAtHeight'];
const LEGACY_SAFETY_BADGE_FIELDS = ['firstAid', 'fireMarshal', 'workingAtHeights'];
const MAX_SAFETY_BADGE_NAMES = 10000;

function emptySafetyBadges() {
  return {
    firstAid: [],
    fireMarshal: [],
    workingAtHeight: []
  };
}

function normaliseSafetyBadgeNames(names, field) {
  if (!Array.isArray(names)) {
    throw new Error(`Safety badge ${field} must be an array`);
  }
  if (names.length > MAX_SAFETY_BADGE_NAMES) {
    throw new Error(`Safety badge ${field} cannot contain more than ${MAX_SAFETY_BADGE_NAMES} names`);
  }

  const normalised = [];
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== 'string') {
      throw new Error(`Safety badge ${field} names must be strings`);
    }

    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 255) {
      throw new Error(`Safety badge ${field} names must be between 1 and 255 characters`);
    }
    if (!seen.has(trimmedName)) {
      seen.add(trimmedName);
      normalised.push(trimmedName);
    }
  }

  return normalised;
}

function isCanonicalSafetyBadgePayload(badges) {
  return SAFETY_BADGE_FIELDS.some(
    (field) => Object.prototype.hasOwnProperty.call(badges, field) && Array.isArray(badges[field])
  );
}

function normaliseCanonicalSafetyBadges(badges) {
  const fields = Object.keys(badges);
  if (
    fields.length !== SAFETY_BADGE_FIELDS.length ||
    fields.some((field) => !SAFETY_BADGE_FIELDS.includes(field))
  ) {
    throw new Error('Safety badges must contain exactly firstAid, fireMarshal, and workingAtHeight');
  }

  return SAFETY_BADGE_FIELDS.reduce((normalised, field) => {
    normalised[field] = normaliseSafetyBadgeNames(badges[field], field);
    return normalised;
  }, {});
}

function normaliseLegacySafetyBadges(badges) {
  const entries = Object.entries(badges);
  if (entries.length > MAX_SAFETY_BADGE_NAMES) {
    throw new Error(`A safety badge upload cannot contain more than ${MAX_SAFETY_BADGE_NAMES} employees`);
  }

  const converted = emptySafetyBadges();
  const employeeNames = new Set();
  for (const [employeeName, badge] of entries) {
    const name = employeeName.trim();
    if (!name || name.length > 255) {
      throw new Error('Each safety badge employee name must be between 1 and 255 characters');
    }
    if (employeeNames.has(name)) {
      throw new Error('Safety badge employee names must be unique after trimming');
    }
    employeeNames.add(name);

    if (!isPlainObject(badge)) {
      throw new Error('Each safety badge must be an object');
    }

    const fields = Object.keys(badge);
    if (fields.some((field) => !LEGACY_SAFETY_BADGE_FIELDS.includes(field))) {
      throw new Error('Safety badge legacy values may only contain firstAid, fireMarshal, and workingAtHeights');
    }
    if (fields.some((field) => typeof badge[field] !== 'boolean')) {
      throw new Error('Safety badge legacy values must be booleans');
    }

    if (badge.firstAid) converted.firstAid.push(name);
    if (badge.fireMarshal) converted.fireMarshal.push(name);
    if (badge.workingAtHeights) converted.workingAtHeight.push(name);
  }

  return converted;
}

function normaliseSafetyBadges(badges) {
  if (!isPlainObject(badges)) {
    throw new Error('Safety badges must be an object');
  }

  return isCanonicalSafetyBadgePayload(badges)
    ? normaliseCanonicalSafetyBadges(badges)
    : normaliseLegacySafetyBadges(badges);
}

function safetyBadgeCount(badges) {
  return new Set(SAFETY_BADGE_FIELDS.flatMap((field) => badges[field])).size;
}

// Routes

function validEmail(value) {
  return typeof value === 'string' &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function issueAccountToken(user) {
  return jwt.sign(
    { type: 'account', sub: user.id },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// Request account access
app.post('/api/auth/register', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!validEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and at most 72 bytes' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'viewer', 'pending')
       RETURNING status`,
      [randomUUID(), email, passwordHash]
    );
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      status: result.rows[0].status,
      message: 'Access request submitted and awaiting admin approval'
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account or access request already exists for this email' });
    }
    console.error('Error registering account:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Account Login
app.post('/api/auth/login', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!validEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Valid email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, role, status FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    if (user.status !== 'approved') {
      return res.status(403).json({
        error: user.status === 'pending'
          ? 'Access request is awaiting admin approval'
          : 'Account access is not approved',
        status: user.status
      });
    }

    res.set('Cache-Control', 'no-store');
    return res.json({
      token: issueAccountToken(user),
      user: publicUser(user)
    });
  } catch (err) {
    console.error('Error logging in account:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Current account identity
app.get('/api/auth/me', authenticate, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(req.user);
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPin = process.env.ADMIN_PIN;
    if (!adminUsername || !adminPin) {
      console.error('ADMIN_USERNAME or ADMIN_PIN is not configured');
      return res.status(500).json({ error: 'Admin login is not configured' });
    }
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not configured');
      return res.status(500).json({ error: 'Admin login is not configured' });
    }
    
    if (username === adminUsername && password === adminPin) {
      const token = jwt.sign(
        { type: 'bootstrap', admin: true, timestamp: Date.now() },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      res.set('Cache-Control', 'no-store');
      return res.json({
        token,
        user: {
          id: null,
          email: adminUsername,
          role: 'admin',
          status: 'approved',
          bootstrap: true
        }
      });
    } else {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get the current schedule
app.get('/api/schedule', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT version, rows, updated_at FROM current_schedule WHERE id = 1'
    );
    const schedule = result.rows[0];
    res.set('Cache-Control', 'no-store');
    res.json({
      version: schedule ? schedule.version : null,
      updated_at: schedule ? schedule.updated_at : null,
      rows: schedule ? schedule.rows : []
    });
  } catch (err) {
    console.error('Error fetching current schedule:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Replace the current schedule (admin only)
app.put('/api/admin/schedule', authenticateAdmin, async (req, res) => {
  try {
    const rows = normaliseScheduleRows(req.body && req.body.rows);
    const version = randomUUID();
    const result = await pool.query(
      `INSERT INTO current_schedule (id, version, rows, updated_at)
       VALUES (1, $1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE
       SET version = EXCLUDED.version, rows = EXCLUDED.rows, updated_at = EXCLUDED.updated_at
       RETURNING version, updated_at, jsonb_array_length(rows) AS row_count`,
      [version, JSON.stringify(rows)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (
      err.message &&
      (
        err.message.startsWith('Schedule rows') ||
        err.message.startsWith('A schedule upload') ||
        err.message.startsWith('Each row')
      )
    ) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error replacing current schedule:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get the current safety badges
app.get('/api/safety-badges', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT version, badges, updated_at FROM current_safety_badges WHERE id = 1'
    );
    const safetyBadges = result.rows[0];
    res.set('Cache-Control', 'no-store');
    res.json({
      version: safetyBadges ? safetyBadges.version : null,
      updated_at: safetyBadges ? safetyBadges.updated_at : null,
      badges: safetyBadges ? normaliseSafetyBadges(safetyBadges.badges) : emptySafetyBadges()
    });
  } catch (err) {
    console.error('Error fetching current safety badges:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Replace the current safety badges (admin only)
app.put('/api/admin/safety-badges', authenticateAdmin, async (req, res) => {
  try {
    const badges = normaliseSafetyBadges(req.body && req.body.badges);
    const version = randomUUID();
    const result = await pool.query(
      `INSERT INTO current_safety_badges (id, version, badges, updated_at)
       VALUES (1, $1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE
       SET version = EXCLUDED.version, badges = EXCLUDED.badges, updated_at = EXCLUDED.updated_at
       RETURNING version, updated_at, badges`,
      [version, JSON.stringify(badges)]
    );
    res.json({
      ...result.rows[0],
      badge_count: safetyBadgeCount(badges)
    });
  } catch (err) {
    if (
      err.message &&
      (
        err.message.startsWith('Safety badge') ||
        err.message.startsWith('A safety badge') ||
        err.message.startsWith('Each safety badge')
      )
    ) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Error replacing current safety badges:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Review and manage account access
app.post('/api/admin/display-credentials', authenticateAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'A display name between 1 and 100 characters is required' });
  }

  const id = randomUUID();
  const setupCode = randomBytes(32).toString('base64url');
  const setupCodeHash = createHash('sha256').update(setupCode).digest('hex');
  try {
    const result = await pool.query(
      `INSERT INTO display_credentials (id, name, setup_code_hash, setup_expires_at, scope)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '10 minutes', 'dashboard:read')
       RETURNING id, name, scope, created_at, setup_expires_at, revoked_at`,
      [id, name, setupCodeHash]
    );
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ...result.rows[0], setup_code: setupCode });
  } catch (err) {
    console.error('Error creating display credential:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/display-credentials/exchange', async (req, res) => {
  const setupCode = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(setupCode)) {
    return res.status(400).json({ error: 'A valid display setup code is required' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const setupCodeHash = createHash('sha256').update(setupCode).digest('hex');
    const result = await client.query(
      `SELECT id, scope
       FROM display_credentials
       WHERE setup_code_hash = $1
         AND setup_used_at IS NULL
         AND setup_expires_at > CURRENT_TIMESTAMP
         AND revoked_at IS NULL
       FOR UPDATE`,
      [setupCodeHash]
    );
    const credential = result.rows[0];
    if (!credential || credential.scope !== 'dashboard:read') {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Display setup code is invalid, expired, or already used' });
    }

    const token = jwt.sign(
      { type: 'display', scope: credential.scope, jti: credential.id },
      process.env.JWT_SECRET
    );
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await client.query(
      `UPDATE display_credentials
       SET token_hash = $1, setup_code_hash = NULL, setup_expires_at = NULL,
           setup_used_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [tokenHash, credential.id]
    );
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({ token, scope: credential.scope, displayId: credential.id });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error exchanging display setup code:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

app.get('/api/admin/display-credentials', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, scope, created_at, revoked_at,
              (token_hash IS NOT NULL) AS activated,
              (setup_code_hash IS NOT NULL AND setup_expires_at > CURRENT_TIMESTAMP) AS setup_pending
       FROM display_credentials
       ORDER BY created_at DESC`
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ credentials: result.rows });
  } catch (err) {
    console.error('Error listing display credentials:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/display-credentials/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'A valid display credential ID is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE display_credentials
       SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
       WHERE id = $1
       RETURNING id, name, scope, created_at, revoked_at`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Display credential not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('Error revoking display credential:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, status, created_at, updated_at
       FROM users
       ORDER BY created_at ASC`
    );
    res.set('Cache-Control', 'no-store');
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const changes = req.body;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'A valid user ID is required' });
  }
  if (!isPlainObject(changes)) {
    return res.status(400).json({ error: 'User changes must be an object' });
  }
  const fields = Object.keys(changes);
  if (
    !fields.length ||
    fields.some((field) => !['status', 'role'].includes(field)) ||
    (Object.prototype.hasOwnProperty.call(changes, 'status') &&
      !['approved', 'rejected', 'revoked'].includes(changes.status)) ||
    (Object.prototype.hasOwnProperty.call(changes, 'role') &&
      !['admin', 'viewer'].includes(changes.role))
  ) {
    return res.status(400).json({
      error: 'Provide status (approved, rejected, or revoked) and/or role (admin or viewer)'
    });
  }

  const assignments = [];
  const values = [];
  for (const field of ['status', 'role']) {
    if (Object.prototype.hasOwnProperty.call(changes, field)) {
      values.push(changes[field]);
      assignments.push(`${field} = $${values.length}`);
    }
  }
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE users
       SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length}
       RETURNING id, email, role, status, created_at, updated_at`,
      values
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(publicUser(result.rows[0]));
  } catch (err) {
    console.error('Error updating user access:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Keep employee changes in shared schedule and badge data.
app.patch('/api/people/:name', authenticate, async (req, res) => {
  const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
  const role = req.body?.role;
  if (!name || name.length > 255) {
    return res.status(400).json({ error: 'A valid employee name is required' });
  }
  if (typeof role !== 'string' || !role.trim() || role.trim().length > 255) {
    return res.status(400).json({ error: 'A core skill between 1 and 255 characters is required' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const scheduleResult = await client.query(
      'SELECT version, rows FROM current_schedule WHERE id = 1 FOR UPDATE'
    );
    const schedule = scheduleResult.rows[0];
    if (!schedule || !Array.isArray(schedule.rows)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }
    const matchingRows = schedule.rows.filter(
      (row) => typeof row.name === 'string' && row.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (!matchingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }
    const rows = schedule.rows.map((row) =>
      typeof row.name === 'string' && row.name.trim().toLowerCase() === name.toLowerCase()
        ? { ...row, role: role.trim() }
        : row
    );
    const version = randomUUID();
    const updateResult = await client.query(
      `UPDATE current_schedule
       SET version = $1, rows = $2::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1
       RETURNING updated_at`,
      [version, JSON.stringify(rows)]
    );
    await client.query('COMMIT');
    return res.json({
      version,
      updated_at: updateResult.rows[0].updated_at,
      rows_updated: matchingRows.length
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error updating employee skill:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

app.delete('/api/people/:name', authenticate, async (req, res) => {
  const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
  if (!name || name.length > 255) {
    return res.status(400).json({ error: 'A valid employee name is required' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const scheduleResult = await client.query(
      'SELECT version, rows FROM current_schedule WHERE id = 1 FOR UPDATE'
    );
    const schedule = scheduleResult.rows[0];
    if (!schedule || !Array.isArray(schedule.rows)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }
    const rows = schedule.rows.filter(
      (row) => typeof row.name !== 'string' || row.name.trim().toLowerCase() !== name.toLowerCase()
    );
    const rowsRemoved = schedule.rows.length - rows.length;
    if (!rowsRemoved) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    const version = randomUUID();
    const updateResult = await client.query(
      `UPDATE current_schedule
       SET version = $1, rows = $2::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1
       RETURNING updated_at`,
      [version, JSON.stringify(rows)]
    );
    const badgesResult = await client.query(
      'SELECT badges FROM current_safety_badges WHERE id = 1 FOR UPDATE'
    );
    if (badgesResult.rows.length) {
      const badges = normaliseSafetyBadges(badgesResult.rows[0].badges);
      for (const field of SAFETY_BADGE_FIELDS) {
        badges[field] = badges[field].filter((employee) => employee.toLowerCase() !== name.toLowerCase());
      }
      await client.query(
        `UPDATE current_safety_badges
         SET version = $1, badges = $2::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
        [randomUUID(), JSON.stringify(badges)]
      );
    }
    await client.query('COMMIT');
    return res.json({
      version,
      updated_at: updateResult.rows[0].updated_at,
      rows_removed: rowsRemoved
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Error removing employee:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

// Get all approved links (public)
app.get('/api/links', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM links WHERE approved = true ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching links:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all links (admin only)
app.get('/api/admin/links', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM links ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching links:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit new link (public)
app.post('/api/links', async (req, res) => {
  try {
    const { title, url } = req.body;
    
    if (!title || !url) {
      return res.status(400).json({ error: 'Title and URL required' });
    }

    const result = await pool.query(
      'INSERT INTO links (title, url, approved) VALUES ($1, $2, false) RETURNING *',
      [title, url]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating link:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve link (admin only)
app.patch('/api/admin/links/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'UPDATE links SET approved = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error approving link:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete link (admin only)
app.delete('/api/admin/links/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM links WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    res.json({ message: 'Link deleted', link: result.rows[0] });
  } catch (err) {
    console.error('Error deleting link:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Start Server
async function startServer() {
  try {
    await ensureDatabaseInitialized();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.pool = pool;
