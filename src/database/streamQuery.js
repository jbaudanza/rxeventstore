import Rx from 'rxjs';

export default function streamQuery(queryFn, notifier, initialCursor, cursorFn, resultsFn) {
  return Rx.Observable.create(function(observer) {
    let cursor = initialCursor;
    const onError = observer.error.bind(observer);

    function runQuery() {
      queryFn(cursor).then(function(result) {
        cursor = cursorFn(cursor, result);
        observer.next(resultsFn(result));
      },
      onError);
    }

    runQuery();

    return notifier.subscribe({next: runQuery, error: onError});
  });
}
