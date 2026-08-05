'use strict';
declareUpdate();

// Remove only what setup.sjs inserted. The `test-fixture` collection exists so
// teardown never has to guess which documents were the test's.
Array.from(cts.uris(null, null, cts.collectionQuery('test-fixture'))).forEach(function (uri) {
  xdmp.documentDelete(uri);
});
