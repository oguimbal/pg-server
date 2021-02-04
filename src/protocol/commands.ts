export interface IProxiedServer {
    /** Sends a raw buffer to server */
    sendRaw(raw: Buffer): void;

    /** Just forward the statement */
    send(command: DbCommand): void;
}

export type DbCommand
    = Init
    | Parse
    | Bind
    | StartupMD5
    | PortalOp
    | CopyFail
    | CopyFromChunk
    | Execute
    | Query
    | CodeOnlyCommand;

// See https://github.com/brianc/node-postgres/blob/master/packages/pg-protocol/src/serializer.ts
export enum CommandCode {
    init = 0,
    startup = 0x70, // p
    query = 0x51, // Q
    parse = 0x50, // P
    bind = 0x42, // B
    execute = 0x45, // E
    flush = 0x48, // H
    sync = 0x53, // S
    end = 0x58, // X
    close = 0x43, // C
    describe = 0x44, // D
    copyFromChunk = 0x64, // d
    copyDone = 0x63, // c
    copyFail = 0x66, // f
}


export interface Init {
    type: CommandCode.init;
    version: { minor: number; major: number };
    options: { [key: string]: string };
}

export interface StartupMD5 {
    type: CommandCode.startup;
    md5: string;
}

export interface Parse {
    type: CommandCode.parse,
    queryName: string;
    query: string;
    parameters: number[];
}

export interface Bind {
    type: CommandCode.bind,
    portal: string;
    statement: string;
    values: any[];
    binary: boolean;
}

export interface PortalOp {
    type: CommandCode.describe | CommandCode.close,
    portalType: 'P' | 'S';
    name?: string;
}

export interface Execute {
    type: CommandCode.execute,
    portal: string;
    rows: number;
}

export interface CodeOnlyCommand {
    type: CommandCode.flush | CommandCode.sync | CommandCode.end | CommandCode.copyDone;
}
export interface Query {
    type: CommandCode.query,
    query: string;
}

export interface CopyFail {
    type: CommandCode.copyFail;
    message: string;
}

export interface CopyFromChunk {
    type: CommandCode.copyFromChunk;
    buffer: Buffer;
}


const byId: any = {};
for (const [k, v] of Object.entries(CommandCode)) {
    byId[v] = k;
}
export function commandToStr(code: CommandCode) {
    return byId[code] ?? `<UNKOWN COMMAND ${String.fromCharCode(code)} (0x${code.toString(16)})>`;
}
