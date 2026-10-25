# ManualOS Frontend

Static site for [manualos.com](https://manualos.com). GitHub Pages serves these files. The API is a separate service at `https://manualforge-backend-production.up.railway.app`.

## Upload page

`upload.html` checks a paid Checkout session with `GET /verify-session?session_id=`, then accepts PLC programs, CAD models, or both.

The page prefers `POST /jobs` (several files, real progress, then `GET /jobs/:id/pdf`). That route is specified in the backend README and is not on production yet. If `POST /jobs` returns **404**, the page falls back to `POST /generate-manual` and sends one file, and it says so on the page. A credit is not used for a file rejected as the wrong format or as having no equipment data.

- `?jobs=0` always uses the current single-file generator.
- `?jobs=1` calls `/jobs` and does not fall back.

On `localhost` / `127.0.0.1` the page calls the same origin, so the mock below can serve the site and the API together. A `?api=` override is honored only when it is also a localhost origin. On manualos.com the page calls the production host.

Advertised formats: .L5X, .L5K, .scl, .st, .exp, PLCopen .xml, .TcPOU, tag lists .csv and .xlsx (a tag-table XML is tags only), CAD .step/.stp, .iges/.igs, ASCII .dxf, and a .zip of those. Up to 25 files, 50 MB each.

## Local check

```bash
node dev/mock-api.mjs
```

Open the printed origin at `/upload.html?session_id=cs_test_local`. The mock session is fake. Do not send a real paid Checkout session to it, and do not point tests at production.

`dev/verify-upload.mjs` runs the headless checks (selector, file list, progress, success, errors, and the `/jobs` 404 fallback). It needs `puppeteer-core` and Chrome.
