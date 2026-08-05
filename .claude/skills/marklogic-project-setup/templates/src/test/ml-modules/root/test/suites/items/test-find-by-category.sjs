'use strict';

// Run with: gradle mlReloadModules mlUnitTest
// mlReloadModules first, always — mlUnitTest executes whatever is in the modules
// database, so a green run against stale modules proves nothing.

const test = require('/test/test-helper.xqy');
const lib = require('/lib/items-lib.sjs');

const books = lib.findByCategory('books');
const films = lib.findByCategory('films');
const missing = lib.findByCategory('no-such-category');
const limited = lib.findByCategory('books', 1);

[]
  .concat(test.assertEqual(2, books.length, 'two book fixtures'))
  .concat(test.assertEqual(1, films.length, 'one film fixture'))
  .concat(test.assertEqual(0, missing.length, 'unknown category returns nothing'))
  .concat(test.assertEqual(1, limited.length, 'limit is respected'))
  // A value containing query-grammar characters must be treated as data, not
  // parsed — this is the regression test for the concatenation bug.
  .concat(test.assertEqual(0, lib.findByCategory('books" OR 1=1').length, 'no injection'));
