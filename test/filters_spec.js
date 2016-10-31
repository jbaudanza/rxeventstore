import assert from 'assert';

import * as filters from '../lib/database/filters';

describe("filters.toSQL", () => {
  it('should render a valid WHERE clause', () => {
    const result = filters.toSQL({
      foo: true,
      bar: false,
      fish: {$eq: 'salmon'},
      amount: {$lt: 1.99},
      count: {$gt: 55},
      color: ['red', 'blue']
    });

    assert.deepEqual(result, 
      [
        'foo = $1 AND bar = $2 AND fish = $3 AND amount < $4 AND count > $5 AND color = ANY ($6)',
        [ true, false, 'salmon', 1.99, 55, ['red', 'blue'] ]
      ]
    );
  });
});
