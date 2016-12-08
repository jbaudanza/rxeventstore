RxEventStore
============

RxEventStore is a module for persisting and querying data using the
[Event Sourcing](http://martinfowler.com/eaaDev/EventSourcing.html) pattern and
[RxJs](https://github.com/ReactiveX/rxjs).

redis and postgresql are currently supported as data stores.

RxEventStore is designed to be used in concert with [RxRemote](https://github.com/jbaudanza/rxremote), which allows you to subscribe to observables remotely via a WebSocke, but either one can be used by itself.

## Installing with [NPM](https://www.npmjs.com/)

```bash`
$ npm install rxeventstore
```

## Introduction

In the Event Sourcing model, the canonical source of truth for your application resides entirely in an event log. You can have other data structures besides an event log, but they must all be generated by listening to events in the event log.

An event can be anything that user does that might mutate the state of your application. For example, a user posting a comment would create an event in the event log.

RxEventStore comes with drivers for using both redis and postgresql as an event log. There are two way to pull data out of the event store. The first uses an Observable that emits all the current events and any future events as they happen:

```js
var PgDatabase = require('rxeventstore/database/pg');

// Connect to an instance of postgres. The redis API is almost identical
var database = new PgDatabase("postgres://localhost/databasename");

// This returns an RxJs Observable
var source = database.observable('counter-events');

// The first parameter to insertEvent is a key that is used to group together events of similar semantics.
// The second parameter is the event value. This can be a number, string, or a JSON-serializable object.
database.insertEvent('counter-events', 1);
database.insertEvent('counter-events', 2);
database.insertEvent('counter-events', 3);

const subscription = source.subscribe(
    function (x) {
        console.log('Next: ' + x);
    },
    function (err) {
        console.log('Error: ' + err);
    },
    function () {
        console.log('Completed');
    });

// Notice that each invocation of next() includes a *batch* of events, instead of a single event.
// => Next: [1, 2, 3]

database.insertEvent('counter-events', 4);
// => Next: [4]

database.insertEvent('counter-events', 5);
// => Next: [5]

database.insertEvent('counter-events', 6);
// => Next: [6]

// The observable will continue listening for new events until it is unsubscribed.
```

You can query all available events in the form of a Promise:

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

Observables from the EventStore can optionally include a cursor. A cursor allows you to a unsubscribe from an observable, and resubscribe later where you left off, possibly in a different process. This is useful if you need to resume an observable after a WebSocket disconnects, or you have a long running worker process to project an event stream onto another data structure.

```js
database.insertEvents('messages', ['Hello', 'World'])

// Specify `null` as a cursor to start from the beginning
var source = database.query('messages', {cursor: null});

const subscription = source.subscribe(
    function (x) {
        console.log('Next: ' + x);
    },
    function (err) {
        console.log('Error: ' + err);
    },
    function () {
        console.log('Completed');
    });

// Next: [{cursor: 2, value: ['hello', 'world']}]

// .. at some point in the future
database.insertEvents('messages', ['Foo', 'Bar']);

// Pass in the last cursor that was emitted by the first subscription
var source = database.query('messages', {cursor: 2});

const subscription = source.subscribe(
    function (x) {
        console.log('Next: ' + x);
    },
    function (err) {
        console.log('Error: ' + err);
    },
    function () {
        console.log('Completed');
    });
    
// Next: [{cursor: 4, value: ['foo', 'bar']}]

```

## Metadata

When an event is inserted into the store, you can include various metadata that describes when/where and who created the event. RxEventStore supports the following metadata fields:

 - `id` - An integer that is guaranteed to be unique for that particiular datastore.
 - `timestamp` - A Date object that describes when the event occured
 - `processId` - A uuid of the process that wrote the event into the datastore
 - `sessionId` - A uuid that uniquely identifies the browser session of the user that created the event.
 - `actor` - A JSON structure that identifies the user that created the event.
 - `aggregateRoot` - A string that be used to group events around a common root, such as a chat room, or blog post.

## Filtering

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

You can also can more complicated filters. For example, you might want to only
receive the events created within the past hour.

```js
var source = database.query('pings', {
  timestamp: {$gt: new Date(Date.now() - 60 * 60 * 1000)}
});
```

## Notifications

A real time application needs some mechanism on the backend to trigger updates when new data is available. Both Redis and PostgreSQL provide such mechanisms. Redis has `PUBLISH` and `SUBSCRIBE` commands and PostgreSQL has `NOTIFY` and `LISTEN`.

If you are using the `database.observable()` you don't need to worry about notifications. This is handled for you. If you are writing projections, or some other custom data structure, then you may need to interact with the notifications API directly.

RxEventStore provides an API to map Redis and PostgreSQL's notificiation functionality onto an Observable object.

```js
// database can be an instance of PgDatabase or RedisDatabase. The APIs are the same
var source = database.channel('messages');

source.subscribe(
    function (x) {
        console.log('Next: ' + x);
    },
    function (err) {
        console.log('Error: ' + err);
    },
    function () {
        console.log('Completed');
    });

// The first event that is emitted is always 'ready'.
// Next: 'ready'

database.notify('messages', 'hello');
database.notify('messages', 'world');

// Next: 'hello'
// Next: 'world'
```

The first event that is emitted is always 'ready'. This signals that the subscription to the channel is online and any new messages on the channel will be received.


## Projections

Sometimes, querying the event log is not the most efficient way to inquire about the state of your application. In these cases, it can make sense to project your event log onto another more appropriate data structure. These secondary data structures called "projections", and RxEventStore has a mechanism to help you maintain them.

Projections are only generated and updated via the event log. They are considered denormalized views. Projections are updated by creating new events, and never by writing to the projections directly.

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

// This will subscribe to the observable and begin updating the projection when new events come in. The observable
// should map events onto redis commands, as shown above.
var stop = database.runProjection('red-marbles-counter', resume);

// Invoking stop() will shutdown the projection worker

```

The `runProjection` functions expects a unique name for the projection and a function that generates an Observable of redis commands.

The observable you pass must emit `Object` values with a `cursor` and `value` attribute.

The `cursor` attribute must be a number, string, or JSON serializable Javascript object. In the case that the projection needs to restart, this cursor wil be passed into the observable constructor function that you specificy.

The `value` attribute must be an array of redis commands. These commands will all be run atomically inside of a `MULTI` block. 

After each block of commands is executed, the projection will notify the channel of any key that was updated. For example, consider the following Object.

```
{
    cursor: '123', 
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

Only one worker should run on projection at once. Running more than one worker won't cause any data corruption, but it will be inefficient and generate warnings.


### Reading from projections

Elsewhere in your application, you can subscribe to the projection just like and other observable.

```js
database.insertEvent('marbles', 'red');
database.insertEvent('marbles', 'green');
database.insertEvent('marbles', 'blue');
database.insertEvent('marbles', 'red');

function redMarbleCounter() {
  return database.channel('red-marbles-counter').switchMap(function() {
    database.client.get('red-marble-counter');
  });
}

redMarbleCounter().subscribe(count => console.log('Next: ' + count));
// Next: 2

```
