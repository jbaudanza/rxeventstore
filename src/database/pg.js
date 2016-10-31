import url from 'url';

import Rx from 'rxjs';
import Pool from 'pg-pool';
import {defaults, mapKeys} from 'lodash';

import processId from '../processId';
import {toSQL} from './filters';

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

  /*
   * options: 
   *   includeMetadata: (default false)
   *   stream: (default true)
   */
  observable(key, options={}) {
    if (typeof options === 'number') {
      options = {offset: options};
    }

    defaults(options, {includeMetadata: false, stream: true, offset: 0});

    function buildQuery(minId, offset) {
      let filters = Object.assign({key: key, id: {$gt: minId}}, options.filters);

      // Convert the filter keys into underscores
      filters = mapKeys(filters, (v, k) => camelToUnderscore(k));

      const [where, params] = toSQL(filters);
      params.push(offset);

      return [
        `SELECT * FROM events WHERE ${where} ORDER BY id ASC OFFSET $${params.length}`,
        params
      ];
    }

    let observable;
    let transformFn;

    if (options.includeMetadata) {
      transformFn = transformEvent;
    } else {
      transformFn = (row) => row.data.v;
    }

    if (options.stream) {
      const channel = this.channel(key);
      observable = streamQuery(options.offset, channel, (minId, offset) => (
          query(this.pool, ...buildQuery(minId, offset))
            .then(r => r.rows)
          ));
    } else {
      observable = Rx.Observable.create((observer) => {
        query(this.pool, ...buildQuery(0, options.offset))
            .then(
              function(r) { observer.next(r.rows); observer.complete(); },
              function(error) { observer.error(error); }
            )
      });
    }

    return observable
        .filter(batch => batch.length > 0)
        .map(batch => batch.map(transformFn));
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


function streamQuery(offset, channel, fn) {
  return Rx.Observable.create(function(observer) {
    let maxIdReturned = 0;

    function poll() {
      return fn(maxIdReturned, offset).then(function(results) {
        let maxIdInBatch = 0;

        const filteredResults = [];

        results.forEach(function(record) {
          if (record.id > maxIdInBatch)
            maxIdInBatch = record.id;

          if (record.id > maxIdReturned) {
            filteredResults.push(record);
            offset = 0;
          }
        });

        if (maxIdInBatch > maxIdReturned)
          maxIdReturned = maxIdInBatch;

        return filteredResults;
      });
    }

    poll()
      .then(
        (results) => observer.next(results),
        (error) => observer.error(error)
      );

    const subscription = channel.flatMap(poll).subscribe(observer);

    return () => subscription.unsubscribe();
  });
}

function camelToUnderscore(input) {
  return input.replace(/([A-Z])/g, ($1) => "_"+$1.toLowerCase());
}

function underscoreToCamel(input) {
  return input.replace(/_([a-z])/g, ($1, $2) => $2.toUpperCase());
}

function transformEvent(row) {
  const meta = {
    id: row.id,
    timestamp: row.timestamp
  };

  if (row.process_id) {
    meta.processId = row.process_id;
  }

  if (row.session_id) {
    meta.sessionId = row.session_id;
  }

  if (row.actor) {
    meta.actor = Object.assign({}, row.actor);
    delete meta.actor.iat;
  }

  return [row.data.v, meta];
}
