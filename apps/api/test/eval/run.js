// Harness evaluasi pemahaman bot.
//
// Offline (default): mengukur Lapisan 1 (rules) + Lapisan 2 (fuzzy) tanpa LLM.
// Live (--live): memanggil llama-server sungguhan dan membandingkan intent+item.
//
// Jalankan dari apps/api:
//   node test/eval/run.js
//   node test/eval/run.js --live --threshold=0.85

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../../src/normalize.js';
import { matchRule } from '../../src/rules.js';
import { matchMenus } from '../../src/menuMatcher.js';
import { INTENTS } from '../../src/intents.js';
import { LLMClient } from '../../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MENUS_PATH = path.join(HERE, 'menus.json');
const TESTSET_PATH = path.join(HERE, 'testset.jsonl');

const RULE_INTENTS = {
  menu: 'tanya_menu',
  jam: 'tanya_jam',
  lokasi: 'tanya_lokasi',
  admin: 'bicara_admin',
  batal: 'batal',
  setuju: 'konfirmasi',
};

export function loadFixtures() {
  const menus = JSON.parse(fs.readFileSync(MENUS_PATH, 'utf8'));
  const tests = fs.readFileSync(TESTSET_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = JSON.parse(line);
      return { ...parsed, line: index + 1 };
    });
  return { menus, tests };
}

export function itemKey(item) {
  return `${item.menu}:${item.qty}`;
}

