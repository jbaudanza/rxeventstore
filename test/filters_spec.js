import assert from 'assert';

import * as filters from '../lib/database/filters';

const testFilters = {
  foo: true,
  bar: false,
  fish: {$eq: 'salmon'},
  amount: {$lt: 1.99},
  count: {$gt: 55},
  color: ['red', 'blue']
};

describe("filters.toSQL", () => {
  it('should render a valid WHERE clause', () => {
    const result = filters.toSQL(testFilters);

    assert.deepEqual(result, 
      [
        'foo = $1 AND bar = $2 AND fish = $3 AND amount < $4 AND count > $5 AND color = ANY ($6)',
        [ true, false, 'salmon', 1.99, 55, ['red', 'blue'] ]
      ]
    );
  });
});

describe('filters.toFunction', () => {
  it('should filter properly', () => {
    const fn = filters.toFunction(testFilters);

    const positive = {
      foo: true,
      bar: false,
      fish: 'salmon',
      amount: 1.00,
      count: 60,
      color: 'red'
    };

    assert(fn(positive));

    function negative(obj) {
      assert(!fn(Object.assign({}, positive, obj)));
    }

    // Negative tests
    negative({foo: false});
    negative({bar: true});
    negative({fish: 'tuna'});
    negative({amount: 5.00});
    negative({count: 25});
    negative({color: 'orange'});
  });
  it('should work with an empty set of filters', () => {
    const fn = filters.toFunction({});
    assert(fn(1));
    assert(fn('hello'));
    assert(fn(null));
    assert(fn());
  });
});
