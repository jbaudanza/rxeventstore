import assert from 'assert';

import Rx from 'rxjs';
import fakeredis from 'fakeredis';
import uuid from 'node-uuid';

import RedisDatabase from '../lib/database/redis';
import SetProjection from '../lib/database/set_projection';

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

      const ops = [
        {add: ['hello', 'world', 'universe']},
        {remove: ['universe']}
      ].map((value, cursor) => ({cursor, value}));

      function resumable(cursor) {
        return Rx.Observable.from(ops);
      }

      const stop = db.runProjection(key, resumable);

      return db
        .smembers(key)
        .takeUntil(Rx.Observable.of(1).delay(1000))
        .toPromise()
        .then(function(result) {
            assert.deepEqual(result.sort(), ['hello', 'world'])
        });
    });
  });
});