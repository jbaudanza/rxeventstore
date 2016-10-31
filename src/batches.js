import Rx from 'rxjs';


export function unwrapBatches(batched) {
  const obs = batched.flatMap((x) => Rx.Observable.from(x));

  batched = batched.filter((l) => l.length > 0);

  // Override the prototype version
  batched.batches = obs.batches = function() { return batched; };

  // Add an version of skip that will keep the batched intact.
  obs.skip = batchSkip;

  obs.map = batchMap;

  return obs;
}


export function rewrapBatches(observable) {
  if (typeof observable.batches === 'function') {
    return observable.batches();
  } else {
    return observable.map(x => [x]);
  }
}


// TODO: For consistency, it might be better to name this something other
// than scan, because it only emits once per batch, not per value.
export function batchedScan(project, seed) {
  return Rx.Observable.create((observer) => {
    let baseIndex = 0;

    return this.scan(function(acc, batch) {
      const result = batch.reduce(function(innerAcc, currentValue, index) {
        return project(innerAcc, currentValue, baseIndex + index);
      }, acc);

      baseIndex += batch.length;

      return result;
    }, seed).subscribe(observer);
  });
};


export function batchedSkip(count) {
  if (count === 0)
    return this;

  const sourceObservable = this;

  return Rx.Observable.create(function(observer) {
    let leftToSkip=count;

    return sourceObservable
        .map(function(batch) {
          if (leftToSkip === 0) {
            return batch;
          }
          if (batch.length <= leftToSkip) {
            leftToSkip -= batch.length;
            return [];
          } else {
            const result = batch.slice(leftToSkip);
            leftToSkip = 0;
            return result;
          }
        })
        .filter((l) => l.length > 0)
        .subscribe(observer);
  });
}


export function batchedMap(project, thisArg) {
  const sourceObservable = this;

  return Rx.Observable.create(function(observer) {
    let baseIndex = 0;

    return sourceObservable.map(function(batch) {
      const result = batch.map(function(currentValue, index) {
        return project.call(thisArg, currentValue, baseIndex + index, sourceObservable);
      });

      baseIndex += batch.length;

      return result;
    }).subscribe(observer);
  });
}
