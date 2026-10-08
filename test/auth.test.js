const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret-for-account-access-tests';
process.env.ADMIN_USERNAME = 'bootstrap-admin';
process.env.ADMIN_PIN = 'bootstrap-password';

const app = require('../server');
const pool = app.pool;
const users = new Map();
const displayCredentials = new Map();
const dbCalls = [];
const approvedViewerId = randomUUID();
const revokedViewerId = randomUUID();
let sharedRows = [
  { name: 'Ada Lovelace', role: 'DC', date: '2026-01-01' },
  { name: 'Ada Lovelace', role: 'DC', date: '2026-01-02' },
  { name: 'Grace Hopper', role: 'CDC', date: '2026-01-01' }
];
let sharedBadges = {
  firstAid: ['Ada Lovelace'],
  fireMarshal: ['Grace Hopper'],
  workingAtHeight: ['Ada Lovelace']
};

users.set(approvedViewerId, {
  id: approvedViewerId,
  email: 'viewer@example.com',
  password_hash: '',
  role: 'viewer',
  status: 'approved',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
});
users.set(revokedViewerId, {
  id: revokedViewerId,
  email: 'revoked@example.com',
  password_hash: '',
  role: 'admin',
  status: 'revoked',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
});

pool.query = async (query, values = []) => {
  const sql = query.replace(/\s+/g, ' ').trim();
  dbCalls.push(sql);

  if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
    return { rows: [] };
  }
  if (sql.startsWith('SELECT token_hash, scope, revoked_at FROM display_credentials')) {
    const credential = displayCredentials.get(values[0]);
    return { rows: credential ? [credential] : [] };
  }
  if (sql.startsWith('INSERT INTO display_credentials')) {
    const credential = {
      id: values[0],
      name: values[1],
      token_hash: null,
      setup_code_hash: values[2],
      setup_expires_at: '2026-01-01T00:10:00.000Z',
      setup_used_at: null,
      scope: 'dashboard:read',
      created_at: '2026-01-01T00:00:00.000Z',
      revoked_at: null
    };
    displayCredentials.set(credential.id, credential);
    return {
      rows: [{
        id: credential.id,
        name: credential.name,
        scope: credential.scope,
        created_at: credential.created_at,
        setup_expires_at: credential.setup_expires_at,
        revoked_at: credential.revoked_at
      }]
    };
  }
  if (sql.startsWith('SELECT id, name, scope, created_at, revoked_at')) {
    return {
      rows: [...displayCredentials.values()].map((credential) => ({
        id: credential.id,
        name: credential.name,
        scope: credential.scope,
        created_at: credential.created_at,
        revoked_at: credential.revoked_at,
        activated: credential.token_hash !== null,
        setup_pending: credential.setup_code_hash !== null
      }))
    };
  }
  if (sql.startsWith('UPDATE display_credentials SET revoked_at')) {
    const credential = displayCredentials.get(values[0]);
    if (!credential) return { rows: [] };
    credential.revoked_at = '2026-01-02T00:00:00.000Z';
    return {
      rows: [{
        id: credential.id,
        name: credential.name,
        scope: credential.scope,
        created_at: credential.created_at,
        revoked_at: credential.revoked_at
      }]
    };
  }
  if (sql.startsWith('SELECT id, email, role, status FROM users WHERE id')) {
    const user = users.get(values[0]);
    return { rows: user ? [{ id: user.id, email: user.email, role: user.role, status: user.status }] : [] };
  }
  if (sql.startsWith('SELECT id, email, password_hash, role, status FROM users WHERE email')) {
    const user = [...users.values()].find((item) => item.email === values[0]);
    return { rows: user ? [user] : [] };
  }
  if (sql.startsWith('INSERT INTO users')) {
    const user = {
      id: values[0],
      email: values[1],
      password_hash: values[2],
      role: 'viewer',
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    };
    users.set(user.id, user);
    return { rows: [{ status: user.status }] };
  }
  if (sql.startsWith('SELECT id, email, role, status, created_at, updated_at FROM users')) {
    return { rows: [...users.values()] };
  }
  if (sql.startsWith('UPDATE users SET')) {
    const targetId = values[values.length - 1];
    const user = users.get(targetId);
    if (!user) return { rows: [] };
    const fields = [...sql.matchAll(/(status|role) = \$(\d+)/g)];
    for (const [, field, parameter] of fields) {
      user[field] = values[Number(parameter) - 1];
    }
    user.updated_at = '2026-01-02T00:00:00.000Z';
    return { rows: [user] };
  }
  if (sql.startsWith('SELECT version, rows, updated_at FROM current_schedule')) {
    return {
      rows: [{
        version: '7f534318-4698-41ac-96e6-3e6bdc71d1a1',
        rows: [{ name: 'Ada Lovelace', role: 'DC', date: '2026-01-01' }],
        updated_at: '2026-01-01T00:00:00.000Z'
      }]
    };
  }
  if (sql.startsWith('SELECT version, badges, updated_at FROM current_safety_badges')) {
    return {
      rows: [{
        version: 'b7b4f6e0-90f7-4a98-bf7b-7fc027856f6d',
        badges: { firstAid: [], fireMarshal: [], workingAtHeight: [] },
        updated_at: '2026-01-01T00:00:00.000Z'
      }]
    };
  }
  throw new Error(`Unexpected database query in test: ${sql}`);
};

