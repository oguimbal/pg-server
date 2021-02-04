import { Socket, createServer } from 'net';
import { DbCommand, commandToStr } from './protocol/commands';
import { IResponseWriter } from './protocol/responses';
import { CommandParser } from './protocol/command-parser';
import { ResponseWriter } from './protocol/response-writer';
import { isDebug, isThenable } from './utils';
import util from 'util';

export type DbRawCommand = {
    command: DbCommand;
    /** Get raw data associated with this command (if you plan to forward it) */
    getRawData: () => Buffer;
}

export type DbCommandHandler = (command: DbRawCommand, response: IResponseWriter) => void;


export interface IAdvanceServerSession {
    /** Subscribe to new connections */
    onConnect?(socket: Socket): any | void;

    /** Handle inbound requests from connecting clients. Must not throw any error */
    onCommand(command: DbRawCommand, response: IResponseWriter): void;
}


export interface AdvanceServerCtor {
    new(): IAdvanceServerSession;
}

/**
 *
 * @param settings
 */
export function createAdvancedServer(ctor: AdvanceServerCtor) {
    return createServer(function (socket) {
        const session = new ctor();
        session.onConnect?.(socket);
        bindSocket(socket, session.onCommand.bind(session));
    });
}

export function bindSocket(this: void, socket: Socket, handler: DbCommandHandler)
    : { writer: IResponseWriter } {
    if (isDebug) {
        function logArgs(on: string) {
            return (...args: any[]) => console.log('💻 ' + on, ...args);
        }

        socket.on('close', logArgs('close'));
        socket.on('drain', logArgs('drain'));
        socket.on('end', logArgs('end'));
        socket.on('error', logArgs('error'));
        socket.on('lookup', logArgs('lookup'));
    }


    const writer: IResponseWriter = new ResponseWriter(socket);
    const ser = new CommandParser(c => {
        if (isDebug) {
            console.log('👉 CMD:', commandToStr(c.command.type), c.command);
        }
        handler(c, writer);
    });

    socket.on('data', data => {
        ser.parse(data);
    });

    // disable Nagle's algorithm
    socket.setNoDelay(true);

    return { writer };
}
