import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize, parseNumber, isBareNumber } from '../src/normalize.js';

test('normalize: kapital dan tanda baca dianggap sama', () => {
  assert.equal(normalize('YA'), 'ya');
  assert.equal(normalize('Ya.'), 'ya');
  assert.equal(normalize('  IYAAA '), 'iya');
});

test('normalize: huruf besar/kecil tidak membedakan menu', () => {
  assert.equal(normalize('Nasi GUDEG 2'), 'nasi gudeg 2');
});

test('normalize: singkatan umum diperluas', () => {
  assert.equal(normalize('GK mau'), 'tidak mau');
  assert.equal(normalize('bsk sm yg lain'), 'besok sama yang lain');
});

test('normalize: angka tidak ikut diringkas', () => {
  assert.ok(normalize('es teh 10000').includes('10000'));
  assert.equal(normalize('harga 25000'), 'harga 25000');
});

test('normalize: emoji dan tanda baca dibuang, spasi dirapikan', () => {
  assert.equal(normalize('  halo!!! 🌶️   mau   pesan  '), 'halo mau pesan');
});

test('normalize: pengulangan 2 huruf tidak diringkas otomatis, ditangani kamus', () => {
  assert.equal(normalize('iyaa'), 'iya');
  assert.equal(normalize('yaa'), 'ya');
  // Kata asli yang memang punya huruf dobel tidak rusak
  assert.equal(normalize('bakso'), 'bakso');
  assert.equal(normalize('assalamualaikum'), 'assalamualaikum');
});

test('normalize: input kosong/null aman', () => {
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize('   '), '');
});

test('parseNumber dan isBareNumber', () => {
  assert.equal(parseNumber('pesan 2'), 2);
  assert.equal(parseNumber('tanpa angka'), null);
  assert.equal(isBareNumber('2'), true);
  assert.equal(isBareNumber('2 porsi'), false);
});
