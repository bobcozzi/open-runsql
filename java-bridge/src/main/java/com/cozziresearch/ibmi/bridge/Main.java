package com.cozziresearch.ibmi.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.ibm.as400.access.AS400;
import com.ibm.as400.access.AS400Message;
import com.ibm.as400.access.Command;
import com.ibm.as400.access.CommandCall;
import com.ibm.as400.access.SecureAS400;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

/**
 * JSON-lines JDBC bridge. stdout is reserved for protocol responses.
 * Each request is dispatched independently; response writes are serialized.
 */
public final class Main {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, Session> SESSIONS = new ConcurrentHashMap<>();
    private static final ExecutorService REQUESTS = Executors.newCachedThreadPool();
    private static final Object OUTPUT_LOCK = new Object();
    private static final AtomicBoolean STOPPING = new AtomicBoolean(false);

    public static void main(String[] args) throws Exception {
        Class.forName("com.ibm.as400.access.AS400JDBCDriver");
        try (BufferedReader in = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while (!STOPPING.get() && (line = in.readLine()) != null) {
                final String requestLine = line;
                REQUESTS.submit(() -> handleLine(requestLine));
            }
        } finally {
            shutdownAll();
            REQUESTS.shutdown();
            REQUESTS.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    private static void handleLine(String line) {
        JsonNode req;
        String id = "";
        try {
            req = JSON.readTree(line);
            id = text(req, "id", "");
            ObjectNode response = dispatch(req);
            response.put("id", id);
            write(response);
        } catch (Throwable t) {
            ObjectNode response = JSON.createObjectNode();
            response.put("id", id);
            response.put("ok", false);
            response.set("error", errorNode(t));
            write(response);
        }
    }

    private static ObjectNode dispatch(JsonNode r) throws Exception {
        String op = text(r, "op", "");
        ObjectNode out = JSON.createObjectNode();
        out.put("ok", true);

        switch (op) {
            case "connect" -> {
                String host = required(r, "host");
                String user = required(r, "user");
                String password = required(r, "password");
                boolean tls = r.path("tls").asBoolean(false);
                String naming = text(r, "naming", "sql").toLowerCase(Locale.ROOT);
                if (!naming.equals("sql") && !naming.equals("system"))
                    throw new IllegalArgumentException("naming must be 'sql' or 'system'");

                String url = "jdbc:as400://" + host + ";prompt=false;naming=" + naming
                        // Extended metadata: resolve column headings/labels fully.
                        + ";extended metadata=true;metadata source=-1";
                if (tls) url += ";secure=true";

                Properties props = new Properties();
                props.setProperty("user", user);
                props.setProperty("password", password);
                int timeout = r.path("timeoutSeconds").asInt(30);
                DriverManager.setLoginTimeout(Math.max(1, timeout));

                Connection c = DriverManager.getConnection(url, props);
                c.setAutoCommit(true);

                String schema = text(r, "defaultSchema", "");
                if (!schema.isBlank()) {
                    try (Statement st = c.createStatement()) {
                        st.execute("SET SCHEMA " + quoteIdentifier(schema));
                    }
                }

                String connectionId = UUID.randomUUID().toString();
                char[] passwordChars = password.toCharArray();
                AS400 clSystem = tls
                        ? new SecureAS400(host, user, passwordChars)
                        : new AS400(host, user, passwordChars);
                clSystem.setGuiAvailable(false);
                Session s = new Session(c, clSystem);
                SESSIONS.put(connectionId, s);
                out.put("connectionId", connectionId);
                out.put("databaseProduct", c.getMetaData().getDatabaseProductName());
                out.put("databaseVersion", c.getMetaData().getDatabaseProductVersion());
                out.put("driverName", c.getMetaData().getDriverName());
                out.put("driverVersion", c.getMetaData().getDriverVersion());
                out.put("autoCommit", c.getAutoCommit());
                // IBM i server job (e.g. "709180/QUSER/QZDASOINIT") for ACS-style logging
                if (c instanceof com.ibm.as400.access.AS400JDBCConnection jc) {
                    try {
                        out.put("serverJob", nullToEmpty(jc.getServerJobIdentifier()));
                    } catch (Exception ignored) {}
                }
            }
            case "disconnect" -> {
                Session s = session(r);
                closeSession(s);
                SESSIONS.remove(text(r, "connectionId", ""));
            }
            case "executeSQL" -> {
                Session s = session(r);
                out.set("result", execute(s, required(r, "sql"), r.path("fetchSize").asInt(200)));
            }
            case "fetchRows" -> {
                Session s = session(r);
                out.set("result", fetch(s, required(r, "cursorId"), r.path("fetchSize").asInt(200)));
            }
            case "cancelSQL" -> {
                Session s = session(r);
                Statement active = s.activeStatement;
                if (active != null) {
                    try { active.cancel(); out.put("cancelRequested", true); }
                    catch (SQLException e) { out.put("cancelRequested", false); out.set("error", sqlError(e)); }
                } else out.put("cancelRequested", false);
            }
            case "executeCL" -> {
                Session s = session(r);
                out.set("result", executeCL(s, required(r, "command")));
            }
            case "getCmdXml" -> {
                Session s = session(r);
                out.set("result", getCmdXml(s, required(r, "command"), text(r, "library", "")));
            }
            case "commit" -> { Session s = session(r); s.lock.lock(); try { s.connection.commit(); } finally { s.lock.unlock(); } }
            case "rollback" -> { Session s = session(r); s.lock.lock(); try { s.connection.rollback(); } finally { s.lock.unlock(); } }
            case "setAutoCommit" -> {
                Session s = session(r);
                s.lock.lock();
                try { s.connection.setAutoCommit(r.path("autoCommit").asBoolean(true)); }
                finally { s.lock.unlock(); }
            }
            case "getConnectionInfo" -> {
                Session s = session(r);
                DatabaseMetaData m = s.connection.getMetaData();
                out.put("databaseProduct", m.getDatabaseProductName());
                out.put("databaseVersion", m.getDatabaseProductVersion());
                out.put("driverName", m.getDriverName());
                out.put("driverVersion", m.getDriverVersion());
                out.put("autoCommit", s.connection.getAutoCommit());
                out.put("closed", s.connection.isClosed());
            }
            case "shutdown" -> {
                shutdownAll();
                STOPPING.set(true);
            }
            default -> throw new IllegalArgumentException("Unknown operation: " + op);
        }
        return out;
    }

    private static ObjectNode execute(Session s, String sql, int requestedFetchSize) throws Exception {
        s.lock.lock();
        long started = System.nanoTime();
        try {
            closeCursor(s, null); // one active result cursor per connection in this starter
            Statement st = s.connection.createStatement(
                    ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY);
            st.setFetchSize(clampFetch(requestedFetchSize));
            s.activeStatement = st;
            boolean hasResult = st.execute(sql);
            ObjectNode result;
            if (hasResult) {
                ResultSet rs = st.getResultSet();
                String cursorId = UUID.randomUUID().toString();
                Cursor cursor = new Cursor(st, rs);
                s.cursors.put(cursorId, cursor);
                result = readBatch(cursor, clampFetch(requestedFetchSize));
                result.put("cursorId", cursorId);
                result.put("more", cursor.more);
                if (!cursor.more) closeCursor(s, cursorId);
            } else {
                int count = st.getUpdateCount();
                result = JSON.createObjectNode();
                result.put("kind", count >= 0 ? "count" : "none");
                if (count >= 0) result.put("updateCount", count);
                result.set("columns", JSON.createArrayNode());
                result.set("rows", JSON.createArrayNode());
                result.put("more", false);
                st.close();
                s.activeStatement = null;
            }
            result.put("elapsedMs", elapsedMs(started));
            return result;
        } catch (SQLException e) {
            if (s.activeStatement != null) {
                try { s.activeStatement.close(); } catch (SQLException ignored) {}
                s.activeStatement = null;
            }
            return sqlErrorResult(s, e, started);
        } finally {
            s.lock.unlock();
        }
    }

    private static ObjectNode executeCL(Session s, String command) {
        long started = System.nanoTime();
        CommandCall call = new CommandCall(s.clSystem);
        ObjectNode result = JSON.createObjectNode();
        result.put("kind", "cl");
        boolean ok;
        String failure = null;
        try {
            ok = call.run(command);
        } catch (Throwable t) {
            ok = false;
            failure = t.getMessage();
        }
        ArrayNode messages = JSON.createArrayNode();
        if (failure != null) {
            ObjectNode m = JSON.createObjectNode();
            m.put("id", "");
            m.put("severity", 40);
            m.put("type", AS400Message.ESCAPE);
            m.put("typeName", "*ESCAPE");
            m.put("text", nullToEmpty(failure));
            messages.add(m);
        }
        for (AS400Message msg : call.getMessageList()) {
            ObjectNode m = JSON.createObjectNode();
            m.put("id", nullToEmpty(msg.getID()));
            m.put("severity", msg.getSeverity());
            m.put("type", msg.getType());
            m.put("typeName", clMessageTypeName(msg.getType()));
            m.put("text", nullToEmpty(msg.getText()));
            // getHelp() loads second-level text from the message file (host round trip).
            String help = "";
            try { help = msg.getHelp(); } catch (Throwable ignored) {}
            m.put("secondLevelText", nullToEmpty(help));
            messages.add(m);
        }
        result.put("ok", ok);
        result.set("messages", messages);
        result.put("elapsedMs", elapsedMs(started));
        return result;
    }

    private static ObjectNode getCmdXml(Session s, String command, String library) throws Exception {
        long started = System.nanoTime();
        String path = library == null || library.isBlank()
                ? "/QSYS.LIB/" + command.toUpperCase(Locale.ROOT) + ".CMD"
                : "/QSYS.LIB/" + library.toUpperCase(Locale.ROOT) + ".LIB/"
                    + command.toUpperCase(Locale.ROOT) + ".CMD";
        // getXMLExtended() = QCDRCMDD CMDD0200 (dependency and choice-program detail).
        String xml = new Command(s.clSystem, path).getXMLExtended();
        ObjectNode result = JSON.createObjectNode();
        result.put("kind", "cmdxml");
        result.put("xml", xml);
        result.put("bytes", xml.getBytes(StandardCharsets.UTF_8).length);
        result.put("elapsedMs", elapsedMs(started));
        return result;
    }

    private static String clMessageTypeName(int type) {
        // IBM i message type names (per the *MSGTYPE values returned by list APIs).
        return switch (type) {
            case AS400Message.COMPLETION -> "*COMP";
            case AS400Message.DIAGNOSTIC -> "*DIAG";
            case AS400Message.INFORMATIONAL -> "*INFO";
            case AS400Message.INQUIRY -> "*INQ";
            case AS400Message.SENDERS_COPY -> "*COPY";
            case AS400Message.REQUEST -> "*RQS";
            case AS400Message.REQUEST_WITH_PROMPTING -> "*RQSPMT";
            case AS400Message.NOTIFY -> "*NOTIFY";
            case AS400Message.ESCAPE -> "*ESCAPE";
            case AS400Message.NOTIFY_NOT_HANDLED -> "*NOTIFYNH";
            case AS400Message.ESCAPE_NOT_HANDLED -> "*ESCAPENH";
            case AS400Message.REPLY_NOT_VALIDITY_CHECKED,
                 AS400Message.REPLY_VALIDITY_CHECKED,
                 AS400Message.REPLY_MESSAGE_DEFAULT_USED,
                 AS400Message.REPLY_SYSTEM_DEFAULT_USED,
                 AS400Message.REPLY_FROM_SYSTEM_REPLY_LIST -> "*RPY";
            case 26 -> "*RPYEXIT";
            default -> "*OTHER(" + type + ")";
        };
    }

    private static ObjectNode fetch(Session s, String cursorId, int requestedFetchSize) throws Exception {
        s.lock.lock();
        long started = System.nanoTime();
        try {
            Cursor c = s.cursors.get(cursorId);
            if (c == null) throw new IllegalArgumentException("Unknown or expired cursor: " + cursorId);
            ObjectNode result = readBatch(c, clampFetch(requestedFetchSize));
            result.put("cursorId", cursorId);
            result.put("more", c.more);
            result.put("elapsedMs", elapsedMs(started));
            if (!c.more) closeCursor(s, cursorId);
            return result;
        } catch (SQLException e) {
            return sqlErrorResult(s, e, started);
        } finally {
            s.lock.unlock();
        }
    }

    private static ObjectNode readBatch(Cursor c, int fetchSize) throws SQLException {
        ResultSet rs = c.resultSet;
        ResultSetMetaData md = rs.getMetaData();
        ObjectNode out = JSON.createObjectNode();
        out.put("kind", "rows");
        ArrayNode columns = JSON.createArrayNode();
        if (!c.metadataSent) {
            for (int i = 1; i <= md.getColumnCount(); i++) {
                ObjectNode col = JSON.createObjectNode();
                col.put("name", nullToEmpty(md.getColumnName(i)));
                col.put("label", nullToEmpty(md.getColumnLabel(i)));
                col.put("type", md.getColumnType(i));
                col.put("typeName", nullToEmpty(md.getColumnTypeName(i)));
                col.put("precision", md.getPrecision(i));
                col.put("scale", md.getScale(i));
                col.put("displaySize", md.getColumnDisplaySize(i));
                col.put("nullable", md.isNullable(i) != ResultSetMetaData.columnNoNulls);
                col.put("autoIncrement", md.isAutoIncrement(i));
                col.put("schemaName", nullToEmpty(md.getSchemaName(i)));
                col.put("tableName", nullToEmpty(md.getTableName(i)));
                columns.add(col);
            }
            c.metadataSent = true;
            c.columns = columns;
        }
        out.set("columns", c.columns.deepCopy());
        ArrayNode rows = JSON.createArrayNode();
        int count = 0;
        while (count < fetchSize && rs.next()) {
            ArrayNode row = JSON.createArrayNode();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                Object value = rs.getObject(i);
                row.add(valueNode(value));
            }
            rows.add(row);
            count++;
        }
        c.more = !rs.isAfterLast();
        // Some drivers do not reliably implement isAfterLast for forward-only cursors.
        if (count < fetchSize) c.more = false;
        out.set("rows", rows);
        return out;
    }

    private static com.fasterxml.jackson.databind.JsonNode valueNode(Object value) {
        if (value == null) return JSON.getNodeFactory().nullNode();
        if (value instanceof byte[] b) return JSON.getNodeFactory().binaryNode(b);
        // Canonical text forms keep date/time values stable for sorting and display.
        if (value instanceof java.sql.Timestamp ts) return JSON.getNodeFactory().textNode(ts.toString());
        if (value instanceof java.sql.Date d) return JSON.getNodeFactory().textNode(d.toString());
        if (value instanceof java.sql.Time t) return JSON.getNodeFactory().textNode(t.toString());
        // Exact decimal text avoids double rounding for NUMERIC/DECIMAL/DECFLOAT.
        if (value instanceof java.math.BigDecimal bd) return JSON.getNodeFactory().textNode(bd.toPlainString());
        if (value instanceof Blob blob) {
            try {
                long len = blob.length();
                if (len > 1_000_000) return JSON.getNodeFactory().textNode("[BLOB " + len + " bytes]");
                return JSON.getNodeFactory().binaryNode(blob.getBytes(1, (int) len));
            } catch (SQLException e) { return JSON.getNodeFactory().textNode("[BLOB read error]"); }
        }
        if (value instanceof Clob clob) {
            try {
                long len = clob.length();
                if (len > 1_000_000) return JSON.getNodeFactory().textNode("[CLOB " + len + " chars]");
                return JSON.getNodeFactory().textNode(clob.getSubString(1, (int) len));
            } catch (SQLException e) { return JSON.getNodeFactory().textNode("[CLOB read error]"); }
        }
        if (value instanceof Number || value instanceof Boolean || value instanceof CharSequence) {
            return JSON.valueToTree(value);
        }
        return JSON.getNodeFactory().textNode(String.valueOf(value));
    }

    private static ObjectNode sqlErrorResult(Session s, SQLException e, long started) {
        ObjectNode out = JSON.createObjectNode();
        out.put("kind", "error");
        out.set("columns", JSON.createArrayNode());
        out.set("rows", JSON.createArrayNode());
        ArrayNode messages = JSON.createArrayNode();
        SQLException x = e;
        while (x != null) {
            ObjectNode m = sqlError(x);
            String help = sqlMessageHelp(s, nullToEmpty(x.getMessage()));
            if (!help.isEmpty()) m.put("secondLevelText", help);
            messages.add(m);
            x = x.getNextException();
        }
        out.set("messages", messages);
        out.put("elapsedMs", elapsedMs(started));
        return out;
    }

    // IBM i SQL/CPF message IDs (SQL0204, CPF9801, ...) can be resolved to
    // message-file second-level text, same as CL messages. Best effort: any
    // failure (no ID in text, host unreachable, no authority) yields "".
    private static String sqlMessageHelp(Session s, String messageText) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\\b(SQL\\d{4}|CPF\\d{4}|CPD\\d{4})\\b").matcher(messageText);
        if (!m.find() || s == null || s.clSystem == null) return "";
        String id = m.group(1);
        String msgf = id.startsWith("SQL") ? "/QSYS.LIB/QSQLMSG.MSGF" : "/QSYS.LIB/QCPFMSG.MSGF";
        try {
            AS400Message msg = new com.ibm.as400.access.MessageFile(s.clSystem, msgf).getMessage(id);
            return msg == null ? "" : nullToEmpty(msg.getHelp());
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static ObjectNode sqlError(SQLException e) {
        ObjectNode n = JSON.createObjectNode();
        n.put("sqlState", nullToEmpty(e.getSQLState()));
        n.put("vendorCode", e.getErrorCode());
        n.put("message", nullToEmpty(e.getMessage()));
        return n;
    }

    private static ObjectNode errorNode(Throwable t) {
        ObjectNode n = JSON.createObjectNode();
        if (t instanceof SQLException e) {
            n.put("type", "SQLException");
            n.put("sqlState", nullToEmpty(e.getSQLState()));
            n.put("vendorCode", e.getErrorCode());
        } else n.put("type", t.getClass().getSimpleName());
        n.put("message", nullToEmpty(t.getMessage()));
        return n;
    }

    private static Session session(JsonNode r) {
        String id = required(r, "connectionId");
        Session s = SESSIONS.get(id);
        if (s == null) throw new IllegalArgumentException("Unknown connectionId: " + id);
        return s;
    }

    private static void closeCursor(Session s, String cursorId) {
        if (cursorId == null) {
            for (String id : new ArrayList<>(s.cursors.keySet())) closeCursor(s, id);
            return;
        }
        Cursor c = s.cursors.remove(cursorId);
        if (c != null) {
            try { c.resultSet.close(); } catch (Exception ignored) {}
            try { c.statement.close(); } catch (Exception ignored) {}
            if (s.activeStatement == c.statement) s.activeStatement = null;
        }
    }

    private static void closeSession(Session s) {
        s.lock.lock();
        try {
            closeCursor(s, null);
            if (s.activeStatement != null) {
                try { s.activeStatement.close(); } catch (Exception ignored) {}
                s.activeStatement = null;
            }
            try { s.connection.close(); } catch (Exception ignored) {}
            try { s.clSystem.disconnectAllServices(); } catch (Exception ignored) {}
        } finally { s.lock.unlock(); }
    }

    private static void shutdownAll() {
        for (Session s : SESSIONS.values()) closeSession(s);
        SESSIONS.clear();
    }

    private static String required(JsonNode n, String field) {
        String v = text(n, field, "");
        if (v.isBlank()) throw new IllegalArgumentException("Missing required field: " + field);
        return v;
    }
    private static String text(JsonNode n, String field, String fallback) {
        JsonNode v = n.get(field);
        return v == null || v.isNull() ? fallback : v.asText(fallback);
    }
    private static String quoteIdentifier(String s) { return "\"" + s.replace("\"", "\"\"") + "\""; }
    private static String nullToEmpty(String s) { return s == null ? "" : s; }
    private static int clampFetch(int n) { return Math.max(1, Math.min(n, 5000)); }
    private static long elapsedMs(long start) { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start); }

    private static void write(ObjectNode response) {
        synchronized (OUTPUT_LOCK) {
            try {
                System.out.println(JSON.writeValueAsString(response));
                System.out.flush();
            } catch (Exception e) {
                System.err.println("Could not write protocol response: " + e);
            }
        }
    }

    private static final class Session {
        final Connection connection;
        final AS400 clSystem;
        final ReentrantLock lock = new ReentrantLock();
        final Map<String, Cursor> cursors = new ConcurrentHashMap<>();
        volatile Statement activeStatement;
        Session(Connection c, AS400 clSystem) { connection = c; this.clSystem = clSystem; }
    }
    private static final class Cursor {
        final Statement statement;
        final ResultSet resultSet;
        volatile boolean more = true;
        boolean metadataSent = false;
        ArrayNode columns;
        Cursor(Statement st, ResultSet rs) { statement = st; resultSet = rs; }
    }
}