export function sameItems(actual = [], expected = []) {
  const a = actual.map(itemKey).sort();
  const b = expected.map(itemKey).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function predictOffline(message, menus) {
  const norm = normalize(message);
  const rule = matchRule(norm);
  if (rule) return { intent: RULE_INTENTS[rule.type] ?? null, items: [], layer: 'rules' };

  const match = matchMenus(norm, menus);
  if (match.status === 'match') {
    return {
      intent: 'pesan',
      items: match.matches.map((entry) => ({ menu: entry.menu.name, qty: entry.qty || 1 })),
      layer: 'fuzzy',
    };
  }
  if (match.status === 'ambiguous') {
    return { intent: 'pesan', items: [], layer: 'fuzzy', clarify: true };
  }
  return { intent: null, items: [], layer: 'llm', candidates: match.candidates.map((menu) => menu.name) };
}

export function evaluateOffline({ menus, tests } = loadFixtures()) {
  const summary = { total: tests.length, correct: 0, wrong: 0, clarify: 0, needsLLM: 0, failures: [] };
  for (const test of tests) {
    const predicted = predictOffline(test.pesan, menus);
    if (predicted.intent === null) {
      summary.needsLLM += 1;
      continue;
    }
    if (predicted.clarify) {
      summary.clarify += 1;
      continue;
    }
    const correct = predicted.intent === test.intent && sameItems(predicted.items, test.items);
    if (correct) summary.correct += 1;
    else {
      summary.wrong += 1;
      summary.failures.push({ test, predicted });
    }
  }
  const resolved = summary.correct + summary.wrong;
  summary.coverage = (resolved + summary.clarify) / summary.total;
  summary.precision = resolved ? summary.correct / resolved : 0;
  return summary;
}

export async function evaluateLive({ menus, tests } = loadFixtures(), {
  baseUrl = process.env.AI_BASE_URL || 'http://127.0.0.1:8080/v1',
  model = process.env.AI_MODEL || 'qwen2.5-1.5b-instruct',
  apiKey = process.env.AI_API_KEY || '',
  timeoutMs = Number(process.env.AI_TIMEOUT_MS || 25000),
  threshold = 0.85,
} = {}) {
  const llm = new LLMClient({ baseUrl, model, apiKey, timeoutMs });
  const healthy = await llm.health();
  if (!healthy) {
    return { total: tests.length, correct: 0, accuracy: 0, threshold, healthy, failures: [{ error: 'LLM tidak tersedia' }] };
  }

  const summary = { total: tests.length, correct: 0, intentCorrect: 0, itemsCorrect: 0, accuracy: 0, intentAccuracy: 0, itemAccuracy: 0, threshold, healthy, failures: [] };
  for (const test of tests) {
    const norm = normalize(test.pesan);
    const match = matchMenus(norm, menus);
    const candidates = (match.candidates.length ? match.candidates : menus).slice(0, 5).map((menu) => menu.name);
    try {
      const result = await llm.extract(test.pesan, { candidates });
      const data = result.ok ? result.data : null;
      const intentOk = Boolean(data) && data.intent === test.intent;
      const itemsOk = intentOk && sameItems(data.items, test.items);
      if (intentOk) summary.intentCorrect += 1;
      if (itemsOk) summary.itemsCorrect += 1;
      if (itemsOk) summary.correct += 1;
      else summary.failures.push({ test, predicted: data, reason: result.reason });
    } catch (error) {
      summary.failures.push({ test, error: error.message });
    }
  }
  summary.accuracy = summary.correct / summary.total;
  summary.intentAccuracy = summary.intentCorrect / summary.total;
  summary.itemAccuracy = summary.itemsCorrect / summary.total;
  return summary;
}

function printOffline(summary) {
  console.log('Evaluasi offline (rules + fuzzy, tanpa LLM)');
  console.log(`Total pesan      : ${summary.total}`);
  console.log(`Benar            : ${summary.correct}`);
  console.log(`Salah            : ${summary.wrong}`);
  console.log(`Perlu klarifikasi: ${summary.clarify}`);
  console.log(`Perlu LLM        : ${summary.needsLLM}`);
  console.log(`Coverage         : ${(summary.coverage * 100).toFixed(1)}%`);
  console.log(`Precision        : ${(summary.precision * 100).toFixed(1)}%`);
  if (summary.failures.length) {
    console.log('\nKesalahan offline:');
    for (const failure of summary.failures) {
      console.log(`- baris ${failure.test.line}: "${failure.test.pesan}"`);
      console.log(`  harap: ${failure.test.intent} ${JSON.stringify(failure.test.items)}`);
      console.log(`  dapat: ${failure.predicted.intent} ${JSON.stringify(failure.predicted.items)}`);
    }
  }
}

function printLive(summary) {
  console.log('Evaluasi live (llama-server)');
  console.log(`Total pesan: ${summary.total}`);
  console.log(`Benar      : ${summary.correct}`);
  console.log(`Akurasi    : ${(summary.accuracy * 100).toFixed(1)}%`);
  console.log(`Akurasi intent : ${(summary.intentAccuracy * 100).toFixed(1)}%`);
  console.log(`Akurasi item   : ${(summary.itemAccuracy * 100).toFixed(1)}%`);
  console.log(`Ambang     : ${(summary.threshold * 100).toFixed(1)}%`);
  if (!summary.healthy) console.log('LLM        : OFFLINE');
  if (summary.failures.length) {
    console.log('\nKesalahan live:');
    for (const failure of summary.failures) {
      if (failure.error) { console.log(`- ${failure.error}`); continue; }
      console.log(`- baris ${failure.test.line}: "${failure.test.pesan}"`);
      console.log(`  harap: ${failure.test.intent} ${JSON.stringify(failure.test.items)}`);
      console.log(`  dapat: ${failure.predicted ? `${failure.predicted.intent} ${JSON.stringify(failure.predicted.items)}` : failure.reason}`);
    }
  }
}

export async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const thresholdArg = args.find((arg) => arg.startsWith('--threshold='));
  const threshold = thresholdArg ? Number(thresholdArg.split('=')[1]) : 0.85;

  if (live) {
    const summary = await evaluateLive(undefined, { threshold });
    printLive(summary);
    if (!summary.healthy || summary.accuracy < threshold) process.exitCode = 1;
  } else {
    const summary = evaluateOffline();
    printOffline(summary);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

export { RULE_INTENTS, INTENTS };
