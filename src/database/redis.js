import redis from 'redis';
import Rx from 'rxjs';

import processId from '../processId';
import streamQuery from './streamQuery';

import {defaults, identity} from 'lodash';
import {toFunction} from './filters';


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

function transformResults(results) {
  return results.reverse().map(JSON.parse);
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

  query(key, options={}) {
    if (typeof options === 'number') {
      options = {offset: options};
    }
    defaults(options, {includeMetadata: false, offset: 0});

    // TODO: Maybe we want to add a batchedFilter operator to batches.js
    let filterBatchFn;
    if (typeof options.filters === 'object') {
      filterBatchFn = function(batch) {
        return batch.filter(toFunction(options.filters));
      };
    } else {
      filterBatchFn = identity;
    }

    let removeMetadata;
    if (options.includeMetadata) {
      removeMetadata = identity;
    } else {
      removeMetadata = (batch) => batch.map(o => o.value);
    }

    return this.redisClient.lrange(key, 0, (-1 - options.offset))
      .then((results) => (
        removeMetadata(filterBatchFn(transformResults(results)))
      ))
  }

  observable(key, options={}) {
    // TODO: This is shared with PG. Maybe make a defaultObservableOptions() function
    if (typeof options === 'number') {
      options = {offset: options};
    }
    defaults(options, {includeMetadata: false, offset: 0});

    const redis = this.redisClient;

    function query(cursor) {
      return redis.lrange(key, 0, (-1 - cursor));
    }

    function nextCursor(lastCursor, results) {
      return lastCursor + results.length;
    }

    const initialCursor = options.offset;

    // TODO: Maybe we want to add a batchedFilter operator to batches.js
    let filterBatchFn;
    if (typeof options.filters === 'object') {
      filterBatchFn = function(batch) {
        return batch.filter(toFunction(options.filters));
      };
    } else {
      filterBatchFn = identity;
    }

    let removeMetadata;
    if (options.includeMetadata) {
      removeMetadata = identity;
    } else {
      removeMetadata = (batch) => batch.map(o => o.value);
    }

    return streamQuery(
        query,
        this.channel(key),
        initialCursor,
        nextCursor,
        transformResults
      )
      .map(filterBatchFn)
      .map(removeMetadata)
      .filter(batch => batch.length > 0);
  }

}
