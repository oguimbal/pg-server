import { TransformOptions } from 'stream'
import { BufferReader } from './buffer-reader';
import { DbCommand, CommandCode } from './commands';
import { expectNever } from '../utils';
import type { DbRawCommand } from '../server';


// https://www.postgresql.org/docs/9.1/protocol-flow.html


export declare type Mode = 'text' | 'binary';


// every message is prefixed with a single bye
const CODE_LENGTH = 1
// every message has an int32 length which includes itself but does
// NOT include the code in the length
const LEN_LENGTH = 4

const HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH

export type Packet = {
    code: number
    packet: Buffer
}

const emptyBuffer = Buffer.allocUnsafe(0)

type StreamOptions = TransformOptions & {
    mode: Mode
}

export class CommandParser {
    private buffer: Buffer = emptyBuffer
    private bufferLength: number = 0
    private bufferOffset: number = 0
    private reader = new BufferReader()
    private mode: Mode
    private started = false;

    constructor(private _callback: (cmd: DbRawCommand) => void, opts?: StreamOptions) {
        if (opts?.mode === 'binary') {
            throw new Error('Binary mode not supported yet')
        }
        this.mode = opts?.mode || 'text'
    }

    private process(command: DbCommand, offset: number, len: number) {

        let callingback = true;
        let thisData: Buffer;
        this._callback({
            command,
            getRawData: () => {
                if (thisData) {
                    return thisData;
                }
                if (!callingback) {
                    throw new Error(`If you're interested in raw data, please ask for it sooner`);
                }
                return thisData = this.buffer.slice(offset, offset + len);
            },
        });
        callingback = false;
    }

    public parse(buffer: Buffer) {
        this.mergeBuffer(buffer);
        const bufferFullLength = this.bufferOffset + this.bufferLength
        let offset = this.bufferOffset

        if (!this.started) {
            this.reader.setBuffer(0, this.buffer)
            const len = this.reader.int32();
            const ret = this.parseInit();
            this.started = true;
            this.process(ret, offset, len);
            offset += len;
        } else {
            while (offset + HEADER_LENGTH <= bufferFullLength) {
                // code is 1 byte long - it identifies the message type
                const code = this.buffer[offset]
                // length is 1 Uint32BE - it is the length of the message EXCLUDING the code
                const length = this.buffer.readUInt32BE(offset + CODE_LENGTH)
                const fullMessageLength = CODE_LENGTH + length
                if (fullMessageLength + offset <= bufferFullLength) {
                    const message = this.handlePacket(offset + HEADER_LENGTH, code, length)
                    this.process(message, offset, fullMessageLength)
                    offset += fullMessageLength;
                } else {
                    break
                }
            }
        }
        if (offset === bufferFullLength) {
            // No more use for the buffer
            this.buffer = emptyBuffer
            this.bufferLength = 0
            this.bufferOffset = 0
        } else {
            // Adjust the cursors of remainingBuffer
            this.bufferLength = bufferFullLength - offset
            this.bufferOffset = offset
        }
    }

