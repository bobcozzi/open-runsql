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
}

// Wails-bound App facade.
export interface AppBinding {
    Connect(req: unknown): Promise<ConnectResponse>;
    Disconnect(connectionId: string): Promise<void>;
    CancelSQL(connectionId: string): Promise<void>;
    Run(req: { connectionId: string; text: string; fetchSize: number }): Promise<SqlResult | CLResult>;
    Fetch(req: { connectionId: string; cursorId: string; fetchSize: number }): Promise<SqlResult>;
    GetCmdXml(req: { connectionId: string; command: string; library?: string }): Promise<CmdXmlResult>;
    ListConnectionProfiles(): Promise<ConnectionProfile[]>;
    SaveConnectionProfile(p: ConnectionProfile): Promise<void>;
    DeleteConnectionProfile(name: string): Promise<void>;
    Version(): Promise<string>;
}

declare global {
    interface Window {
        go?: { main?: { App?: AppBinding } };
    }
}

export function App(): AppBinding | undefined {
    return window.go?.main?.App;
}
