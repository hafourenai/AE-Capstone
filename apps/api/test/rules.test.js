import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize } from '../src/normalize.js';
import { matchRule, matchStateRule, SETUJU, BATAL } from '../src/rules.js';

const rule = (text) => matchRule(normalize(text));

test('rules: setuju dalam berbagai penulisan', () => {
  for (const text of ['YA', 'Ya.', 'iya', 'IYAAA', 'ok', 'oke', 'siap', 'betul', 'benar', 'y']) {
    assert.equal(rule(text)?.type, 'setuju', `gagal untuk ${text}`);
  }
  assert.ok(SETUJU.has('ya'));
});

test('rules: batal dalam berbagai penulisan', () => {
  for (const text of ['BATAL', 'batal.', 'ga jadi', 'gak jadi', 'tidak jadi', 'cancel', 'gajadi']) {
    assert.equal(rule(text)?.type, 'batal', `gagal untuk ${text}`);
  }
  assert.ok(BATAL.has('batal'));
});

test('rules: lihat menu, jam, lokasi, admin', () => {
  assert.equal(rule('menu')?.type, 'menu');
  assert.equal(rule('daftar menu')?.type, 'menu');
  assert.equal(rule('mau lihat menu')?.type, 'menu');
  assert.equal(rule('jam buka')?.type, 'jam');
  assert.equal(rule('buka jam berapa')?.type, 'jam');
  assert.equal(rule('lokasi')?.type, 'lokasi');
  assert.equal(rule('di mana alamatnya')?.type, 'lokasi');
  assert.equal(rule('admin')?.type, 'admin');
  assert.equal(rule('mau bicara orang')?.type, 'admin');
  assert.equal(rule('cs')?.type, 'admin');
});

test('rules: kalimat pesanan tidak dianggap perintah baku', () => {
  assert.equal(rule('mau pesan gdg 2'), null);
  assert.equal(rule('nasi gudeg 2 sama teh 1'), null);
  assert.equal(rule('bakso'), null);
});

test('rules: aturan berbasis state', () => {
  assert.deepEqual(matchStateRule('2', 'PILIH_MENU'), { type: 'quantity', qty: 2 });
  assert.equal(matchStateRule('2 porsi', 'PILIH_MENU'), null);
  assert.equal(matchStateRule('ya', 'KONFIRMASI')?.type, 'setuju');
  assert.equal(matchStateRule('batal', 'KONFIRMASI')?.type, 'batal');
  assert.equal(matchStateRule('2', 'IDLE'), null);
});
