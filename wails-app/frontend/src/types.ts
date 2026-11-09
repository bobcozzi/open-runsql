// Shared result types mirroring wails-app/app.go bound structs.

export interface ColumnInfo {
    name: string;
    label: string;
    type: number;
    typeName: string;
    precision: number;
    scale: number;
    displaySize: number;
    nullable: boolean;
    autoIncrement: boolean;
    schemaName: string;
    tableName: string;
}

export interface SqlMessage {
    sqlState: string;
    vendorCode: number;
    message: string;
    secondLevelText?: string;
    kind?: "info" | "warning" | "error";
}

export interface SqlResult {
    kind: "rows" | "count" | "none" | "error";
    columns?: ColumnInfo[];
    rows?: unknown[][];
    cursorId?: string;
    more?: boolean;
    updateCount?: number;
    messages?: SqlMessage[];
    elapsedMs: number;
    error?: string;
}

export interface CLMessage {
    id: string;
    severity: number;
    type: number;
    typeName: string;
    text: string;
    secondLevelText?: string;
    kind: "info" | "warning" | "error";
}

export interface CLResult {
    kind: "cl";
    command: string;
    ok: boolean;
    messages: CLMessage[];
    elapsedMs: number;
}

export interface ConnectResponse {
    connectionId: string;
    databaseProduct: string;
    databaseVersion: string;
    driverName: string;
    driverVersion: string;
    host: string;
    user: string;
    serverJob?: string;
}

export interface CmdXmlResult {
    xml: string;
    bytes: number;
}

export interface SpooledFileRequest {
    connectionId: string;
    outqLib?: string;
    outq?: string;
    user?: string;
    allUsers?: boolean;
    allOutqs?: boolean;
}

export interface SpooledFileInfo {
    name: string;
    number: string;
    jobName: string;
    jobUser: string;
    jobNumber: string;
    userData: string;
    outqName: string;
    outqLib: string;
    createDate: string;
    createTime: string;
    pages: number;
    size: number;
    status: string;
    holdStatus: string;
    copies: number;
    printer: string;
    printerDevType: string;
    createdBy: string;
    priority: string;
    jobSystem: string;
    lpi: string;
}

export interface SpooledFileResult {
    kind: "spooledFiles";
    files: SpooledFileInfo[];
    openMs: number;
    iterateMs: number;
    elapsedMs: number;
}

export interface SpooledFileTarget {
    connectionId: string;
    name: string;
    number: string;
    jobName: string;
    jobUser: string;
    jobNumber: string;
}

export interface SpooledFileActionResult {
    ok: boolean;
    message: string;
    elapsedMs: number;
}

export interface SpooledFileDataResult {
    kind: string;
    format: string;
    bytes: number;
    base64: string;
    elapsedMs: number;
}

export interface OutputQueueInfo {
    name: string;
    library: string;
    description: string;
}

export interface OutputQueueListResult {
    queues: OutputQueueInfo[];
    elapsedMs: number;
}

export interface ConnectionProfile {
    name: string;
    host: string;
    user: string;
    defaultSchema?: string;
    naming?: string;
    tls: boolean;
    savePassword?: boolean;
    passwordB64?: string;
    lastUsedAt?: number;
    pinnedAt?: number;
}

export interface AppSettings {
    spoolDownloadDir?: string;
    fetchSize?: number;
    autoOpenDownloads?: boolean; // legacy; superseded by spoolDblClickAction
    spoolDblClickAction?: "" | "view" | "dlPdf" | "dlText" | "print"; // "" = view
    defaultNaming?: "" | "sql" | "system"; // "" = sql
    spoolMaxRows?: number; // 0/undefined = unlimited
    confirmSpoolDelete?: boolean; // undefined = on
}

// Wails v3: the App service is exposed via generated bindings
// (frontend/bindings/.../wails-app/app.js). App() returns the module.
import * as appBindings from "../bindings/github.com/BobCozzi/open-runsql/wails-app/app.js";

export interface AppBinding {
    Connect(req: unknown): Promise<ConnectResponse>;
    Disconnect(connectionId: string): Promise<void>;
    CancelSQL(connectionId: string): Promise<void>;
    Run(req: { connectionId: string; text: string; fetchSize: number }): Promise<SqlResult | CLResult>;
    Fetch(req: { connectionId: string; cursorId: string; fetchSize: number }): Promise<SqlResult>;
    GetCmdXml(req: { connectionId: string; command: string; library?: string }): Promise<CmdXmlResult>;
    ListSpooledFiles(req: SpooledFileRequest): Promise<SpooledFileResult>;
    SpooledFileAction(req: SpooledFileTarget & { action: string }): Promise<SpooledFileActionResult>;
    MoveSpooledFile(req: SpooledFileTarget & { toLibrary: string; toQueue: string; holdFirst: boolean }): Promise<SpooledFileActionResult>;
    ListOutputQueues(req: { connectionId: string; nameFilter: string; libraryFilter: string; limit: number }): Promise<OutputQueueListResult>;
    GetSpooledFileData(req: SpooledFileTarget & { format: string }): Promise<SpooledFileDataResult>;
    SaveSpooledFile(filename: string, base64Data: string): Promise<string>;
    PrintSpooledFile(filename: string, base64Data: string): Promise<string>;
    OpenSpooledFile(path: string): Promise<void>;
    GetAppSettings(): Promise<AppSettings>;
    SetSpoolDownloadDir(dir: string): Promise<void>;
    SetAppSetting(key: string, value: string): Promise<void>;
    OpenSpoolDownloadDir(): Promise<void>;
    PickDirectory(title: string): Promise<string>;
    ListConnectionProfiles(): Promise<ConnectionProfile[]>;
    SaveConnectionProfile(p: ConnectionProfile): Promise<void>;
    UpdateConnectionProfile(origName: string, p: ConnectionProfile): Promise<void>;
    DeleteConnectionProfile(name: string): Promise<void>;
    MoveConnectionProfileToTop(name: string): Promise<void>;
    DetachConnection(connectionId: string, title: string): Promise<void>;
    AttachConnection(connectionId: string): Promise<void>;
    ListDetached(): Promise<string[]>;
    GetWorkspace(connectionId: string): Promise<unknown>;
    ListWorkspaces(): Promise<unknown[]>;
    UpdateEditorText(connectionId: string, text: string): Promise<void>;
    UpdateMessagesHTML(connectionId: string, html: string): Promise<void>;
    UpdateStatusText(connectionId: string, text: string): Promise<void>;
    DetachedConnectionID(): Promise<string>;
    Version(): Promise<string>;
}

export function App(): AppBinding {
    return appBindings as unknown as AppBinding;
}
