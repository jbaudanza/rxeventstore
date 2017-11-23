RxEventStore
============

RxEventStore is a module for persisting and querying data using the
[Event Sourcing](http://martinfowler.com/eaaDev/EventSourcing.html) pattern and
[RxJs](https://github.com/ReactiveX/rxjs).

Redis and PostgreSQL are currently supported as data stores. The redis driver also has the ability to project the event log onto any other redis data structure.

RxEventStore is designed to be used in concert with [RxRemote](https://github.com/jbaudanza/rxremote), which allows you to subscribe to observables remotely via a WebSocket, but either one can be used by individually.

## Installing with [NPM](https://www.npmjs.com/)

```bash
$ npm install rxeventstore
```

## Introduction

In the Event Sourcing model, the canonical source of truth for your application resides entirely in an event log. The event log is persistent and append-only. 

An event can be anything that a user does that might mutate the state of your application. For example, a user posting a comment would create an event in the event log.

RxEventStore has drivers that use both Redis and PostgreSQL to store and query events. You are free to use either one, or mix and match them both.

There are two ways to pull data out of the event store. The first is to use the `.observable()` function that returns an RxJs Observable that emits all the current events and any future events as they happen:

```js
var PgDatabase = require('rxeventstore/pg'); // or require('rxeventstore/redis')

// Connect to an instance of postgres. The redis API is almost identical
var database = new PgDatabase("postgres://localhost/databasename");

// The first parameter to insertEvent is a key that is used to group together events of similar semantics.
// The second parameter is the event value. This can be a number, string, or a JSON-serializable object.
database.insertEvent('counter-events', 1);
database.insertEvent('counter-events', 2);
database.insertEvent('counter-events', 3);

// This returns an RxJs Observable. The first parameter should make the key that was passed into insertEvent()
var source = database.observable('counter-events');

source.subscribe((x) => console.log('Next: ' + x));

// Notice that each invocation of next() includes a *batch* of events, not a single event.
// => Next: [1, 2, 3]

database.insertEvent('counter-events', 4);
// => Next: [4]

database.insertEvent('counter-events', 5);
// => Next: [5]

database.insertEvent('counter-events', 6);
// => Next: [6]

// The observable will continue listening for new events until it is unsubscribed.
```

You can also use the `.query()` function to return all available events in the form of a Promise.

```js
database.query('counter-events');

// insertEvents() inserts multiple events into the same key at once, and returns a
// promise that resolves when the events have been written to the datastore
database.insertEvents('counter-events', [1,2,3]).then(function() {
  return database.query('counter-events')
}).then(function(results) {
  console.log('Results: ' + results);
})

// Results: [1,2,3]
```

## Cursors

Results from the EventStore can optionally include a cursor. A cursor allows you to a unsubscribe from an observable, and resubscribe later where you left off, possibly in a different process. This is useful if you need to resume an observable after a WebSocket disconnection, or you have a long running worker process that is projecting an event stream onto another data structure.

```js
database.insertEvents('messages', ['Hello', 'World'])

// Specify `null` as a cursor to start from the beginning
var source = database.query('messages', {cursor: null});

source.subscribe((x) => console.log('Next: ' + x));

// Next: [{cursor: 2, value: ['hello', 'world']}]

// .. at some point in the future
database.insertEvents('messages', ['Foo', 'Bar']);

// Pass in the last cursor that was emitted by the previous subscription
var source = database.query('messages', {cursor: 2});

source.subscribe((x) => console.log('Next: ' + x));
    
// Next: [{cursor: 4, value: ['foo', 'bar']}]

```

## Metadata

An event can optionally by stored with metadata that describes when/where and who created the event. RxEventStore supports the following metadata fields:

 - `sessionId` - A uuid that uniquely identifies the browser session of the user that created the event.
 - `ipAddress` - A string that identifies an IPv4 or IPV6 IP address
 - `actor` - A JSON structure that identifies the user that created the event.
 - `aggregateRoot` - A string that be used to group events around a common root, such as a chat room, or blog post.

Some metadata is generated automically for you when an event is inserted.

 - `id` - An integer that is guaranteed to be unique for that particiular datastore.
 - `timestamp` - A Date object that describes when the event occured.
 - `processId` - A uuid of the process that wrote the event into the datastore.

Metadata is inserted by adding a third parameter to the `.insertEvent()` or `.insertEvents()` function. Metadata can be retrieved by using the `includeMetadata` option on the `.query()` or `.observable()` functions. This option can be set to `true`, `false`, or an array of metadata fields.

```js
database.insertEvent('message', 'Hello Event Store!', {
    ipAddress: '127.0.0.1',
    sessionId: 'fd864add-420e-4e08-b34c-213f9e8b17e0'
});

database.query('message', {includeMetadata: true}).then(function(result) {
  console.log(result);
});

// {ipAddress: '127.0.0.1', sessionId: 'fd864add-420e-4e08-b34c-213f9e8b17e0', value: 'Hello World');
```

### Filtering

Observables can optionally filter by metadata.

```js
var source = database.query('comments', {
  filters: {aggregateRoot: 'blog-post-3'}
});
```

This could also be accomplished by using an RxJs filter operator. The advantage
of the previous method is that the filtering can happen in SQL.

```js
var source = database.query('comments', {includeMetadata: 'aggregateRoot'})
  .filter(e => e.aggregateRoot === 'blog-post-3')
```

You can also make more complicated filters. For example, you might want to only
receive the events created within the past hour.

```js
var source = database.query('pings', {
  timestamp: {$gt: new Date(Date.now() - 60 * 60 * 1000)}
});
```

## Projections

Sometimes, querying the event log is not the most efficient way to inquire about the state of your application. In these cases, it can make sense to project your event log onto another more appropriate data structure. These secondary data structures called "projections", and RxEventStore has a mechanism to help you maintain them.

Projections are only updated by a worker process that is following the event log. They should never be updated directly. Conceptually, you should be able to delete and recreate all your projections from the event log at any time.

### Writing to projections

You will need a worker process that keeps the projection up to date. The worker is started by calling the `runProjection` function.

```js
function resume(cursor) {
  return database.observable('marbles').map(function(batch) {
    var count = batch.value.filter((color) => color === 'red').length;
    return {
      cursor: cursor,
      value: [
        ['incrby', 'red-marble-counter', count]
      ]
    };
  });
}

// This will subscribe to the observable and begin updating the projection when new events arrive. The observable
// should map events onto redis commands, as shown above.
var stop = database.runProjection('red-marbles-counter', resume);

// Invoking stop() will shutdown the projection worker

```

The `.runProjection()` functions expects a unique name for the projection and a function that generates an Observable of redis commands.

The observable you pass must emit `Object` values with a `cursor` and `value` attribute.

The `cursor` attribute must be a number, string, or JSON serializable Javascript object. In the case that the projection needs to restart, this cursor wil be passed into the observable constructor function that you specify.

The `value` attribute must be an array of redis commands. These commands will all be run atomically inside of a `MULTI` block. 

After each block of commands is executed, the projection will notify the channel of any key that was updated. For example, consider the following Object.

```
{
    cursor: 50, 
    value: [
      ['set', 'foo', 1],
      ['set', 'bar', 2],
      ['incr', 'counter'],
    ]
}
```

When emitted from an observable, it will cause the following projection update:

```
MULTI
SET foo 1
SET bar 2
INCR counter
EXEC
PUBLISH foo
PUBLISH bar
PUBLISH counter
```

The original source that drives your observable to emit these values is up to you, but it must support the use of a cursor somehow to resume operation. It's likely that you'll drive this from some database observable of user actions. For example:

```js
function resume(cursor) {
  return database.observable('comments', {cusor: cursor})
    .map(function(result) {
      return {
        cursor: result.cursor,
        value: [
          ['INCRBY', 'comment-counter', result.value.length]
        ]
      }
    })
}

runProjection('comment-counter', resume);
```

Only one worker should run a projection at once. Running more than one worker won't cause any data corruption, but it will be inefficient and generate warnings.

### Reading from projections

In order to subscribe to a projection, you need to subscribe to the relevant notification channel off of the `database.notifier` attribute and map updates onto the appropriate redis commands.

To help with this, the redis driver contains a `.client` attribute. This is a normal redis client that has been instrumented with Promises.

```js
database.insertEvent('marbles', 'red');
database.insertEvent('marbles', 'green');
database.insertEvent('marbles', 'blue');
database.insertEvent('marbles', 'red');

function redMarbleCounter() {
  return database.notifier.channel('red-marbles-counter').switchMap(function() {
    database.client.get('red-marble-counter');
  });
}

redMarbleCounter().subscribe(count => console.log('Next: ' + count));
// Next: 2

```

For more information on the `database.notifier` attribute, see the [RxNotifier module](https://github.com/jbaudanza/rxnotifier).
