import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const username = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || 'higormanoel';
const token = process.env.GITHUB_TOKEN || '';
const outputPath = process.env.OUTPUT_PATH || 'assets/pokemon-contributions.svg';

if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) {
  throw new Error(`GitHub username inválido: ${username}`);
}

const now = new Date();
const to = new Date(now);
const from = new Date(now);
from.setUTCFullYear(from.getUTCFullYear() - 1);
from.setUTCDate(from.getUTCDate() + 1);

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${username}-pokedev-card`,
  'X-GitHub-Api-Version': '2022-11-28',
};

if (token) headers.Authorization = `Bearer ${token}`;

const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const isoDate = (date) => date.toISOString().slice(0, 10);

async function getGraphqlData() {
  if (!token) return null;

  const query = `
    query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        name
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                contributionLevel
                date
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { login: username, from: from.toISOString(), to: to.toISOString() },
    }),
  });

  if (!response.ok) throw new Error(`GitHub GraphQL respondeu ${response.status}`);

  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map((item) => item.message).join('; '));
  if (!payload.data?.user) throw new Error(`Usuário @${username} não encontrado`);

  const collection = payload.data.user.contributionsCollection;
  const days = collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays);

  return {
    name: payload.data.user.name || username,
    days,
    totalCommits: collection.totalCommitContributions,
    totalContributions: collection.contributionCalendar.totalContributions,
  };
}

async function getPublicData() {
  const profileResponse = await fetch(`https://github.com/users/${username}/contributions`, { headers });
  if (!profileResponse.ok) throw new Error(`Calendário público respondeu ${profileResponse.status}`);

  const html = await profileResponse.text();
  const days = [];
  const cellPattern = /<td[^>]*data-date="([^"]+)"[^>]*data-level="([0-4])"[^>]*><\/td>\s*<tool-tip[^>]*>([\s\S]*?)<\/tool-tip>/g;

  for (const match of html.matchAll(cellPattern)) {
    const tooltip = match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const countMatch = tooltip.match(/^([\d,.]+)\s+contributions?/i);
    const contributionCount = countMatch ? Number(countMatch[1].replace(/[,.]/g, '')) : 0;
    days.push({
      date: match[1],
      contributionCount,
      contributionLevel: Number(match[2]),
    });
  }

  if (!days.length) throw new Error('Não foi possível interpretar o calendário público do GitHub');

  const totalMatch = html.match(/<h2[^>]*id="js-contribution-activity-description"[^>]*>\s*([\d,.]+)/i);
  const totalContributions = totalMatch
    ? Number(totalMatch[1].replace(/[,.]/g, ''))
    : days.reduce((sum, day) => sum + day.contributionCount, 0);

  let totalCommits = null;
  const searchQuery = encodeURIComponent(`author:${username} committer-date:>=${isoDate(from)}`);
  const commitResponse = await fetch(`https://api.github.com/search/commits?q=${searchQuery}&per_page=1`, { headers });

  if (commitResponse.ok) {
    const commitPayload = await commitResponse.json();
    totalCommits = Number.isFinite(commitPayload.total_count) ? commitPayload.total_count : null;
  }

  return { name: username, days, totalCommits, totalContributions };
}

async function loadData() {
  try {
    return (await getGraphqlData()) || (await getPublicData());
  } catch (error) {
    console.warn(`GraphQL indisponível: ${error.message}. Usando calendário público.`);
    return getPublicData();
  }
}

function numericLevel(day) {
  if (!day || day.contributionCount === 0) return 0;
  if (Number.isInteger(day.contributionLevel)) return day.contributionLevel;

  const levels = {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
  };

  return levels[day.contributionLevel] ?? 1;
}

function buildCalendar(days) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const availableDates = days.map((day) => day.date).sort();
  const lastDate = new Date(`${availableDates.at(-1)}T00:00:00Z`);
  const firstSunday = new Date(lastDate);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - firstSunday.getUTCDay() - 52 * 7);

  return Array.from({ length: 53 }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = new Date(firstSunday);
      date.setUTCDate(date.getUTCDate() + week * 7 + weekday);
      const dateKey = isoDate(date);
      return byDate.get(dateKey) || { date: dateKey, contributionCount: 0, contributionLevel: 0 };
    }),
  );
}

