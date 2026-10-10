const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard";

const FIXTURE_FETCH_DAYS = 8;

const eloByAlias = new Map();

function normalizeName(s) {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function registerEloTeam(team) {
  for (const alias of team.aliases) {
    eloByAlias.set(normalizeName(alias), team);
  }
  eloByAlias.set(normalizeName(team.name), team);
}

function lookupElo(displayName) {
  const key = normalizeName(displayName);
  if (eloByAlias.has(key)) return eloByAlias.get(key);

  let best = null;
  let bestLen = 0;
  for (const [alias, team] of eloByAlias) {
    if (alias.length < 4) continue;
    const exact = key === alias;
    const contained = key.includes(alias) || alias.includes(key);
    if (!exact && !contained) continue;
    const score = exact ? 1000 + alias.length : alias.length;
    if (score > bestLen) {
      bestLen = score;
      best = team;
    }
  }
  return best;
}

/** ClubElo / repo short name for ESPN display strings. */
function shortTeamName(espnDisplayName) {
  return lookupElo(espnDisplayName)?.name ?? espnDisplayName;
}

function americanToDecimal(american) {
  const n = Number(american);
  if (Number.isNaN(n)) return null;
  if (n > 0) return 1 + n / 100;
  return 1 + 100 / Math.abs(n);
}

function impliedProbabilities(homeAmerican, drawAmerican, awayAmerican) {
  const dec = [
    americanToDecimal(homeAmerican),
    americanToDecimal(drawAmerican),
    americanToDecimal(awayAmerican),
  ];
  if (dec.some((d) => d == null)) return null;
  const raw = dec.map((d) => 1 / d);
  const total = raw.reduce((a, b) => a + b, 0);
  return {
    home: raw[0] / total,
    draw: raw[1] / total,
    away: raw[2] / total,
  };
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfFixtureWindow(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 8);
  return d;
}

function isInFixtureWindow(kickoffIso, now = new Date()) {
  const kick = new Date(kickoffIso);
  const start = startOfWeek(now);
  const end = endOfFixtureWindow(start);
  return kick >= start && kick < end;
}

function espnDateParam(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function kickoffTime(event) {
  return event.competitions?.[0]?.startDate || event.date;
}

function getMoneylineClose(oddsBlock) {
  if (!oddsBlock?.moneyline) return null;
  const ml = oddsBlock.moneyline;
  const home = ml.home?.close?.odds ?? ml.home?.open?.odds;
  const draw = ml.draw?.close?.odds ?? ml.draw?.open?.odds;
  const away = ml.away?.close?.odds ?? ml.away?.open?.odds;
  if (home == null || draw == null || away == null) return null;
  return { home, draw, away };
}

function formatPct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

function formatKickoffShort(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 50% = red, 100% = green; below 50% stays red. */
function pctColor(p) {
  const t = Math.max(0, Math.min(1, (p - 0.5) / 0.5));
  const hue = 8 + t * 112;
  return `hsl(${hue} 62% 52%)`;
}

function buildFixtureMap(events) {
  /** @type {Map<string, { opponent: string, kickoff: string, winOrDraw: number }>} */
  const byEloSlug = new Map();

  const upcoming = events.filter((e) => {
    const state = e.competitions?.[0]?.status?.type?.state;
    return state === "pre" || state === "in";
  });

  for (const event of upcoming) {
    const comp = event.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === "home");
    const away = comp.competitors.find((c) => c.homeAway === "away");
    const homeName = home?.team?.displayName;
    const awayName = away?.team?.displayName;
    if (!homeName || !awayName) continue;

    const kickoff = comp.startDate || event.date;
    const ml = getMoneylineClose(comp.odds?.[0]);
    const implied = ml
      ? impliedProbabilities(ml.home, ml.draw, ml.away)
      : null;

    const homeElo = lookupElo(homeName);
    const awayElo = lookupElo(awayName);

    if (homeElo && implied) {
      byEloSlug.set(homeElo.clubeloSlug, {
        opponent: shortTeamName(awayName),
        kickoff,
        winOrDraw: implied.home + implied.draw,
      });
    }
    if (awayElo && implied) {
      byEloSlug.set(awayElo.clubeloSlug, {
        opponent: shortTeamName(homeName),
        kickoff,
        winOrDraw: implied.away + implied.draw,
      });
    }
  }

  return byEloSlug;
}

function renderTable(teams, fixtureBySlug, tbody) {
  tbody.replaceChildren();
  const sorted = [...teams.teams].sort((a, b) => b.elo - a.elo);

  sorted.forEach((team, i) => {
    const fx = fixtureBySlug.get(team.clubeloSlug);
    const tr = document.createElement("tr");

    let pctCell;
    if (fx?.winOrDraw != null) {
      const width = Math.round(fx.winOrDraw * 100);
      const color = pctColor(fx.winOrDraw);
      const fixtureLabel = `vs ${fx.opponent}`;
      pctCell = `
        <td class="col-num">
          <div class="pct-bar">
            <span class="pct-value" style="color: ${color}">${formatPct(fx.winOrDraw)}</span>
            <div class="pct-track" aria-hidden="true">
              <div class="pct-fill" style="width: ${width}%; background: ${color}"></div>
            </div>
          </div>
        </td>`;
      tr.innerHTML = `
        <td class="col-rank">${i + 1}</td>
        <td class="team-cell">
          ${team.name}
          <span class="fixture-hint">${fixtureLabel} · ${formatKickoffShort(fx.kickoff)}</span>
        </td>
        <td class="col-num">${team.elo}</td>
        ${pctCell}
      `;
    } else {
      tr.innerHTML = `
        <td class="col-rank">${i + 1}</td>
        <td class="team-cell">${team.name}</td>
        <td class="col-num">${team.elo}</td>
        <td class="col-num muted-cell">—</td>
      `;
    }

    tbody.appendChild(tr);
  });
}

async function loadElo() {
  const res = await fetch("data/elo.json");
  if (!res.ok) throw new Error(`Could not load data/elo.json (${res.status})`);
  const data = await res.json();
  data.teams.forEach(registerEloTeam);
  return data;
}

async function fetchScoreboardDay(yyyymmdd) {
  const res = await fetch(`${ESPN_SCOREBOARD}?dates=${yyyymmdd}`);
  if (!res.ok) {
    throw new Error(`Could not load fixtures (${res.status})`);
  }
  const data = await res.json();
  return data.events ?? [];
}

async function loadFixtures(now = new Date()) {
  const weekStart = startOfWeek(now);
  const dayParams = [];
  for (let i = 0; i < FIXTURE_FETCH_DAYS; i++) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    dayParams.push(espnDateParam(day));
  }

  const batches = await Promise.all(dayParams.map(fetchScoreboardDay));
  const byId = new Map();
  for (const events of batches) {
    for (const event of events) {
      byId.set(event.id, event);
    }
  }

  return [...byId.values()].filter((e) =>
    isInFixtureWindow(kickoffTime(e), now)
  );
}

function matchweekLabel(now = new Date()) {
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(endOfFixtureWindow(weekStart));
  weekEnd.setDate(weekEnd.getDate() - 1);
  return `${weekStart.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${weekEnd.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

async function main() {
  const metaEl = document.getElementById("page-meta");
  const statusEl = document.getElementById("status");
  const tbody = document.querySelector("#lms-table tbody");

  metaEl.textContent = `Matchweek ${matchweekLabel()}`;

  statusEl.textContent = "Loading…";

  try {
    const [elo, events] = await Promise.all([loadElo(), loadFixtures()]);
    const fixtureBySlug = buildFixtureMap(events);
    metaEl.textContent = `Matchweek ${matchweekLabel()} · Elo last updated ${elo.updated}`;
    renderTable(elo, fixtureBySlug, tbody);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = String(err);
    statusEl.classList.add("error");
  }
}

main();
