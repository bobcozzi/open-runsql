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

// A frozen, retained result set pinned in the Results pane. Static — never
// re-queried; renamed/closed by the user.
export interface PinnedResult {
    id: string;
    label: string;
    columns: ColumnInfo[];
    rows: unknown[][];
    /** The SQL statement that produced the set (shown in the pop-out window). */
    sql?: string;
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
    maxRows?: number;
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
    deviceType: string;
    createdBy: string;
    priority: string;
    jobSystem: string;
    lpi: string;
}

export interface SpooledFileResult {
    kind: "spooledFiles";
    files: SpooledFileInfo[];
    truncated: boolean;
    cancelled: boolean;
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
    deviceType?: string;
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
    /** format="image": per-page image payloads (base64) + content type, or
     * errorCode "imageTransformUnavailable" when the host lacks HPT/QWPGIF. */
    contentType?: string;
    pages?: string[];
    pageCount?: number;
    errorCode?: string;
    message?: string;
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
    /** JT400 "bidi string type" for Arabic/Hebrew hosts; "" = driver default. */
    bidiStringType?: string;
    savePassword?: boolean;
    preloadSpool?: boolean; // undefined = on
    saveScript?: boolean; // undefined = on ("Save SQL/CL script between sessions")
    script?: string; // SQL/CL text saved with the profile
    sessionScript?: string;
    passwordB64?: string;
    lastUsedAt?: number;
    pinnedAt?: number;
    sortOrder?: number;
}

export interface AppSettings {
    spoolDownloadDir?: string;
    scriptsDir?: string;
    fetchSize?: number;
    autoOpenDownloads?: boolean; // legacy; superseded by spoolDblClickAction
    spoolDblClickAction?: "" | "view" | "dlPdf" | "dlText" | "print"; // "" = view
    defaultNaming?: "" | "sql" | "system"; // "" = sql
    excelColumnHeading?: "" | "fieldName" | "columnHeading";
    excelDateFormat?: "" | "locale" | "iso" | "us" | "eu";
    excelTimeFormat?: "" | "locale" | "24h" | "12h";
    excelTimestampFormat?: "" | "locale" | "iso" | "us" | "eu" | "ibmi" | "ibmiDot";
    spoolMaxRows?: number; // 0/undefined = unlimited
    confirmSpoolDelete?: boolean; // undefined = on
    ctrlEnterRun?: boolean; // undefined/false = off (Ctrl/Cmd+Enter runs current statement)
    // Connection-tab label format: userHost (default) | nameHost | nameUserHost
    // | nameUser | hostUser | name.
    connTabLabel?: "" | "userHost" | "nameHost" | "nameUserHost" | "nameUser" | "hostUser" | "name";
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
    CancelSpoolList(connectionId: string): Promise<void>;
    SpooledFileAction(req: SpooledFileTarget & { action: string }): Promise<SpooledFileActionResult>;
    MoveSpooledFile(req: SpooledFileTarget & { toLibrary: string; toQueue: string; holdFirst: boolean }): Promise<SpooledFileActionResult>;
    ListOutputQueues(req: { connectionId: string; nameFilter: string; libraryFilter: string; limit: number }): Promise<OutputQueueListResult>;
    GetSpooledFileData(req: SpooledFileTarget & { format: string }): Promise<SpooledFileDataResult>;
    SaveSpooledFile(filename: string, base64Data: string): Promise<string>;
    SaveFileAs(filename: string, base64Data: string, filterLabel: string, filterPattern: string): Promise<string>;
    SaveXLSXAs(filename: string, columns: ColumnInfo[], rows: unknown[][]): Promise<string>;
    SaveConnectionSessionScript(host: string, user: string, script: string): Promise<void>;
    OpenFileAs(filterLabel: string, filterPattern: string): Promise<string>;
    PrintSpooledFile(filename: string, base64Data: string): Promise<string>;
    OpenSpooledFile(path: string): Promise<void>;
    ListStatementHistory(connectionId: string): Promise<{ text: string; at: number }[]>;
    AddStatementHistory(connectionId: string, text: string): Promise<{ text: string; at: number }[]>;
    DeleteStatementHistory(connectionId: string, index: number): Promise<{ text: string; at: number }[]>;
    GetAppSettings(): Promise<AppSettings>;
    SetSpoolDownloadDir(dir: string): Promise<void>;
    SetAppSetting(key: string, value: string): Promise<void>;
    OpenSpoolDownloadDir(): Promise<void>;
    PickDirectory(title: string): Promise<string>;
    ListConnectionProfiles(): Promise<ConnectionProfile[]>;
    SaveConnectionProfile(p: ConnectionProfile): Promise<void>;
    GetProfilePassword(name: string): Promise<string>;
    UpdateConnectionProfile(origName: string, p: ConnectionProfile): Promise<void>;
    ReorderConnectionProfiles(names: string[]): Promise<void>;
    DeleteConnectionProfile(name: string): Promise<void>;
    MoveConnectionProfileToTop(name: string): Promise<void>;
    DetachConnection(connectionId: string, title: string): Promise<void>;
    AttachConnection(connectionId: string): Promise<void>;
    ListDetached(): Promise<string[]>;
    GetWorkspace(connectionId: string): Promise<unknown>;
    ListWorkspaces(): Promise<unknown[]>;
    GetConnectionIdentity(connectionId: string): Promise<{ host: string; user: string }>;
    UpdateEditorText(connectionId: string, text: string): Promise<void>;
    SetInitialEditorText(connectionId: string, text: string): Promise<void>;
    UpdateMessagesHTML(connectionId: string, html: string): Promise<void>;
    UpdateStatusText(connectionId: string, text: string): Promise<void>;
    UpdatePinnedResults(connectionId: string, pinned: PinnedResult[]): Promise<void>;
    OpenPinnedWindow(connectionId: string, pinId: string, title: string): Promise<void>;
    CloseAllPinnedWindows(): Promise<void>;
    ClosePinnedWindowsFor(connectionId: string): Promise<void>;
    DetachedConnectionID(): Promise<string>;
    Version(): Promise<string>;
}

export function App(): AppBinding {
    return appBindings as unknown as AppBinding;
}
