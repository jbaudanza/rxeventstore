import assert from 'assert';
import uuid from 'node-uuid';

import {times, flatten, identity} from 'lodash';

function insertEvents(eventStore, key, count, iteratee) {
  const sessionId = uuid.v4();
  return eventStore.insertEvents(key, times(count, iteratee), {sessionId});
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Helper function to assert that an observable emits the batched results
// that are expected within a given timeout.
function assertBatch(observable, timeout, expectedResults, transform=identity) {
  return observable
    .scan((results, batch) => results.concat(batch), [])
    .first((results) => results.length >= expectedResults.length)
    .timeout(timeout)
    .toPromise()
    .then(function(results) {
      assert.deepEqual(transform(results.slice(0, expectedResults.length)), expectedResults);
    });
}

export function itShouldActLikeAnEventStore(eventStoreFactory) {
  describe('.query', () => {
    it('should return a set of results', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();

      return insertEvents(eventStore, key, 3)
          .then(() => eventStore.query(key))
          .then(function(results) {
            assert.deepEqual(results, [0,1,2]);
          });
    });

    it('should return an empty set of results', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();

      return eventStore.query(key).then(function(results) {
        assert.deepEqual(results, []);
      });
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

      return eventStore.insertEvents(key, events)
          .then(() => eventStore.query(key))
          .then(function(results) {
              assert.deepEqual(results, events);
          });
    });

    it('should skip ahead to the cursor', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();
      const inserts = insertEvents(eventStore, key, 3);

      return inserts.then(() => (eventStore.query(key, {cursor: null})))
      .then(function(results) {
        assert('cursor' in results);
        assert.deepEqual(results.value, [0,1,2]);
        const nextCursor = results.cursor;

        return insertEvents(eventStore, key, 3, (x) => x + 3)
            .then(() => (eventStore.query(key, {cursor: nextCursor})))
      })
      .then(function(results) {
        assert('cursor' in results);
        assert.deepEqual(results.value, [3,4,5]);
      });
    });

    it('should include the metadata', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();
      return insertEvents(eventStore, key, 3)
          .then(() => eventStore.query(key, {includeMetadata: true}))
          .then(function(results) {
            assert.equal(3, results.length);

            assert(results[0]);
            assert('timestamp' in results[0]);
            assert('processId' in results[0]);
            assert.equal(results[0].value, 0);
          });
    });

    it('should include only the metadata in the list', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();
      return insertEvents(eventStore, key, 3)
          .then(() => eventStore.query(key, {includeMetadata: ['sessionId', 'timestamp']}))
          .then(function(results) {
            assert.equal(3, results.length);

            assert(results[0]);
            assert('sessionId' in results[0]);
            assert('timestamp' in results[0]);
            assert(!('processId' in results[0]));
            assert.equal(results[0].value, 0);
          });
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

      const source = eventStore.query(key, {filters});

      return inserts
          .then( () => eventStore.query(key, {filters}))
          .then(function(results) {
            assert.deepEqual(results, [1,3]);
          });
    });
  });

  describe('.observable', () => {
    it('should stream a set of results', () => {
      const eventStore = eventStoreFactory();

      const key = uuid.v4();

      // Insert some events, wait a bit, insert some more, and validate that
      // they were all emitted by the observable
      insertEvents(eventStore, key, 3)
        .then(wait(50))
        .then(() => insertEvents(eventStore, key, 3, (x) => x + 3));

      const obs = eventStore.observable(key);

      return Promise.all([
        assertBatch(obs, 500, [0,1,2]),
        assertBatch(obs, 500, [0,1,2,3,4,5])
      ]);
    });

    it('should not return an empty set of results', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();

      // Assert that nothing is ever emitted from the observable
      return eventStore.observable(key)
          .bufferTime(100)
          .take(1)
          .forEach(function(result) {
            assert.deepEqual(result, []);
          });
    });

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

    it('should skip ahead to the cursor', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();
      const inserts = insertEvents(eventStore, key, 3);

      return inserts.then(() => (
        eventStore.observable(key, {cursor: null})
          .take(1)
          .toPromise()
      )).then(function(results) {
        assert('cursor' in results);
        assert.deepEqual(results.value, [0,1,2]);
        const nextCursor = results.cursor;

        return insertEvents(eventStore, key, 3, (x) => x + 3)
            .then(() => (
              eventStore.observable(key, {cursor: nextCursor})
                .take(1)
                .toPromise()
            ))
      }).then(function(results) {
        assert('cursor' in results);
        assert.deepEqual(results.value, [3,4,5]);
      });
    });

    it('should include only the metadata in the list', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();

      const inserts = insertEvents(eventStore, key, 3);
      return inserts.then(
          () => eventStore
            .observable(key, {includeMetadata: ['sessionId', 'timestamp']})
            .take(1)
            .toPromise()
        ).then(function(results) {
          assert.equal(3, results.length);

          assert(results[0]);
          assert('sessionId' in results[0]);
          assert('timestamp' in results[0]);
          assert(!('processId' in results[0]));
          assert.equal(results[0].value, 0);
        });
    });

    it('should handle multiple events inserted in parallel', () => {
      const key = uuid.v4();
      const eventStore = eventStoreFactory();

      const obs = eventStore.observable(key);

      let results = [];

      // These will all happen at the same time, with no guarantee about ordering
      const inserts = Promise.all([
        eventStore.insertEvent(key, 1),
        eventStore.insertEvent(key, 3),
        eventStore.insertEvent(key, 2)
      ])
      .then(() => wait(100))
      .then(() => (
        Promise.all([
          eventStore.insertEvent(key, 6),
          eventStore.insertEvent(key, 4),
          eventStore.insertEvent(key, 5)
        ])
      ));

      return assertBatch(eventStore.observable(key), 500, [1,2,3,4,5,6], (array) => array.sort());
    });
  });
}
