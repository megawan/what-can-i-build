# what-can-i-build

Find out which sets you can build from the loose bricks you already own. Add your pieces and see a ranked list of matching sets, with the missing parts for each one.

Live at **https://megawan.github.io/what-can-i-build/**

## How to use

### 1. Add the pieces you own

- **Search for a part** by part number (`3001`), name (`plate 2x4`) or element ID (the 6–7 digit number in the parts list at the back of LEGO instructions). Pick it, choose the color and quantity, and click **Add**.
- **Don't know the part?** Click *Don't know the part number or name? Find it by look, description or photo* under the search box:
  - **Pick what it looks like**: choose a shape (brick, plate, slope, technic, …), then a size, details and color. Each step only offers choices that still match some parts, and you can skip any step. Click the right picture.
  - **Describe it**: type a description in English or Indonesian, such as `red flat 2x2 with hole` or `bata miring 2x1 biru`. Count sizes in studs, the bumps on top. The line under the box shows how your words were understood.
  - **Use a photo**: take or choose a photo of one piece on a plain background, then pick the best guess and choose its color. The photo is sent to [Brickognize](https://brickognize.com/), a separate free service, which may keep it.
- **Add a whole set you own**: type its number (`10696`) or name under *Add a set you own*, pick it, set the number of copies, and click **Add set**. You can also click **I own this set** in a set's details.
- **Import a CSV** in Rebrickable's `Part,Color,Quantity` format, for example a parts list exported from your Rebrickable collection. Spare parts are skipped.
- **Try a sample** loads a Medium Creative Brick Box (10696) to see how it works.

Change a quantity in the list, remove a part with ×, or start over with **Clear**. Your list stays in this browser; use **Export** to keep a copy or move it to another device, and **Import CSV** to load it back.

### 2. See which sets you can build

Sets are ranked by the share of their pieces you have. The bar fills green at 100%.

- **Match** sets how strictly pieces count:
  - **Exact colors**: the part in the color the set uses.
  - **Any color**: the right part in any color.
  - **Any color + similar parts**: also alternates and printed or patterned versions of a part.

  In the stricter modes, results show how many more pieces other colors or similar parts would cover, such as *+15 with other colors or similar parts*.
- **Min. set size**, **Theme**, **Years** and **Missing** (how many pieces may be missing) narrow the list. Your choices are remembered.
- **Search all sets** (the box above the results) finds any set by name, number or theme and shows how much of it you have, even 0%. Use **Show more** to see more results.

### 3. Look at a set

Click a result to see every missing piece and how many you have of each. Under a missing piece, *Using …* or *Could use …* names the pieces of yours that could stand in, in another color or as a similar part. The links open the building instructions on LEGO.com and the set on Rebrickable and BrickLink.

### 4. Buy the missing pieces

- **Download missing (CSV)** saves the missing pieces in Rebrickable numbers.
- **BrickLink wanted list** makes a wanted list in BrickLink's part and color numbers:
  1. Click **Copy XML** (or **Download XML**).
  2. Click **Open BrickLink upload page** and sign in to BrickLink.
  3. Paste the XML (or choose the file), pick the wanted list to add the pieces to, and upload.
  4. Open the wanted list on BrickLink to find shops that sell those pieces.

  Any piece without a BrickLink number or color is listed in the panel, and BrickLink asks you to fix it during the upload.

## How it works

- `scripts/build_db.py` downloads Rebrickable's CSV dumps and builds one compact SQLite database (about 39 MB). Mold variants are folded into one part, minifig parts are counted in the sets that include them, and spare parts are dropped. The file is split into 10 MB chunks under `web/data/`.
- `web/` is a static page. It queries the database in the browser with [sql.js-httpvfs](https://github.com/phiresky/sql.js-httpvfs), which fetches only the pages each query needs over HTTP Range requests, so no backend is required. The database is used for part search, set details and the wanted list export.
- The same script writes `web/data/match.bin.gz` (about 2.7 MB): every set's parts packed by part and color, the set list, families of similar parts and the sample collection. The page downloads it once at startup and matches in memory, which takes a few milliseconds instead of hundreds of range requests.
- Matching: for every set, `coverage = Σ min(have, need) / Σ need` over its parts. Parts are matched by part and color, by part in any color, or by family of similar parts in any color. Families come from Rebrickable's part relationships: alternates, and printed or patterned versions of a plain part.
- The part finder reads `web/data/parts.json.gz` (about 0.8 MB), loaded the first time the finder opens. It holds the parts used in two or more sets, with their category and a picture, and is searched in memory. Photos are identified by Brickognize's public API, whose BrickLink part numbers are mapped back to Rebrickable's.
- The piece list is kept in the browser's `localStorage`; nothing is sent anywhere except a photo you choose to identify.

## Run locally

```bash
python3 -I scripts/build_db.py
```

```bash
python3 -I scripts/serve.py
```

Then open http://localhost:8000/. `serve.py` is used instead of `python -m http.server` because the app needs HTTP Range support.

## BrickLink numbers

Rebrickable's CSV dumps have no BrickLink numbers, so `build_db.py` fetches them from the [Rebrickable API](https://rebrickable.com/api/) when `REBRICKABLE_API_KEY` is set (a free key from your Rebrickable account settings). That is about 60 requests at the API's one a second; the result is cached in `build/raw/bricklink_ids.json` for a week. Without a key the build still works, and the wanted list export says it isn't available.

For the deployed site, add the key as a repository secret named `REBRICKABLE_API_KEY` (Settings → Secrets and variables → Actions). The workflow caches the numbers per week, so pushes in between don't call the API again.

## Deploy

`.github/workflows/pages.yml` rebuilds the database and deploys `web/` to GitHub Pages on every push to `main`, weekly, and on demand. The database is built in CI and never committed. In the repo settings, set **Pages → Source** to **GitHub Actions**.

## Notes

- `web/vendor/sql.js-httpvfs/` is a patched copy of version 0.8.12; see the README there.
- Set and part data, and part images, come from [Rebrickable](https://rebrickable.com/).

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this site.
