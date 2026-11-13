package com.cozziresearch.ibmi.bridge;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import org.junit.jupiter.api.Test;

class EnhancedCLTest {
    @Test
    void executesSqlJobClOnceWithLockAndReportsFailures() throws Exception {
        for (String naming : List.of("sql", "system")) {
            List<String> calls = new ArrayList<>();
            boolean[] fail = {false};
            Object[] sessionHolder = {null};
            Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
            var lockField = sessionClass.getDeclaredField("lock");
            lockField.setAccessible(true);
            var activeField = sessionClass.getDeclaredField("activeStatement");
            activeField.setAccessible(true);
            PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {PreparedStatement.class}, (proxy, method, args) -> switch (method.getName()) {
                        case "setString" -> { calls.add("bind " + args[0] + " " + args[1]); yield null; }
                        case "execute" -> {
                            assertTrue(((ReentrantLock) lockField.get(sessionHolder[0])).isHeldByCurrentThread());
                            assertSame(proxy, activeField.get(sessionHolder[0]));
                            calls.add("execute");
                            if (fail[0]) throw new SQLException("command failed", "57000", 123);
                            yield false;
                        }
                        case "close" -> { calls.add("close"); yield null; }
                        default -> throw new UnsupportedOperationException(method.getName());
                    });
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                        case "prepareStatement" -> { calls.add((String) args[0]); yield statement; }
                        default -> throw new UnsupportedOperationException(method.getName());
                    });
            Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
            constructor.setAccessible(true);
            Object session = constructor.newInstance(connection, null, naming);
            sessionHolder[0] = session;
            boolean[] cursorClosed = {false};
            ResultSet oldRows = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {ResultSet.class}, (proxy, method, args) -> {
                        if (method.getName().equals("close")) { cursorClosed[0] = true; return null; }
                        throw new UnsupportedOperationException(method.getName());
                    });
            Class<?> cursorClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Cursor");
            Constructor<?> cursorConstructor = cursorClass.getDeclaredConstructor(Statement.class, ResultSet.class);
            cursorConstructor.setAccessible(true);
            var cursorsField = sessionClass.getDeclaredField("cursors");
            cursorsField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, Object> cursors = (Map<String, Object>) cursorsField.get(session);
            cursors.put("old", cursorConstructor.newInstance(statement, oldRows));
            var execute = Main.class.getDeclaredMethod("executeSQLJobCL", sessionClass, String.class);
            execute.setAccessible(true);
            ObjectNode result = (ObjectNode) execute.invoke(null, session, "CMD('A''B')");
            assertTrue(result.path("ok").asBoolean());
            assertEquals("cl", result.path("kind").asText());
            assertEquals(0, result.path("messages").size());
            assertTrue(cursorClosed[0]);
            assertTrue(cursors.isEmpty());
            assertTrue(calls.contains("CALL QSYS2" + (naming.equals("system") ? "/" : ".") + "QCMDEXC(?)"));
            assertTrue(calls.contains("bind 1 CMD('A''B')"));
            assertNull(activeField.get(session));
            calls.clear();
            fail[0] = true;
            InvocationTargetException failure = assertThrows(InvocationTargetException.class,
                    () -> execute.invoke(null, session, "COMMAND"));
            SQLException cause = (SQLException) failure.getCause();
            assertTrue(cause.getMessage().contains("command failed"));
            assertTrue(cause.getMessage().contains("command may have run"));
            assertEquals("57000", cause.getSQLState());
            assertEquals(123, cause.getErrorCode());
            assertEquals(1, calls.stream().filter("execute"::equals).count());
            assertEquals(1, calls.stream().filter("close"::equals).count());
            assertNull(activeField.get(session));
            assertFalse(((ReentrantLock) lockField.get(session)).isLocked());
        }
    }

    @Test
    void executesQcmdexcScalarFunctionInTheSqlJob() throws Exception {
        List<String> calls = new ArrayList<>();
        ResultSet rows = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] {ResultSet.class}, new java.lang.reflect.InvocationHandler() {
                    boolean read;
                    @Override public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) {
                        return switch (method.getName()) {
                            case "next" -> !read && (read = true);
                            case "getInt" -> 0;
                            case "close" -> null;
                            default -> throw new UnsupportedOperationException(method.getName());
                        };
                    }
                });
        PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] {PreparedStatement.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "setString" -> { calls.add("bind " + args[0] + " " + args[1]); yield null; }
                    case "executeQuery" -> { calls.add("executeQuery"); yield rows; }
                    case "close" -> { calls.add("close"); yield null; }
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] {Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "prepareStatement" -> { calls.add((String) args[0]); yield statement; }
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
        Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
        constructor.setAccessible(true);
        Object session = constructor.newInstance(connection, null, "system");
        var execute = Main.class.getDeclaredMethod("executeQcmdexcFunction", sessionClass, String.class);
        execute.setAccessible(true);
        ObjectNode result = (ObjectNode) execute.invoke(null, session, "OVRDBF FILE(INPUT) TOFILE(QGPL/INPUT)");
        assertTrue(result.path("ok").asBoolean());
        assertEquals(0, result.path("returnCode").asInt());
        assertEquals(0, result.path("messages").size());
        assertTrue(calls.contains("VALUES QSYS2.QCMDEXC(?)"));
        assertTrue(calls.contains("bind 1 OVRDBF FILE(INPUT) TOFILE(QGPL/INPUT)"));
        assertTrue(calls.contains("executeQuery"));
    }

    private static ResultSet rows(List<Map<String, Object>> data) {
        int[] index = {-1};
        List<String> columns = List.of("ORDINAL_POSITION", "MSGID", "MSGSEV", "MSGTYPE", "SENT_TIMESTAMP", "MSGTEXT",
                "SENT_BY_USER", "SENT_FROM_PGM", "SENT_FROM_STMT", "SENT_FROM_MOD", "SENT_FROM_PROC",
                "SENT_TO_PGM", "SENT_TO_STMT", "SENT_TO_MOD", "SENT_TO_PROC", "SECLVLMSG");
        ResultSetMetaData metadata = (ResultSetMetaData) Proxy.newProxyInstance(EnhancedCLTest.class.getClassLoader(),
                new Class<?>[] {ResultSetMetaData.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "getColumnCount" -> columns.size();
                    case "getColumnName", "getColumnLabel" -> columns.get((int) args[0] - 1);
                    case "getColumnType" -> columns.get((int) args[0] - 1).equals("SENT_TIMESTAMP") ? Types.TIMESTAMP : Types.VARCHAR;
                    case "getColumnTypeName" -> "VARCHAR";
                    case "getPrecision", "getScale", "getColumnDisplaySize", "isNullable" -> 0;
                    case "isAutoIncrement" -> false;
                    case "getSchemaName", "getTableName" -> "";
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        return (ResultSet) Proxy.newProxyInstance(EnhancedCLTest.class.getClassLoader(), new Class<?>[] {ResultSet.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "next" -> ++index[0] < data.size();
                    case "getString" -> {
                        Object value = data.get(index[0]).get(args[0]);
                        yield value == null ? null : value.toString();
                    }
                    case "getInt" -> data.get(index[0]).get(args[0]);
                    case "getMetaData" -> metadata;
                    case "getObject" -> data.get(index[0]).get(columns.get((int) args[0] - 1));
                    case "close" -> null;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
    }

    @Test
    void mapsAllMessagesAndEmptyResults() throws SQLException {
        ObjectNode empty = Main.enhancedCLResult(rows(List.of()));
        assertTrue(empty.path("ok").asBoolean());
        assertEquals(0, empty.path("messages").size());
        assertEquals(16, empty.path("resultSet").path("columns").size());
        assertEquals(0, empty.path("resultSet").path("rows").size());
        ObjectNode result = Main.enhancedCLResult(rows(List.of(
                Map.of("MSGID", "CPC0001", "MSGSEV", 0, "MSGTYPE", "*COMP", "MSGTEXT", "Done", "SECLVLMSG", "Help"),
                Map.of("MSGID", "CPF0001", "MSGSEV", 20, "MSGTYPE", "*DIAG", "MSGTEXT", "Warning", "SECLVLMSG", ""),
                Map.of("MSGID", "CPF0002", "MSGSEV", 0, "MSGTYPE", "*ESCAPE", "MSGTEXT", "Failed", "SECLVLMSG", "Details"))));
        assertFalse(result.path("ok").asBoolean());
        assertEquals(3, result.path("messages").size());
        assertEquals("CPC0001", result.path("messages").get(0).path("id").asText());
        assertEquals("Help", result.path("messages").get(0).path("secondLevelText").asText());
        assertEquals("*DIAG", result.path("messages").get(1).path("typeName").asText());
        assertEquals("Failed", result.path("messages").get(2).path("text").asText());
        assertEquals(3, result.path("resultSet").path("rows").size());
        ObjectNode detailed = Main.enhancedCLResult(rows(List.of(Map.of(
            "MSGID", "CPC0001", "MSGSEV", 0, "MSGTYPE", "*COMP", "MSGTEXT", "Done", "SECLVLMSG", "Help",
                "SENT_FROM_PGM", " PGMA ", "SENT_TO_PROC", "Target", "SENT_TIMESTAMP", java.sql.Timestamp.valueOf("2026-11-13 12:34:56.123456")))));
        assertEquals("PGMA", detailed.path("messages").get(0).path("fromProgram").asText());
        assertEquals("Target", detailed.path("messages").get(0).path("toProcedure").asText());
        assertEquals("2026-11-13 12:34:56.123456", detailed.path("resultSet").path("rows").get(0).get(4).asText());
        assertTrue(Main.enhancedCLResult(rows(List.of(Map.of("MSGID", "x", "MSGSEV", 29,
                "MSGTYPE", "*DIAG", "MSGTEXT", "", "SECLVLMSG", "")))).path("ok").asBoolean());
        assertFalse(Main.enhancedCLResult(rows(List.of(Map.of("MSGID", "x", "MSGSEV", 30,
                "MSGTYPE", "*INFO", "MSGTEXT", "", "SECLVLMSG", "")))).path("ok").asBoolean());
    }

    @Test
    void executesParameterizedSqlAndReportsUncertainFailure() throws Throwable {
        for (String naming : List.of("sql", "system")) {
            List<String> calls = new ArrayList<>();
            boolean[] fail = {false};
            PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {PreparedStatement.class}, (proxy, method, args) -> switch (method.getName()) {
                        case "setString" -> { calls.add("bind " + args[0] + " " + args[1]); yield null; }
                        case "executeQuery" -> { calls.add("executeQuery"); if (fail[0]) throw new SQLException("read failed", "08006"); yield rows(List.of()); }
                        case "close" -> null;
                        default -> throw new UnsupportedOperationException(method.getName());
                    });
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                        case "prepareStatement" -> { calls.add((String) args[0]); yield statement; }
                        default -> throw new UnsupportedOperationException(method.getName());
                    });
            Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
            Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
            constructor.setAccessible(true);
            Object session = constructor.newInstance(connection, null, naming);
            boolean[] cursorClosed = {false};
            ResultSet oldRows = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(),
                    new Class<?>[] {ResultSet.class}, (proxy, method, args) -> {
                        if (method.getName().equals("close")) { cursorClosed[0] = true; return null; }
                        throw new UnsupportedOperationException(method.getName());
                    });
            Class<?> cursorClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Cursor");
            Constructor<?> cursorConstructor = cursorClass.getDeclaredConstructor(Statement.class, ResultSet.class);
            cursorConstructor.setAccessible(true);
            var cursorsField = sessionClass.getDeclaredField("cursors");
            cursorsField.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, Object> cursors = (Map<String, Object>) cursorsField.get(session);
            cursors.put("old", cursorConstructor.newInstance(statement, oldRows));
            var execute = Main.class.getDeclaredMethod("executeEnhancedCL", sessionClass, String.class, String.class);
            execute.setAccessible(true);
            ObjectNode result = (ObjectNode) execute.invoke(null, session, "CMD('A''B')", "mylib");
            assertTrue(result.path("ok").asBoolean());
            assertTrue(cursorClosed[0]);
            assertTrue(cursors.isEmpty());
            assertEquals("SELECT * FROM TABLE(MYLIB"
                    + (naming.equals("system") ? "/" : ".")
                    + "CMD_RUN(CAST(? AS VARCHAR(32700)), CAST('*RUN' AS VARCHAR(14)))) AS M", calls.get(0));
            assertEquals("bind 1 CMD('A''B')", calls.get(1));
            assertEquals(1, calls.stream().filter("executeQuery"::equals).count());
            fail[0] = true;
            InvocationTargetException failure = assertThrows(InvocationTargetException.class,
                    () -> execute.invoke(null, session, "COMMAND", "MYLIB"));
            assertTrue(failure.getCause().getMessage().contains("command may have run"));
            assertEquals("08006", ((SQLException) failure.getCause()).getSQLState());
            assertThrows(InvocationTargetException.class, () -> execute.invoke(null, session, "COMMAND", "QSYS"));
        }
    }
}