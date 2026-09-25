# Productivity & Performance Portal backend

Express/PostgreSQL API for the Productivity & Performance Portal and Live Schedule Dashboard.

## Live Schedule API

The schedule API lets an administrator publish a normalized schedule once, then lets
public card-display pages read it without a GitHub token or browser-side write access.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/schedule` | Public | Returns `{ version, updated_at, rows }` for embedded displays. |
| `PUT /api/admin/schedule` | Bearer admin token | Atomically replaces the current schedule with `{ "rows": [...] }`. |
| `POST /api/admin/login` | Public | Exchanges `ADMIN_USERNAME` and `ADMIN_PIN` for a 24-hour admin token. |

Each submitted row must include `name`, `role`, `type` (`DC` or `CDC`), `date`,
`start`, `end`, and `hours`. Dates are returned as `YYYY-MM-DD`; start and end values
are returned as local ISO date-times. Uploads are limited to 10,000 rows.

## Safety Badges API

Safety badge data is stored durably for dashboard and card-display clients, rather
than in a particular browser's local storage.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/safety-badges` | Public | Returns `{ version, updated_at, badges }`. |
| `PUT /api/admin/safety-badges` | Admin token | Atomically replaces the badges with `{ "badges": { ... } }` and returns the canonical badges. |

The public response and admin request use this canonical shape:

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
database credentials, `DB_SSL`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PIN`, and
`ALLOWED_ORIGINS`. Vercel's Neon Postgres integration provides `DATABASE_URL` by
default; a custom `STORAGE` prefix provides `STORAGE_URL`, which this backend also
supports. Set
`DB_SSL=true` for Supabase or another individual managed database connection.
`ALLOWED_ORIGINS` is a comma-separated allowlist
and must include the GitHub Pages dashboard origin:

```text
https://christopherrichardson-rgb.github.io
```

For Vercel, configure matching encrypted environment variables/secrets. Do not put an
admin token, PIN, or database credential into an embedded display URL.
