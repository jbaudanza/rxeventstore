require('babel-polyfill')
module.exports = {
  RedisDatabase: require('./lib/database/redis').default,
  PgDatabase: require('./lib/database/pg').default
};