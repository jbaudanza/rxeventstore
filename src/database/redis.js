import redis from 'redis';
import Rx from 'rxjs';

export default class RedisDatabase {
  constructor(url) {
    this.redisClient = redis.createClient(url);
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

    return new Promise((resolve, reject) => {
      this.redisClient.publish(key, message, function(err, result) {
        if (err)
          reject(err);
        else
          resolve(result);
      })
    });
  }
}
