#!/usr/bin/env python3
"""Scrape ClubElo ENG ratings for the current Premier League squad.

PL membership comes from the public FPL API (same 20 teams as the real league).
Only awkward name pairs need manual overrides below — not the full squad list.
"""
import json
import re
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"

# FPL short name -> ClubElo URL slug when automatic matching fails
FPL_TO_CLUBELO_SLUG = {
    "Man Utd": "ManUnited",
    "Spurs": "Tottenham",
    "Nott'm Forest": "Forest",
    "Man City": "ManCity",
    "Manchester City": "ManCity",
    "Manchester United": "ManUnited",
    "Aston Villa": "AstonVilla",
    "Crystal Palace": "CrystalPalace",
    "West Ham": "WestHam",
    "Wolves": "Wolves",
    "Brighton": "Brighton",
    "Bournemouth": "Bournemouth",
    "Newcastle": "Newcastle",
    "Leeds": "Leeds",
    "Ipswich Town": "Ipswich",
    "Hull City": "Hull",
    "Coventry City": "Coventry",
}

# ESPN / broadcast names that do not substring-match FPL or ClubElo short names
EXTRA_ALIASES_BY_SLUG = {
    "ManCity": ["Manchester City"],
    "ManUnited": ["Manchester United"],
    "Tottenham": ["Tottenham Hotspur"],
    "Brighton": ["Brighton & Hove Albion"],
    "Bournemouth": ["AFC Bournemouth"],
    "Newcastle": ["Newcastle United"],
    "WestHam": ["West Ham United"],
    "Wolves": ["Wolverhampton Wanderers"],
    "Forest": ["Nottingham Forest"],
    "CrystalPalace": ["Crystal Palace"],
    "Leeds": ["Leeds United"],
    "Ipswich": ["Ipswich Town"],
}


def normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def fetch_fpl_teams() -> List[dict]:
    with urllib.request.urlopen(FPL_BOOTSTRAP, timeout=30) as res:
        data = json.load(res)
    return data["teams"]


def scrape_clubelo_eng() -> Tuple[str, Dict[str, Tuple[str, int]]]:
    with urllib.request.urlopen("http://clubelo.com/ENG", timeout=30) as res:
        html = res.read().decode("utf-8", errors="replace")

    m_date = re.search(r'href="/(\d{4}-\d{2}-\d{2})/ENG"', html)
    updated = m_date.group(1) if m_date else "unknown"

    start = html.find("const eloData = ")
    if start < 0:
        raise SystemExit("eloData not found on ClubElo ENG page")
    chunk = html[start : start + 25000]

    by_slug: Dict[str, Tuple[str, int]] = {}
    for m in re.finditer(r'href="/(\w+)">([^<]+)', chunk):
        slug, name = m.groups()
        if slug == "ENG":
            continue
        em = re.search(r"',\s*'(\d+)'", chunk[m.end() : m.end() + 80])
        if not em:
            continue
        by_slug[slug] = (name.strip(), int(em.group(1)))

    return updated, by_slug


def fetch_elo_from_club_page(slug: str) -> Tuple[str, int]:
    """Fallback when a club is not in the ENG page eloData table."""
    url = f"http://clubelo.com/{slug}"
    with urllib.request.urlopen(url, timeout=30) as res:
        html = res.read().decode("utf-8", errors="replace")
    values = [float(x) for x in re.findall(r'"Elo": ([0-9.]+)', html)]
    if not values:
        raise SystemExit(f"Could not read Elo from {url}")
    elo = int(round(values[-1]))
    title = re.search(r"<title>([^<]+)</title>", html)
    name = title.group(1).strip() if title else slug
    if name.lower() == "clubelo":
        name = slug
    return name, elo


def resolve_clubelo_slug(
    fpl_name: str, by_slug: Dict[str, Tuple[str, int]]
) -> Optional[str]:
    if fpl_name in FPL_TO_CLUBELO_SLUG:
        return FPL_TO_CLUBELO_SLUG[fpl_name]

    target = normalize(fpl_name)
    for slug, (name, _elo) in by_slug.items():
        if normalize(name) == target or normalize(slug) == target:
            return slug

    # Substring match for "Leeds" vs "Leeds United" style gaps
    for slug, (name, _elo) in by_slug.items():
        nn, ns = normalize(name), normalize(slug)
        if target in nn or nn in target or target in ns:
            return slug

    return None


def main() -> None:
    fpl_teams = fetch_fpl_teams()
    updated, by_slug = scrape_clubelo_eng()

    selected = []
    missing = []

    for t in fpl_teams:
        fpl_name = t["name"]
        slug = resolve_clubelo_slug(fpl_name, by_slug)
        if not slug:
            missing.append(fpl_name)
            continue
        if slug in by_slug:
            club_name, elo = by_slug[slug]
        else:
            club_name, elo = fetch_elo_from_club_page(slug)
        aliases = sorted(
            {fpl_name, club_name, t.get("short_name", "")}
            | set(EXTRA_ALIASES_BY_SLUG.get(slug, []))
            - {""}
        )
        selected.append(
            {
                "clubeloSlug": slug,
                "name": club_name,
                "elo": elo,
                "aliases": aliases,
            }
        )

    if missing:
        raise SystemExit(
            "Could not match these FPL teams to ClubElo slugs: "
            + ", ".join(missing)
            + "\nAdd an entry to FPL_TO_CLUBELO_SLUG in scripts/fetch_elo.py"
        )

    selected.sort(key=lambda row: -row["elo"])

    out = {
        "updated": updated,
        "source": "https://clubelo.com/ENG",
        "plSource": FPL_BOOTSTRAP,
        "teams": selected,
    }

    root = Path(__file__).resolve().parents[1]
    path = root / "data" / "elo.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(selected)} teams to {path}")


if __name__ == "__main__":
    main()