    private mergeBuffer(buffer: Buffer): void {
        if (this.bufferLength > 0) {
            const newLength = this.bufferLength + buffer.byteLength
            const newFullLength = newLength + this.bufferOffset
            if (newFullLength > this.buffer.byteLength) {
                // We can't concat the new buffer with the remaining one
                let newBuffer: Buffer
                if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
                    // We can move the relevant part to the beginning of the buffer instead of allocating a new buffer
                    newBuffer = this.buffer
                } else {
                    // Allocate a new larger buffer
                    let newBufferLength = this.buffer.byteLength * 2
                    while (newLength >= newBufferLength) {
                        newBufferLength *= 2
                    }
                    newBuffer = Buffer.allocUnsafe(newBufferLength)
                }
                // Move the remaining buffer to the new one
                this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength)
                this.buffer = newBuffer
                this.bufferOffset = 0
            }
            // Concat the new buffer with the remaining one
            buffer.copy(this.buffer, this.bufferOffset + this.bufferLength)
            this.bufferLength = newLength
        } else {
            this.buffer = buffer
            this.bufferOffset = 0
            this.bufferLength = buffer.byteLength
        }
    }

    private handlePacket(offset: number, type: CommandCode, length: number): DbCommand {
        this.reader.setBuffer(offset, this.buffer);
        switch (type) {
            case CommandCode.init:
                throw new Error('Connection already started up');
            case CommandCode.startup:
                return this.parseStartup();
            case CommandCode.parse:
                return this.parseParse();
            case CommandCode.bind:
                return this.parseBind();
            case CommandCode.describe:
            case CommandCode.close:
                return this.portalOp(type);
            case CommandCode.execute:
                return {
                    type,
                    portal: this.reader.cstring(),
                    rows: this.reader.uint32(),
                };
            case CommandCode.flush:
            case CommandCode.sync:
            case CommandCode.end:
            case CommandCode.copyDone:
                return { type }
            case CommandCode.query:
                return {
                    type,
                    query: this.reader.cstring(),
                };
            case CommandCode.copyFail:
                return {
                    type,
                    message: this.reader.cstring(),
                };
            case CommandCode.copyFromChunk:
                return {
                    type,
                    buffer: this.reader.bytes(length),
                };
            default:
                expectNever(type);
                throw new Error(`unknown command code: ${(type as any as number).toString(16)}`)
        }
    }

    valuesRead(): any[] {
        const len = this.reader.int16();
        const ret = Array(len);
        for (let i = 0; i < len; i++) {
            const type: ParamType = this.reader.int16();
            switch (type) {
                case ParamType.STRING:
                    const strLen = this.reader.int32();
                    if (strLen >= 0) {
                        ret[i] = this.reader.string(strLen);
                    } else {
                        ret[i] = null;
                    }
                    break;
                case ParamType.BINARY:
                    const bufLen = this.reader.int32();
                    ret[i] = this.reader.bytes(bufLen);;
                    break;
            }
        }
        return ret;
    }

    private parseInit(): DbCommand {

        // === PROTOCOL VERSION
        const major = this.reader.int16();
        const minor = this.reader.int16();
        if (major !== 3) {
            throw new Error(`Unsupported protocol version: ${major}.${minor}`);
        }

        // === OPTIONS
        const options: { [key: string]: string } = {};
        while (true) {
            const option = this.reader.cstring();
            if (!option) {
                break;
            }
            options[option] = this.reader.cstring();
        }
        return {
            type: CommandCode.init,
            version: { major, minor },
            options,
        };
    }

    private parseStartup(): DbCommand {
        const hash = this.reader.cstring();
        return {
            type: CommandCode.startup,
            md5: hash,
        };
    }

    private parseParse(): DbCommand {
        const queryName = this.reader.cstring();
        const query = this.reader.cstring();
        const len = this.reader.int16();
        const parameters: number[] = [];
        for (var i = 0; i < len; i++) {
            parameters.push(this.reader.int32());
        }
        return {
            type: CommandCode.parse,
            parameters,
            query,
            queryName,
        }
    }

    private parseBind(): DbCommand {
        const portal = this.reader.cstring();
        const statement = this.reader.cstring();
        const lenAgain = this.reader.int16(); /// ?? see serializer.ts:157
        const values = this.valuesRead();
        const binary = this.reader.int16() === ParamType.BINARY;
        return {
            type: CommandCode.bind,
            portal,
            statement,
            binary,
            values,
        }
    }

    private portalOp(type: CommandCode.describe | CommandCode.close): DbCommand {
        const description = this.reader.cstring();
        switch (description[0]) {
            case 'P':
            case 'S':
                break;
            default:
                throw new Error('Unknown description ' + description);
        }
        return {
            type,
            portalType: description[0],
            name: description.length > 1 ? description.substring(1) : undefined,
        };
    }

}



const enum ParamType {
    STRING = 0,
    BINARY = 1,
}