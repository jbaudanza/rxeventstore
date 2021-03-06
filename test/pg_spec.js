import assert from 'assert';
import uuid from 'node-uuid';

import {times} from 'lodash';
import Rx from 'rxjs';
import PgDatabase from '../lib/database/pg';
import {configFromURL} from '../lib/database/pg';

import {itShouldActLikeAnEventStore} from './eventstore_spec';


function factory() {
  return new PgDatabase("postgres://localhost/rxeventstore_test");
}

function insertEvents(eventStore, key, count, iteratee) {
  return eventStore.insertEvents(key, times(count, iteratee));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PgDatabase', () => {
  it('should return all connections to the pool', () => {
    const key = uuid.v4();
    const db = factory();

    const inserts = insertEvents(db, key, 5);

    // Helpful for debugging pool issues
    //db.pool.pool._factory.log = function(str) { console.log(str); }

    // There should be a single connection allocated for listening for
    // notifications
    function assertPoolSize() {
      // TODO: If pg-pool ever upgrades its dependency on generic-pool to
      // something newer, we can probably stop using this hidden API and use
      // the newer public API. Right now, we're using generic-pool 2.4.2 and the
      // newest is 3.1.1
      assert.equal(db.pool.pool._inUseObjects.length, 1);
    }

    return inserts
        .then(() => wait(100))
        .then(assertPoolSize)
        .then(() => db.query(key))
        .then(assertPoolSize)
        .then(() => db.observable(key).take(1).toPromise())
        .then(assertPoolSize);
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

  itShouldActLikeAnEventStore(factory);
});

describe('configFromURL', () => {
  it('should work', () => {
    const url = 'postgres://user:password@localhost/database_name';
    assert.deepEqual(configFromURL(url), {
        host: 'localhost',
        database: 'database_name',
        user: 'user',
        ssl: false,
        password: 'password'
    });
  });
});
