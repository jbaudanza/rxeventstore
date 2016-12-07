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

function castCursor(cursor) {
  if (typeof cursor === 'string' && /^\d+$/.test(cursor)) {
    return parseInt(cursor);
  } else {
    return cursor;
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

function cursorKey(key) {
  return `projection-cursor:${key}`;
}

export default class RedisDatabase {
  constructor(url, driver=redisDriver) {
    this.clients = new RedisConnections(url, driver);
    this.client = this.clients.global;
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
      } else {
        onReady(null, null);
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

    const promise = this.clients.global.incrby('event-id', events.length).then((lastId) => {
      const firstId = lastId - events.length + 1;

      const values = events.map((event, i) => (
        JSON.stringify(Object.assign({
          id: firstId + i,
          value: event,
          processId: processId,
          timestamp: Date.now()
        }, meta))
      ));

      return this.clients.global.lpush(key, ...values);
    });

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
          redis.watch(cursorKey(key));

          redis.get(cursorKey(key)).then(castCursor).then((currentCursor) => {
            if (lastCursor !== currentCursor) {
              logger(`Cursor out of sync with redis. There may be multiple projections running on the same key. Redis: ${currentCursor}, Memory: ${lastCursor}`)
              transactionClient = null;
              doSubscription();
              return;
            }

            const multi = redis.multi();

            const channels = new Set();

            queuedEvents.forEach(function(e) {
              e.value.forEach(function(op) {
                if (!Array.isArray(op)) {
                  console.warn('Expected operation to be an Array: ', op);
                  return;
                }

                if (op.length < 2) {
                  console.warn('Operation must have at least 2 elements: ', op);
                  return;
                }

                if (!(typeof multi[op[0]] === 'function')) {
                  console.warn("Invalid redis op:", op[0]);
                  return;
                }

                multi[op[0]].apply(multi, op.slice(1));
                channels.add(op[1]);
              });
            });

            const nextCursor = last(queuedEvents).cursor;
            multi.set(cursorKey(key), nextCursor);

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
                  lastCursor = nextCursor;
                  channels.forEach(notify);
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
      redis.get(cursorKey(key)).then(castCursor).then((cursor) => {
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

        queuedEvents = [];

        subscription = observable.subscribe({
          next: next,
          error: (err) => { logger('Error raised. Shutting down.'); logger(err) },
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
}
