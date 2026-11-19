import Fuse from 'fuse.js';
import { normalize } from './normalize.js';

export const FUZZY_THRESHOLD = 0.3;
const ACCEPT_SCORE = 0.22;
const AMBIGUITY_GAP = 0.07;
const CANDIDATE_SCORE = 0.6;

const FILLER_WORDS = new Set([
  'mau', 'pesan', 'pesen', 'order', 'beli', 'saya', 'aku', 'pak', 'bu', 'ibu',
  'bapak', 'kak', 'kakak', 'min', 'dong', 'ya', 'nih', 'itu', 'ini', 'yang',
  'untuk', 'buat', 'dengan', 'sama', 'dan', 'juga', 'aja', 'saja', 'tolong',
  'minta', 'pingin', 'pengen', 'ingin', 'seporsi', 'porsi', 'nya', 'sih', 'deh',
]);

const QUANTITY_WORDS = new Set([
  'porsi', 'buah', 'biji', 'gelas', 'bungkus', 'kotak', 'pak', 'orang', 'x',
]);

/** Pisahkan pesanan menjadi beberapa segmen: "gdg 2 dan teh 1", "lele 3, nasi jeruk 10". */
export function splitSegments(norm) {
  return String(norm ?? '')
    .split(/\s*(?:dan|sama|sm|\+|\/|\band\b|,)\s*/)
    .map((segment) => segment.trim().replace(/^,|,$/g, '').trim())
    .filter(Boolean);
}

/** Ambil angka pertama dalam satu segmen. */
export function extractQuantity(segment) {
  const match = String(segment ?? '').match(/\d+/);
  if (!match) return null;
  const qty = Number(match[0]);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

/** Buang angka, kata jumlah, dan kata pengisi agar pencocokan fokus ke nama menu. */
export function cleanSegment(segment) {
  const words = String(segment ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !/^\d+$/.test(word))
    .filter((word) => !FILLER_WORDS.has(word))
    .filter((word) => !QUANTITY_WORDS.has(word));
  return words.join(' ').trim();
}

function aliasEntries(menus) {
  const entries = [];
  for (const menu of menus || []) {
    if (!menu.active || (menu.stock !== undefined && menu.stock <= 0)) continue;
    const name = normalize(menu.name);
    if (name) entries.push({ menuId: menu.id, menu, alias: name, isPrimary: true });
    for (const alias of menu.aliases || []) {
      const norm = normalize(alias);
      if (norm) entries.push({ menuId: menu.id, menu, alias: norm, isPrimary: false });
    }
  }
  return entries;
}

export function buildFuse(menus, threshold = FUZZY_THRESHOLD) {
  const entries = aliasEntries(menus);
  if (!entries.length) return null;
  return new Fuse(entries, {
    keys: ['alias'],
    threshold,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
  });
}

/**
 * Cocokkan potongan `norm` ke menu memakai index Fuse yang sudah dibangun.
 * Return kandidat unik (skor terbaik per menu) beserta keputusan.
 */
export function matchMenusWithFuse(normText, fuse, { limit = 5, threshold = FUZZY_THRESHOLD } = {}) {
  if (!fuse) {
    return { status: 'none', matches: [], ambiguous: [], candidates: [], segments: [] };
  }

  const segments = splitSegments(normText);
  const matches = [];
  const ambiguous = [];
  const candidateScores = new Map();
  const searchable = [];

  for (const segment of segments) {
    const clean = cleanSegment(segment);
    const query = clean || segment;
    if (!query) continue;
    searchable.push({ segment, query });

    const results = fuse.search(query).filter((result) => result.score <= threshold);
    if (!results.length) continue;

    // Skor terbaik per menu (satu menu bisa punya beberapa alias).
    const bestByMenu = new Map();
    for (const result of results) {
      const id = result.item.menuId;
      const previous = bestByMenu.get(id);
      if (!previous || result.score < previous.score) {
        bestByMenu.set(id, { menu: result.item.menu, score: result.score, alias: result.item.alias });
      }
      const candidate = candidateScores.get(id);
      if (!candidate || result.score < candidate.score) {
        candidateScores.set(id, { menu: result.item.menu, score: result.score });
      }
    }

    const ranked = [...bestByMenu.values()].sort((a, b) => a.score - b.score);
    const best = ranked[0];
    const second = ranked[1];
    const closeSecond = second && second.score - best.score < AMBIGUITY_GAP;

    if (best.score <= ACCEPT_SCORE && !closeSecond) {
      matches.push({ menu: best.menu, qty: extractQuantity(segment), segment, score: best.score });
    } else if (closeSecond) {
      ambiguous.push({
        segment,
        options: [best.menu, second.menu],
        scores: [best.score, second.score],
      });
    } else {
      // Keyakinan sedang: jangan diputuskan di sini, kirim sebagai kandidat ke LLM.
      candidateScores.set(best.menu.id, { menu: best.menu, score: best.score });
    }
  }

  // Kandidat untuk LLM: ambil skor terbaik walau di atas threshold, tetap dibatasi.
  const candidates = [...candidateScores.values()]
    .filter((entry) => entry.score <= CANDIDATE_SCORE)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.menu);

  const status = ambiguous.length ? 'ambiguous' : matches.length ? 'match' : 'none';
  return { status, matches, ambiguous, candidates, segments: searchable.map((item) => item.segment) };
}

/** Versi tanpa cache; dipakai test/eval. Untuk runtime gunakan MenuMatcher. */
export function matchMenus(normText, menus, { limit = 5, threshold = FUZZY_THRESHOLD } = {}) {
  return matchMenusWithFuse(normText, buildFuse(menus, threshold), { limit, threshold });
}

/**
 * Instance ber-cache. Index Fuse dibangun sekali dan hanya dibangun ulang
 * saat `invalidate()` dipanggil (menu/alias berubah).
 */
export class MenuMatcher {
  constructor({ getMenus, threshold = FUZZY_THRESHOLD } = {}) {
    this.getMenus = getMenus;
    this.threshold = threshold;
    this.indexed = null;
    this.fuse = null;
    this.version = 0;
    this.pending = null;
  }

  invalidate() {
    this.indexed = null;
    this.fuse = null;
    this.version += 1;
  }

  async load() {
    if (this.indexed) return this.indexed;
    if (!this.pending) {
      this.pending = Promise.resolve(this.getMenus()).then((menus) => {
        this.indexed = menus || [];
        this.fuse = buildFuse(this.indexed, this.threshold);
        this.pending = null;
        return this.indexed;
      }).catch((error) => {
        this.pending = null;
        throw error;
      });
    }
    return this.pending;
  }

  async search(normText, options = {}) {
    await this.load();
    return matchMenusWithFuse(normText, this.fuse, { threshold: this.threshold, ...options });
  }

  async candidates(normText, limit = 5) {
    const result = await this.search(normText, { limit });
    return result.candidates.slice(0, limit);
  }
}
