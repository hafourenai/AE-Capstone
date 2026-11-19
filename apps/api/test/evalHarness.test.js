import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENTS } from '../src/intents.js';
import { loadFixtures, evaluateOffline, predictOffline, sameItems } from './eval/run.js';

test('eval: test set minimal 20 pesan dan semua label valid', () => {
  const { menus, tests } = loadFixtures();
  assert.ok(tests.length >= 20, 'test set harus berisi minimal 20 pesan');
  const menuNames = new Set(menus.map((menu) => menu.name));
  for (const entry of tests) {
    assert.ok(INTENTS.includes(entry.intent), `intent tidak dikenal di baris ${entry.line}: ${entry.intent}`);
    for (const item of entry.items || []) {
      assert.ok(menuNames.has(item.menu), `menu ${item.menu} tidak ada di fixture (baris ${entry.line})`);
      assert.ok(Number.isInteger(item.qty) && item.qty > 0, `qty tidak valid di baris ${entry.line}`);
    }
  }
});

test('eval: lapisan rules+fuzzy menangani mayoritas pesan dengan tepat', () => {
  const summary = evaluateOffline();
  assert.equal(summary.wrong, 0, 'tidak boleh ada prediksi offline yang salah');
  assert.ok(summary.precision >= 0.99);
  assert.ok(summary.coverage >= 0.75, `coverage offline terlalu rendah: ${summary.coverage}`);
  assert.ok(summary.correct >= 20);
});

test('eval: contoh kunci dipahami tanpa LLM', () => {
  const { menus } = loadFixtures();
  assert.deepEqual(predictOffline('gdg 2', menus), {
    intent: 'pesan',
    items: [{ menu: 'Nasi Gudeg', qty: 2 }],
    layer: 'fuzzy',
  });
  assert.equal(predictOffline('buka jam berapa', menus).intent, 'tanya_jam');
  assert.equal(predictOffline('gajadi pesan', menus).intent, 'batal');
  assert.equal(predictOffline('menu apa aja', menus).intent, 'tanya_menu');
});

test('eval: sameItems mengabaikan urutan tapi bukan qty', () => {
  assert.equal(sameItems(
    [{ menu: 'A', qty: 1 }, { menu: 'B', qty: 2 }],
    [{ menu: 'B', qty: 2 }, { menu: 'A', qty: 1 }],
  ), true);
  assert.equal(sameItems([{ menu: 'A', qty: 2 }], [{ menu: 'A', qty: 1 }]), false);
});
