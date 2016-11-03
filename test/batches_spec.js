import assert from 'assert';

import Rx from 'rxjs';
import {batchedMap, batchedSkip, batchedScan} from '../batches';


function reduceToList(list, i) {
  return list.concat([i]);
}


describe(".batchedSkip", () => {
  it('should skip individual elements but keep the batches intact', () => {
    const batched = Rx.Observable.of([1,2,3], [4,5,6])
    Object.assign(batched, {batchedSkip});

    return batched
        .batchedSkip(2)
        .reduce(reduceToList, [])
        .forEach(function(result) {
          assert.deepEqual(result, [[3], [4,5,6]]);
        });
  });
});


describe('.batchedScan', () => {
  it('should scan each element in a batch and emit once per batch', () => {
    const batched = Rx.Observable.of([1,2,3], [4,5,6])
    Object.assign(batched, {batchedScan});

    return batched
      .batchedScan((i,j) => i + j, 0)
      .take(2)
      .reduce(reduceToList, [])
      .forEach(function(result) {
        assert.deepEqual(result, [6, 21]);
      });
  });

  it('should pass the correct args to the project function', () => {
    const batched = Rx.Observable.of([1,2,3], [4,5,6]);
    Object.assign(batched, {batchedScan});

    let nextExpectedIndex = 0;
    let nextExpectedValue = 1;
    let nextExpectedAcc   = 0;

    function project(acc, value, index) {
      assert.equal(acc, nextExpectedAcc);
      nextExpectedAcc += value;

      assert.equal(index, nextExpectedIndex++);
      assert.equal(value, nextExpectedValue++);

      return acc + value;
    }

    return batched.batchedScan(project, 0).toPromise();
  });
});

describe('.batchedMap', () => {
  it('should map the elements in a batch but keep the batches intact', () => {
    const batched = Rx.Observable.of([1,2,3], [4,5,6])
    Object.assign(batched, {batchedMap});

    return batched
        .batchedMap(x => x + 1)
        .reduce(reduceToList, [])
        .forEach(function(result) {
          assert.deepEqual(result, [[2,3,4], [5,6,7]]);
        });
  });

  it('should pass the correct args to the project function', () => {
    const batched = Rx.Observable.of([1,2,3], [4,5,6]);
    Object.assign(batched, {batchedMap});

    const context = {hello: 'world'};

    let nextExpectedIndex = 0;
    let nextExpectedValue = 1;

    function project(value, index, observable) {
      assert.equal(this.hello, 'world');
      assert.equal(nextExpectedIndex++, index);
      assert.equal(nextExpectedValue++, value);
      assert.equal(observable, batched);
    }

    return batched.batchedMap(project, context).toPromise();
  });
});
