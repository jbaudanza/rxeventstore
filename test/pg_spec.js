import assert from 'assert';

import Rx from 'rxjs';
import PgDatabase from '../lib/database/pg';

import {itShouldActLikeANotifier} from './notifier_spec';
import {itShouldActLikeAnEventStore} from './eventstore_spec';


function factory() {
  return new PgDatabase("postgres://localhost/jindo_test");
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

  itShouldActLikeANotifier(factory);
  itShouldActLikeAnEventStore(factory);
});
