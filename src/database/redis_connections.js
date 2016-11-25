import genericPool from 'generic-pool';
import promisify from '../promisify';


export default class RedisConnections {
  constructor(url, driver) {
    function createClient() {
      return promisify(
          driver.createClient(url),
          'get', 'set', 'publish', 'lpush', 'lrange', 'srem', 'sadd', 'smembers'
      );
    }

    //
    // The global connection should be used for most things that aren't
    // related to pub-sub or transactions
    //
    this.global = createClient();
    this.global.watch = function() {
      throw "WATCH attempt on the global connection. Use a pooled connection instead.";
    }

    //
    // This should be used to listen for messages on PUBSUB channels
    //
    this.subscriptions = driver.createClient(url);

    //
    // The pool should be used for WATCH/MULTI/EXEC transactions
    //
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

    this.pool = genericPool.createPool(factory, opts);
  }
}

