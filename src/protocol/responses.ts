import { Socket } from 'net';


/** Send low level responses to client */
export interface IResponseWriter {

  /** The underlying socket (connection to client) */
  readonly socket: Socket;

  command(cmd: DbResponse): void;

  authenticationOk(): void;
  readyForQuery(): void;
  bindComplete(): void;
  parseComplete(): void;
  closeComplete(): void;
  noData(): void;
  portalSuspended(): void;
  copyDone(): void;
  replicationStart(): void;
  emptyQuery(): void;
  error(message: string | Error | NoticeOrError): void;
  notice(message: string | NoticeOrError): void;
  dataRow(row: string[]): void;
  commandComplete(message: string): void;
  notificationResponse(pid: number, channel: string, payload: string): void;
  parameterStatus(name: string, value: string): void;
  backendKeyData(pid: number, secretKey: number): void;
  rowDescription(fieldDescs: FieldDesc[]): void;
  copyIn(isBinary: boolean, types: number[]): void;
  copyOut(isBinary: boolean, types: number[]): void;
  copyData(data: Buffer): void;
}

export enum ResponseCode {
  DataRow = 0x44, // D
  ParseComplete = 0x31, // 1
  BindComplete = 0x32, // 2
  CloseComplete = 0x33, // 3
  CommandComplete = 0x43, // C
  ReadyForQuery = 0x5a, // Z
  NoData = 0x6e, // n
  NotificationResponse = 0x41, // A
  AuthenticationResponse = 0x52, // R
  ParameterStatus = 0x53, // S
  BackendKeyData = 0x4b, // K
  ErrorMessage = 0x45, // E
  NoticeMessage = 0x4e, // N
  RowDescriptionMessage = 0x54, // T
  PortalSuspended = 0x73, // s
  ReplicationStart = 0x57, // W
  EmptyQuery = 0x49, // I
  CopyIn = 0x47, // G
  CopyOut = 0x48, // H
  CopyDone = 0x63, // c
  CopyData = 0x64, // d
}

const byId: any = {};
for (const [k, v] of Object.entries(ResponseCode)) {
  byId[v] = k;
}
export function messageToStr(code: ResponseCode) {
  return byId[code] ?? `<UNKOWN MESSAGE ${String.fromCharCode(code)} (0x${code.toString(16)})>`;
}


export declare type Mode = 'text' | 'binary';


export interface NoticeOrError {
  message?: string | undefined
  severity?: string | undefined
  code?: string | undefined
  detail?: string | undefined
  hint?: string | undefined
  position?: string | undefined
  internalPosition?: string | undefined
  internalQuery?: string | undefined
  where?: string | undefined
  schema?: string | undefined
  table?: string | undefined
  column?: string | undefined
  dataType?: string | undefined
  constraint?: string | undefined
  file?: string | undefined
  line?: string | undefined
  routine?: string | undefined
}

export type DbResponse = CodeOnlyResponse
  | ReadyForQueryResponse
  | CommandCompleteResponse
  | CopyDataResponse
  | CopyInOutResponse
  | NotificationResponse
  | RowDescriptionResponse
  | DataRowResponse
  | ParameterStatusResponse
  | AuthenticationResponse
  | BackendKeyDataResponse
  | NoticeOrErrorResponse;

export interface NoticeOrErrorResponse {
  type: ResponseCode.NoticeMessage | ResponseCode.ErrorMessage;
  message: NoticeOrError;
}

export type AuthenticationResponse = {
  type: ResponseCode.AuthenticationResponse;
  kind: 'ok';
} | {
  type: ResponseCode.AuthenticationResponse;
  kind: 'cleartextPassword';
} | {
  type: ResponseCode.AuthenticationResponse;
  kind: 'md5Password';
  salt: Buffer;
} | {
  type: ResponseCode.AuthenticationResponse;
  kind: 'SASL';
  mechanisms: string[]
} | {
  type: ResponseCode.AuthenticationResponse;
  kind: 'SASLContinue' | 'SASLFinal';
  data: string;
}

export interface BackendKeyDataResponse {
  type: ResponseCode.BackendKeyData;
  processID: number;
  secretKey: number;
}

export interface ParameterStatusResponse {
  type: ResponseCode.ParameterStatus;
  name: string;
  value: string;
}

export interface DataRowResponse {
  type: ResponseCode.DataRow;
  fields: (string | null)[]
}
export interface FieldDesc {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  mode: Mode;
}

export interface RowDescriptionResponse {
  type: ResponseCode.RowDescriptionMessage;
  fields: FieldDesc[];
}

export interface NotificationResponse {
  type: ResponseCode.NotificationResponse;
  processId: number;
  channel: string;
  payload: string;
}

export interface CopyInOutResponse {
  type: ResponseCode.CopyIn | ResponseCode.CopyOut;
  isBinary: boolean;
  columnTypes: number[];
}

export interface CopyDataResponse {
  type: ResponseCode.CopyData;
  data: Buffer;
}
export interface CommandCompleteResponse {
  type: ResponseCode.CommandComplete;
  text: string;
}
export interface ReadyForQueryResponse {
  type: ResponseCode.ReadyForQuery;
  status: string;
}


export interface CodeOnlyResponse {
  type: ResponseCode.BindComplete
  | ResponseCode.ParseComplete
  | ResponseCode.CloseComplete
  | ResponseCode.NoData
  | ResponseCode.PortalSuspended
  | ResponseCode.CopyDone
  | ResponseCode.ReplicationStart
  | ResponseCode.EmptyQuery;
};
