#!/usr/bin/env python3
"""Build the SQLite database the web app queries, from Rebrickable's CSV dumps.

Usage:
    python3 -I scripts/build_db.py [--raw build/raw] [--out web/data] [--refresh]

Steps:
  1. Download the gzipped CSVs from Rebrickable into --raw (cached unless --refresh).
  2. Load them into a staging database and build a compact final database:
     integer ids instead of repeated part strings, mold variants folded into one
     part, minifig parts expanded into the sets that include them, spares dropped.
  3. Split the final file into fixed-size chunks under --out, plus a config.json
     that sql.js-httpvfs reads, so the browser fetches only the pages a query needs.
  4. Write match.bin.gz under --out: every set's part list packed by part and
     color, which the browser downloads once and matches against in memory.
"""

import argparse
import array
import csv
import gzip
import json
import os
import sqlite3
import struct
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "https://cdn.rebrickable.com/media/downloads/"
TABLES = [
    "themes",
    "colors",
    "parts",
    "part_relationships",
    "elements",
    "sets",
    "inventories",
    "inventory_parts",
    "inventory_minifigs",
]
IMG_PREFIX = "https://cdn.rebrickable.com/media/"
PAGE_SIZE = 4096
CHUNK_SIZE = 10 * 1024 * 1024  # well under GitHub's 100 MB per-file limit
SAMPLE_SET = "10696-1"  # Medium Creative Brick Box, behind the "Try a sample" button
COLOR_BITS = 14  # match.bin keys are pid << COLOR_BITS | (color_id + 1); -1 is "Unknown"

csv.field_size_limit(sys.maxsize)


def download(raw_dir: Path, refresh: bool) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    for name in TABLES:
        dest = raw_dir / f"{name}.csv.gz"
        if dest.exists() and not refresh:
            continue
        print(f"downloading {name}.csv.gz", flush=True)
        tmp = dest.with_suffix(".part")
        req = urllib.request.Request(BASE_URL + dest.name, headers={"User-Agent": "what-can-i-build"})
        with urllib.request.urlopen(req) as resp, open(tmp, "wb") as fh:
            while chunk := resp.read(1 << 20):
                fh.write(chunk)
        tmp.replace(dest)


