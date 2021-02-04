import { connect, createServer, Server, Socket } from 'net';
import { bindSocket, DbRawCommand } from './server';
import { CommandCode, IProxiedServer } from './protocol/commands';
import { IResponseWriter } from './protocol/responses';
import util from 'util';
import { isDebug, isThenable } from './utils';
import { DbRawResponse, DbResponseParser } from './protocol/response-parser';
import { CommandWriter } from './protocol/command-writer';



export type ProxyParties = {
    /** The connected client */
    client: IResponseWriter;

    /** The proxied DB */
    db: IProxiedServer;
}

type DbConnect = { host: string; port: number; } | (() => Socket);


export interface InterceptedQuery {
    query: string;
}
type CommandOrError = string | { error: string };

/**
 * Create a db proxying server which only gives you a chance to intercepts/modify queries on the fly.
 *
 * This is a wrapper for @see createLowLevelProxy .
 *
 * Must call .listen() to start listening.
 */
export function createSimpleProxy(settings: {
    /** The DB to proxy */
    db: DbConnect;

    /** Subscribe to new connections */
    onConnect?: (socket: Socket) => any;

    /** Handle inbound requests from connecting clients */
    onCommand: (query: string, socket: Socket) => CommandOrError | Promise<CommandOrError>,
}) {
    return createAdvancedProxy({
        db: settings.db,
        onConnect: settings.onConnect,
        onCommand: async ({ command, getRawData }, { client, db }) => {
            if (command.type === CommandCode.parse || command.type === CommandCode.query) {
                try {
                    const _transformed = settings.onCommand(command.query, client.socket) ?? command.query;
                    let transformed: CommandOrError;
                    if (isThenable(_transformed)) {
                        getRawData(); // force get raw data before awaiting
                        transformed = await _transformed;
                    } else {
                        transformed = _transformed;
                    }
                    if (typeof transformed === 'object') {
                        client.error(transformed.error);
                        client.readyForQuery();
                        return;
                    }
                    if (transformed !== command.query) {
                        command.query = transformed;
                        db.send(command);
                        return;
                    }
                } catch (e) {
                    client.error(e);
                    client.readyForQuery();
                    return;

                }
            }
            db.sendRaw(getRawData());
        }
    })
}

/**
 * Create a db proxying server.
 *
 * Must call .listen() to start listening.
 */
export function createAdvancedProxy(settings: {
    /** The DB to proxy */
    db: DbConnect;

    /** Subscribe to new connections */
    onConnect?: (socket: Socket) => any;

    /** Handle inbound requests from connecting clients. Must not throw any error. */
    onCommand?: (command: DbRawCommand, parties: ProxyParties) => any,

    /** Handle responses from the db */
    onResult?: (result: DbRawResponse, parties: ProxyParties) => any
}): Server {
    return createServer(socket => {

        settings.onConnect?.(socket);

        const db = typeof settings.db === 'function'
            ? settings.db()
            : connect(settings.db.port, settings.db.host);

        let parties: ProxyParties;

        // === when receiving a command from client...
        const { writer } = bindSocket(socket, command => {
            if (settings.onCommand) {
                // ... either ask the proxy what to do
                settings.onCommand(command, parties);
            } else {
                // ... or just forward it
                db.write(command.getRawData());
            }
        });

        // === when receiving response from db...
        const parser = new DbResponseParser();
        db.on('data', buffer => {
            if (settings.onResult) {
                // ... either ask the proxy what to do
                parser.parse(buffer, c => {
                    if (isDebug) {
                        console.log('   🕋 db: ', c);
                    }
                    settings.onResult!(c, parties);
                })
            } else {
                // ... or just forward it
                socket.write(buffer);
            }
        });

        parties = { client: writer, db: new CommandWriter(db) };

        // === bind errors
        db.on('error', e => writer.error(util.inspect(e)));
        db.on('close', () => socket.destroy());
        db.setNoDelay(true);
    });
}
