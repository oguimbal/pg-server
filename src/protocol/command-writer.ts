import { Socket } from 'net';
import { CommandCode, DbCommand, IProxiedServer } from './commands';
import { serialize } from 'pg-protocol/dist/serializer'
import { assertNever } from '../utils';


export class CommandWriter implements IProxiedServer {
    constructor(private db: Socket) {
    }

    sendRaw(raw: Buffer): void {
        this.db.write(raw);
    }

    send(command: DbCommand): void {
        const buf = this.serialize(command);
        this.db.write(buf);
    }

    private serialize(command: DbCommand): Buffer {
        switch (command.type) {
            case CommandCode.bind:
                return serialize.bind({
                    binary: command.binary,
                    portal: command.portal,
                    statement: command.statement,
                    values: command.values,
                });
            case CommandCode.close:
                return serialize.close({
                    type: command.portalType,
                    name: command.name,
                });
            case CommandCode.copyDone:
                return serialize.copyDone();
            case CommandCode.copyFail:
                return serialize.copyFail(command.message);
            case CommandCode.copyFromChunk:
                return serialize.copyData(command.buffer);
            case CommandCode.describe:
                return serialize.describe({
                    type: command.portalType,
                    name: command.name,
                });
            case CommandCode.end:
                return serialize.end();
            case CommandCode.execute:
                return serialize.execute({
                    portal: command.portal,
                    rows: command.rows,
                });
            case CommandCode.flush:
                return serialize.flush();
            case CommandCode.init:
                return serialize.startup(command.options);
            case CommandCode.parse:
                return serialize.parse({
                    text: command.query,
                    name: command.queryName,
                    types: command.parameters,
                });
            case CommandCode.query:
                return serialize.query(command.query);
            case CommandCode.startup:
                return serialize.password(command.md5);
            case CommandCode.sync:
                return serialize.sync();
            default:
                assertNever(command);
        }
    }

}