function renderPixels(rows, colors) {
  const width = Math.max(...rows.map((row) => row.length));

  return rows
    .map((row, y) =>
      row
        .padEnd(width, '.')
        .split('')
        .map((pixel, x) => {
          const fill = colors[pixel];
          return fill ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>` : '';
        })
        .join(''),
    )
    .join('');
}

function renderCharizard() {
  const rows = [
    '........DOOD...BYYYD.',
    '.......DOOD...BYYYD..',
    '.......DOOD.BBYYYOD..',
    '......DOOBYDYYYYOD...',
    '......DOYYYYYYYOOD...',
    '.....BYYYYYYYYOOD....',
    '....BBYYYYYYYYYOOD...',
    '...BYYOYYYBBYYYOOOD..',
    '..BOOBYYOB.BYYYYOOD..',
    '..DBBOBOBWWOYYYYOOOD.',
    '...DBOODWWOYYYYOOOOD.',
    '...DOOYYYYYYYYOOOOOOD',
    '..BYYYYYYYYYDDBOOOOOD',
    '.BYYYYYYYYYDOOOOOOOOD',
    'BYYYYYYYBBDOOOOOOOOOD',
    'BYYBYYBDOOOOOBBBOOOOO',
    '.BYOYD.BOOODDDBOOOOOO',
    '..DYBOBOOBD.DDBOOOOOO',
    '...DDOOOD.....BOOOOOO',
  ];

  return renderPixels(rows, {
    D: '#2B2118',
    B: '#713D29',
    O: '#F97316',
    Y: '#FFB13B',
    W: '#F8FAFC',
  });
}

function renderTail() {
  return renderPixels(
    [
      '....DD',
      '....OD',
      '...OOD',
      '...OOD',
      '..OOOD',
      '..OOOD',
      '.OOOOD',
      '.OOOD.',
      'OOOD..',
      'OOD...',
      'DD....',
    ],
    { D: '#2B2118', O: '#F58A2A' },
  );
}

function renderFlame(frame) {
  const frames = {
    a: [
      '...R...',
      '..RRR..',
      '.ROOR..',
      'ROYYOR.',
      'ROYYOR.',
      '.ROOR..',
      '..RR...',
    ],
    b: [
      '..R....',
      '.RRR...',
      'ROORR..',
      'ROYYOR.',
      '.OYYOR.',
      '.ROOR..',
      '..R....',
    ],
  };

  return renderPixels(frames[frame], {
    R: '#EF4444',
    O: '#F97316',
    Y: '#FFE14D',
  });
}

function renderSvg(data) {
  const calendar = buildCalendar(data.days);
  const totalCommits = Number.isFinite(data.totalCommits) ? data.totalCommits : null;
  const activeDays = data.days.filter((day) => day.contributionCount > 0).length;
  const level = Math.min(99, Math.max(1, Math.floor((totalCommits || 0) / 10) + 1));
  const xp = totalCommits === null ? 0 : totalCommits % 10;
  const colors = ['#21262D', '#5B2918', '#9A4318', '#DF6B21', '#FFB13B'];
  const square = 8;
  const step = 11;
  const gridX = 349;
  const gridY = 161;

  const cells = calendar.map((week, weekIndex) =>
    week.map((day, weekday) => {
      const x = gridX + weekIndex * step;
      const y = gridY + weekday * step;
      const count = day.contributionCount;
      const label = `${day.date}: ${count} ${count === 1 ? 'contribuição' : 'contribuições'}`;
      return `<rect x="${x}" y="${y}" width="${square}" height="${square}" rx="1" fill="${colors[numericLevel(day)]}" class="cell"><title>${escapeXml(label)}</title></rect>`;
    }).join(''),
  ).join('');

  const xpBars = Array.from({ length: 10 }, (_, index) => {
    const fill = index < xp ? '#FFB13B' : '#30363D';
    return `<rect x="${530 + index * 23}" y="269" width="18" height="7" rx="1" fill="${fill}"/>`;
  }).join('');

  const updatedAt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="320" viewBox="0 0 1000 320" role="img" aria-labelledby="title description">
  <title id="title">PokeDev de contribuições de ${escapeXml(data.name)}</title>
  <desc id="description">Card pixel art com Charizard, ${totalCommits ?? 'total indisponível'} commits públicos, ${data.totalContributions} contribuições e ${activeDays} dias ativos nos últimos 12 meses.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0D1117"/>
      <stop offset="1" stop-color="#16121A"/>
    </linearGradient>
    <linearGradient id="header" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#B92B16"/>
      <stop offset="1" stop-color="#E85D1F"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity=".35"/>
    </filter>
    <style>
      text { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      .label { fill: #8B949E; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
      .value { fill: #F0F6FC; font-size: 24px; font-weight: 800; }
      .eye-front { animation: eye-front 4.8s steps(1, end) infinite; }
      .eye-side { opacity: 0; animation: eye-side 4.8s steps(1, end) infinite; }
      .flame-a { animation: flame-a .72s steps(1, end) infinite; }
      .flame-b { opacity: 0; animation: flame-b .72s steps(1, end) infinite; }
      @keyframes eye-front { 0%, 47%, 86%, 100% { opacity: 1; } 48%, 85% { opacity: 0; } }
      @keyframes eye-side { 0%, 47%, 86%, 100% { opacity: 0; } 48%, 85% { opacity: 1; } }
      @keyframes flame-a { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
      @keyframes flame-b { 0%, 49% { opacity: 0; } 50%, 100% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .eye-front, .eye-side, .flame-a, .flame-b { animation: none; }
        .eye-front, .flame-a { opacity: 1; }
        .eye-side, .flame-b { opacity: 0; }
      }
    </style>
  </defs>

  <rect width="1000" height="320" rx="16" fill="url(#background)"/>
  <rect x="1.5" y="1.5" width="997" height="317" rx="14.5" fill="none" stroke="#3B302C" stroke-width="3"/>
  <path d="M16 2h968a14 14 0 0 1 14 14v28H2V16A14 14 0 0 1 16 2Z" fill="url(#header)"/>
  <path d="M2 44h996" stroke="#7F1D1D" stroke-width="3"/>

  <g transform="translate(20 10)" shape-rendering="crispEdges">
    <circle cx="13" cy="13" r="11" fill="#F8FAFC" stroke="#2B2118" stroke-width="3"/>
    <path d="M2 13a11 11 0 0 1 22 0Z" fill="#EF4444"/>
    <path d="M2 13h22" stroke="#2B2118" stroke-width="3"/>
    <circle cx="13" cy="13" r="4" fill="#FFB13B" stroke="#2B2118" stroke-width="2"/>
  </g>
  <text x="58" y="29" fill="#FFFFFF" font-size="17" font-weight="900" letter-spacing="2">POKEDEV • COMMITS</text>
  <text x="975" y="28" fill="#FFEDD5" font-size="10" font-weight="700" text-anchor="end">ATUALIZADO ${updatedAt}</text>

  <g filter="url(#shadow)">
    <rect x="24" y="61" width="245" height="235" rx="10" fill="#161B22" stroke="#3B302C" stroke-width="2"/>
    <rect x="285" y="61" width="691" height="235" rx="10" fill="#161B22" stroke="#3B302C" stroke-width="2"/>
  </g>

  <g transform="translate(53 70) scale(6)" shape-rendering="crispEdges">${renderCharizard()}</g>
  <g transform="translate(53 70) scale(6)" fill="#20D4D9" shape-rendering="crispEdges">
    <g class="eye-front"><rect x="9" y="10" width="1" height="1"/></g>
    <g class="eye-side"><rect x="8" y="10" width="1" height="1"/></g>
  </g>
  <g transform="translate(224 112) scale(4)" shape-rendering="crispEdges">${renderTail()}</g>
  <g class="flame-a" transform="translate(219 80) scale(4)" shape-rendering="crispEdges">${renderFlame('a')}</g>
  <g class="flame-b" transform="translate(219 80) scale(4)" shape-rendering="crispEdges">${renderFlame('b')}</g>
  <text x="146" y="235" fill="#F0F6FC" font-size="14" font-weight="900" text-anchor="middle">POKEDEV #006</text>
  <text x="146" y="254" fill="#8B949E" font-size="10" font-weight="700" text-anchor="middle" letter-spacing="1">FOGO / TECH</text>
  <rect x="53" y="269" width="186" height="7" rx="2" fill="#30363D"/>
  <rect x="53" y="269" width="${Math.min(186, Math.round((level / 99) * 186))}" height="7" rx="2" fill="#F97316"/>
  <text x="53" y="289" fill="#8B949E" font-size="9">TRAINER @${escapeXml(username)}</text>
  <text x="239" y="289" fill="#FFB13B" font-size="10" font-weight="800" text-anchor="end">LV.${level}</text>

  <text x="313" y="88" class="label">COMMITS PÚBLICOS</text>
  <text x="313" y="119" class="value">${totalCommits ?? '—'}</text>
  <text x="485" y="88" class="label">CONTRIBUIÇÕES</text>
  <text x="485" y="119" class="value">${data.totalContributions}</text>
  <text x="650" y="88" class="label">DIAS ATIVOS</text>
  <text x="650" y="119" class="value">${activeDays}</text>
  <text x="942" y="88" fill="#FFB13B" font-size="11" font-weight="800" text-anchor="end">ÚLTIMOS 12 MESES</text>

  <text x="313" y="176" class="label" text-anchor="middle">DOM</text>
  <text x="313" y="209" class="label" text-anchor="middle">QUA</text>
  <text x="313" y="242" class="label" text-anchor="middle">SÁB</text>
  <g shape-rendering="crispEdges">${cells}</g>

  <text x="313" y="275" class="label">XP PARA O PRÓXIMO NÍVEL</text>
  <g shape-rendering="crispEdges">${xpBars}</g>
  <text x="942" y="275" fill="#8B949E" font-size="10" text-anchor="end">cada quadrado = 1 dia</text>
  <text x="313" y="289" fill="#6E7681" font-size="9">mais atividade</text>
  <rect x="395" y="282" width="8" height="8" rx="1" fill="#5B2918"/>
  <rect x="407" y="282" width="8" height="8" rx="1" fill="#9A4318"/>
  <rect x="419" y="282" width="8" height="8" rx="1" fill="#DF6B21"/>
  <rect x="431" y="282" width="8" height="8" rx="1" fill="#FFB13B"/>
</svg>`;
}

const data = await loadData();
const svg = renderSvg(data);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, svg, 'utf8');

console.log(`PokeDev atualizado para @${username}: ${data.totalCommits ?? '—'} commits, ${data.totalContributions} contribuições.`);
