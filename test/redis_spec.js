import assert from 'assert';

import Rx from 'rxjs';
import fakeredis from 'fakeredis';
import uuid from 'node-uuid';

import RedisDatabase from '../lib/database/redis';

import {itShouldActLikeANotifier} from './notifier_spec';
import {itShouldActLikeAnEventStore} from './eventstore_spec';


function factory() {
  return new RedisDatabase("redis://localhost/0", fakeredis);
}


describe('RedisDatabase', () => {
  itShouldActLikeANotifier(factory);
  itShouldActLikeAnEventStore(factory);

  describe('.runProjection', () => {
    it('should work', function() {
      const key = uuid.v4();
      const db = factory();
      const projectionKey = 'projection:' + key;

      const opSubject = new Rx.ReplaySubject(10);
      const logSubject = new Rx.Subject();
      //logSubject.subscribe((x) => console.log(x));

      opSubject.next({
        cursor: 1,
        value: [['sadd', key, 'hello', 'world', 'universe']]
      });

      opSubject.next({
        cursor: 2,
        value: [['srem', key, 'universe']]
      });

      function resumable(cursor) {
        assert(cursor === null || typeof cursor === 'number');
        return opSubject.skip(cursor || 0);
      }

      let stop = db.runProjection(projectionKey, resumable, logSubject);
      const members = db.channel(key)
          .flatMap(() => db.clients.global.smembers(key));

      return members
        .takeUntil(Rx.Observable.of(1).delay(500))
        .toPromise()
        .then(function(result) {
            assert(Array.isArray(result))
            assert.deepEqual(result.sort(), ['hello', 'world']);
            stop();

            opSubject.next({
              cursor: 3,
              value: [
                ['sadd', key, 'foo'],
                ['sadd', key, 'bar']
              ]
            });

            stop = db.runProjection(projectionKey, resumable, logSubject);

            return members
              .takeUntil(Rx.Observable.of(1).delay(500))
              .toPromise()
        }).then(function(result) {
            assert(Array.isArray(result))
            assert.deepEqual(result.sort(), ['bar', 'foo', 'hello', 'world']);
            stop();
        });
    });
  });
});