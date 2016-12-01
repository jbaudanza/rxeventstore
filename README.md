RxEventStore
============

RxEventStore is a module for persisting and querying data using the
[Event Sourcing](http://martinfowler.com/eaaDev/EventSourcing.html) pattern and
[RxJs](https://github.com/ReactiveX/rxjs).

redis and postgresql are currently supported as data stores.

RxEventStore is designed to be used in concert with [RxRemote](https://github.com/jbaudanza/rxremote), which allows you to subscribe to observables remotely via a WebSocket.

## Installing with [NPM](https://www.npmjs.com/)

```bash`
$ npm install rxeventstore
```

## Introduction

In the Event Sourcing model, the canonical source of truth for your application resides entirely in an event log. An event can be anything that user does that might mutate the state of your application. For example, a user posting a comment would create an event in the event log.

RxEventStore comes with drivers for using both redis and postgresql as an event log.

```js
// Connect to an instance of postgres. The redis API is almost identical
var database = new PgDatabase("postgres://localhost/databasename");

var source = database.observable('foobar');

database.insertEvent('foobar', 1);
database.insertEvent('foobar', 2);
database.insertEvent('foobar', 2);

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

// => Next: 1
// => Next: 2
// => Next: 3
```

## Projections

Your application might have other persisted data structures that you use to do efficent queries on your data. These secondary data structures called "projections", and RxEventStore has a mechanism to help you maintain them. Projections are generated and updated via the event log. They are considered denormalized views of your event log. 

TODO:
  - More code examples
  - Concept of a resumable observable
  - APIS: observable, insertEvent, notify, channel, runProjection
