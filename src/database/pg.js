import url from 'url';

import Rx from 'rxjs';
import Pool from 'pg-pool';
import pg from 'pg';
import {mapKeys, identity, last, includes} from 'lodash';

import processId from '../processId';
import {toSQL} from './filters';
import streamQuery from './streamQuery';

import PgNotifier from 'rxnotifier/pg_notifier';


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
    this.notifier = new PgNotifier(this.pool);
  }

  query(key, options={}) {
    let filters = Object.assign({key}, options.filters);

    // Convert the filter keys into underscores
    filters = mapKeys(filters, (v, k) => camelToUnderscore(k));

    if (typeof options.cursor === 'string') {
      console.warn('Received a cursor of type string. number or null expected ')
    }

    if (typeof options.cursor === 'number') {
      filters.id = {$gt: options.cursor};
    }

    const [where, params] = toSQL(filters);
    const sql = `SELECT id, (timestamp AT TIME ZONE 'utc') AS timestamp, actor, key, process_id, connection_id, session_id, ip_address, aggregate_root, data FROM events WHERE ${where} ORDER BY id ASC`;

    let transformValues;
    if (options.includeMetadata) {
      let fields;
      if (Array.isArray(options.includeMetadata)) {
        fields = options.includeMetadata;
      } else {
        fields = ['id', 'timestamp', 'processId', 'sessionId', 'actor', 'aggregateRoot', 'ipAddress']
      }
      transformValues = transformEvent.bind(undefined, fields);
    } else {
      transformValues = (row) => row.data.v;
    }

    let transformBatch;

    if('cursor' in options) {
      transformBatch = function(batch) {
        const value = batch.map(transformValues);
        if (batch.length > 0) {
          return {
            value: value,
            cursor: last(batch).id
          }
        } else {
          return {
            value: value,
            cursor: options.cursor
          };
        }
      };
    } else {
      transformBatch = (batch) => batch.map(transformValues);
    }

    return this.pool.query(sql, params).then(r => transformBatch(r.rows));
  }

  /*
   * options:
   *   includeMetadata: (default false)
   *   cursor: (no default)
   */
  observable(key, options={}) {
    function nextCursor(lastCursor, results) {
      return results.cursor;
    }

    function runQuery(cursor) {
      return this.query(key, Object.assign({}, options, {cursor}));
    }

    let transformFn;
    if ('cursor' in options) {
      transformFn = identity;
    } else {
      transformFn = (results) => results.value;
    }

    const channel = this.notifier.channel(key);

    return streamQuery(runQuery.bind(this), channel, options.cursor, nextCursor, identity)
        .filter(result => result.value.length > 0)
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
        meta.ipAddress,
        meta.aggregateRoot
      ];

      function done() { client.release(); }

      const persisted = Promise.all(
        events.map((event) => (
          client.query(INSERT_SQL, values.concat({v: event}))
                .then(result => result.rows[0])
        ))
      )

      persisted.then(() => this.notifier.notify(key));

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

    const ageSql = `(NOW() AT TIME ZONE 'utc' - cast($${filterValues.length + 1} AS interval))`;

    const sql = `
      SELECT
        COUNT(*) AS count, (MIN(timestamp) - ${ageSql}) AS retryAfter
        FROM events
        WHERE ${filterWhere} AND timestamp > ${ageSql}
    `;

    const p = this.pool.query(sql, filterValues.concat(windowSize));

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
      timestamp, actor, key, process_id, connection_id, session_id, ip_address, aggregate_root, data
  ) VALUES (NOW() AT TIME ZONE 'utc', $1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING *
`;


export function configFromURL(urlString) {
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

function transformEvent(fields, row) {
  const obj = {
    value: row.data.v
  };

  if (includes(fields, 'id')) {
    obj.id = row.id;
  }

  if (includes(fields, 'timestamp')) {
    obj.timestamp = row.timestamp;
  }

  if (includes(fields, 'processId') && row.process_id) {
    obj.processId = row.process_id;
  }

  if (includes(fields, 'sessionId') && row.session_id) {
    obj.sessionId = row.session_id;
  }

  if (includes(fields, 'aggregateRoot') && row.aggregate_root) {
    obj.aggregateRoot = row.aggregate_root;
  }

  if (includes(fields, 'ipAddress') && row.ip_address) {
    obj.ipAddress = row.ip_address;
  }

  if (includes(fields, 'actor') && row.actor) {
    obj.actor = Object.assign({}, row.actor);
    delete obj.actor.iat;
  }

  return obj;
}
