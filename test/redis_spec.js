import assert from 'assert';

import Rx from 'rxjs';
import fakeredis from 'fakeredis';

import RedisDatabase from '../lib/database/redis';

import {itShouldActLikeANotifier} from './notifier_spec';
import {itShouldActLikeAnEventStore} from './eventstore_spec';


function factory() {
  return new RedisDatabase("redis://localhost/0", fakeredis);
}


describe('RedisDatabase', () => {
  itShouldActLikeANotifier(factory);
  itShouldActLikeAnEventStore(factory);
});
