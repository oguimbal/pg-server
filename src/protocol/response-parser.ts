import { TransformOptions } from 'stream'
import { BufferReader } from './buffer-reader'
import { DbResponse, FieldDesc, ResponseCode, Mode, NoticeOrError } from './responses'

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


export type DbRawResponse = {
    response: DbResponse;
    /** Get raw data associated with this response (if you plan to forward it) */
    getRawData: () => Buffer;
}


export type MessageCallback = (msg: DbRawResponse, getRawData?: () => Buffer) => void

export class DbResponseParser {
    private buffer: Buffer = emptyBuffer;
    private bufferLength: number = 0
    private bufferOffset: number = 0
    private reader = new BufferReader()
    private mode: Mode

    constructor(opts?: StreamOptions) {
        if (opts?.mode === 'binary') {
            throw new Error('Binary mode not supported yet')
        }
        this.mode = opts?.mode || 'text'
    }

    private process(callback: MessageCallback, response: DbResponse, offset: number, len: number) {

        let callingback = true;
        let thisData: Buffer;
        callback({
            response,
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

    public parse(buffer: Buffer, callback: MessageCallback) {
        this.mergeBuffer(buffer)
        const bufferFullLength = this.bufferOffset + this.bufferLength
        let offset = this.bufferOffset
        while (offset + HEADER_LENGTH <= bufferFullLength) {
            // code is 1 byte long - it identifies the message type
            const code = this.buffer[offset]
            // length is 1 Uint32BE - it is the length of the message EXCLUDING the code
            const length = this.buffer.readUInt32BE(offset + CODE_LENGTH)
            const fullMessageLength = CODE_LENGTH + length
            if (fullMessageLength + offset <= bufferFullLength) {
                const message = this.handlePacket(offset + HEADER_LENGTH, code, length, this.buffer)
                this.process(callback, message, offset, fullMessageLength)
                offset += fullMessageLength
            } else {
                break
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

    private handlePacket(offset: number, type: number, length: number, bytes: Buffer): DbResponse {
        switch (type) {
            case ResponseCode.BindComplete:
            case ResponseCode.ParseComplete:
            case ResponseCode.CloseComplete:
            case ResponseCode.NoData:
            case ResponseCode.PortalSuspended:
            case ResponseCode.CopyDone:
            case ResponseCode.ReplicationStart:
            case ResponseCode.EmptyQuery:
                return { type }
            case ResponseCode.DataRow:
                return this.parseDataRowMessage(offset, length, bytes)
            case ResponseCode.CommandComplete:
                return this.parseCommandCompleteMessage(offset, length, bytes)
            case ResponseCode.ReadyForQuery:
                return this.parseReadyForQueryMessage(offset, length, bytes)
            case ResponseCode.NotificationResponse:
                return this.parseNotificationMessage(offset, length, bytes)
            case ResponseCode.AuthenticationResponse:
                return this.parseAuthenticationResponse(offset, length, bytes)
            case ResponseCode.ParameterStatus:
                return this.parseParameterStatusMessage(offset, length, bytes)
            case ResponseCode.BackendKeyData:
                return this.parseBackendKeyData(offset, length, bytes)
            case ResponseCode.ErrorMessage:
                return this.parseErrorMessage(offset, length, bytes, ResponseCode.ErrorMessage)
            case ResponseCode.NoticeMessage:
                return this.parseErrorMessage(offset, length, bytes, ResponseCode.NoticeMessage)
            case ResponseCode.RowDescriptionMessage:
                return this.parseRowDescriptionMessage(offset, length, bytes)
            case ResponseCode.CopyIn:
            case ResponseCode.CopyOut:
                return this.parseCopyMessage(offset, length, bytes, type)
            case ResponseCode.CopyData:
                return this.parseCopyData(offset, length, bytes)
            default:
                throw new Error(`unknown message code: 0x${type.toString(16)}`);
        }
    }

    private parseReadyForQueryMessage(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const status = this.reader.string(1)
        return {
            type: ResponseCode.ReadyForQuery,
            status,
        }
    }

    private parseCommandCompleteMessage(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const text = this.reader.cstring()
        return {
            type: ResponseCode.CommandComplete,
            text,
        }
    }

    private parseCopyData(offset: number, length: number, bytes: Buffer): DbResponse {
        const data = bytes.slice(offset, offset + (length - 4))
        return {
            type: ResponseCode.CopyData,
            data,
        }
    }


    private parseCopyMessage(offset: number, length: number, bytes: Buffer, type: ResponseCode.CopyIn | ResponseCode.CopyOut): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const isBinary = this.reader.byte() !== 0
        const columnCount = this.reader.int16()
        const columnTypes: number[] = Array(columnCount);
        for (let i = 0; i < columnCount; i++) {
            columnTypes[i] = this.reader.int16()
        }
        return {
            type,
            columnTypes,
            isBinary,
        }
    }

    private parseNotificationMessage(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const processId = this.reader.int32()
        const channel = this.reader.cstring()
        const payload = this.reader.cstring()
        return {
            type: ResponseCode.NotificationResponse,
            processId,
            channel,
            payload
        };
    }

    private parseRowDescriptionMessage(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const fieldCount = this.reader.int16()
        const fields: FieldDesc[] = Array(fieldCount);
        for (let i = 0; i < fieldCount; i++) {
            fields[i] = this.parseField()
        }
        return {
            type: ResponseCode.RowDescriptionMessage,
            fields,
        }
    }

    private parseField(): FieldDesc {
        const name = this.reader.cstring()
        const tableID = this.reader.int32()
        const columnID = this.reader.int16()
        const dataTypeID = this.reader.int32()
        const dataTypeSize = this.reader.int16()
        const dataTypeModifier = this.reader.int32()
        const mode = this.reader.int16() === 0 ? 'text' : 'binary'
        return { name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode };
    }

    private parseDataRowMessage(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const fieldCount = this.reader.int16()
        const fields: (string | null)[] = new Array(fieldCount)
        for (let i = 0; i < fieldCount; i++) {
            const len = this.reader.int32()
            // a -1 for length means the value of the field is null
            fields[i] = len === -1 ? null : this.reader.string(len)
        }
        return {
            type: ResponseCode.DataRow,
            fields,
        }
    }

    private parseParameterStatusMessage(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const name = this.reader.cstring()
        const value = this.reader.cstring()
        return {
            type: ResponseCode.ParameterStatus,
            name,
            value
        }
    }

    private parseBackendKeyData(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const processID = this.reader.int32()
        const secretKey = this.reader.int32()
        return {
            type: ResponseCode.BackendKeyData,
            processID,
            secretKey
        }
    }

    public parseAuthenticationResponse(offset: number, length: number, bytes: Buffer): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const code = this.reader.int32()

        const ret = { type: ResponseCode.AuthenticationResponse as const };

        switch (code) {
            case 0: // AuthenticationOk
                return { ...ret, kind: 'ok' };
            case 3: // AuthenticationCleartextPassword
                if (length === 8) {
                    return { ...ret, kind: 'cleartextPassword' };
                }
                return { ...ret, kind: 'ok' };
            case 5: // AuthenticationMD5Password
                if (length === 12) {
                    const salt = this.reader.bytes(4)
                    return { ...ret, salt, kind: 'md5Password' };
                }
                return { ...ret, kind: 'ok' };
            case 10: // AuthenticationSASL

                const mechanisms: string[] = []
                let mechanism: string
                do {
                    mechanism = this.reader.cstring()
                    if (mechanism) {
                        mechanisms.push(mechanism)
                    }
                } while (mechanism)
                return { ...ret, mechanisms, kind: 'SASL' }
            case 11: // AuthenticationSASLContinue
                return { ...ret, data: this.reader.string(length - 8), kind: 'SASLContinue' }
            case 12: // AuthenticationSASLFinal
                return { ...ret, data: this.reader.string(length - 8), kind: 'SASLFinal' }
            default:
                throw new Error('Unknown authenticationOk message type ' + code)
        }
    }

    private parseErrorMessage(offset: number, length: number, bytes: Buffer, type: ResponseCode.NoticeMessage | ResponseCode.ErrorMessage): DbResponse {
        this.reader.setBuffer(offset, bytes)
        const fields: Record<string, string> = {}
        let fieldType = this.reader.string(1)
        while (fieldType !== '\0') {
            fields[fieldType] = this.reader.cstring()
            fieldType = this.reader.string(1)
        }


        const message: NoticeOrError = {
            message: fields.M,
            severity: fields.S,
            code: fields.C,
            detail: fields.D,
            hint: fields.H,
            position: fields.P,
            internalPosition: fields.p,
            internalQuery: fields.q,
            where: fields.W,
            schema: fields.s,
            table: fields.t,
            column: fields.c,
            dataType: fields.d,
            constraint: fields.n,
            file: fields.F,
            line: fields.L,
            routine: fields.R,
        };
        return { message, type };
    }
}
