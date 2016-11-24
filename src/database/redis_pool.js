import genericPool from 'generic-pool';

let driver;
if (false && process.env['NODE_ENV'] === 'test') {
  driver = require('fakeredis');
} else {
  driver = require('redis');
}

import promisify from '../promisify';


function createClient() {
  return promisify(
      driver.createClient(process.env['REDIS_URL']), 
      'get', 'set', 'publish', 'publish', 'lpush', 'lrange',
      'srem', 'sadd', 'smembers', 'exec'
  );
}

const factory = {
  create() {
    return Promise.resolve(createClient());
  },
  destroy(client) {
    client.quit();
    return Promise.resolve();
  }
};

const opts = { min: 1, max: 10 };

const pool = genericPool.createPool(factory, opts);

pool.global = createClient();
pool.global.watch = function() {
  throw "WATCH attempt on the global connection. Use a pooled connection instead.";
}

export default pool;

