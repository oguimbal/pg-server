
<p align="center">
  <a href="https://npmjs.org/package/pg-server"><img src="http://img.shields.io/npm/v/pg-server.svg"></a>
  <a href="https://npmjs.org/package/pg-server"><img src="https://img.shields.io/npm/dm/pg-server.svg"></a>
  <a href="https://david-dm.org/oguimbal/pg-server"><img src="https://david-dm.org/oguimbal/pg-server.svg"></a>
  <img src="https://github.com/oguimbal/pg-server/workflows/CI/badge.svg">
</p>


 <h3 align="center">
 pg-server is a postgres server emulator allowing you to <b>proxy, honeypot, filter, or emulate</b> an actual Postgres server
 </h3>

# Table of contents

- [🔌 Usage: As a proxy](#-usage-as-a-proxy)
- [💻 Usage: As a Postgres server emulator](#-usage-as-a-postgres-server-emulator)
- [📚 Some literature](#-some-literature)



# 🔌 Usage: As a proxy

Let's say that you want to proxy a real postgres server instance, and let filter only requests that access a given table.

pg-server contains a small utility that abstracts away most of the heavy lifting and which lets you listen/intercept requests.

```typescript
import {createSimpleProxy} from 'pg-server';

const server = createSimpleProxy({
    // The DB that must be proxied
    db: { port: 5432, host: 'localhost' },

    // An optional handler which will be called
    //  on each new connection
    onConnect: socket => {
        console.log('👤 Client connected, IP: ', socket.remoteAddress);
    },

    // A handler which will be called for each sql query
    onCommand: (query, socket) => {
        // Ok, proceed to this query, unmodified.
        // You could also choose to modify the query.
        return query;
        // ... or return an error
        return { error: 'Forbidden !' };
    },
});


// listen on localhost:1234
// ... which will now appear as a postgres db server !
sever.listen(1234, 'localhost');
```

## Example: Analyze & Intercept some queries

You can use [pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser), another library of mine, to parse the inbound requests in order to decide if you'd like to forward them to the actual sql server.

For instance, to only allow simple select requests without joins on a given set of tables, you could do something like that:

```typescript
import {createSimpleProxy} from 'pg-server';
import {parse, astVisitor} from 'pgsql-ast-parser';

const server = createSimpleProxy({
    db: { port: 5432, host: 'localhost' },
    onConnect: socket => {
        console.log('👤 Client connected, IP: ', socket.remoteAddress);
    },
    onCommand: query => {

        // parse the query & check it has only one query
        const parsed = parse(query);
        if (parsed.length !== 1) {
            return { error: 'Only single queries accepted' };
        }

        // check that it is a select
        const [first] = parsed
        if (first.type !== 'select') {
            return { error: 'Only SELECT queries accepted' };
        }

        // check that it selects data from "some_public_table" only
        let authorized = true;
        astVisitor(m => ({
            tableRef: r => authorized = authorized
                && !r.schema
                && r.name === 'some_public_table',
        })).statement(first);
        if (!authorized) {
            return { error: 'Cannot select data from tables. Only expressions allowed.' };
        }

        // ok, proceed to this query, unmodified.
        return query;
    },
});

server.listen(1234, '127.0.0.1');
```

Test it:

```typescript
const client = new require('pg')
      .Client('postgresql://user:pwd@localhost:1234/mydb')

// this works:
await client.query('select * from some_public_table')
// this fails:
await client.query('select * from other_table')
```
## Advanced proxy

The `createSimpleProxy` abstracts away lots of things.
If you wish to have a more fine grained control over which data is exchanged, you can use `createAdvancedProxy()` (refer to the types, and to the ["Some literature"](#-some-literature) section below to understand how it works).

# 💻 Usage: As a Postgres server emulator

You could expose a brand new fake postgres server to the world, without an actual postgres datbase server. As [a Honeypot](https://en.wikipedia.org/wiki/Honeypot_(computing)), for instance.

You could also simulate a postgres db, for which you could use [pg-mem](https://github.com/oguimbal/pg-mem), another lib of mine which simulates a db in memory.

## Simplified interface

TODO

## Advanced interface

`createAdvancedServer()` gives you full control over commands received/responses sent. Only use this if you know the pg protocol a bit.

Example:

```typescript
const server = createAdvancedServer({
    // An optional handler which will be called
    //  on each new connection
    onConnect: socket => {
        console.log('👤 Client connected, IP: ', socket.remoteAddress);
    },

    // A handler which will be called on each received instuction.
    onCommand: ({ command }, response) => {

        // use the "response" writer
        // to react to the "command"  argument

    }
})

server.listen(1234, '127.0.0.1');

```


If you would like your postgres server on a custom already open socket, you can also use the `bindSocket()`, of which `createAdvancedServer()` is just a wrapper.

## With pg-mem

TODO


# 📚 Some literature

- [awesome-honeypots](https://github.com/paralax/awesome-honeypots) A list of honeypots
- [simple & extended queries](https://blog.hackeriet.no/Simple-and-Extended-postgresql-queries/) A very short explanation about query modes
- [postgres on the wire](https://www.pgcon.org/2014/schedule/attachments/330_postgres-for-the-wire.pdf)  55 slides about the postgres protocol
- [Protocol flow](https://www.postgresql.org/docs/13/protocol-flow.html) The official procol explanation
