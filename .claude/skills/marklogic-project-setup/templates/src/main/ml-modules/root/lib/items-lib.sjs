'use strict';

// Library module, deployed to the modules database at /lib/items-lib.sjs by
// `gradle mlLoadModules`. Endpoint handlers stay thin and call in here, so the
// logic is unit-testable without going through the REST API.

/**
 * Find items in a category.
 *
 * The category value comes from a caller, so it is passed to a cts constructor
 * as *data*. Never build query text by concatenation — see the
 * marklogic-server-side-code skill, references/coding-practices.md.
 *
 * @param {string} category - exact category value
 * @param {number} [limit=10] - maximum documents to return
 * @returns {Array<Object>} plain objects, safe to serialize as JSON
 */
function findByCategory(category, limit) {
  const max = limit || 10;
  const query = cts.andQuery([
    cts.collectionQuery('myapp-items'),
    cts.jsonPropertyValueQuery('category', category),
  ]);
  // fn.subsequence is the pagination idiom; cts.search's third argument is the
  // quality weight, not a limit.
  const results = fn.subsequence(cts.search(query), 1, max);
  return Array.from(results).map(function (doc) {
    return doc.toObject();
  });
}

/**
 * Insert one item, carrying explicit permissions and collections.
 * Called from a POST handler, which already runs in an update transaction —
 * declareUpdate() must NOT appear in a REST extension module.
 *
 * @param {Object} item - must have an `id`
 * @returns {string} the URI written
 */
function insertItem(item) {
  if (!item || !item.id) {
    throw new Error('item.id is required');
  }
  const uri = '/items/' + item.id + '.json';
  xdmp.documentInsert(uri, item, {
    collections: ['myapp-items'],
    permissions: [
      xdmp.permission('myapp-reader', 'read'),
      xdmp.permission('myapp-writer', 'update'),
    ],
  });
  return uri;
}

module.exports = {
  findByCategory: findByCategory,
  insertItem: insertItem,
};