def load_staging(db: sqlite3.Connection, raw_dir: Path) -> None:
    for name in TABLES:
        with gzip.open(raw_dir / f"{name}.csv.gz", "rt", encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            cols = ", ".join(f'"{c}"' for c in header)
            marks = ", ".join("?" for _ in header)
            db.execute(f"CREATE TABLE raw_{name} ({cols})")
            db.executemany(f"INSERT INTO raw_{name} VALUES ({marks})", reader)
        count = db.execute(f"SELECT count(*) FROM raw_{name}").fetchone()[0]
        print(f"loaded {name}: {count:,} rows", flush=True)


def mold_roots(db: sqlite3.Connection) -> dict:
    """Map each part to the root of its mold family ("M" relationships), so that
    e.g. 3001 and 3001old count as the same brick."""
    parent = {}
    for child, par in db.execute(
        "SELECT child_part_num, parent_part_num FROM raw_part_relationships WHERE rel_type = 'M'"
    ):
        parent.setdefault(child, par)

    def root(p: str) -> str:
        seen = set()
        while p in parent and p not in seen:
            seen.add(p)
            p = parent[p]
        return p

    return {child: root(child) for child in parent}


def similar_families(staging: sqlite3.Connection, canon, pid_of: dict) -> list:
    """Group parts that build the same way: alternates ("A"), and printed ("P") or
    patterned ("T") versions of a plain part. Returns (pid, grp) for every part in
    a family of two or more, grp being the family's smallest (most-used) pid."""
    parent = {}

    def find(p: int) -> int:
        while parent.get(p, p) != p:
            parent[p] = parent.get(parent[p], parent[p])
            p = parent[p]
        return p

    for child, par in staging.execute(
        "SELECT child_part_num, parent_part_num FROM raw_part_relationships WHERE rel_type IN ('A', 'P', 'T')"
    ):
        a, b = pid_of.get(canon(child)), pid_of.get(canon(par))
        if a and b and a != b:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
                parent.setdefault(min(ra, rb), min(ra, rb))
    return sorted((p, find(p)) for p in parent)


def build(staging: sqlite3.Connection, out_path: Path) -> None:
    if out_path.exists():
        out_path.unlink()
    db = sqlite3.connect(out_path)
    db.execute(f"PRAGMA page_size = {PAGE_SIZE}")
    db.execute("PRAGMA journal_mode = DELETE")
    db.executescript(
        """
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
        CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER);
        CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rgb TEXT, is_trans INTEGER);
        -- pid is the canonical (mold-family root) part id; aliases point variants at it.
        CREATE TABLE parts (pid INTEGER PRIMARY KEY, part_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                            in_sets INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE part_aliases (part_num TEXT PRIMARY KEY, pid INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE elements (element_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, color_id INTEGER NOT NULL)
            WITHOUT ROWID;
        CREATE TABLE sets (sid INTEGER PRIMARY KEY, set_num TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                           year INTEGER, theme_id INTEGER, total INTEGER NOT NULL);
        -- Clustered by set for the set detail view; matching uses match.bin.gz instead.
        CREATE TABLE set_parts (sid INTEGER NOT NULL, pid INTEGER NOT NULL, color_id INTEGER NOT NULL,
                                qty INTEGER NOT NULL, PRIMARY KEY (sid, pid, color_id)) WITHOUT ROWID;
        CREATE TABLE part_imgs (pid INTEGER NOT NULL, color_id INTEGER NOT NULL, img TEXT NOT NULL,
                                PRIMARY KEY (pid, color_id)) WITHOUT ROWID;
        -- Parts that can stand in for each other; grp is the most-used pid of the family.
        CREATE TABLE similar_parts (pid INTEGER PRIMARY KEY, grp INTEGER NOT NULL);
        """
    )

    db.executemany(
        "INSERT INTO themes VALUES (?, ?, ?)",
        ((int(i), n, int(p) if p else None) for i, n, p in staging.execute("SELECT id, name, parent_id FROM raw_themes")),
    )
    db.executemany(
        "INSERT INTO colors VALUES (?, ?, ?, ?)",
        (
            (int(i), n, rgb, 1 if t == "True" else 0)
            for i, n, rgb, t in staging.execute("SELECT id, name, rgb, is_trans FROM raw_colors")
        ),
    )

    # Inventories: one per set (lowest version), minifig parts folded into their sets.
    staging.executescript(
        """
        CREATE TEMP TABLE set_inv AS
            SELECT set_num, CAST(id AS INTEGER) AS inv_id FROM raw_inventories i
            WHERE CAST(version AS INTEGER) = (SELECT min(CAST(version AS INTEGER)) FROM raw_inventories j
                                              WHERE j.set_num = i.set_num);
        CREATE INDEX temp.set_inv_num ON set_inv(set_num);
        CREATE TEMP TABLE needs AS
            SELECT si.set_num, ip.part_num, CAST(ip.color_id AS INTEGER) AS color_id,
                   CAST(ip.quantity AS INTEGER) AS qty, ip.img_url
            FROM raw_inventory_parts ip JOIN set_inv si ON si.inv_id = CAST(ip.inventory_id AS INTEGER)
            WHERE ip.is_spare = 'False' AND si.set_num NOT LIKE 'fig-%'
            UNION ALL
            SELECT si.set_num, ip.part_num, CAST(ip.color_id AS INTEGER),
                   CAST(ip.quantity AS INTEGER) * CAST(im.quantity AS INTEGER), ip.img_url
            FROM raw_inventory_minifigs im
            JOIN set_inv si ON si.inv_id = CAST(im.inventory_id AS INTEGER)
            JOIN set_inv fi ON fi.set_num = im.fig_num
            JOIN raw_inventory_parts ip ON CAST(ip.inventory_id AS INTEGER) = fi.inv_id
            WHERE ip.is_spare = 'False';
        """
    )

    # Every part is folded into the root of its mold family.
    roots = mold_roots(staging)
    names = dict(staging.execute("SELECT part_num, name FROM raw_parts"))

    def canon(p: str) -> str:
        return roots.get(p, p)

    totals = {}
    agg = {}
    imgs = {}
    for set_num, part_num, color_id, qty, img in staging.execute("SELECT * FROM needs"):
        key = (canon(part_num), color_id, set_num)
        agg[key] = agg.get(key, 0) + qty
        totals[set_num] = totals.get(set_num, 0) + qty
        if img and img.startswith(IMG_PREFIX):
            imgs.setdefault(key[:2], img[len(IMG_PREFIX):])

    sid_of = {}
    set_rows = []
    rows = staging.execute(
        "SELECT set_num, name, year, theme_id FROM raw_sets WHERE set_num NOT LIKE 'fig-%' ORDER BY set_num"
    )
    for set_num, name, year, theme_id in rows:
        total = totals.get(set_num, 0)
        if total == 0:
            continue
        sid_of[set_num] = len(sid_of) + 1
        set_rows.append((sid_of[set_num], set_num, name, int(year), int(theme_id), total))
    db.executemany("INSERT INTO sets VALUES (?, ?, ?, ?, ?, ?)", set_rows)

    # pids are assigned most-used first, so full-text matches (returned in rowid
    # order) come back popular-first and a LIMIT touches only a few pages.
    used = {}
    for part, _, set_num in agg:
        if set_num in sid_of:
            used.setdefault(part, set()).add(set_num)
    in_sets = {part: len(s) for part, s in used.items()}
    all_canon = {canon(p) for p in names} | set(in_sets)
    order = sorted(all_canon, key=lambda p: (-in_sets.get(p, 0), p))
    pid_of = {p: i + 1 for i, p in enumerate(order)}
    db.executemany(
        "INSERT INTO parts VALUES (?, ?, ?, ?)",
        ((pid_of[p], p, names.get(p, p), in_sets.get(p, 0)) for p in order),
    )
    db.executemany(
        "INSERT INTO part_aliases VALUES (?, ?)",
        ((p, pid_of[canon(p)]) for p in sorted(names) if canon(p) != p),
    )
    db.executemany(
        "INSERT OR IGNORE INTO elements VALUES (?, ?, ?)",
        (
            (e, pid_of[canon(p)], int(c))
            for e, p, c in staging.execute("SELECT element_id, part_num, color_id FROM raw_elements")
            if canon(p) in pid_of
        ),
    )
    db.executemany(
        "INSERT INTO set_parts VALUES (?, ?, ?, ?)",
        sorted((sid_of[s], pid_of[p], c, q) for (p, c, s), q in agg.items() if s in sid_of),
    )
    db.executemany("INSERT INTO similar_parts VALUES (?, ?)", similar_families(staging, canon, pid_of))
    db.executemany(
        "INSERT INTO part_imgs VALUES (?, ?, ?)",
        sorted((pid_of[p], c, i) for (p, c), i in imgs.items()),
    )

    db.executescript(
        """
        CREATE VIRTUAL TABLE parts_fts USING fts5 (part_num, name, content='parts', content_rowid='pid');
        INSERT INTO parts_fts (parts_fts) VALUES ('rebuild');
        INSERT INTO parts_fts (parts_fts) VALUES ('optimize');
        """
    )
    db.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("built_at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
            ("source", "Rebrickable (https://rebrickable.com/downloads/)"),
            ("sets", str(len(set_rows))),
            ("parts", str(len(pid_of))),
        ],
    )
    db.commit()
    db.execute("VACUUM")
    db.execute("ANALYZE")
    db.commit()
    db.close()
    print(f"built {out_path}: {len(set_rows):,} sets, {len(agg):,} set-part rows", flush=True)


