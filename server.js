require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

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
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
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
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// JWT Middleware
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

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

// Routes

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPin = process.env.ADMIN_PIN;
    if (!adminUsername || !adminPin) {
      console.error('ADMIN_USERNAME or ADMIN_PIN is not configured');
      return res.status(500).json({ error: 'Admin login is not configured' });
    }
    
    if (username === adminUsername && password === adminPin) {
      const token = jwt.sign(
        { admin: true, timestamp: Date.now() },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      return res.json({ token });
    } else {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get the current schedule (public for embedded displays)
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
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
