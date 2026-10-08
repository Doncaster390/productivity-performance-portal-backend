# Productivity & Performance Portal backend

Express/PostgreSQL API for the Productivity & Performance Portal and Live Schedule Dashboard.

## Authentication and access

Schedule and safety badge reads are public and require no bearer token. Anyone who
knows the API URL can read this data, so do not store private or sensitive information
in schedules or safety badges. Human accounts remain pending until an administrator
approves them. Account passwords are stored as bcrypt hashes; the API never returns
password hashes. Admin writes and other protected operations still require
authentication.

| Route | Access | Purpose |
| --- | --- | --- |
| `POST /api/auth/register` | Public | Request access with `{ "email", "password" }`; returns `201` with `status: "pending"` and no token. |
| `POST /api/auth/login` | Approved account | Exchange `{ "email", "password" }` for `{ "token", "user" }`. Pending/rejected/revoked accounts cannot log in. |
| `GET /api/auth/me` | Approved account or bootstrap admin | Returns the current `{ id, email, role, status, bootstrap }` identity. |
| `POST /api/admin/login` | Public | Exchanges `ADMIN_USERNAME` and `ADMIN_PIN` for a 24-hour bootstrap admin token. |
| `GET /api/admin/users` | Admin | Returns `{ "users": [...] }` without password hashes. |
| `PATCH /api/admin/users/:id` | Admin | Set `status` to `approved`, `rejected`, or `revoked`, and/or `role` to `admin` or `viewer`. |
| `POST /api/admin/display-credentials` | Admin | Create a named kiosk credential; returns a one-time setup code. |
| `POST /api/display-credentials/exchange` | Public, setup code required | Exchange `{ "code" }` once for `{ "token", "scope", "displayId" }`. |
| `GET /api/admin/display-credentials` | Admin | List display credential metadata without hashes, setup codes, or bearer tokens. |
| `DELETE /api/admin/display-credentials/:id` | Admin | Revoke a display credential immediately. |

Account tokens are checked against the current database account status and role on
every request, so revoking an account or changing its role takes effect immediately.
The configured bootstrap login remains available as an admin account. Display
credential management and exchange remain available for existing deployments, but
display credentials do not make the public schedule or badge reads private.

Create a kiosk credential with `{ "name": "Warehouse display" }`. The response
contains a one-time setup code, valid for 10 minutes, which the kiosk can exchange
once for its JWT. The backend stores the long-lived token only as a SHA-256 hash and
it has no automatic expiry. These credentials remain available to deployments that
use them, but they are not required to read schedule or badge data and do not restrict
who can read it.

If a display credential is lost or exposed, revoke it and create/claim a replacement.
Changing `JWT_SECRET` invalidates all human, bootstrap, and display tokens; users must
log in again and each kiosk must be provisioned with a newly claimed credential.
Human login remains available for protected operations; it is not required for public
schedule or badge reads.

Public schedule and badge reads mean anyone with the backend API URL can retrieve
the current data without logging in. These API controls also do not protect public
static files or old copies in the GitHub repository's public history. Any schedule or
badge data committed to a public GitHub Pages source or repository history remains
readable independently of this backend; remove/disable those static data sources and
treat previously published data as exposed.

## Live Schedule API

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/schedule` | Public | Returns `{ version, updated_at, rows }` for the dashboard; anyone with the API URL can read it. |
| `PUT /api/admin/schedule` | Admin | Atomically replaces the current schedule with `{ "rows": [...] }`. |
| `PATCH /api/people/:name` | Approved viewer or admin | Changes that employee's core skill in all schedule rows using `{ "role": "..." }`. |
| `DELETE /api/people/:name` | Approved viewer or admin | Removes the employee from all schedule rows and safety badge lists. |

Each submitted row must include `name`, `role`, `type` (`DC` or `CDC`), `date`,
`start`, `end`, and `hours`. Dates are returned as `YYYY-MM-DD`; start and end values
are returned as local ISO date-times. Uploads are limited to 10,000 rows.

## Safety Badges API

Safety badge data is stored durably for dashboard clients, rather than in a
particular browser's local storage.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/safety-badges` | Public | Returns `{ version, updated_at, badges }`; anyone with the API URL can read it. |
| `PUT /api/admin/safety-badges` | Admin | Atomically replaces the badges with `{ "badges": { ... } }` and returns the canonical badges. |

The response and admin request use this canonical shape:

```json
{
  "badges": {
    "firstAid": ["Ada Lovelace"],
    "fireMarshal": ["Grace Hopper"],
    "workingAtHeight": ["Ada Lovelace"]
  }
}
```

The `badges` object must contain exactly `firstAid`, `fireMarshal`, and
`workingAtHeight`; each field is an array of employee names. Names must be non-empty
trimmed strings of at most 255 characters. Duplicate names within a list are removed,
and each list may contain at most 10,000 submitted names. For a non-breaking migration,
the admin endpoint also accepts the prior employee-name map with boolean `firstAid`,
`fireMarshal`, and `workingAtHeights` fields, but all responses use the canonical list
format.

## Configuration

Copy `.env.example` to `.env` and set `DATABASE_URL`, `STORAGE_URL`, or individual
database credentials, `DB_SSL`, a long random `JWT_SECRET`, `ADMIN_USERNAME`,
`ADMIN_PIN`, and `ALLOWED_ORIGINS`. New account passwords must contain at least 8
characters and may be at most 72 UTF-8 bytes (bcrypt's input limit). Vercel's Neon
Postgres integration provides `DATABASE_URL` by default; a custom `STORAGE` prefix
provides `STORAGE_URL`, which this backend also supports. Set `DB_SSL=true` for
Supabase or another individual managed database connection.

`ALLOWED_ORIGINS` is a comma-separated allowlist and must include the GitHub Pages
dashboard origin:

```text
https://christopherrichardson-rgb.github.io
```

For Vercel, configure matching encrypted environment variables/secrets. Do not put an
admin token, PIN, or database credential into an embedded display URL.
