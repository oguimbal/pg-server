import { connect, createServer, Server, Socket } from 'net';
import { bindSocket, DbRawCommand } from './server';
import { CommandCode, IProxiedServer } from './protocol/commands';
import { IResponseWriter, messageToStr } from './protocol/responses';
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



export interface ISimpleProxySession {
    /** Subscribe to new connections */
    onConnect?(socket: Socket): any;

    /** Handle inbound requests from connecting clients */
    onQuery(query: string): CommandOrError | Promise<CommandOrError>;
}

export interface SimpleProxyCtor {
    new(): ISimpleProxySession;
}


/**
 * Create a db proxying server which only gives you a chance to intercepts/modify queries on the fly.
 *
 * This is a wrapper for @see createLowLevelProxy .
 *
 * Must call .listen() to start listening.
 */
export function createSimpleProxy(db: DbConnect, ctor: SimpleProxyCtor) {
    return createAdvancedProxy(db, class extends ctor implements IAdvancedProxySession {
        async onCommand({ command, getRawData }: DbRawCommand, { client, db }: ProxyParties) {
            if (command.type === CommandCode.parse || command.type === CommandCode.query) {
                try {
                    const _transformed = this.onQuery(command.query) ?? command.query;
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


export interface IAdvancedProxySession {
    /** Subscribe to new connections */
    onConnect?: (socket: Socket) => any;

    /** Handle inbound requests from connecting clients. Must not throw any error. */
    onCommand?: (command: DbRawCommand, parties: ProxyParties) => any,

    /** Handle responses from the db */
    onResult?: (result: DbRawResponse, parties: ProxyParties) => any
}

export interface AdvancedProxyCtor {
    new(): IAdvancedProxySession;
}
/**
 * Create a db proxying server.
 *
 * Must call .listen() to start listening.
 */
export function createAdvancedProxy(db: DbConnect, ctor: AdvancedProxyCtor): Server {
    return createServer(socket => {

        const instance = new ctor();

        instance.onConnect?.(socket);

        const dbSock = typeof db === 'function'
            ? db()
            : connect(db.port, db.host);

        let parties: ProxyParties;

        // === when receiving a command from client...
        const { writer } = bindSocket(socket, command => {
            if (instance.onCommand) {
                // ... either ask the proxy what to do
                instance.onCommand(command, parties);
            } else {
                // ... or just forward it
                dbSock.write(command.getRawData());
            }
        });

        // === when receiving response from db...
        const parser = new DbResponseParser();
        dbSock.on('data', buffer => {
            if (instance.onResult) {
                // ... either ask the proxy what to do
                parser.parse(buffer, c => {
                    if (isDebug) {
                        console.log('   🕋 db ', messageToStr(c.response.type), c.response);
                    }
                    instance.onResult!(c, parties);
                })
            } else {
                // ... or just forward it
                socket.write(buffer);
            }
        });

        parties = { client: writer, db: new CommandWriter(dbSock) };

        // === bind errors
        dbSock.on('error', e => writer.error(util.inspect(e)));
        dbSock.on('close', () => socket.destroy());
        dbSock.setNoDelay(true);
    });
}
