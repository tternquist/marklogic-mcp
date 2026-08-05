'use strict';

// REST resource extension → /v1/resources/items
//
// Deployed by `gradle mlLoadModules` together with services/metadata/items.xml.
// WITHOUT that metadata file the module deploys but the endpoint 404s.
//
//   GET  /v1/resources/items?rs:category=demo&rs:limit=5
//   POST /v1/resources/items          (JSON body: {"id":"i-1","category":"demo"})
//
// Four rules this file demonstrates:
//   1. Exports are UPPERCASE. exports.get never runs.
//   2. Custom params keep the rs: prefix inside `params`.
//   3. Set context.outputTypes before returning; its length must match the
//      number of items returned.
//   4. Control HTTP status with fn.error(RESTAPI-SRVEXERR), never a bare throw —
//      a thrown error becomes an opaque 500 with no usable body.
//
// declareUpdate() must NOT appear here. The REST framework owns the transaction;
// a POST/PUT request is already an update transaction.

const lib = require('/lib/items-lib.sjs');

/** Raise a REST error with an explicit HTTP status. */
function fail(status, statusMessage, body) {
  fn.error(null, 'RESTAPI-SRVEXERR', Sequence.from([status, statusMessage, body]));
}

function get(context, params) {
  const category = params['rs:category'];
  if (!category) {
    fail(400, 'Bad Request', 'rs:category is required');
  }

  const limit = parseInt(params['rs:limit'] || '10', 10);
  if (isNaN(limit) || limit < 1 || limit > 100) {
    fail(400, 'Bad Request', 'rs:limit must be an integer between 1 and 100');
  }

  context.outputTypes = ['application/json'];
  try {
    const items = lib.findByCategory(category, limit);
    return { category: category, count: items.length, items: items };
  } catch (e) {
    // Log the real cause; return a generic message. The RESTAPI-SRVEXERR body
    // goes to the client verbatim, so stack traces there leak internals.
    xdmp.log('items GET failed: ' + (e.stack || e.toString()), 'error');
    fail(500, 'Internal Server Error', 'lookup failed');
  }
}

function post(context, params, input) {
  if (!input) {
    fail(400, 'Bad Request', 'a JSON body is required');
  }

  // `input` is a Node, not a string.
  let item;
  try {
    item = input.toObject();
  } catch (e) {
    fail(400, 'Bad Request', 'body must be well-formed JSON');
  }

  context.outputTypes = ['application/json'];
  try {
    return { created: lib.insertItem(item) };
  } catch (e) {
    xdmp.log('items POST failed: ' + (e.stack || e.toString()), 'error');
    fail(400, 'Bad Request', e.message);
  }
}

exports.GET = get;
exports.POST = post;
