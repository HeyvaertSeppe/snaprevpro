'use strict';
const config = require('./config');

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const min = levels[config.logLevel] || levels.info;

function out(level, args) {
  if (levels[level] < min) return;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](`${ts} [${level}]`, ...args);
}

module.exports = {
  debug: (...a) => out('debug', a),
  info: (...a) => out('info', a),
  warn: (...a) => out('warn', a),
  error: (...a) => out('error', a),
};
