import Rx from 'rxjs';

export default function streamQuery(queryFn, notifier, initialCursor, cursorFn, resultsFn) {
  return Rx.Observable.create(function(observer) {
    let cursor = initialCursor;
    let inFlight = false;
    let shouldRequest = false;

    const onError = observer.error.bind(observer);

    function runQuery() {
      inFlight = true;
      shouldRequest = false;

      queryFn(cursor).then(function(result) {
        inFlight = false;
        observer.next(resultsFn(result, cursor));
        cursor = cursorFn(cursor, result);

        if (shouldRequest) {
          runQuery();
        }
      },
      onError);
    }

    runQuery();

    function next() {
      if (inFlight) {
        shouldRequest = true;
      } else {
        runQuery();
      }
    }

    return notifier.subscribe({next: next, error: onError});
  });
}
