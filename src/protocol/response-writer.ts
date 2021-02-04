import { Socket } from 'net';
import { Writer } from './buffer-writer';
import { messageToStr, ResponseCode, DbResponse, NoticeOrError, FieldDesc, IResponseWriter } from './responses';
import { assertNever, isDebug, nullish } from '../utils';
import util from 'util';

export class ResponseWriter implements IResponseWriter {
    private writer = new Writer();
    constructor(readonly socket: Socket) {
    }
    private flush(code: ResponseCode) {
        const buf = this.writer.flush(code);
        if (isDebug) {
            if (code !== ResponseCode.ErrorMessage) {
                console.log(`  ✈ `, messageToStr(code));
            }
        }
        this.socket.write(buf);
    }

    bindComplete(): void { this.codeOnly(ResponseCode.BindComplete); }
    parseComplete(): void { this.codeOnly(ResponseCode.ParseComplete); }
    closeComplete(): void { this.codeOnly(ResponseCode.CloseComplete); }
    noData(): void { this.codeOnly(ResponseCode.NoData); }
    portalSuspended(): void { this.codeOnly(ResponseCode.PortalSuspended); }
    copyDone(): void { this.codeOnly(ResponseCode.CopyDone); }
    replicationStart(): void { this.codeOnly(ResponseCode.ReplicationStart); }
    emptyQuery(): void { this.codeOnly(ResponseCode.EmptyQuery); }


    readyForQuery(status?: string) {
        this.writer.addString(status?.[0] ?? 'I');
        return this.flush(ResponseCode.ReadyForQuery);
    }


    private codeOnly(code: ResponseCode.BindComplete
        | ResponseCode.ParseComplete
        | ResponseCode.CloseComplete
        | ResponseCode.NoData
        | ResponseCode.PortalSuspended
        | ResponseCode.CopyDone
        | ResponseCode.ReplicationStart
        | ResponseCode.EmptyQuery) {
        return this.flush(code);
    }


    dataRow(row: (string | null)[]) {
        this.writer.addInt16(row.length);
        for (const r of row) {
            if (nullish(r)) {
                this.writer.addInt16(-1);
            } else {
                this.writer.addInt32(r!.length);
                this.writer.addString(r!);
            }
        }
        return this.flush(ResponseCode.DataRow);
    }

    command(cmd: DbResponse): void {
        switch (cmd.type) {
            case ResponseCode.BackendKeyData:
                return this.backendKeyData(cmd.processID, cmd.secretKey);
            case ResponseCode.BindComplete:
                return this.bindComplete();
            case ResponseCode.CloseComplete:
                return this.closeComplete();
            case ResponseCode.CommandComplete:
                return this.commandComplete(cmd.text);
            case ResponseCode.CopyData:
                return this.copyData(cmd.data);
            case ResponseCode.CopyDone:
                return this.copyDone();
            case ResponseCode.CopyIn:
                return this.copyIn(cmd.isBinary, cmd.columnTypes);
            case ResponseCode.CopyOut:
                return this.copyOut(cmd.isBinary, cmd.columnTypes);
            case ResponseCode.DataRow:
                return this.dataRow(cmd.fields);
            case ResponseCode.EmptyQuery:
                return this.emptyQuery();
            case ResponseCode.ErrorMessage:
                return this.error(cmd.message);
            case ResponseCode.NoData:
                return this.noData();
            case ResponseCode.NoticeMessage:
                return this.notice(cmd.message);
            case ResponseCode.NotificationResponse:
                return this.notificationResponse(cmd.processId, cmd.channel, cmd.payload);
            case ResponseCode.ParameterStatus:
                return this.parameterStatus(cmd.name, cmd.value);
            case ResponseCode.ParseComplete:
                return this.parseComplete();
            case ResponseCode.PortalSuspended:
                return this.portalSuspended();
            case ResponseCode.ReadyForQuery:
                return this.readyForQuery(cmd.status);
            case ResponseCode.ReplicationStart:
                return this.replicationStart();
            case ResponseCode.RowDescriptionMessage:
                return this.rowDescription(cmd.fields);
            case ResponseCode.AuthenticationResponse:
                if (cmd.kind === 'ok') {
                    return this.authenticationOk();
                }
                throw new Error('Command has no writer: ' + messageToStr(cmd.type));
            default:
                assertNever(cmd);
        }
    }