pool.connect = async () => ({
  async query(query, values = []) {
    const sql = query.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('SELECT id, scope FROM display_credentials')) {
      const credential = [...displayCredentials.values()].find(
        (item) => item.setup_code_hash === values[0] &&
          item.setup_used_at === null &&
          item.revoked_at === null
      );
      return { rows: credential ? [{ id: credential.id, scope: credential.scope }] : [] };
    }
    if (sql.startsWith('UPDATE display_credentials SET token_hash')) {
      const credential = displayCredentials.get(values[1]);
      credential.token_hash = values[0];
      credential.setup_code_hash = null;
      credential.setup_expires_at = null;
      credential.setup_used_at = '2026-01-02T00:00:00.000Z';
      return { rows: [] };
    }
    if (sql.startsWith('SELECT version, rows FROM current_schedule')) {
      return { rows: [{ version: 'old-version', rows: sharedRows }] };
    }
    if (sql.startsWith('UPDATE current_schedule')) {
      sharedRows = JSON.parse(values[1]);
      return { rows: [{ updated_at: '2026-01-02T00:00:00.000Z' }] };
    }
    if (sql.startsWith('SELECT badges FROM current_safety_badges')) {
      return { rows: [{ badges: sharedBadges }] };
    }
    if (sql.startsWith('UPDATE current_safety_badges')) {
      sharedBadges = JSON.parse(values[1]);
      return { rows: [] };
    }
    throw new Error(`Unexpected transaction query in test: ${sql}`);
  },
  release() {}
});

let server;
let baseUrl;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

function tokenFor(id, role = 'viewer') {
  return jwt.sign({ type: 'account', sub: id, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test('schedule and safety badge reads are public and not cached', async () => {
  dbCalls.length = 0;
  const schedule = await fetch(`${baseUrl}/api/schedule`);
  const badges = await fetch(`${baseUrl}/api/safety-badges`);
  const scheduleBody = await schedule.json();
  const badgesBody = await badges.json();

  assert.equal(schedule.status, 200);
  assert.deepEqual(Object.keys(scheduleBody).sort(), ['rows', 'updated_at', 'version']);
  assert.equal(scheduleBody.rows[0].name, 'Ada Lovelace');
  assert.equal(schedule.headers.get('cache-control'), 'no-store');
  assert.equal(badges.status, 200);
  assert.deepEqual(Object.keys(badgesBody).sort(), ['badges', 'updated_at', 'version']);
  assert.deepEqual(badgesBody.badges, { firstAid: [], fireMarshal: [], workingAtHeight: [] });
  assert.equal(badges.headers.get('cache-control'), 'no-store');
  assert.equal(
    dbCalls.some((query) =>
      query.startsWith('SELECT version, rows') ||
      query.startsWith('SELECT version, badges')
    ),
    true
  );
});

test('approved viewer can read shared data but cannot upload', async () => {
  const token = tokenFor(approvedViewerId, 'admin');
  const schedule = await fetch(`${baseUrl}/api/schedule`, { headers: auth(token) });
  const badges = await fetch(`${baseUrl}/api/safety-badges`, { headers: auth(token) });
  const upload = await fetch(`${baseUrl}/api/admin/schedule`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [] })
  });
  const badgeUpload = await fetch(`${baseUrl}/api/admin/safety-badges`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ badges: { firstAid: [], fireMarshal: [], workingAtHeight: [] } })
  });

  assert.equal(schedule.status, 200);
  assert.equal((await schedule.json()).rows[0].name, 'Ada Lovelace');
  assert.equal(badges.status, 200);
  assert.equal(upload.status, 403);
  assert.equal(badgeUpload.status, 403);
});

