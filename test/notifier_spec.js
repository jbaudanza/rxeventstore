import assert from 'assert';
import Rx from 'rxjs';

function collectFromChannel(channel) {
  return channel
    .bufferTime(500)
    .take(1)
    .toPromise()
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function itShouldActLikeANotifier(notifierFactory) {
  it('should notify the correct channel', () => {
    const notifier = notifierFactory();

    const promise = Promise.all([
      collectFromChannel(notifier.channel('foo')),
      collectFromChannel(notifier.channel('bar'))
    ]);

    notifier.notify('foo', 'hello');

    return promise.then(function([foo, bar]) {
      assert.deepEqual(foo, ['hello']);
      assert.deepEqual(bar, []);
    });
  });

  it('should refcount the subscriptions', () => {
    const notifier = notifierFactory();

    const obs = notifier.channel('foo');

    let callCount = 0;

    // Subscribe once
    const sub1 = obs.subscribe(function() {
      callCount++;
    });
    // Subscribe again. This shouldn't cause a duplicate LISTEN operation
    // on the underlying datastore
    const sub2 = obs.subscribe(function() {
      assert(false, 'this observer should never be called');
    });

    // We need to wait for both subscriptions to become active
    return wait(10).then(function() {
      // Cancel the subscription. Again, this should cause an UNLISTEN operation
      // because sub1 is still active.
      sub2.unsubscribe();

      notifier.notify('foo');

      return wait(150);
    }).then(function() {
      // assert.equal(callCount, 1);
      sub1.unsubscribe();
    });
  });
}