def split(db_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("db.sqlite3.*"):
        old.unlink()
    size = db_path.stat().st_size
    with open(db_path, "rb") as fh:
        i = 0
        while chunk := fh.read(CHUNK_SIZE):
            (out_dir / f"db.sqlite3.{i:03d}").write_bytes(chunk)
            i += 1
    config = {
        "serverMode": "chunked",
        "requestChunkSize": PAGE_SIZE,
        "databaseLengthBytes": size,
        "serverChunkSize": CHUNK_SIZE,
        "urlPrefix": "db.sqlite3.",
        "suffixLength": 3,
        # Caps sequential read-ahead (needs the patched worker in web/vendor): bigger
        # means fewer, larger requests; 256 KB balanced the two in testing.
        "maxReadSpeed": 256 * 1024,
    }
    (out_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    print(f"split into {i} chunk(s) in {out_dir} ({size / 1e6:.1f} MB total)", flush=True)


def write_match(db_path: Path, out_dir: Path) -> None:
    """Pack what matching needs into one gzipped file, read by web/app.js:

        "WCIB", uint32 header length, header JSON (space-padded to 4 bytes):
            {built_at, groups, entries,
             sets: [[set_num, name, year, theme_id, total], ...]   (index = sid - 1),
             sample: [[pid, part_num, name, color_id, qty, img], ...],
             similar: [[pid, ...], ...]   (families of similar parts, most-used first)}
        uint32[groups]   key = pid << COLOR_BITS | (color_id + 1), delta from the previous key
        uint16[groups]   number of sets in each (pid, color_id) group
        uint16[entries]  sid, delta from the previous entry in the same group
        uint16[entries]  quantity

    Numbers are little-endian. Groups are sorted by key, entries by sid.
    """
    db = sqlite3.connect(db_path)
    built_at = db.execute("SELECT value FROM meta WHERE key = 'built_at'").fetchone()[0]
    sets = db.execute("SELECT sid, set_num, name, year, theme_id, total FROM sets ORDER BY sid").fetchall()
    assert [r[0] for r in sets] == list(range(1, len(sets) + 1)), "sids must be 1..n"
    assert len(sets) < 1 << 16, "sids no longer fit in uint16"
    sample = db.execute(
        """SELECT sp.pid, p.part_num, p.name, sp.color_id, sp.qty,
                  coalesce(i.img, (SELECT img FROM part_imgs j WHERE j.pid = sp.pid LIMIT 1))
           FROM sets s JOIN set_parts sp ON sp.sid = s.sid JOIN parts p ON p.pid = sp.pid
           LEFT JOIN part_imgs i ON i.pid = sp.pid AND i.color_id = sp.color_id
           WHERE s.set_num = ?""",
        (SAMPLE_SET,),
    ).fetchall()

    families = {}
    for pid, grp in db.execute("SELECT pid, grp FROM similar_parts ORDER BY grp, pid"):
        families.setdefault(grp, []).append(pid)

    keys, counts, sids, qtys = array.array("I"), array.array("H"), array.array("H"), array.array("H")
    prev_key = prev_sid = 0
    for pid, color_id, sid, qty in db.execute(
        "SELECT pid, color_id, sid, qty FROM set_parts ORDER BY pid, color_id, sid"
    ):
        assert -1 <= color_id < (1 << COLOR_BITS) - 1 and qty < 1 << 16
        key = pid << COLOR_BITS | (color_id + 1)
        if not counts or key != prev_key:
            keys.append(key - prev_key)
            counts.append(0)
            prev_key, prev_sid = key, 0
        counts[-1] += 1
        sids.append(sid - prev_sid)
        qtys.append(qty)
        prev_sid = sid
    db.close()

    header = json.dumps(
        {
            "built_at": built_at,
            "groups": len(keys),
            "entries": len(sids),
            "sets": [list(r[1:]) for r in sets],
            "sample": [list(r) for r in sample],
            "similar": list(families.values()),
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    header += b" " * (-len(header) % 4)
    if sys.byteorder != "little":
        for a in (keys, counts, sids, qtys):
            a.byteswap()
    body = b"".join([b"WCIB", struct.pack("<I", len(header)), header, *(a.tobytes() for a in (keys, counts, sids, qtys))])
    out = out_dir / "match.bin.gz"
    out.write_bytes(gzip.compress(body, 9, mtime=0))
    print(f"wrote {out} ({len(keys):,} groups, {len(sids):,} entries, {out.stat().st_size / 1e6:.1f} MB)", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--raw", default="build/raw", type=Path, help="where to cache the downloaded CSVs")
    ap.add_argument("--out", default="web/data", type=Path, help="where to write the chunked database")
    ap.add_argument("--refresh", action="store_true", help="re-download the CSVs even if cached")
    args = ap.parse_args()

    download(args.raw, args.refresh)
    work = Path("build")
    work.mkdir(exist_ok=True)
    staging_path = work / "staging.sqlite3"
    if staging_path.exists():
        staging_path.unlink()
    staging = sqlite3.connect(staging_path)
    staging.execute("PRAGMA journal_mode = OFF")
    staging.execute("PRAGMA synchronous = OFF")
    load_staging(staging, args.raw)
    final_path = work / "db.sqlite3"
    build(staging, final_path)
    staging.close()
    os.remove(staging_path)
    split(final_path, args.out)
    write_match(final_path, args.out)


if __name__ == "__main__":
    main()
