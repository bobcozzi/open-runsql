package com.cozziresearch.ibmi.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Properties;

final class SQLCompletions implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TABLES = "SELECT TABLE_NAME, COALESCE(TABLE_TEXT, '') FROM QSYS2.SYSTABLES"
            + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ? ESCAPE '!' ORDER BY TABLE_NAME FETCH FIRST 200 ROWS ONLY";
    private static final String COLUMNS = "SELECT COLUMN_NAME, DATA_TYPE FROM QSYS2.SYSCOLUMNS"
            + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME LIKE ? ESCAPE '!'"
            + " ORDER BY ORDINAL_POSITION FETCH FIRST 200 ROWS ONLY";
    private static final String ROUTINES = "SELECT ROUTINE_NAME, ROUTINE_TYPE, FUNCTION_TYPE, SPECIFIC_NAME, SPECIFIC_SCHEMA"
            + " FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME LIKE ? ESCAPE '!'";
    private static final String ROUTINE_ORDER = " ORDER BY ROUTINE_NAME, SPECIFIC_SCHEMA, SPECIFIC_NAME FETCH FIRST 200 ROWS ONLY";
    private static final String PARMS = "SELECT P.PARAMETER_NAME, P.DATA_TYPE, P.PARAMETER_MODE, R.SPECIFIC_NAME, R.SPECIFIC_SCHEMA"
            + " FROM QSYS2.SYSPARMS P JOIN QSYS2.SYSROUTINES R"
            + " ON P.SPECIFIC_SCHEMA = R.SPECIFIC_SCHEMA AND P.SPECIFIC_NAME = R.SPECIFIC_NAME"
            + " WHERE R.ROUTINE_SCHEMA = ? AND R.ROUTINE_NAME = ? AND P.PARAMETER_NAME LIKE ? ESCAPE '!'";
    private static final String PARM_ORDER = " ORDER BY R.SPECIFIC_SCHEMA, R.SPECIFIC_NAME, P.ORDINAL_POSITION FETCH FIRST 200 ROWS ONLY";

    private final String url;
    private final Properties properties = new Properties();
    private Connection connection;
    private boolean closed;

    SQLCompletions(String url, Properties properties) {
        this.url = url.replaceAll("(?i)(;\\s*naming\\s*=)[^;]*", "$1sql")
            .replaceAll("(?i)(;\\s*access\\s*=)[^;]*", "$1read only");
        this.properties.putAll(properties);
        this.properties.setProperty("naming", "sql");
        this.properties.setProperty("access", "read only");
    }

    synchronized ArrayNode lookup(JsonNode request) throws SQLException {
        String kind = input(request, "kind", false);
        String sql = switch (kind) {
            case "tables" -> TABLES;
            case "columns" -> COLUMNS;
            case "routines" -> ROUTINES + ROUTINE_ORDER;
            case "tableFunctions" -> ROUTINES + " AND ROUTINE_TYPE = 'FUNCTION' AND FUNCTION_TYPE = 'T'" + ROUTINE_ORDER;
                case "parameters" -> PARMS + " AND P.ROW_TYPE = 'P' AND P.PARAMETER_MODE IN ('IN', 'INOUT')" + PARM_ORDER;
            case "routineColumns" -> PARMS + " AND R.ROUTINE_TYPE = 'FUNCTION' AND R.FUNCTION_TYPE = 'T'"
                    + " AND P.ROW_TYPE = 'R'" + PARM_ORDER;
            default -> throw new IllegalArgumentException("unsupported SQL completion kind");
        };
        String schema = input(request, "schema", false);
        String object = input(request, "object", true);
        String prefix = input(request, "prefix", true);
        boolean needsObject = kind.equals("columns") || kind.equals("parameters") || kind.equals("routineColumns");
        if (needsObject && object.isBlank()) throw new IllegalArgumentException("object is required");
        if (closed) throw new SQLException("SQL completion session is closed");
        if (connection == null) {
            Properties credentials = new Properties();
            credentials.putAll(properties);
            Connection opened = null;
            try {
                opened = DriverManager.getConnection(url, credentials);
                opened.setReadOnly(true);
                opened.setAutoCommit(true);
                connection = opened;
                properties.clear();
            } catch (SQLException failure) {
                if (opened != null) {
                    try { opened.close(); } catch (SQLException cleanup) { failure.addSuppressed(cleanup); }
                }
                throw failure;
            } finally {
                credentials.clear();
            }
        }
        ArrayNode result = JSON.createArrayNode();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setMaxRows(200);
            statement.setQueryTimeout(5);
            statement.setString(1, schema);
            if (needsObject) statement.setString(2, object);
            statement.setString(needsObject ? 3 : 2, prefix.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%");
            try (ResultSet rows = statement.executeQuery()) {
                while (result.size() < 200 && rows.next()) {
                    ObjectNode item = result.addObject();
                    item.put("name", value(rows, 1));
                    item.put("kind", kind);
                    String detail = value(rows, 2);
                    if (kind.equals("routines") || kind.equals("tableFunctions")) {
                        detail += " " + value(rows, 3) + " [" + value(rows, 5) + "." + value(rows, 4) + "]";
                        item.put("specificName", value(rows, 4));
                    } else if (kind.equals("parameters") || kind.equals("routineColumns")) {
                        detail = value(rows, 3) + " " + detail + " [" + value(rows, 5) + "." + value(rows, 4) + "]";
                        item.put("specificName", value(rows, 4));
                    }
                    item.put("detail", detail);
                }
            }
        }
        return result;
    }

    private static String value(ResultSet rows, int column) throws SQLException {
        String value = rows.getString(column);
        return value == null ? "" : value.stripTrailing();
    }

    private static String input(JsonNode request, String name, boolean optional) {
        JsonNode node = request.get(name);
        if (node == null && optional) return "";
        if (node == null || !node.isTextual()) throw new IllegalArgumentException(name + " must be a string");
        String value = node.textValue();
        if (value.codePointCount(0, value.length()) > 128 || value.indexOf(0) >= 0)
            throw new IllegalArgumentException(name + " must be at most 128 characters and contain no NUL");
        if (!optional && value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    @Override
    public synchronized void close() {
        closed = true;
        if (connection != null) {
            try { connection.close(); } catch (SQLException ignored) {}
            connection = null;
        }
        properties.clear();
    }
}