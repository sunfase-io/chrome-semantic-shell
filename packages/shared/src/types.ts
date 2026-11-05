export enum NativeMessageType {
  START = 'start',
  STOP = 'stop',
  ERROR = 'error',
  CALL_TOOL = 'call_tool',
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
}

export interface NativeMessage<P = unknown, E = unknown> {
  type?: NativeMessageType;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}
