import assert from 'assert';
import uuid from 'node-uuid';

import {times} from 'lodash';

function insertEvents(eventStore, key, count) {
  return eventStore.insertEvents(key, times(count));
}

export function itShouldActLikeAnEventStore(eventStoreFactory) {
  it('should stream a set of results', () => {
    const eventStore = eventStoreFactory();

    const key = uuid.v4();
    insertEvents(eventStore, key, 3);

    const observable = eventStore.observable(key);

    return observable
      .take(1)
      .toPromise()
      .then(function(results) {
        assert.equal(results.length, 3);

        // Insert some more events and check to make sure they are also
        // streamed
        return insertEvents(eventStore, key, 3);
      })
      .then(() => observable.take(1).toPromise())
      .then((results) => {
        assert.equal(results.length, 6);
      });
  });

  it('should return a set of results and then end', () => {
    const key = uuid.v4();
    const eventStore = eventStoreFactory();
    const inserts = insertEvents(eventStore, key, 3);

    return inserts.then(() => (
      eventStore.observable(key, {stream: false})
        .forEach((results) => {
          assert.equal(results.length, 3);
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

          const [value, meta] = results[0];
          assert('id' in meta);
          assert('timestamp' in meta);
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
}
