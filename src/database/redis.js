import redis from 'redis';
import Rx from 'rxjs';

import processId from '../processId';
import streamQuery from './streamQuery';

import {defaults} from 'lodash';

function promisify(object, ...methods) {
  const properties = {};

  methods.forEach(function(method) {
    const value = function() {
      const args = Array.prototype.slice.call(arguments);
      return new Promise(function(resolve, reject) {
        object[method].apply(object, args.concat(function(err, result) {
          if (err) reject(err);
          else resolve(result);
        }));
      });
    };
    properties[method] = {value: value};
  });

  return Object.create(object, properties);
}


export default class RedisDatabase {
  constructor(url) {
    this.redisClient = promisify(redis.createClient(url),
        'publish', 'lpush', 'lrange'
    );
    this.subscriberClient = redis.createClient(url);
  }

  channel(key) {
    return Rx.Observable.create((observer) => {
      if (!('subscriptionRefCounts' in this.subscriberClient)) {
        this.subscriberClient.subscriptionRefCounts = {};
      }

      if (!(key in this.subscriberClient.subscriptionRefCounts)) {
        this.subscriberClient.subscriptionRefCounts[key] = 0;
      }

      if (this.subscriberClient.subscriptionRefCounts[key] === 0) {
        this.subscriberClient.subscribe(key, redisCallback);
      }

      function redisCallback(err, result) {
        if (err)
          observer.error(err);
      }

      function listener(channel, message) {
        if (channel === key) {
          observer.next(message);
        }
      }

      this.subscriberClient.on('message', listener);

      return () => {
        this.subscriberClient.subscriptionRefCounts[key]--;

        if (this.subscriberClient.subscriptionRefCounts[key] === 0) {
          this.subscriberClient.unsubscribe(key);
        }
        this.subscriberClient.removeListener('notification', listener);
      };
    });
  }

  notify(key, message) {
    if (typeof message === 'undefined')
        message = '';

    return this.redisClient.publish(key, message);
  }

  insertEvent(key, event, meta={}) {
    return this.insertEvents(key, [event], meta);
  }

  insertEvents(key, events, meta={}) {
    if (events.length === 0)
      return;

    const values = events.map((event) => (
      JSON.stringify(Object.assign({
        value: event,
        processId: processId,
        timestamp: Date.now()
      }, meta))
    ));

    const promise = this.redisClient.lpush(key, ...values);

    promise.then(() => {
      this.notify(key);
    });

    return promise;
  }

  observable(key, options={}) {
    // TODO: This is shared with PG. Maybe make a defaultObservableOptions() function
    if (typeof options === 'number') {
      options = {offset: options};
    }
    defaults(options, {includeMetadata: false, stream: true, offset: 0});

    const redis = this.redisClient;

    function query(cursor) {
      return redis.lrange(key, 0, cursor);
    }

    function transformResults(results) {
      return results.reverse().map(JSON.parse).map(
        (o) => options.includeMetadata ? o : o.value
      );
    }

    function nextCursor(lastCursor, results) {
      return lastCursor - results.length;
    }

    const initialCursor = -1 - options.offset;

    if (options.stream) {
      return streamQuery(
          query,
          this.channel(key),
          initialCursor,
          nextCursor,
          transformResults
      ).filter(batch => batch.length > 0);
    } else {
      return Rx.Observable.fromPromise(query(initialCursor).then(transformResults));
    }
  }

}
