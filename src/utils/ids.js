'use strict';
/**
 * ID helpers — short 12-char hex IDs (like Docker) and full UUIDs.
 */

const { v4: uuidv4 } = require('uuid');

function shortId() {
  return uuidv4().replace(/-/g, '').slice(0, 12);
}

function fullId() {
  return uuidv4().replace(/-/g, '');
}

module.exports = { shortId, fullId };
