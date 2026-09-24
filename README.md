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

## Configuration

Copy `.env.example` to `.env` and set database credentials, `DB_SSL`, `JWT_SECRET`,
`ADMIN_USERNAME`, `ADMIN_PIN`, and `ALLOWED_ORIGINS`. Set `DB_SSL=true` for Supabase.
`ALLOWED_ORIGINS` is a comma-separated allowlist
and must include the GitHub Pages dashboard origin:

```text
https://christopherrichardson-rgb.github.io
```

For Vercel, configure matching encrypted environment variables/secrets. Do not put an
admin token, PIN, or database credential into an embedded display URL.
