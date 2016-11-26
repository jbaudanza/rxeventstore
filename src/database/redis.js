import redisDriver from 'redis';
import Rx from 'rxjs';

import processId from '../processId';
import streamQuery from './streamQuery';

import {identity, pick, last} from 'lodash';
import {toFunction} from './filters';
import promisify from '../promisify';

import RedisConnections from './redis_connections';

function parseTimestamp(obj) {
  return Object.assign({}, obj, {timestamp: new Date(obj.timestamp)});
}

function transformResults(results, cursor) {
  return {
    cursor: cursor + results.length,
    value: results.reverse().map(JSON.parse).map(parseTimestamp)
  }
}

function validateProjectionEvent(event) {
  if (typeof event !== 'object' || Array.isArray(event.value)) {
    console.warn(`Malformed event for SetProjection ${this.key}`);
    return false;
  } else {
    return true;
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
    this.clients = new RedisConnections(url, driver);
  }

  channel(key) {
    return Rx.Observable.create((observer) => {
      if (!('subscriptionRefCounts' in this.clients.subscriptions)) {
        this.clients.subscriptions.subscriptionRefCounts = {};
      }

      if (!(key in this.clients.subscriptions.subscriptionRefCounts)) {
        this.clients.subscriptions.subscriptionRefCounts[key] = 0;
      }

      if (this.clients.subscriptions.subscriptionRefCounts[key] === 0) {
        this.clients.subscriptions.subscribe(key, onReady);
      }

      this.clients.subscriptions.subscriptionRefCounts[key]++;

      function onReady(err, result) {
        if (err)
          observer.error(err);
        else
          observer.next('ready');
      }

      function listener(channel, message) {
        if (channel === key) {
          observer.next(message);
        }
      }

      this.clients.subscriptions.on('message', listener);

      return () => {
        this.clients.subscriptions.subscriptionRefCounts[key]--;

        if (this.clients.subscriptions.subscriptionRefCounts[key] === 0) {
          this.clients.subscriptions.unsubscribe(key);
        }
        this.clients.subscriptions.removeListener('message', listener);
      };
    });
  }

  notify(key, message) {
    if (typeof message === 'undefined')
        message = '';

    return this.clients.global.publish(key, message);
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

    const promise = this.clients.global.lpush(key, ...values);

    promise.then(() => {
      this.notify(key);
    });

    return promise;
  }

  query(key, options={}) {
    const offset = (options.cursor || 0);

    return this.clients.global.lrange(key, 0, (-1 - offset))
      .then((results) => transformResults(results, offset))
      .then(postProcessFunction(options));
  }

  observable(key, options={}) {
    const redis = this.clients.global;

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

  runProjection(key, resumable, logObserver) {
    const cursorKey = `projection-cursor:${key}`;

    const notify = this.notify.bind(this);
    const pool = this.clients.pool;
    const redis = this.clients.global;

    // projection state
    let subscription;
    let queuedEvents = [];
    let cancelled = false;
    let transactionClient;
    let lastCursor = null;

    function logger(arg) {
      if (logObserver) {
        if (typeof arg === 'string') {
          logObserver.next(`Projection ${key}: ` + arg);
        } else {
          logObserver.next(arg);
        }
      }
    }

    function startTransaction() {
      if (!transactionClient) {
        transactionClient = pool.acquire().then((redis) => {
          redis.watch(cursorKey);

          redis.get(cursorKey).then((currentCursor) => {
            if (lastCursor !== currentCursor) {
              logger('Out of sync with redis. There may be multiple projections running on the same key.')
              doSubscription();
              return;
            }

            const multi = redis.multi();

            queuedEvents.forEach(function(e) {
              e.value.forEach(function(op) {
                multi[op[0]].apply(multi, op.slice(1))
              });
            });

            multi.set(cursorKey, last(queuedEvents).cursor);

            multi.exec((err, result) => {
              pool.release(redis);

              if (err) {
                console.error(err);
              } else {
                // Detect a write conflict
                if (result === null) {
                  logger('Write conflict was detected. There may be multiple projections running on the same key.')
                  doSubscription();
                } else {
                  notify(cursorKey);
                }
              }
            });

            transactionClient = null;
            queuedEvents = [];
          });
        });
      }
    }

    function next(event) {
      if (typeof event !== 'object' || !Array.isArray(event.value)) {
        logger('Malformed event received. Skipping.');
        return;
      }

      queuedEvents.push(event);
      startTransaction();
    }

    function doSubscription() {
      redis.get(cursorKey).then((cursor) => {
        if (cancelled)
          return;

        if (subscription) {
          subscription.unsubscribe();
          subscription = null;
          logger('Restarting.');
        } else {
          logger('Starting.');
        }

        const observable = resumable(cursor);
        lastCursor = cursor;

        subscription = observable.subscribe({
          next: next,
          error: (err) => { logger('Error raised. Shutting down.'); logger(error) },
          complete: () => { logger('Stream complete. Shutting down.'); }
        });
      });
    }

    doSubscription();

    return function() {
      logger('Shutting down.')
      cancelled = true;
      if (subscription)
        subscription.unsubscribe()
    }
  }

  smembers(key) {
    return this
        .channel(`projection-cursor:${key}`)
        .flatMap(() => this.clients.global.smembers(key));
  }
}
