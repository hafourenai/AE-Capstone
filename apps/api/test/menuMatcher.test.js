import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize } from '../src/normalize.js';
import { matchMenus, splitSegments, cleanSegment, extractQuantity, MenuMatcher } from '../src/menuMatcher.js';

const MENUS = [
  { id: 'nasi-gudeg', name: 'Nasi Gudeg', price: 15000, stock: 10, active: true, aliases: ['gdg', 'gudeg'] },
  { id: 'es-teh', name: 'Es Teh Manis', price: 5000, stock: 20, active: true, aliases: ['teh'] },
  { id: 'es-jeruk', name: 'Es Jeruk', price: 7000, stock: 20, active: true, aliases: ['jeruk'] },
  { id: 'ayam-geprek', name: 'Ayam Geprek', price: 18000, stock: 0, active: true, aliases: ['geprek'] },
  { id: 'menu-lama', name: 'Menu Lama', price: 1000, stock: 10, active: false, aliases: ['lama'] },
];

test('matcher: "gdg 2" cocok ke Nasi Gudeg dengan qty 2', () => {
  const result = matchMenus(normalize('gdg 2'), MENUS);
  assert.equal(result.status, 'match');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].menu.id, 'nasi-gudeg');
  assert.equal(result.matches[0].qty, 2);
});

test('matcher: dua item dipisah "sama"', () => {
  const result = matchMenus(normalize('pesen gdg 2 sama teh 1'), MENUS);
  assert.equal(result.status, 'match');
  assert.deepEqual(result.matches.map((match) => [match.menu.id, match.qty]), [
    ['nasi-gudeg', 2],
    ['es-teh', 1],
  ]);
});

test('matcher: nama menu lengkap dan kapital', () => {
  const result = matchMenus(normalize('NASI GUDEG 3'), MENUS);
  assert.equal(result.status, 'match');
  assert.equal(result.matches[0].menu.id, 'nasi-gudeg');
  assert.equal(result.matches[0].qty, 3);
});

test('matcher: kandidat berdekatan memicu ambigu', () => {
  const menus = [
    { id: 'a', name: 'Es Teh', price: 1, stock: 9, active: true, aliases: ['es'] },
    { id: 'b', name: 'Es Jeruk', price: 1, stock: 9, active: true, aliases: ['es'] },
  ];
  const result = matchMenus('es', menus);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.ambiguous[0].options.length, 2);
});

test('matcher: menu nonaktif dan stok habis tidak menjadi kandidat', () => {
  const result = matchMenus('geprek lama', MENUS);
  assert.equal(result.status, 'none');
  assert.deepEqual(result.candidates, []);
});

test('matcher: tidak ada kandidat untuk kata asing', () => {
  const result = matchMenus('bakso urat', MENUS);
  assert.equal(result.status, 'none');
  assert.equal(result.matches.length, 0);
});

test('matcher: kandidat untuk LLM dibatasi dan unik', () => {
  const result = matchMenus('es', MENUS, { limit: 2 });
  assert.ok(result.candidates.length <= 2);
  assert.equal(new Set(result.candidates.map((menu) => menu.id)).size, result.candidates.length);
});

test('utility: splitSegments, cleanSegment, extractQuantity', () => {
  assert.deepEqual(splitSegments('gdg 2 sama teh 1'), ['gdg 2', 'teh 1']);
  assert.equal(cleanSegment('pesen gdg 2'), 'gdg');
  assert.equal(extractQuantity('gdg 2'), 2);
  assert.equal(extractQuantity('gdg'), null);
});

test('MenuMatcher: cache dan invalidate', async () => {
  let calls = 0;
  const matcher = new MenuMatcher({ getMenus: async () => { calls += 1; return MENUS; } });
  await matcher.search('gdg');
  await matcher.search('teh');
  assert.equal(calls, 1);
  matcher.invalidate();
  await matcher.search('gdg');
  assert.equal(calls, 2);
});
