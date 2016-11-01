RxPersist

require('rxpersist/database/pg')
require('rxpersist/database/redis')
require('rxpersist/database/memory')
require('rxpersist/database/sqlite')
require('rxpersist/database/indexdb')
require('rxpersist/database/kafka')
require('rxpersist/batching')


import PgDatabase from 'rxpersist/database/pg'

db = new PgDatabase('postgres://localhost/foobar');

db.events('foobar').subscribe
db.insertEvent('foobar', {...});
db.shouldThrottle()

db.notifier('hello').subscribe(...)
db.notify('hello', 'world')
