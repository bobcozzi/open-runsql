package com.cozziresearch.ibmi.bridge;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;

class SQLCompletionsTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    private static ObjectNode request(String kind) {
        return JSON.createObjectNode().put("kind", kind).put("schema", "Mixed Schema")
                .put("object", "Mixed Object").put("prefix", "a!_%' OR 1=1");
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler);
    }

    private static final class Catalog implements Driver, AutoCloseable {
        final String url = "jdbc:completion-test:" + UUID.randomUUID();
        final Properties properties = new Properties();
        final List<String> sql = new ArrayList<>();
        final Map<Integer, String> bindings = new HashMap<>();
        final List<String> events = new ArrayList<>();
        int opens;
        int rowCount = 1;
        int rowIndex;
        int maxRows;
        int timeout;
        boolean readOnly;
        boolean autoCommit;
        boolean failQuery;
        boolean failSetup;
        String requestedUrl;
        Properties suppliedProperties;
        boolean failConnect;
        boolean failClose;
        String[] row = {"Result", "INTEGER", "IN", "Overload", "Specific Schema"};

        Catalog() throws SQLException { DriverManager.registerDriver(this); }

        SQLCompletions completions() {
            Properties credentials = new Properties();
            credentials.setProperty("user", "user");
            credentials.setProperty("password", "secret");
            SQLCompletions result = new SQLCompletions(url, credentials);
            credentials.clear();
            return result;
        }

        public Connection connect(String requested, Properties supplied) throws SQLException {
            if (!acceptsURL(requested)) return null;
            requestedUrl = requested;
            opens++;
            properties.putAll(supplied);
            suppliedProperties = supplied;
            if (failConnect) throw new SQLException("connect failed");
            return proxy(Connection.class, (connection, method, args) -> {
                switch (method.getName()) {
                    case "setReadOnly":
                        if (failSetup) throw new SQLException("setup failed");
                        readOnly = (boolean) args[0]; return null;
                    case "setAutoCommit": autoCommit = (boolean) args[0]; return null;
                    case "close":
                        events.add("connection.close");
                        if (failClose) throw new SQLException("close failed");
                        return null;
                    case "prepareStatement":
                        sql.add((String) args[0]);
                        bindings.clear();
                        return statement();
                    default: throw new AssertionError("unexpected metadata connection call " + method.getName());
                }
            });
        }

        private PreparedStatement statement() {
            return proxy(PreparedStatement.class, (statement, method, args) -> {
                switch (method.getName()) {
                    case "setMaxRows": maxRows = (int) args[0]; return null;
                    case "setQueryTimeout": timeout = (int) args[0]; return null;
                    case "setString": bindings.put((int) args[0], (String) args[1]); return null;
                    case "close": events.add("statement.close"); return null;
                    case "executeQuery":
                        if (failQuery) throw new SQLException("query failed");
                        rowIndex = 0;
                        return proxy(ResultSet.class, (rows, operation, values) -> {
                            switch (operation.getName()) {
                                case "next": return ++rowIndex <= rowCount;
                                case "getString": return row[(int) values[0] - 1];
                                case "close": events.add("rows.close"); return null;
                                default: throw new AssertionError("unexpected result call " + operation.getName());
                            }
                        });
                    default: throw new AssertionError("unexpected statement call " + method.getName());
                }
            });
        }

        public boolean acceptsURL(String requested) { return url.equals(requested) || requested.startsWith(url + ";"); }
        public DriverPropertyInfo[] getPropertyInfo(String requested, Properties supplied) { return new DriverPropertyInfo[0]; }
        public int getMajorVersion() { return 1; }
        public int getMinorVersion() { return 0; }
        public boolean jdbcCompliant() { return false; }
        public Logger getParentLogger() { return Logger.getGlobal(); }
        public void close() throws SQLException { DriverManager.deregisterDriver(this); }
    }

    @Test
    void auxiliaryUrlOverridesSystemNamingWithoutChangingCallerProperties() throws Exception {
        try (Catalog catalog = new Catalog()) {
            Properties credentials = new Properties();
            credentials.setProperty("naming", "system");
            credentials.setProperty("access", "all");
            credentials.setProperty("password", "secret");
            String userUrl = catalog.url + ";naming=system;libraries=MYLIB;NAMING=system;ACCESS=all;";
            try (SQLCompletions completions = new SQLCompletions(userUrl, credentials)) {
                assertEquals(0, catalog.opens);
                completions.lookup(request("tables"));
                assertEquals(catalog.url + ";naming=sql;libraries=MYLIB;NAMING=sql;ACCESS=read only;", catalog.requestedUrl);
                assertEquals("sql", catalog.properties.getProperty("naming"));
                assertEquals("read only", catalog.properties.getProperty("access"));
                assertEquals("system", credentials.getProperty("naming"));
                assertEquals("all", credentials.getProperty("access"));
                assertEquals("secret", credentials.getProperty("password"));
            }
        }
    }

    @Test
    void lazyReadOnlyConnectionReusedAndClosed() throws Exception {
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            assertEquals(0, catalog.opens);
            completions.lookup(request("tables"));
            completions.lookup(request("columns"));
            assertEquals(1, catalog.opens);
            assertTrue(catalog.readOnly);
            assertTrue(catalog.autoCommit);
            assertEquals("sql", catalog.properties.getProperty("naming"));
            assertEquals("read only", catalog.properties.getProperty("access"));
            assertEquals("secret", catalog.properties.getProperty("password"));
            assertFalse(catalog.events.contains("connection.close"));
            completions.close();
            completions.close();
            assertEquals(1, catalog.events.stream().filter("connection.close"::equals).count());
            assertThrows(SQLException.class, () -> completions.lookup(request("tables")));
            assertEquals(1, catalog.opens);
        }
    }

    @Test
    void fixedCatalogQueriesBindCasePreservedNamesAndEscapedPrefix() throws Exception {
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            for (String kind : List.of("tables", "columns", "routines", "tableFunctions", "parameters", "routineColumns")) {
                JsonNode rows = completions.lookup(request(kind));
                String sql = catalog.sql.get(catalog.sql.size() - 1);
                assertTrue(sql.endsWith("FETCH FIRST 200 ROWS ONLY"));
                assertTrue(sql.contains("ESCAPE '!'"));
                assertFalse(sql.contains("Mixed"));
                assertFalse(sql.contains("OR 1=1"));
                assertEquals(200, catalog.maxRows);
                assertEquals(5, catalog.timeout);
                assertEquals("Mixed Schema", catalog.bindings.get(1));
                boolean needsObject = List.of("columns", "parameters", "routineColumns").contains(kind);
                if (needsObject) assertEquals("Mixed Object", catalog.bindings.get(2));
                assertEquals("a!!!_!%' OR 1=1%", catalog.bindings.get(needsObject ? 3 : 2));
                assertEquals(kind, rows.get(0).path("kind").asText());
                if (kind.equals("tables")) assertTrue(sql.contains("TABLE_TEXT"));
                if (kind.equals("columns")) assertTrue(sql.contains("ORDER BY ORDINAL_POSITION"));
                if (kind.equals("tableFunctions") || kind.equals("routineColumns")) {
                    assertTrue(sql.contains("FUNCTION_TYPE = 'T'"));
                    assertTrue(sql.contains("ROUTINE_TYPE = 'FUNCTION'"));
                }
                if (kind.equals("parameters") || kind.equals("routineColumns")) {
                    assertTrue(sql.contains("P.SPECIFIC_SCHEMA = R.SPECIFIC_SCHEMA AND P.SPECIFIC_NAME = R.SPECIFIC_NAME"));
                    assertTrue(sql.contains("P.PARAMETER_NAME"));
                    assertTrue(sql.contains("P.ORDINAL_POSITION"));
                    assertTrue(sql.contains(kind.equals("parameters") ? "P.ROW_TYPE = 'P'" : "P.ROW_TYPE = 'R'"));
                    if (kind.equals("parameters")) assertTrue(sql.contains("IN ('IN', 'INOUT')"));
                    assertTrue(sql.contains("R.ROUTINE_SCHEMA = ? AND R.ROUTINE_NAME = ?"));
                }
                if (!kind.equals("tables") && !kind.equals("columns")) {
                    assertEquals("Overload", rows.get(0).path("specificName").asText());
                    assertTrue(rows.get(0).path("detail").asText().contains("Specific Schema.Overload"));
                }
            }
        }
    }

    @Test
    void invalidInputNeverOpensConnection() throws Exception {
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            for (String field : List.of("kind", "schema", "object", "prefix")) {
                assertThrows(IllegalArgumentException.class, () -> completions.lookup(request("columns").put(field, 42)));
                assertThrows(IllegalArgumentException.class, () -> completions.lookup(request("columns").putNull(field)));
                assertThrows(IllegalArgumentException.class, () -> completions.lookup(request("columns").put(field, "a".repeat(129))));
                assertThrows(IllegalArgumentException.class, () -> completions.lookup(request("columns").put(field, "a\0b")));
            }
            assertThrows(IllegalArgumentException.class, () -> completions.lookup(request("bogus")));
            assertThrows(IllegalArgumentException.class, () -> completions.lookup(request("tables").put("schema", "")));
            for (String kind : List.of("columns", "parameters", "routineColumns")) {
                assertThrows(IllegalArgumentException.class, () -> completions.lookup(request(kind).put("object", "")));
            }
            assertEquals(0, catalog.opens);
        }
    }

    @Test
    void boundsRowsAndClosesResourcesOnSuccessAndFailure() throws Exception {
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            catalog.rowCount = 250;
            assertEquals(200, completions.lookup(request("tables")).size());
            assertEquals(List.of("rows.close", "statement.close"), catalog.events);
            catalog.failQuery = true;
            assertThrows(SQLException.class, () -> completions.lookup(request("tables")));
            assertEquals("statement.close", catalog.events.get(2));
            catalog.failQuery = false;
            catalog.rowCount = 0;
            assertEquals(0, completions.lookup(request("tables")).size());
        }
    }

    @Test
    void credentialCopiesReleasedAfterConnectFailureSuccessAndClose() throws Exception {
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            Field field = SQLCompletions.class.getDeclaredField("properties");
            field.setAccessible(true);
            Properties retained = (Properties) field.get(completions);
            catalog.failConnect = true;
            assertThrows(SQLException.class, () -> completions.lookup(request("tables")));
            assertTrue(catalog.suppliedProperties.isEmpty());
            assertEquals("secret", retained.getProperty("password"));
            assertTrue(catalog.events.isEmpty());
            catalog.failConnect = false;
            completions.lookup(request("tables"));
            assertEquals(2, catalog.opens);
            assertTrue(catalog.suppliedProperties.isEmpty());
            assertTrue(retained.isEmpty());
            catalog.failClose = true;
            completions.close();
            assertTrue(retained.isEmpty());
            assertThrows(SQLException.class, () -> completions.lookup(request("tables")));
        }
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            Field field = SQLCompletions.class.getDeclaredField("properties");
            field.setAccessible(true);
            Properties retained = (Properties) field.get(completions);
            catalog.failConnect = true;
            assertThrows(SQLException.class, () -> completions.lookup(request("tables")));
            completions.close();
            assertTrue(retained.isEmpty());
            assertTrue(catalog.suppliedProperties.isEmpty());
        }
    }

    @Test
    void failedSetupClosesConnectionAndCanRetry() throws Exception {
        try (Catalog catalog = new Catalog(); SQLCompletions completions = catalog.completions()) {
            catalog.failSetup = true;
            catalog.failClose = true;
            SQLException failure = assertThrows(SQLException.class, () -> completions.lookup(request("tables")));
            assertEquals("setup failed", failure.getMessage());
            assertEquals(1, failure.getSuppressed().length);
            assertEquals("close failed", failure.getSuppressed()[0].getMessage());
            assertEquals(List.of("connection.close"), catalog.events);
            assertTrue(catalog.suppliedProperties.isEmpty());
            catalog.failSetup = false;
            catalog.failClose = false;
            completions.lookup(request("tables"));
            assertEquals(2, catalog.opens);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void dispatchIgnoresUserSessionLockAndPreservesCursorUntilDisconnect() throws Exception {
        try (Catalog catalog = new Catalog()) {
            Class<?> type = Class.forName(Main.class.getName() + "$Session");
            Constructor<?> constructor = type.getDeclaredConstructors()[0];
            constructor.setAccessible(true);
            Connection user = proxy(Connection.class, (connection, method, args) -> {
                assertEquals("close", method.getName(), "completion touched user JDBC connection");
                catalog.events.add("user.close");
                return null;
            });
            Object session = constructor.newInstance(user, null, "sql");
            Field metadata = type.getDeclaredField("completions");
            metadata.setAccessible(true);
            metadata.set(session, catalog.completions());
            Field lockField = type.getDeclaredField("lock");
            lockField.setAccessible(true);
            ReentrantLock lock = (ReentrantLock) lockField.get(session);
            Field cursorsField = type.getDeclaredField("cursors");
            cursorsField.setAccessible(true);
            Map<String, Object> cursors = (Map<String, Object>) cursorsField.get(session);
            Class<?> cursorType = Class.forName(Main.class.getName() + "$Cursor");
            Constructor<?> cursorConstructor = cursorType.getDeclaredConstructors()[0];
            cursorConstructor.setAccessible(true);
            Object cursor = cursorConstructor.newInstance(null, null);
            cursors.put("cursor", cursor);
            Field sessionsField = Main.class.getDeclaredField("SESSIONS");
            sessionsField.setAccessible(true);
            Map<String, Object> sessions = (Map<String, Object>) sessionsField.get(null);
            String id = UUID.randomUUID().toString();
            sessions.put(id, session);
            Method dispatch = Main.class.getDeclaredMethod("dispatch", JsonNode.class);
            dispatch.setAccessible(true);
            var executor = Executors.newSingleThreadExecutor();
            try {
                lock.lock();
                try {
                    var future = executor.submit(() -> (JsonNode) dispatch.invoke(null,
                            request("columns").put("op", "sqlCompletions").put("connectionId", id)));
                    assertEquals(1, future.get(2, TimeUnit.SECONDS).path("result").size());
                    assertSame(cursor, cursors.get("cursor"));
                    assertEquals(1, cursors.size());
                    assertFalse(catalog.events.contains("user.close"));
                } finally { lock.unlock(); }
                dispatch.invoke(null, JSON.createObjectNode().put("op", "disconnect").put("connectionId", id));
                assertFalse(sessions.containsKey(id));
                assertTrue(catalog.events.indexOf("connection.close") < catalog.events.indexOf("user.close"));
                assertThrows(SQLException.class, () -> ((SQLCompletions) metadata.get(session)).lookup(request("tables")));
            } finally {
                executor.shutdownNow();
                sessions.remove(id);
                ((SQLCompletions) metadata.get(session)).close();
            }
        }
    }
}