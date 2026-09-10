'use strict';

const { loadProfile } = require('./profileLoader');

module.exports = loadProfile({ throwOnError: false }) || {};
