# ManualOS Frontend

Static site for [manualos.com](https://manualos.com). GitHub Pages serves these files. The production API origin is set in `config.js` as `window.MANUALOS_API_BASE` (`https://manualforge-backend-production.up.railway.app`). Only `manualos.com` and `www.manualos.com` use that value.

## Which backend a page calls

`api-base.js` is the only resolver. `config.js` is the production setting.

- On `manualos.com` the page uses `window.MANUALOS_API_BASE`.
- On any other host — `localhost`, `127.0.0.1`, a `*.pages.dev` preview, or any other preview — the page does not use the production origin. It uses the first match:
  1. `?api=` — an `http` or `https` URL; the origin is kept
  2. `localStorage` key `manualos_api_base` — an `http` or `https` URL
  3. `http://localhost:8787`

Those hosts show a fixed banner: `TEST MODE: backend <url>`.

If the resolved origin is the production API, checkout does not start and the page shows an error. Uploads are turned off in that case too. Previews never call the production API by default.

A production deploy keeps the production origin by writing `config.js` explicitly:

```bash
MANUALOS_API_BASE='https://manualforge-backend-production.up.railway.app' node dev/write-config.mjs
```

The script stores the origin only. Do not put secrets in `MANUALOS_API_BASE`.

## Test-mode backend

Checkout from a preview or from your machine must hit a backend in test mode, not the production API. Run that backend on port 8787 with a test secret (`sk_test_…`) or with stripe-mock. Serve this site from any other origin, such as a static server on port 8788 or a `*.pages.dev` preview. The banner should read `TEST MODE: backend http://localhost:8787`, and buying a plan from that page talks to the test-mode backend.

Point one page at another test origin with `?api=http://127.0.0.1:8787`. To keep the override in this browser:

```js
localStorage.setItem('manualos_api_base', 'http://127.0.0.1:8787')
```

Only `http` and `https` origins are accepted. `javascript:` and other schemes are ignored.

## Upload page

`upload.html` checks a paid Checkout session with `GET /verify-session?session_id=`, then accepts PLC programs, CAD models, or both. It uses the same API origin rules as checkout.

The page prefers `POST /jobs` (several files, real progress, then `GET /jobs/:id/pdf`). That route is specified in the backend README and is not on production yet. If `POST /jobs` returns **404**, the page falls back to `POST /generate-manual` and sends one file, and it says so on the page. A credit is not used for a file rejected as the wrong format or as having no equipment data.

- `?jobs=0` always uses the current single-file generator.
- `?jobs=1` calls `/jobs` and does not fall back.

Advertised formats: .L5X, .L5K, .scl, .st, .exp, PLCopen .xml, .TcPOU, tag lists .csv and .xlsx (a tag-table XML is tags only), CAD .step/.stp, .iges/.igs, ASCII .dxf, and a .zip of those. Up to 25 files, 50 MB each.

## Local check

```bash
node dev/mock-api.mjs
```

The process prints an origin. Open `/upload.html?session_id=cs_test_local&api=<that origin>`. The mock session is fake. Do not send a real paid Checkout session to it, and do not point tests at the production API.

To use the default port, bind the mock there and open it as localhost. The default API base is then that same origin:

```bash
PORT=8787 node dev/mock-api.mjs
```

Open `http://localhost:8787/upload.html?session_id=cs_test_local`.

`dev/verify-upload.mjs` runs the headless checks (selector, file list, progress, success, errors, the `/jobs` 404 fallback, and that the localhost default is not the production API). It passes `?api=` set to the mock origin. It needs `puppeteer-core` and Chrome. `dev/check-brands.mjs` checks that shipped HTML and JS do not name vendors.