    commandComplete(message: string) {
        this.writer.addCString(message);
        return this.flush(ResponseCode.CommandComplete);
    }

    notificationResponse(pid: number, channel: string, payload: string) {
        this.writer.addInt32(pid);
        this.writer.addCString(channel);
        this.writer.addCString(payload);
        return this.flush(ResponseCode.NotificationResponse);
    }

    parameterStatus(name: string, value: string) {
        this.writer.addCString(name);
        this.writer.addCString(value);
        return this.flush(ResponseCode.ParameterStatus);
    }

    backendKeyData(pid: number, secretKey: number) {
        this.writer.addInt32(pid);
        this.writer.addInt32(secretKey);
        return this.flush(ResponseCode.BackendKeyData);
    }

    error(error: string | Error | NoticeOrError) {
        this.errorMessage(error, ResponseCode.ErrorMessage);
    }
    notice(error: string | NoticeOrError) {
        this.errorMessage(error, ResponseCode.NoticeMessage);
    }

    private errorMessage(error: string | Error | NoticeOrError, code: ResponseCode.ErrorMessage | ResponseCode.NoticeMessage) {
        error = error instanceof Error
            ? util.inspect(error)
            : error;
        error = typeof error === 'string'
            ? { message: error }
            : error;
        if (isDebug) {
            console.warn(`  ✈⚠ `, error.message);
        }
        // https://www.postgresql.org/docs/12/protocol-error-fields.html
        for (const [k, v] of Object.entries(error)) {
            const mk = noticeMapping[k];
            if (mk && typeof v === 'string' && v) {
                this.writer.addString(mk[0]);
                this.writer.addCString(v);
            }
        }
        this.writer.addString('\0');
        return this.flush(code);
    }

    rowDescription(fieldDescs: FieldDesc[]) {
        this.writer.addInt16(fieldDescs.length);
        for (const f of fieldDescs) {
            this.writer.addCString(f.name)
            this.writer.addInt32(f.tableID)
            this.writer.addInt16(f.columnID)
            this.writer.addInt32(f.dataTypeID)
            this.writer.addInt16(f.dataTypeSize)
            this.writer.addInt32(f.dataTypeModifier);
            this.writer.addInt16(f.mode === 'text' ? 0 : 1);
        }
        return this.flush(ResponseCode.RowDescriptionMessage);
    }


    copyIn(isBinary: boolean, types: number[]): void { this.copyMessage(isBinary, types, ResponseCode.CopyIn) }
    copyOut(isBinary: boolean, types: number[]): void { this.copyMessage(isBinary, types, ResponseCode.CopyOut) }
    private copyMessage(isBinary: boolean, types: number[], code: ResponseCode.CopyIn | ResponseCode.CopyOut) {
        this.writer.byte(isBinary ? 1 : 0);
        this.writer.addInt16(types.length);
        for (const t of types) {
            this.writer.addInt16(t);
        }
        return this.flush(code);
    }

    copyData(data: Buffer) {
        this.writer.add(data);
        return this.flush(ResponseCode.CopyData);
    }


    authenticationOk() {
        this.writer.addInt32(0);
        return this.flush(ResponseCode.AuthenticationResponse);
    }
}


const noticeMapping: Record<string, string> = {
    'message': 'M',
    'severity': 'S',
    'code': 'C',
    'detail': 'D',
    'hint': 'H',
    'position': 'P',
    'internalPosition': 'p',
    'internalQuery': 'q',
    'where': 'W',
    'schema': 's',
    'table': 't',
    'column': 'c',
    'dataType': 'd',
    'constraint': 'n',
    'file': 'F',
    'line': 'L',
    'routine': 'R',
}
