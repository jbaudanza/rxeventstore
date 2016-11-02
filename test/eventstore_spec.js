import assert from 'assert';
import uuid from 'node-uuid';

import {times} from 'lodash';

function insertEvents(eventStore, key, count, iteratee) {
  return eventStore.insertEvents(key, times(count, iteratee));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function itShouldActLikeAnEventStore(eventStoreFactory) {
  it('should stream a set of results', () => {
    const eventStore = eventStoreFactory();

    const key = uuid.v4();
    insertEvents(eventStore, key, 3);

    const observable = eventStore.observable(key);
    const results = [];

    observable.subscribe(function(batch) {
      results.push(batch);
    });

    return wait(50).then(() => {
      assert.deepEqual([[0,1,2]], results);

      // Insert some more events and check to make sure they are also
      // streamed
      return insertEvents(eventStore, key, 3, (x) => x + 3)
    })
    .then(() => wait(50))
    .then(() => {
      assert.deepEqual([[0,1,2], [3,4,5]], results);
    });
  });

  it('should return a set of results and then end', () => {
    const key = uuid.v4();
    const eventStore = eventStoreFactory();
    const inserts = insertEvents(eventStore, key, 3);

    return inserts.then(() => (
      eventStore.observable(key, {stream: false})
        .forEach((results) => {
          assert.deepEqual(results, [0,1,2]);
        })
    ));
  });

  it('should work with numbers, strings, arrays and objects', () => {
    const eventStore = eventStoreFactory();
    const key = uuid.v4();

    const events = [
      123,
      {numbers: 123},
      [1,2,3],
      'Hello: 123'
    ];

    return eventStore.insertEvents(key, events).then(() => (
      eventStore.observable(key, {stream: false})
        .forEach((results) => {
          assert.deepEqual(results, events);
        })
    ));
  });

  it('should include the metadata', () => {
    const key = uuid.v4();
    const eventStore = eventStoreFactory();
    const inserts = insertEvents(eventStore, key, 3);

    return inserts.then(() => (
      eventStore.observable(key, {includeMetadata: true, stream: false})
        .forEach((results) => {
          assert.equal(3, results.length);

          assert(results[0]);
          assert('timestamp' in results[0]);
          assert('processId' in results[0]);
          assert.equal(results[0].value, 0);
        })
    ));
  });

  it('should filter by metadata', () => {
    const key = uuid.v4();
    const eventStore = eventStoreFactory();

    const inserts = Promise.all([
      eventStore.insertEvent(key, 1, {ipAddress: '192.168.1.1'}),
      eventStore.insertEvent(key, 2, {ipAddress: '192.168.1.2'}),
      eventStore.insertEvent(key, 3, {ipAddress: '192.168.1.1'}),
      eventStore.insertEvent(key, 4, {ipAddress: '192.168.1.2'})
    ]);

    const filters = {ipAddress: '192.168.1.1'};

    const source = eventStore.observable(key, {stream: false, filters: filters});

    return inserts.then(function() {
      return source
          .forEach(function(results) {
            assert.deepEqual(results, [1,3])
          })
    });
  })

  it('should batch the results', () => {
    const eventStore = eventStoreFactory();
    const key = uuid.v4();
    const inserts = insertEvents(eventStore, key, 3);

    return inserts.then(() => (
      eventStore.observable(key)
        .take(1)
        .forEach((results) => {
          assert.equal(results.length, 3);
        })
    ));
  });

  it('should skip ahead to the offset', () => {
    const key = uuid.v4();
    const eventStore = eventStoreFactory();
    const inserts = insertEvents(eventStore, key, 5);

    return inserts.then(() => (
      eventStore.observable(key, 2)
        .take(1)
        .forEach((results) => {
          assert.deepEqual(results, [2,3,4]);
        })
    ));
  });

  it('should handle multiple events insterted in parallel', () => {
    const key = uuid.v4();
    const eventStore = eventStoreFactory();

    const obs = eventStore.observable(key);

    const results = [];

    // These will all happen at the same time, with no guarantee about ordering
    const inserts = Promise.all([
      eventStore.insertEvent(key, 1),
      eventStore.insertEvent(key, 2),
      eventStore.insertEvent(key, 3)
    ]);

    obs.subscribe(function(batch) {
      results.push(batch);
    });

    return wait(50).then(function() {
      assert.equal(results.length, 1);
      assert.deepEqual(results[0].sort(), [1,2,3]);

      return Promise.all([
        eventStore.insertEvent(key, 4),
        eventStore.insertEvent(key, 5),
        eventStore.insertEvent(key, 6)
      ])
    })
    .then(() => wait(50))
    .then(function() {
      assert.equal(results.length, 2);
      assert.deepEqual(results[0].sort(), [1,2,3]);
      assert.deepEqual(results[1].sort(), [4,5,6]);
    })

  });

}
