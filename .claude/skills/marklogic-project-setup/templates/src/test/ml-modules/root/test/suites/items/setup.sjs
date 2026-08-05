'use strict';
declareUpdate();

// Fixtures for the `items` suite. Assert against documents inserted here, never
// against whatever happens to be in the database — a test that passes only on a
// developer's machine is worse than no test.

const PERMS = [
  xdmp.permission('myapp-reader', 'read'),
  xdmp.permission('myapp-writer', 'update'),
];

[
  { id: 'test-1', category: 'books', title: 'Test Book One' },
  { id: 'test-2', category: 'books', title: 'Test Book Two' },
  { id: 'test-3', category: 'films', title: 'Test Film' },
].forEach(function (item) {
  xdmp.documentInsert('/items/' + item.id + '.json', item, {
    collections: ['myapp-items', 'test-fixture'],
    permissions: PERMS,
  });
});
