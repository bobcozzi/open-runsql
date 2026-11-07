package com.cozziresearch.ibmi.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.ibm.as400.access.AS400Message;

/**
 * Unit tests for the JSON-lines bridge. All tests run without IBM i
 * infrastructure: private static helpers are exercised via reflection,
 * protocol error paths via {@code handleLine} with captured stdout, and
 * {@code readBatch} via dynamic-proxy JDBC ResultSet/ResultSetMetaData.
 */
class MainTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Invokes a private static method on Main, unwrapping the real cause. */
    private static Object call(String name, Class<?>[] sig, Object... args) throws Throwable {
        Method m = Main.class.getDeclaredMethod(name, sig);
        m.setAccessible(true);
        try {
            return m.invoke(null, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }

    private static JsonNode json(String text) throws Exception {
        return MAPPER.readTree(text);
    }

    // --- clMessageTypeName -------------------------------------------------

    @Test
    void clMessageTypeNameMapsAllKnownTypes() throws Throwable {
        Class<?>[] sig = { int.class };
        assertEquals("*COMP", call("clMessageTypeName", sig, AS400Message.COMPLETION));
        assertEquals("*DIAG", call("clMessageTypeName", sig, AS400Message.DIAGNOSTIC));
        assertEquals("*INFO", call("clMessageTypeName", sig, AS400Message.INFORMATIONAL));
        assertEquals("*INQ", call("clMessageTypeName", sig, AS400Message.INQUIRY));
        assertEquals("*COPY", call("clMessageTypeName", sig, AS400Message.SENDERS_COPY));
        assertEquals("*RQS", call("clMessageTypeName", sig, AS400Message.REQUEST));
        assertEquals("*RQSPMT", call("clMessageTypeName", sig, AS400Message.REQUEST_WITH_PROMPTING));
        assertEquals("*NOTIFY", call("clMessageTypeName", sig, AS400Message.NOTIFY));
        assertEquals("*ESCAPE", call("clMessageTypeName", sig, AS400Message.ESCAPE));
        assertEquals("*NOTIFYNH", call("clMessageTypeName", sig, AS400Message.NOTIFY_NOT_HANDLED));
        assertEquals("*ESCAPENH", call("clMessageTypeName", sig, AS400Message.ESCAPE_NOT_HANDLED));
        assertEquals("*RPY", call("clMessageTypeName", sig, AS400Message.REPLY_NOT_VALIDITY_CHECKED));
        assertEquals("*RPY", call("clMessageTypeName", sig, AS400Message.REPLY_VALIDITY_CHECKED));
        assertEquals("*RPY", call("clMessageTypeName", sig, AS400Message.REPLY_MESSAGE_DEFAULT_USED));
        assertEquals("*RPY", call("clMessageTypeName", sig, AS400Message.REPLY_SYSTEM_DEFAULT_USED));
        assertEquals("*RPY", call("clMessageTypeName", sig, AS400Message.REPLY_FROM_SYSTEM_REPLY_LIST));
        assertEquals("*RPYEXIT", call("clMessageTypeName", sig, 26));
        assertEquals("*OTHER(999)", call("clMessageTypeName", sig, 999));
    }

    // --- valueNode ---------------------------------------------------------

    private static JsonNode valueNode(Object value) throws Throwable {
        return (JsonNode) call("valueNode", new Class<?>[] { Object.class }, value);
    }

    @Test
    void valueNodeMapsNull() throws Throwable {
        assertTrue(valueNode(null).isNull());
    }

    @Test
    void valueNodeMapsByteArrayToBinary() throws Throwable {
        byte[] bytes = { 1, 2, 3 };
        JsonNode node = valueNode(bytes);
        assertTrue(node.isBinary());
        assertEquals(3, node.binaryValue().length);
    }

    @Test
    void valueNodeMapsTemporalTypesToCanonicalText() throws Throwable {
        java.sql.Timestamp ts = java.sql.Timestamp.valueOf("2024-01-02 03:04:05.123456");
        assertEquals(ts.toString(), valueNode(ts).asText());
        assertEquals("2024-01-02", valueNode(java.sql.Date.valueOf("2024-01-02")).asText());
        assertEquals("03:04:05", valueNode(java.sql.Time.valueOf("03:04:05")).asText());
    }

    @Test
    void valueNodeMapsBigDecimalToExactPlainText() throws Throwable {
        // Trailing zeros must survive: NUMERIC/DECIMAL exactness is a bridge contract.
        assertEquals("123.4500", valueNode(new java.math.BigDecimal("123.4500")).asText());
    }

    @Test
    void valueNodeMapsPrimitivesAndStrings() throws Throwable {
        assertEquals(42, valueNode(42).asInt());
        assertTrue(valueNode(Boolean.TRUE).asBoolean());
        assertEquals("hello", valueNode("hello").asText());
    }

    @Test
    void valueNodeFallsBackToToStringForUnknownTypes() throws Throwable {
        Object custom = new Object() {
            @Override
            public String toString() {
                return "custom-thing";
            }
        };
        assertEquals("custom-thing", valueNode(custom).asText());
    }

    private static Blob fakeBlob(long length, byte[] content, boolean failOnRead) {
        InvocationHandler h = (proxy, method, args) -> switch (method.getName()) {
            case "length" -> {
                if (failOnRead) throw new SQLException("no lob");
                yield length;
            }
            case "getBytes" -> content;
            default -> throw new UnsupportedOperationException(method.getName());
        };
        return (Blob) Proxy.newProxyInstance(MainTest.class.getClassLoader(), new Class<?>[] { Blob.class }, h);
    }

    private static Clob fakeClob(long length, String content, boolean failOnRead) {
        InvocationHandler h = (proxy, method, args) -> switch (method.getName()) {
            case "length" -> {
                if (failOnRead) throw new SQLException("no lob");
                yield length;
            }
            case "getSubString" -> content;
            default -> throw new UnsupportedOperationException(method.getName());
        };
        return (Clob) Proxy.newProxyInstance(MainTest.class.getClassLoader(), new Class<?>[] { Clob.class }, h);
    }

    @Test
    void valueNodeMapsSmallBlobToBinary() throws Throwable {
        JsonNode node = valueNode(fakeBlob(3L, new byte[] { 9, 8, 7 }, false));
        assertTrue(node.isBinary());
        assertEquals(3, node.binaryValue().length);
    }

    @Test
    void valueNodeSummarizesLargeBlob() throws Throwable {
        assertEquals("[BLOB 2000000 bytes]", valueNode(fakeBlob(2_000_000L, null, false)).asText());
    }

    @Test
    void valueNodeReportsBlobReadError() throws Throwable {
        assertEquals("[BLOB read error]", valueNode(fakeBlob(0L, null, true)).asText());
    }

    @Test
    void valueNodeMapsSmallClobToText() throws Throwable {
        assertEquals("lob text", valueNode(fakeClob(8L, "lob text", false)).asText());
    }

    @Test
    void valueNodeSummarizesLargeClob() throws Throwable {
        assertEquals("[CLOB 2000000 chars]", valueNode(fakeClob(2_000_000L, null, false)).asText());
    }

    @Test
    void valueNodeReportsClobReadError() throws Throwable {
        assertEquals("[CLOB read error]", valueNode(fakeClob(0L, null, true)).asText());
    }

    // --- SQL / error node helpers ------------------------------------------

    @Test
    void sqlErrorMapsStateCodeAndMessage() throws Throwable {
        ObjectNode node = (ObjectNode) call("sqlError", new Class<?>[] { SQLException.class },
                new SQLException("db boom", "42000", 123));
        assertEquals("42000", node.get("sqlState").asText());
        assertEquals(123, node.get("vendorCode").asInt());
        assertEquals("db boom", node.get("message").asText());
    }

    @Test
    void sqlErrorMapsNullsToEmptyStrings() throws Throwable {
        ObjectNode node = (ObjectNode) call("sqlError", new Class<?>[] { SQLException.class },
                new SQLException(null, null, 0));
        assertEquals("", node.get("sqlState").asText());
        assertEquals("", node.get("message").asText());
    }

    @Test
    void sqlErrorResultFollowsExceptionChain() throws Throwable {
        SQLException first = new SQLException("first", "42000", 1);
        first.setNextException(new SQLException("second", "HY000", 2));
        ObjectNode out = (ObjectNode) call("sqlErrorResult", new Class<?>[] { sessionClass(), SQLException.class, long.class },
                null, first, System.nanoTime());
        assertEquals("error", out.get("kind").asText());
        assertTrue(out.get("columns").isEmpty());
        assertTrue(out.get("rows").isEmpty());
        ArrayNode messages = (ArrayNode) out.get("messages");
        assertEquals(2, messages.size());
        assertEquals("first", messages.get(0).get("message").asText());
        assertEquals("second", messages.get(1).get("message").asText());
        assertTrue(out.get("elapsedMs").asLong() >= 0);
    }

    @Test
    void errorNodeSpecializesSqlExceptions() throws Throwable {
        ObjectNode node = (ObjectNode) call("errorNode", new Class<?>[] { Throwable.class },
                new SQLException("db boom", "42000", 123));
        assertEquals("SQLException", node.get("type").asText());
        assertEquals("42000", node.get("sqlState").asText());
        assertEquals(123, node.get("vendorCode").asInt());
    }

    @Test
    void errorNodeHandlesGenericThrowables() throws Throwable {
        ObjectNode node = (ObjectNode) call("errorNode", new Class<?>[] { Throwable.class },
                new IllegalStateException("oops"));
        assertEquals("IllegalStateException", node.get("type").asText());
        assertFalse(node.has("sqlState"));
        assertEquals("oops", node.get("message").asText());
    }

    @Test
    void errorNodeMapsNullMessageToEmpty() throws Throwable {
        ObjectNode node = (ObjectNode) call("errorNode", new Class<?>[] { Throwable.class },
                new RuntimeException((String) null));
        assertEquals("", node.get("message").asText());
    }

    // --- small string/int helpers ------------------------------------------

    @Test
    void requiredReturnsPresentField() throws Throwable {
        assertEquals("x", call("required", new Class<?>[] { JsonNode.class, String.class }, json("{\"a\":\"x\"}"), "a"));
    }

    @Test
    void requiredRejectsMissingAndBlankFields() throws Exception {
        Class<?>[] sig = { JsonNode.class, String.class };
        JsonNode missing = json("{\"a\":\"x\"}");
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> call("required", sig, missing, "b"));
        assertTrue(e.getMessage().contains("b"));
        JsonNode blank = json("{\"a\":\"  \"}");
        assertThrows(IllegalArgumentException.class, () -> call("required", sig, blank, "a"));
    }

    @Test
    void textFallsBackOnMissingAndNullFields() throws Throwable {
        Class<?>[] sig = { JsonNode.class, String.class, String.class };
        JsonNode node = json("{\"a\":null}");
        assertEquals("fb", call("text", sig, node, "a", "fb"));
        assertEquals("fb", call("text", sig, node, "missing", "fb"));
        assertEquals("v", call("text", sig, json("{\"a\":\"v\"}"), "a", "fb"));
    }

    @Test
    void quoteIdentifierDoublesEmbeddedQuotes() throws Throwable {
        Class<?>[] sig = { String.class };
        assertEquals("\"ABC\"", call("quoteIdentifier", sig, "ABC"));
        assertEquals("\"A\"\"B\"", call("quoteIdentifier", sig, "A\"B"));
    }

    @Test
    void nullToEmptyMapsNullOnly() throws Throwable {
        Class<?>[] sig = { String.class };
        assertEquals("", call("nullToEmpty", sig, new String[] { null }));
        assertEquals("x", call("nullToEmpty", sig, "x"));
    }

    @Test
    void clampFetchEnforcesBounds() throws Throwable {
        Class<?>[] sig = { int.class };
        assertEquals(1, call("clampFetch", sig, 0));
        assertEquals(1, call("clampFetch", sig, -10));
        assertEquals(200, call("clampFetch", sig, 200));
        assertEquals(5000, call("clampFetch", sig, 5000));
        assertEquals(5000, call("clampFetch", sig, Integer.MAX_VALUE));
    }

    @Test
    void elapsedMsIsNonNegative() throws Throwable {
        long result = (long) call("elapsedMs", new Class<?>[] { long.class }, System.nanoTime());
        assertTrue(result >= 0 && result < 60_000);
    }

    // --- protocol error paths via handleLine -------------------------------

    private static JsonNode handleLineCapture(String line) throws Throwable {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        PrintStream original = System.out;
        System.setOut(new PrintStream(buf, true, StandardCharsets.UTF_8));
        try {
            call("handleLine", new Class<?>[] { String.class }, line);
        } finally {
            System.setOut(original);
        }
        String out = buf.toString(StandardCharsets.UTF_8).trim();
        assertFalse(out.isEmpty(), "expected a protocol response on stdout");
        return MAPPER.readTree(out);
    }

    @Test
    void handleLineReportsInvalidJson() throws Throwable {
        JsonNode resp = handleLineCapture("this is not json");
        assertFalse(resp.get("ok").asBoolean());
        assertEquals("", resp.get("id").asText());
        assertNotNull(resp.get("error"));
    }

    @Test
    void handleLineRejectsUnknownOperation() throws Throwable {
        JsonNode resp = handleLineCapture("{\"id\":\"1\",\"op\":\"wat\"}");
        assertFalse(resp.get("ok").asBoolean());
        assertEquals("1", resp.get("id").asText());
        assertTrue(resp.get("error").get("message").asText().contains("Unknown operation"));
    }

    @Test
    void handleLineRejectsConnectWithoutHost() throws Throwable {
        JsonNode resp = handleLineCapture("{\"id\":\"2\",\"op\":\"connect\",\"user\":\"u\",\"password\":\"p\"}");
        assertFalse(resp.get("ok").asBoolean());
        assertTrue(resp.get("error").get("message").asText().contains("host"));
    }

    @Test
    void handleLineRejectsInvalidNamingBeforeAnyNetworkUse() throws Throwable {
        JsonNode resp = handleLineCapture(
                "{\"id\":\"3\",\"op\":\"connect\",\"host\":\"h\",\"user\":\"u\",\"password\":\"p\",\"naming\":\"bogus\"}");
        assertFalse(resp.get("ok").asBoolean());
        assertTrue(resp.get("error").get("message").asText().contains("naming"));
    }

    @Test
    void handleLineRejectsUnknownConnectionId() throws Throwable {
        JsonNode resp = handleLineCapture("{\"id\":\"4\",\"op\":\"disconnect\",\"connectionId\":\"no-such-conn\"}");
        assertFalse(resp.get("ok").asBoolean());
        assertTrue(resp.get("error").get("message").asText().contains("Unknown connectionId"));
    }

    // --- readBatch with proxy JDBC objects ----------------------------------

    private static ResultSet fakeResultSet(String[] columns, Object[][] data) {
        ResultSetMetaData md = (ResultSetMetaData) Proxy.newProxyInstance(
                MainTest.class.getClassLoader(), new Class<?>[] { ResultSetMetaData.class },
                (proxy, method, args) -> switch (method.getName()) {
                    case "getColumnCount" -> columns.length;
                    case "getColumnName" -> columns[(int) args[0] - 1];
                    case "getColumnLabel" -> "Label " + columns[(int) args[0] - 1];
                    case "getColumnType" -> Types.VARCHAR;
                    case "getColumnTypeName" -> "VARCHAR";
                    case "getPrecision", "getColumnDisplaySize" -> 20;
                    case "getScale" -> 0;
                    case "isNullable" -> ResultSetMetaData.columnNullable;
                    case "isAutoIncrement" -> false;
                    case "getSchemaName" -> "TESTSCHEMA";
                    case "getTableName" -> "TESTTABLE";
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        int[] pos = { 0 };
        return (ResultSet) Proxy.newProxyInstance(
                MainTest.class.getClassLoader(), new Class<?>[] { ResultSet.class },
                (proxy, method, args) -> switch (method.getName()) {
                    case "getMetaData" -> md;
                    case "next" -> {
                        if (pos[0] < data.length) {
                            pos[0]++;
                            yield true;
                        }
                        yield false;
                    }
                    case "getObject" -> data[pos[0] - 1][(int) args[0] - 1];
                    case "isAfterLast" -> pos[0] >= data.length;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
    }

    private static Object newCursor(ResultSet rs) throws Exception {
        Class<?> cursorClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Cursor");
        Constructor<?> ctor = cursorClass.getDeclaredConstructor(Statement.class, ResultSet.class);
        ctor.setAccessible(true);
        return ctor.newInstance(null, rs);
    }

    private static ObjectNode readBatch(Object cursor, int fetchSize) throws Throwable {
        Class<?> cursorClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Cursor");
        return (ObjectNode) call("readBatch", new Class<?>[] { cursorClass, int.class }, cursor, fetchSize);
    }

    private static boolean cursorFlag(Object cursor, String field) throws Exception {
        Class<?> cursorClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Cursor");
        var f = cursorClass.getDeclaredField(field);
        f.setAccessible(true);
        return f.getBoolean(cursor);
    }

    @Test
    void readBatchReadsRowsAndSendsMetadataOnce() throws Throwable {
        String[] columns = { "ID", "NAME" };
        Object[][] data = { { 1, "a" }, { 2, "b" } };
        Object cursor = newCursor(fakeResultSet(columns, data));

        ObjectNode first = readBatch(cursor, 200);
        assertEquals("rows", first.get("kind").asText());
        assertEquals(2, first.get("rows").size());
        assertEquals(1, first.get("rows").get(0).get(0).asInt());
        assertEquals("a", first.get("rows").get(0).get(1).asText());

        ArrayNode cols = (ArrayNode) first.get("columns");
        assertEquals(2, cols.size());
        assertEquals("ID", cols.get(0).get("name").asText());
        assertEquals("Label ID", cols.get(0).get("label").asText());
        assertEquals("VARCHAR", cols.get(0).get("typeName").asText());
        assertEquals("TESTSCHEMA", cols.get(0).get("schemaName").asText());
        assertEquals("TESTTABLE", cols.get(0).get("tableName").asText());
        assertTrue(cols.get(0).get("nullable").asBoolean());
        assertFalse(cols.get(0).get("autoIncrement").asBoolean());

        assertTrue(cursorFlag(cursor, "metadataSent"));
        assertFalse(cursorFlag(cursor, "more"), "short final batch must clear the more flag");

        ObjectNode second = readBatch(cursor, 200);
        assertEquals(first.get("columns"), second.get("columns"), "metadata must be reused, not rebuilt");
    }

    @Test
    void readBatchReportsMoreWhenBatchIsFull() throws Throwable {
        String[] columns = { "ID" };
        Object[][] data = { { 1 }, { 2 } };
        Object cursor = newCursor(fakeResultSet(columns, data));

        ObjectNode batch = readBatch(cursor, 1);
        assertEquals(1, batch.get("rows").size());
        assertTrue(cursorFlag(cursor, "more"), "a full batch with remaining rows must keep the more flag");
    }

    // --- JDBC-backed paths with proxy connections ---------------------------

    private static Class<?> sessionClass() throws ClassNotFoundException {
        return Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
    }

    private static Connection fakeConnection(Statement statement) {
        java.sql.DatabaseMetaData md = (java.sql.DatabaseMetaData) Proxy.newProxyInstance(
                MainTest.class.getClassLoader(), new Class<?>[] { java.sql.DatabaseMetaData.class },
                (proxy, method, args) -> switch (method.getName()) {
                    case "getDatabaseProductName" -> "DB2 for IBM i";
                    case "getDatabaseProductVersion" -> "V7R5M0";
                    case "getDriverName" -> "IBM Toolbox for Java JDBC Driver";
                    case "getDriverVersion" -> "21.0.7";
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        return (Connection) Proxy.newProxyInstance(
                MainTest.class.getClassLoader(), new Class<?>[] { Connection.class },
                (proxy, method, args) -> switch (method.getName()) {
                    case "createStatement" -> statement;
                    case "getMetaData" -> md;
                    case "getAutoCommit" -> true;
                    case "isClosed" -> false;
                    case "commit", "rollback", "setAutoCommit", "close" -> null;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
    }

    /** A Statement whose execute() yields the given ResultSet, an update count, or a failure. */
    private static Statement fakeStatement(ResultSet rs, int updateCount, SQLException failOnExecute) {
        return (Statement) Proxy.newProxyInstance(
                MainTest.class.getClassLoader(), new Class<?>[] { Statement.class },
                (proxy, method, args) -> switch (method.getName()) {
                    case "execute" -> {
                        if (failOnExecute != null) throw failOnExecute;
                        yield rs != null;
                    }
                    case "getResultSet" -> rs;
                    case "getUpdateCount" -> updateCount;
                    case "setFetchSize", "setQueryTimeout", "close", "cancel" -> null;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
    }

    private static Object newSession(Connection conn) throws Exception {
        Constructor<?> ctor = sessionClass().getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class);
        ctor.setAccessible(true);
        // An unconnected AS400 object is inert: no services start until connect().
        return ctor.newInstance(conn, new com.ibm.as400.access.AS400());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cursorsOf(Object session) throws Exception {
        var f = sessionClass().getDeclaredField("cursors");
        f.setAccessible(true);
        return (Map<String, Object>) f.get(session);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sessions() throws Exception {
        var f = Main.class.getDeclaredField("SESSIONS");
        f.setAccessible(true);
        return (Map<String, Object>) f.get(null);
    }

    @Test
    void executeReturnsRowsAndClosesShortCursor() throws Throwable {
        ResultSet rs = fakeResultSet(new String[] { "ID" }, new Object[][] { { 1 }, { 2 } });
        Object session = newSession(fakeConnection(fakeStatement(rs, -1, null)));
        ObjectNode result = (ObjectNode) call("execute",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "select id from t", 200);
        assertEquals("rows", result.get("kind").asText());
        assertEquals(2, result.get("rows").size());
        assertFalse(result.get("more").asBoolean(), "short batch must report no more rows");
        assertTrue(result.get("cursorId").asText().length() > 0);
        assertTrue(cursorsOf(session).isEmpty(), "exhausted cursor must be closed");
    }

    @Test
    void executeKeepsCursorOpenWhenMoreRowsRemain() throws Throwable {
        ResultSet rs = fakeResultSet(new String[] { "ID" }, new Object[][] { { 1 }, { 2 } });
        Object session = newSession(fakeConnection(fakeStatement(rs, -1, null)));
        ObjectNode result = (ObjectNode) call("execute",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "select id from t", 1);
        assertTrue(result.get("more").asBoolean());
        assertTrue(cursorsOf(session).containsKey(result.get("cursorId").asText()));
    }

    @Test
    void executeReportsUpdateCount() throws Throwable {
        Object session = newSession(fakeConnection(fakeStatement(null, 5, null)));
        ObjectNode result = (ObjectNode) call("execute",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "update t set x = 1", 200);
        assertEquals("count", result.get("kind").asText());
        assertEquals(5, result.get("updateCount").asInt());
        assertTrue(result.get("columns").isEmpty());
        assertTrue(result.get("rows").isEmpty());
    }

    @Test
    void executeTurnsSqlFailureIntoErrorResult() throws Throwable {
        SQLException boom = new SQLException("bad sql", "42000", 123);
        Object session = newSession(fakeConnection(fakeStatement(null, -1, boom)));
        ObjectNode result = (ObjectNode) call("execute",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "select broken", 200);
        assertEquals("error", result.get("kind").asText());
        assertEquals("42000", result.get("messages").get(0).get("sqlState").asText());
        assertEquals("bad sql", result.get("messages").get(0).get("message").asText());
    }

    @Test
    void fetchReadsNextBatchFromStoredCursor() throws Throwable {
        ResultSet rs = fakeResultSet(new String[] { "ID" }, new Object[][] { { 1 }, { 2 } });
        Object session = newSession(fakeConnection(fakeStatement(null, -1, null)));
        cursorsOf(session).put("cid-1", newCursor(rs));
        ObjectNode result = (ObjectNode) call("fetch",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "cid-1", 1);
        assertEquals("rows", result.get("kind").asText());
        assertEquals("cid-1", result.get("cursorId").asText());
        assertTrue(result.get("more").asBoolean());
        assertEquals(1, result.get("rows").size());
    }

    @Test
    void fetchClosesCursorWhenExhausted() throws Throwable {
        ResultSet rs = fakeResultSet(new String[] { "ID" }, new Object[][] { { 1 }, { 2 } });
        Object session = newSession(fakeConnection(fakeStatement(null, -1, null)));
        cursorsOf(session).put("cid-2", newCursor(rs));
        ObjectNode result = (ObjectNode) call("fetch",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "cid-2", 200);
        assertFalse(result.get("more").asBoolean());
        assertFalse(cursorsOf(session).containsKey("cid-2"), "exhausted cursor must be removed");
    }

    @Test
    void fetchRejectsUnknownCursor() throws Exception {
        Object session = newSession(fakeConnection(fakeStatement(null, -1, null)));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> call("fetch",
                new Class<?>[] { sessionClass(), String.class, int.class }, session, "nope", 200));
        assertTrue(e.getMessage().contains("Unknown or expired cursor"));
    }

    @Test
    void disconnectClosesAndRemovesSession() throws Throwable {
        Object session = newSession(fakeConnection(fakeStatement(null, -1, null)));
        cursorsOf(session).put("cid-x", newCursor(fakeResultSet(new String[] { "ID" }, new Object[0][0])));
        sessions().put("conn-disc", session);
        try {
            JsonNode resp = handleLineCapture("{\"id\":\"d1\",\"op\":\"disconnect\",\"connectionId\":\"conn-disc\"}");
            assertTrue(resp.get("ok").asBoolean());
            assertFalse(sessions().containsKey("conn-disc"));
        } finally {
            sessions().remove("conn-disc");
        }
    }

    @Test
    void dispatchHandlesTransactionAndInfoOps() throws Throwable {
        Object session = newSession(fakeConnection(fakeStatement(null, -1, null)));
        sessions().put("conn-tx", session);
        try {
            assertTrue(handleLineCapture("{\"id\":\"t1\",\"op\":\"commit\",\"connectionId\":\"conn-tx\"}").get("ok").asBoolean());
            assertTrue(handleLineCapture("{\"id\":\"t2\",\"op\":\"rollback\",\"connectionId\":\"conn-tx\"}").get("ok").asBoolean());
            assertTrue(handleLineCapture("{\"id\":\"t3\",\"op\":\"setAutoCommit\",\"connectionId\":\"conn-tx\",\"autoCommit\":false}").get("ok").asBoolean());
            JsonNode info = handleLineCapture("{\"id\":\"t4\",\"op\":\"getConnectionInfo\",\"connectionId\":\"conn-tx\"}");
            assertTrue(info.get("ok").asBoolean());
            assertEquals("DB2 for IBM i", info.get("databaseProduct").asText());
            assertEquals("V7R5M0", info.get("databaseVersion").asText());
            assertEquals("IBM Toolbox for Java JDBC Driver", info.get("driverName").asText());
            assertEquals("21.0.7", info.get("driverVersion").asText());
            assertTrue(info.get("autoCommit").asBoolean());
            assertFalse(info.get("closed").asBoolean());
        } finally {
            sessions().remove("conn-tx");
        }
    }

    @Test
    void shutdownOpReportsOk() throws Throwable {
        JsonNode resp = handleLineCapture("{\"id\":\"s1\",\"op\":\"shutdown\"}");
        assertTrue(resp.get("ok").asBoolean());
        // Reset the static stop flag so the main() smoke test still exercises the EOF path.
        var f = Main.class.getDeclaredField("STOPPING");
        f.setAccessible(true);
        ((AtomicBoolean) f.get(null)).set(false);
    }

    // --- CL / command-metadata paths (offline) --------------------------------

    // JTOpen CommandCall/Command have no offline seam: a real (even unconnected)
    // AS400 object attempts a socket connection on run()/getXMLExtended(), which
    // would make these tests infrastructure-dependent. A null clSystem instead
    // fails construction immediately and deterministically.
    @Test
    void executeCLFailsFastWithoutClSystem() throws Exception {
        Constructor<?> ctor = sessionClass().getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class);
        ctor.setAccessible(true);
        Object session = ctor.newInstance(fakeConnection(fakeStatement(null, -1, null)), null);
        assertThrows(Exception.class, () -> call("executeCL",
                new Class<?>[] { sessionClass(), String.class }, session, "WRKSYSSTS OUTPUT(*PRINT)"));
    }

    @Test
    void getCmdXmlBuildsQsysPathsWithoutClSystem() throws Exception {
        Constructor<?> ctor = sessionClass().getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class);
        ctor.setAccessible(true);
        Object session = ctor.newInstance(fakeConnection(fakeStatement(null, -1, null)), null);
        // No library: /QSYS.LIB/<CMD>.CMD
        assertThrows(Exception.class, () -> call("getCmdXml",
                new Class<?>[] { sessionClass(), String.class, String.class }, session, "CRTLIB", ""));
        // Explicit library: /QSYS.LIB/<LIB>.LIB/<CMD>.CMD
        assertThrows(Exception.class, () -> call("getCmdXml",
                new Class<?>[] { sessionClass(), String.class, String.class }, session, "CRTLIB", "MYLIB"));
    }

    // --- main() smoke test ---------------------------------------------------

    @Test
    void mainLoadsDriverAndExitsCleanlyOnEof() throws Exception {
        InputStream original = System.in;
        System.setIn(new ByteArrayInputStream(new byte[0]));
        try {
            Main.main(new String[0]);
        } finally {
            System.setIn(original);
        }
    }
}
