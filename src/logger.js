// SPDX-License-Identifier: Apache-2.0

// https://github.com/wataash/scraps_js/blob/master/logger.js

// TODO: license survives though minifying?
// TODO: test browser
// TODO: check https://github.com/haadcode/logplease
// TODO: performance: get stack only for warn,error

// https://log4js-node.github.io/log4js-node/api.html
// https://log4js-node.github.io/log4js-node/appenders.html
// https://log4js-node.github.io/log4js-node/layouts.html

const dateFormat = require('date-format');
const log4js = require('log4js');
const layouts = require('log4js/lib/layouts');
const LoggingEvent = require('log4js/lib/LoggingEvent');

// https://github.com/visionmedia/debug/blob/master/src/index.js
const browser = Boolean(
  typeof process === 'undefined' ||
    process.type === 'renderer' ||
    process.browser === true ||
    process.__nwjs,
);

// TODO: can compile for browser?
const tty = browser ? null : require('tty');

// -----------------------------------------------------------------------------
// layout

/**
 * {
 *   "date":         "2006-01-02T03:04:05.000"
 *   "level":        "INFO",
 *   "message":      "message"
 *   "pid":          1234,
 *   "file":         "/home/wsh/qjs/log4js-node/examples/stacktrace.js"
 *   "line":         31,
 *   "function":     "func",
 *   "backtrace":    "(backtrace)" TODO: only for LOG_STACK_LEVEL
 * }
 *
 * @param {LoggingEvent} logEvent todo
 * @returns {Object} todo
 */
function j(logEvent) {
  // TODO: show  most-recent non-anonymous function
  const function_ = logEvent.functionName === undefined ? 'anonymous()' : logEvent.functionName;
  return {
    date: dateFormat.asString(dateFormat.ISO8601_FORMAT, logEvent.startTime),
    level: logEvent.level.levelStr,
    message: logEvent.data.join(' '),
    pid: logEvent.pid,
    file: logEvent.fileName,
    line: logEvent.lineNumber,
    function: function_,
    backtrace: logEvent.callStack,
  };
}

// ref. https://github.com/log4js-node/log4js-node/blob/master/lib/layouts.js
function color(level) {
  switch (level) {
    case 'ERROR':
      return '\u001B[31m';
    case 'WARN':
      return '\u001B[33m';
    case 'INFO':
      return '\u001B[34m';
    case 'DEBUG':
      return '\u001B[37m';
    default:
      return '\u001B[31m';
  }
}

/**
 *                pid
 * 01-02T03:04:05 01234   foo.js:func:31 message
 * (stack trace only for error,warn)
 *
 * @param {LoggingEvent} logEvent todo
 * @returns {string} todo
 */
function c(logEvent) {
  const j_ = j(logEvent);
  const file = j_.file.substring(j_.file.lastIndexOf('/') + 1);
  // 2006-01-02T03:04:05.000
  // 01-02T03:04:05
  let s = color(j_.level);
  s += `${j_.date.slice(5, 19)} ${j_.pid.toString().padStart(4, '0')} `;
  s += `${file}:${j_.function}:${j_.line.toString()} `.padStart(20, ' ');
  s += j_.message;
  s += '\u001B[39m';
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  if (prettyStacktrace) {
    s += `\n${j_.backtrace}`;
  }
  return s;
}

log4js.addLayout('json-layout', (_config) => {
  return (logEvent) => {
    return JSON.stringify(j(logEvent));
  };
});

log4js.addLayout('console-layout', (_config) => {
  return (logEvent) => {
    return c(logEvent);
  };
});

// -----------------------------------------------------------------------------
// configure

const confBrowser = {
  appenders: {
    'pretty-appender': { type: 'console', layout: { type: 'console-layout' } },
  },
  categories: {
    default: {
      appenders: ['pretty-appender'],
      enableCallStack: true,
      level: 'debug',
    },
  },
};

const confNode = {
  appenders: {
    'pretty-appender': { type: 'stderr', layout: { type: 'console-layout' } },
    'json-appender': { type: 'stderr', layout: { type: 'json-layout' } },
  },
  categories: {
    default: {
      appenders: [],
      enableCallStack: true,
      level: 'debug',
    },
  },
};

if (tty.isatty(process.stderr.fd) || process.env.LOG_PRETTY === '1') {
  confNode.categories.default.appenders.push('pretty-appender');
} else {
  confNode.categories.default.appenders.push('json-appender');
}

const conf = browser ? confBrowser : confNode;
log4js.configure(conf);

// -----------------------------------------------------------------------------
// API

const logger = log4js.getLogger();

// with stack trace
// TODO: cleanup

// HACK: do debugging and see log4js/lib/logger.js
const defaultParseCallStack = logger.parseCallStack;
// TODO: avoid global
let prettyStacktrace = false;

logger.errors = (...args) => {
  prettyStacktrace = true;
  logger.setParseCallStackFunction((data) => {
    return defaultParseCallStack(data, 5);
  });
  logger.error(...args);
  logger.setParseCallStackFunction(defaultParseCallStack);
  prettyStacktrace = false;
};

logger.warns = (...args) => {
  prettyStacktrace = true;
  logger.setParseCallStackFunction((data) => {
    return defaultParseCallStack(data, 5);
  });
  logger.warn(...args);
  logger.setParseCallStackFunction(defaultParseCallStack);
  prettyStacktrace = false;
};

logger.infos = (...args) => {
  prettyStacktrace = true;
  logger.setParseCallStackFunction((data) => {
    return defaultParseCallStack(data, 5);
  });
  logger.info(...args);
  logger.setParseCallStackFunction(defaultParseCallStack);
  prettyStacktrace = false;
};

logger.debugs = (...args) => {
  prettyStacktrace = true;
  logger.setParseCallStackFunction((data) => {
    return defaultParseCallStack(data, 5);
  });
  logger.debug(...args);
  logger.setParseCallStackFunction(defaultParseCallStack);
  prettyStacktrace = false;
};

module.exports = {
  logger,
};
