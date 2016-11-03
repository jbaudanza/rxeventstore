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
