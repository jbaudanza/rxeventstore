import redisDriver from 'redis';
import Rx from 'rxjs';

import processId from '../processId';
import streamQuery from './streamQuery';

import {identity, pick} from 'lodash';
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

function transformResults(results, cursor) {
  return {
    cursor: cursor + results.length,
    value: results.reverse().map(JSON.parse)
  }
}

function postProcessFunction(options) {
  let filterBatchFn;
  if (typeof options.filters === 'object') {
    filterBatchFn = (batch) => batch.filter(toFunction(options.filters));
  } else {
    filterBatchFn = identity;
  }

  let removeMetadata;
  if (options.includeMetadata) {
    if (Array.isArray(options.includeMetadata)) {
      removeMetadata = (batch) => batch.map(obj => pick(obj, options.includeMetadata, 'value'));
    } else {
      removeMetadata = identity;
    }
  } else {
    removeMetadata = (batch) => batch.map(o => o.value);
  }

  if ('cursor' in options) {
    return (result) => ({
      value: removeMetadata(filterBatchFn(result.value)),
      cursor: result.cursor
    })
  } else {
    return (result) => removeMetadata(filterBatchFn(result.value));
  }
}


export default class RedisDatabase {
  constructor(url, driver=redisDriver) {
    // Instrument the client to use promises
    this.redisClient = promisify(
      driver.createClient(url),
      'publish', 'lpush', 'lrange'
    );

    this.subscriberClient = driver.createClient(url);
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
    const offset = (options.cursor || 0);

    return this.redisClient.lrange(key, 0, (-1 - offset))
      .then((results) => transformResults(results, offset))
      .then(postProcessFunction(options));
  }

  observable(key, options={}) {
    const redis = this.redisClient;

    function query(cursor) {
      return redis.lrange(key, 0, (-1 - cursor));
    }

    function nextCursor(lastCursor, results) {
      return lastCursor + results.length;
    }


    let filterEmpty;
    if ('cursor' in options) {
      filterEmpty = (obj) => obj.value.length > 0;
    } else {
      filterEmpty = (obj) => obj.length > 0;
    }

    return streamQuery(
        query,
        this.channel(key),
        (options.cursor || 0),
        nextCursor,
        transformResults
      )
      .map(postProcessFunction(options))
      .filter(filterEmpty)
  }

}