test('revoked account is denied even when its token claims admin role', async () => {
  const response = await fetch(`${baseUrl}/api/people/Ada%20Lovelace`, {
    method: 'PATCH',
    headers: { ...auth(tokenFor(revokedViewerId, 'admin')), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Problem Solver' })
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /not approved/i);
});

test('approved viewer skill changes and removals persist across shared data', async () => {
  const token = tokenFor(approvedViewerId);
  const update = await fetch(`${baseUrl}/api/people/Ada%20Lovelace`, {
    method: 'PATCH',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Problem Solver' })
  });
  const updateBody = await update.json();
  assert.equal(update.status, 200);
  assert.equal(updateBody.rows_updated, 2);
  assert.equal(sharedRows.filter((row) => row.name === 'Ada Lovelace').every((row) => row.role === 'Problem Solver'), true);

  const removal = await fetch(`${baseUrl}/api/people/Ada%20Lovelace`, {
    method: 'DELETE',
    headers: auth(token)
  });
  const removalBody = await removal.json();
  assert.equal(removal.status, 200);
  assert.equal(removalBody.rows_removed, 2);
  assert.equal(sharedRows.some((row) => row.name === 'Ada Lovelace'), false);
  assert.deepEqual(sharedBadges.firstAid, []);
  assert.deepEqual(sharedBadges.workingAtHeight, []);
});

test('display setup codes exchange once for scoped read-only tokens and can be revoked', async () => {
  const adminToken = jwt.sign({ type: 'bootstrap', admin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const create = await fetch(`${baseUrl}/api/admin/display-credentials`, {
    method: 'POST',
    headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Warehouse display' })
  });
  const credential = await create.json();
  assert.equal(create.status, 201);
  assert.equal(credential.scope, 'dashboard:read');
  assert.equal(typeof credential.setup_code, 'string');
  assert.equal('token' in credential, false);
  assert.equal(displayCredentials.get(credential.id).token_hash, null);

  const exchange = await fetch(`${baseUrl}/api/display-credentials/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: credential.setup_code })
  });
  const exchanged = await exchange.json();
  assert.equal(exchange.status, 200);
  assert.equal(exchanged.scope, 'dashboard:read');
  assert.notEqual(displayCredentials.get(credential.id).token_hash, exchanged.token);

  const schedule = await fetch(`${baseUrl}/api/schedule`, { headers: auth(exchanged.token) });
  assert.equal(schedule.status, 200);
  const upload = await fetch(`${baseUrl}/api/admin/schedule`, {
    method: 'PUT',
    headers: { ...auth(exchanged.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [] })
  });
  assert.equal(upload.status, 403);

  const replay = await fetch(`${baseUrl}/api/display-credentials/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: credential.setup_code })
  });
  assert.equal(replay.status, 401);

  const revoke = await fetch(`${baseUrl}/api/admin/display-credentials/${credential.id}`, {
    method: 'DELETE',
    headers: auth(adminToken)
  });
  assert.equal(revoke.status, 200);
  const afterRevoke = await fetch(`${baseUrl}/api/safety-badges`, { headers: auth(exchanged.token) });
  assert.equal(afterRevoke.status, 403);
});

test('registration creates a pending account and never returns a token or hash', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ' New.User@Example.com ', password: 'correct horse battery' })
  });
  const body = await response.json();
  const user = [...users.values()].find((item) => item.email === 'new.user@example.com');

  assert.equal(response.status, 201);
  assert.equal(body.status, 'pending');
  assert.equal('token' in body, false);
  assert.equal('password_hash' in body, false);
  assert.ok(user);
  assert.notEqual(user.password_hash, 'correct horse battery');
  assert.equal(await bcrypt.compare('correct horse battery', user.password_hash), true);
});

test('admin approval grants the stored role and account login returns a token', async () => {
  const pendingUser = [...users.values()].find((item) => item.email === 'new.user@example.com');
  const adminToken = jwt.sign({ type: 'bootstrap', admin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const resetStatus = await fetch(`${baseUrl}/api/admin/users/${pendingUser.id}`, {
    method: 'PATCH',
    headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'pending', role: 'viewer' })
  });
  assert.equal(resetStatus.status, 200);
  assert.deepEqual(
    (({ status, role }) => ({ status, role }))(await resetStatus.json()),
    { status: 'pending', role: 'viewer' }
  );

  const update = await fetch(`${baseUrl}/api/admin/users/${pendingUser.id}`, {
    method: 'PATCH',
    headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved', role: 'admin' })
  });
  assert.equal(update.status, 200);
  assert.deepEqual(
    (({ status, role }) => ({ status, role }))(await update.json()),
    { status: 'approved', role: 'admin' }
  );

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new.user@example.com', password: 'correct horse battery' })
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200);
  assert.equal(loginBody.user.role, 'admin');
  assert.equal(typeof loginBody.token, 'string');
});

test('admin can review users without receiving password hashes', async () => {
  const token = jwt.sign({ type: 'bootstrap', admin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const response = await fetch(`${baseUrl}/api/admin/users`, { headers: auth(token) });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.users));
  assert.equal(body.users.some((user) => 'password_hash' in user), false);
});
