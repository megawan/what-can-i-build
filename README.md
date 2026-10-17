# what-can-i-build

Find out which sets you can build from the loose bricks you already own. Add your pieces and see a ranked list of matching sets, with the missing parts for each one.

Live at **https://megawan.github.io/what-can-i-build/**

## How it works

- `scripts/build_db.py` downloads Rebrickable's CSV dumps and builds one compact SQLite database (about 55 MB): mold variants are folded into one part, minifig parts are counted in the sets that include them, and spare parts are dropped. The file is split into 10 MB chunks under `web/data/`.
- `web/` is a static page. It queries the database in the browser with [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs), which fetches only the pages each query needs over HTTP Range requests, so no backend is required.
- Matching: for every set, `coverage = Σ min(have, need) / Σ need` over its parts, matched by part and color (or by part only, with **Ignore colors**).
- Your piece list is kept in the browser's `localStorage`. Use **Export** to keep a copy; the CSV (`Part,Color,Quantity`, Rebrickable IDs) can be imported again here or on Rebrickable.

## Run locally

```bash
python3 -I scripts/build_db.py
```

```bash
python3 -I scripts/serve.py
```

Then open http://localhost:8000/. `serve.py` is used instead of `python -m http.server` because the app needs HTTP Range support.

## Deploy

`.github/workflows/pages.yml` rebuilds the database and deploys `web/` to GitHub Pages on every push to `main`, weekly, and on demand. The database is built in CI and never committed. In the repo settings, set **Pages → Source** to **GitHub Actions**.

## Notes

- `web/vendor/sql.js-httpvfs/` is a patched copy of version 0.8.12; see the README there.
- Set and part data, and part images, come from [Rebrickable](https://rebrickable.com/).

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this site.
