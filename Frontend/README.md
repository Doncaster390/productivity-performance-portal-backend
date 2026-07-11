# Productivity & Performance Registry — frontend

A static frontend for the `productivity-performance-portal-backend` API. No build step, no framework, no npm install — just three files:

```
frontend/
├── index.html
├── styles.css
├── app.js
└── README.md
```

Drop the `frontend/` folder straight into your GitHub repo (e.g. alongside `server.js`, or in its own `frontend` repo/branch — whatever matches how you want to deploy it).

## Run it

Any static file server works, e.g.:

```bash
npx serve frontend
# or
cd frontend && python3 -m http.server 3000
```

Then open the page in your browser.

## Point it at your backend

The page needs to know where the API lives. By default it looks for `http://localhost:5000`. If your backend runs somewhere else (a deployed URL, a different port), open the page and click **Change API address** at the bottom, enter the base URL, and click **Save** — it's remembered in your browser (localStorage) from then on.

Make sure the backend's `FRONTEND_URL` env var (used for CORS) matches the origin you're serving this page from.

## What it does

- **Published registry** — anyone can browse approved links (`GET /api/links`).
- **File a new entry** — anyone can submit a title + link for review (`POST /api/links`). It's marked pending until a staff member approves it.
- **Staff login** — enter the admin PIN (`POST /api/admin/login`) to unlock the review queue.
- **Review queue** — staff can approve (`PATCH /api/admin/links/:id/approve`) or delete (`DELETE /api/admin/links/:id`) pending entries.

Links are auto-tagged as **Deck** (PowerPoint), **Dashboard** (Power BI), **Workbook** (Excel), or **Link** based on the URL, same as the original `LinkManager.jsx` logic.

## Deploying alongside the backend

Since the backend is plain Express, the simplest path is to have it serve this folder as static assets: `app.use(express.static('public'))` in `server.js`, with these three files copied into a `public/` folder. Or host the folder separately (Vercel, Netlify, GitHub Pages) and set the API address via the in-page setting above.
