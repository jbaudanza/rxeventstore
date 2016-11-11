import assert from 'assert';
import uuid from 'node-uuid';

import {times} from 'lodash';
import Rx from 'rxjs';
import PgDatabase from '../lib/database/pg';

import {itShouldActLikeANotifier} from './notifier_spec';
import {itShouldActLikeAnEventStore} from './eventstore_spec';


function factory() {
  return new PgDatabase("postgres://localhost/jindo_test");
}

function insertEvents(eventStore, key, count, iteratee) {
  return eventStore.insertEvents(key, times(count, iteratee));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PgDatabase', () => {
  it('should configure the database connection', () => {
    const url = 'postgres://user:password@localhost/database_name';
    const db = new PgDatabase(url, {ssl: true});
    assert.deepEqual(db.config, { host: 'localhost',
        database: 'database_name',
        ssl: true,
        user: 'user',
        password: 'password'
    });
  });

  it('should return all connections to the pool', () => {
    const key = uuid.v4();
    const db = factory();

    const inserts = insertEvents(db, key, 5);

    // Helpful for debugging pool issues
    //db.pool.pool._factory.log = function(str) { console.log(str); }

    function assertEmpty() {
      // TODO: If db-pool ever upgrades it's dependency on generic-pool to
      // something newer, we can probably stop using this hidden API and use
      // the newer public API. Right now, we're using generic-pool 2.4.2 and the
      // newest is 3.1.1
      assert.equal(db.pool.pool._inUseObjects.length, 0);
    }

    assertEmpty();

    return inserts
        .then(() => wait(100))
        .then(assertEmpty)
        .then(() => db.query(key))
        .then(assertEmpty)
        .then(() => db.observable(key).take(1).toPromise())
        .then(() => db.notifyClient)
        .then(function(client) {
          delete db.notifyClient;
          client.release();
          assertEmpty();
        });
  });

  describe(".shouldThrottle", () => {
    it('should throttle', () => {
      const key = uuid.v4();
      const db = factory();

      const inserts = insertEvents(db, key, 5);

      return inserts
          .then(() => db.shouldThrottle({key}, '10 seconds', 5))
          .then((result) => assert.equal(typeof result, 'number'));
    });

    it('should not throttle', () => {
      const key = uuid.v4();
      const db = factory();

      return db.shouldThrottle({key}, '10 seconds', 5)
        .then((result) => assert.equal(result, null));
    });
  });

  itShouldActLikeANotifier(factory);
  itShouldActLikeAnEventStore(factory);
});
