import Rx from 'rxjs';
import {last} from 'lodash';

import pool from './redis_pool';

export default class SetProjection {
  constructor(notifier, key, resumable) {
    this.key = key;
    this.resumable = resumable;
    this.notifier = notifier;
    this.queuedEvents = [];
  }

  /* Returns an observables list of all members. This is probably best for 
     small sets only
  */
  members() {
    const baseKey = `projection:${this.key}`;
    const cursorKey = `${baseKey}:cursor`;

    return this.notifier
        .channel(baseKey)
        .flatMap(() => pool.global.smembers(baseKey));
  }

  run() {
    const baseKey = `projection:${this.key}`;
    const cursorKey = `${baseKey}:cursor`;

    pool.global.get(cursorKey).then((cursor) => {
      if (this.subscription)
        this.subscription.unsubscribe();

      const observable = this.resumable(cursor);
      this.subscription = observable.subscribe(this.onEvent.bind(this));
    });
  }

  onEvent(event) {
    if (typeof event !== 'object' || typeof event.value !== 'object') {
      console.warn(`Malformed event for SetProjection ${this.key}`)
      return;
    }

    this.queuedEvents.push(event);
    this.startTransaction();
  }

  startTransaction() {
    const lastCursor = null;

    // TODO: Dry this
    const baseKey = `projection:${this.key}`;
    const cursorKey = `${baseKey}:cursor`;

    if (!this.transactionClient) {
      this.transactionClient = pool.acquire().then((redis) => {
        redis.watch(cursorKey);

        redis.get(cursorKey).then((currentCursor) => {
          if (lastCursor !== currentCursor) {
            // TODO: Abort and resubscribe
            return;
          }

          const multi = redis.multi();
          
          this.queuedEvents.forEach(function(e) {
            if (Array.isArray(e.value.add)) {
              e.value.add.forEach((value) => multi.sadd(baseKey, value));
            }
            if (Array.isArray(e.value.remove)) {
              e.value.remove.forEach((value) => multi.srem(baseKey, value));
            }            
          });

          multi.set(cursorKey, last(this.queuedEvents).cursor);

          multi.exec((err, result) => {
            pool.release(redis);

            if (err) {
              console.error(err);
            } else {
              // Detect a write conflict
              if (result === null) {
                console.warn(`A write conflict was detected on the projection ${baseKey}. There may be multiple projections running on the same key.`)
                this.run();
              } else {
                this.notifier.notify(baseKey);
              }
            }
          });

          delete this.transactionClient;
          this.queuedEvents = [];
        });
      });
    }
  }
}
