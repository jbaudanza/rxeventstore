import url from 'url';

import Rx from 'rxjs';
import Pool from 'pg-pool';
import {defaults, mapKeys, identity, maxBy} from 'lodash';

import processId from '../processId';
import {toSQL} from './filters';
import streamQuery from './streamQuery';


export default class PgDatabase {
  constructor(databaseURL, config) {
    if (arguments.length === 1 && typeof databaseURL === 'object') {
      this.config = databaseURL;
      databaseURL = undefined;
    } else {
      this.config = Object.assign(
          {},
          configFromURL(databaseURL),
          config
      );
    }

    this.pool = new Pool(this.config);
  }

  channel(key) {
    // Keep one connection open for notifications
    if (!this.notifyClient) {
      this.notifyClient = this.pool.connect();
    }

    return Rx.Observable.fromPromise(this.notifyClient).flatMap(function(client) {
      return Rx.Observable.create(function(observer) {

        if (!('subscriptionRefCounts' in client)) {
          client.subscriptionRefCounts = {};
        }

        if (!(key in client.subscriptionRefCounts)) {
          client.subscriptionRefCounts[key] = 0;
        }

        if (client.subscriptionRefCounts[key] === 0) {
          client.query('LISTEN ' + client.escapeIdentifier(key));
        }

        client.subscriptionRefCounts[key]++;

        function listener(event) {
          if (event.channel === key) {
            observer.next(event.payload);
          }      
        }

        client.on('notification', listener);

        return function() {
          client.subscriptionRefCounts[key]--;

          if (client.subscriptionRefCounts[key] === 0) {
            client.query('UNLISTEN ' + client.escapeIdentifier(key));
          }
          client.removeListener('notification', listener);
        };
      });
    });
  }

  notify(channel, message) {
    return this.pool.connect().then(function(client) {
      let cmd = 'NOTIFY ' + client.escapeIdentifier(channel);

      if (message) {
        cmd += ", " + client.escapeLiteral(message);
      }

      return client.query(cmd);
    });
  }

  query(key, options={}) {
    if (typeof options === 'number') {
      options = {offset: options};
    }

    defaults(options, {includeMetadata: false, offset: 0});

    function buildQuery(offset) {
      let filters = Object.assign({key: key}, options.filters);

      // Convert the filter keys into underscores
      filters = mapKeys(filters, (v, k) => camelToUnderscore(k));

      const [where, params] = toSQL(filters);
      params.push(offset);

      return [
        `SELECT * FROM events WHERE ${where} ORDER BY id ASC OFFSET $${params.length}`,
        params
      ];
    }

    let transformFn;
    if (options.includeMetadata) {
      transformFn = transformEvent;
    } else {
      transformFn = (row) => row.data.v;
    }

    return query(this.pool, ...buildQuery(options.offset))
        .then(r => r.rows.map(transformFn))
  }

  /*
   * options:
   *   includeMetadata: (default false)
   *   offset: (default 0)
   */
  observable(key, options={}) {
    if (typeof options === 'number') {
      options = {offset: options};
    }

    defaults(options, {offset: 0});

    function nextCursor(lastCursor, result) {
      if (result.length > 0)
        return maxBy(result, (row) => row.id).id;
      else
        return lastCursor;
    }

    function runQuery(minId) {
      const filters = Object.assign({}, options.filters, {id: {$gt: minId}});
      const localOptions = Object.assign({}, options, {
        offset: (minId > 0) ? 0 : options.offset,
        filters: filters,
        includeMetadata: true
      });
      return this.query(key, localOptions);
    }

    let transformFn;
    if (options.includeMetadata) {
      transformFn = identity;
    } else {
      transformFn = (batch) => batch.map((row) => row.value);
    }

    const channel = this.channel(key);
    return streamQuery(runQuery.bind(this), channel, 0, nextCursor, identity)
        .filter(batch => batch.length > 0)
        .map(transformFn);
  }

  // Note: this won't guarantee the order of insertion. If this is important,
  // wait for the promise to resolve or use insertEvents() instead
  insertEvent(key, event, meta={}) {
    return this.insertEvents(key, [event], meta);
  }

  insertEvents(key, events, meta={}) {
    return this.pool.connect().then((client) => {
      const values = [
        meta.actor,
        key,
        processId,
        meta.connectionId,
        meta.sessionId,
        meta.ipAddress
      ];

      function done() { client.release(); }

      const persisted = Promise.all(
        events.map((event) => (
          client.query(INSERT_SQL, values.concat({v: event}))
                .then(result => result.rows[0])
        ))
      )

      persisted.then(() => this.notify(key));

      persisted.then(done, done);

      // Note that we are returning a promise that resolves *before* the
      // notify query. This is because we want to resolve as soon as the events
      // have been persisted in the database.
      return persisted;
    });
  }

  shouldThrottle(filters, windowSize, maxCount) {
    // Convert the filter keys into underscores
    filters = mapKeys(filters, (v, k) => camelToUnderscore(k));

    const [filterWhere, filterValues] = toSQL(filters);

    const ageSql = `(NOW() - cast($${filterValues.length + 1} AS interval))`;

    const sql = `
      SELECT
        COUNT(*) AS count, (MIN(timestamp) - ${ageSql}) AS retryAfter
        FROM events
        WHERE ${filterWhere} AND timestamp > ${ageSql}
    `;

    const p = this.pool.connect().then((client) => (
      client.query(sql, filterValues.concat(windowSize))
    ));

    return p.then(r => (
      r.rows[0].count >= maxCount) ? r.rows[0].retryafter.seconds : null
    );
  }

  throttled(filters, windowSize, count, fn) {
    return this.shouldThrottle(filters, windowSize, count).then(function(retryAfter) {
      if (retryAfter == null) {
        return fn();
      } else {
        return Promise.reject({retryAfter: retryAfter});
      }
    });
  }
}


const INSERT_SQL = `
  INSERT INTO events (
      timestamp, actor, key, process_id, connection_id, session_id, ip_address, data
  ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7)
  RETURNING *
`;


function query(pool, sql, args) {
  return pool.connect().then(function(client) {
    const p = client.query(sql, args);
    function done() { client.release(); }
    function error(err) { done(); throw err; }

    p.then(done, error);

    return p;
  });
}


function configFromURL(urlString) {
  const params = url.parse(urlString);

  const config = {
    host: params.hostname,
    database: params.pathname.split('/')[1],
    ssl: (process.env['NODE_ENV'] === 'production')
  };

  if (params.port) {
    config.port = params.port;
  }

  if (params.auth) {
    const auth = params.auth.split(':');
    config.user = auth[0];
    config.password = auth[1];
  }

  return config;
}

function camelToUnderscore(input) {
  return input.replace(/([A-Z])/g, ($1) => "_"+$1.toLowerCase());
}

function underscoreToCamel(input) {
  return input.replace(/_([a-z])/g, ($1, $2) => $2.toUpperCase());
}

function transformEvent(row) {
  const obj = {
    id: row.id,
    timestamp: row.timestamp,
    value: row.data.v
  };

  if (row.process_id) {
    obj.processId = row.process_id;
  }

  if (row.session_id) {
    obj.sessionId = row.session_id;
  }

  if (row.actor) {
    obj.actor = Object.assign({}, row.actor);
    delete obj.actor.iat;
  }

  return obj;
}
