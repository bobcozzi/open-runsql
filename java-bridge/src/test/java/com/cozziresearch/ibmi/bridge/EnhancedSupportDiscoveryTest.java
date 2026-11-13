package com.cozziresearch.ibmi.bridge;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

class EnhancedSupportDiscoveryTest {
    @Test
    void installationsIncludeEveryValidSchemaOnceInVersionOrder() throws Exception {
        Catalog host = new Catalog();
        host.add("TARGET", "1.9", true);
        host.add("ZED", "1.10.0", true);
        host.add("ALPHA", "1.10", true);
        host.add("UNKNOWNZ", null, true);
        host.add("UNKNOWNA", "99.x", true);
        host.add("NOPGM", "100", false);
        String[] invalid = host.add("INVALID", "200", true);
        invalid[5] = "OTHER";
        host.discoverySchemas = List.of("ZED", "ALPHA", "ZED", "UNKNOWNZ", "UNKNOWNA", "NOPGM", "INVALID", "QTEMP", "bad.name");

        var result = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("TARGET", result.path("library").asText());
        assertEquals("ALPHA", result.path("newerAvailable").path("library").asText());
        assertEquals(List.of("ALPHA", "ZED", "TARGET", "UNKNOWNA", "UNKNOWNZ"),
                libraries(result.path("installations")));
        assertTrue(result.path("cppCompilerAvailable").asBoolean());
        assertTrue(result.path("cppCompilerAvailable").asBoolean());
        assertEquals("1.10", result.path("installations").get(0).path("installedVersion").asText());
        assertTrue(result.path("installations").get(3).path("installedVersion").isNull());
        assertTrue(result.path("installations").get(0).path("installed").asBoolean());
        assertTrue(host.queries.stream().allMatch(query -> query.startsWith("SELECT ")));

        var absent = EnhancedSupport.discover(host.connection(), "sql", "ABSENT");
        assertEquals("ALPHA", absent.path("library").asText());
        assertFalse(absent.path("configuredTarget").path("installed").asBoolean());
        assertEquals(List.of("ALPHA", "ZED", "UNKNOWNA", "UNKNOWNZ"), libraries(absent.path("installations")));
    }

    private static List<String> libraries(JsonNode installations) {
        assertTrue(installations.isArray());
        List<String> libraries = new ArrayList<>();
        installations.forEach(installation -> libraries.add(installation.path("library").asText()));
        return libraries;
    }

    @Test
    void prioritizesConfiguredVersionAndQualifiesCatalogInBothNamingModes() throws Exception {
        for (String naming : List.of("sql", "system")) {
            Catalog host = new Catalog();
            host.add("TARGET", "1.9", true);
            host.add("NEWER", "1.10", true);
            host.add("MISSING", "99.0", false);
            host.add("UNKNOWN", null, true);
            var result = EnhancedSupport.discover(host.connection(), naming, "target");
            assertEquals("TARGET", result.path("library").asText());
            assertTrue(result.path("installed").asBoolean());
            assertEquals("1.9", result.path("installedVersion").asText());
            assertEquals("0.2.1", result.path("bundledVersion").asText());
            assertEquals("newer", result.path("versionStatus").asText());
            assertEquals("NEWER", result.path("newerAvailable").path("library").asText());
            assertEquals("1.10", result.path("newerAvailable").path("installedVersion").asText());
            assertEquals("TARGET", result.path("configuredTarget").path("library").asText());
            assertEquals("1.9", result.path("configuredTarget").path("installedVersion").asText());
            String separator = naming.equals("system") ? "/" : ".";
            assertTrue(host.queries.stream().anyMatch(query -> query.contains("FROM QSYS2" + separator + "SYSROUTINES")));
            assertTrue(host.queries.stream().anyMatch(query -> query.contains("TABLE(QSYS2" + separator + "OBJECT_STATISTICS")));
            assertTrue(host.queries.stream().allMatch(query -> query.startsWith("SELECT ")));
        }
    }

    @Test
    void discoversExistingQPrefixedSchemaWithoutTreatingItAsAnUpgradeTarget() throws Exception {
        Catalog host = new Catalog();
        host.add("QFOO", "0.1.0", true);
        var result = EnhancedSupport.discover(host.connection(), "sql", "SQLTOOLS");
        assertEquals("QFOO", result.path("library").asText());
        assertEquals("older", result.path("versionStatus").asText());
        assertEquals("SQLTOOLS", result.path("configuredTarget").path("library").asText());
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.upgrade(host.connection(), "sql", "QFOO", "0.1.0"));
    }

    @Test
    void tiesPreferTargetThenLexicographicAndUnknownNeverBeatsNumeric() throws Exception {
        Catalog host = new Catalog();
        host.add("ZED", "2.0", true);
        host.add("ALPHA", "2", true);
        host.add("TARGET", "2.0.0", true);
        host.add("UNKNOWN", null, true);
        var tied = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("TARGET", tied.path("library").asText());
        assertFalse(tied.has("newerAvailable"));
        assertEquals(List.of("ALPHA", "TARGET", "ZED", "UNKNOWN"), libraries(tied.path("installations")));
        assertEquals("ALPHA", EnhancedSupport.discover(host.connection(), "sql", "OTHER").path("library").asText());

        host.rows.clear();
        host.add("ZED", null, true);
        host.add("ALPHA", null, true);
        host.add("TARGET", null, true);
        var result = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("TARGET", result.path("library").asText());
        assertTrue(result.path("installedVersion").isNull());
        assertEquals("unknown", result.path("versionStatus").asText());
        assertEquals(List.of("ALPHA", "TARGET", "ZED"), libraries(result.path("installations")));
        assertEquals("ALPHA", EnhancedSupport.discover(host.connection(), "sql", "OTHER").path("library").asText());
    }

    @Test
    void rejectsInvalidRoutineShapesAndSchemaNames() throws Exception {
        Catalog host = new Catalog();
        host.add("GOOD", "1.0", true);
        for (int field : List.of(0, 1, 2, 3, 4, 5, 9)) {
            String schema = "BAD" + field;
            String[] row = host.add(schema, "99", true);
            row[field] = field == 3 ? "OTHER/CMD_RUN" : "OTHER";
        }
        host.add("QTEMP", "999", true);
        host.add("QSYS", "999", true);
        host.add("bad.name", "999", true);
        host.add("lowercase", "999", true);
        host.add("NOPGM", "1000", false);
        var result = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("GOOD", result.path("library").asText());
        assertFalse(host.checkedLibraries.contains("QTEMP"));
        assertFalse(host.checkedLibraries.contains("QSYS"));
        assertFalse(host.checkedLibraries.contains("bad.name"));
        assertFalse(host.checkedLibraries.contains("lowercase"));
    }

    @Test
    void ambiguousMetadataIsUnknownAndTargetCollisionsStaySeparate() throws Exception {
        Catalog host = new Catalog();
        host.add("AMBIG", "99", true);
        host.add("AMBIG", "98", true);
        host.add("KNOWN", "1", true);
        String[] target = host.add("TARGET", "42", true);
        target[1] = "DIFFERENT";
        var selected = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("KNOWN", selected.path("library").asText());
        assertTrue(selected.path("installed").asBoolean());
        assertTrue(selected.path("configuredTarget").path("programExists").asBoolean());
        assertTrue(selected.path("configuredTarget").path("routineExists").asBoolean());
        assertFalse(selected.path("configuredTarget").path("installed").asBoolean());

        host.rows.removeIf(row -> row[8].equals("KNOWN") || row[8].equals("AMBIG"));
        var missing = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("TARGET", missing.path("library").asText());
        assertFalse(missing.path("installed").asBoolean());
        assertTrue(missing.path("programExists").asBoolean());
        assertTrue(missing.path("routineExists").asBoolean());
        assertFalse(missing.path("routineMatches").asBoolean());
        assertTrue(missing.path("configuredTarget").path("routineExists").asBoolean());
        assertEquals(List.of(), libraries(missing.path("installations")));
    }

    @Test
    void conflictingAndAmbiguousVersionsRemainEligibleButUnknown() throws Exception {
        Catalog host = new Catalog();
        String[] conflict = host.add("CONFLICT", "99", true);
        conflict[7] = "100";
        host.add("AMBIG", "99", true);
        host.add("AMBIG", "98", true);
        var result = EnhancedSupport.discover(host.connection(), "sql", "CONFLICT");
        assertEquals("CONFLICT", result.path("library").asText());
        assertTrue(result.path("installed").asBoolean());
        assertTrue(result.path("installedVersion").isNull());
        assertEquals("unknown", result.path("versionStatus").asText());
        host.add("KNOWN", "0.0.1", true);
        var unknown = EnhancedSupport.discover(host.connection(), "sql", "CONFLICT");
        assertEquals("CONFLICT", unknown.path("library").asText());
        assertFalse(unknown.has("newerAvailable"));
    }

    @Test
    void newerAlternativeIgnoresMalformedVersionsAndBreaksTiesDeterministically() throws Exception {
        Catalog host = new Catalog();
        host.add("TARGET", "0.1", true);
        host.add("ZED", "1.10.0", true);
        host.add("ALPHA", "1.10", true);
        host.add("MALFORMED", "99.x", true);
        var result = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("TARGET", result.path("library").asText());
        assertEquals("older", result.path("versionStatus").asText());
        assertEquals("ALPHA", result.path("newerAvailable").path("library").asText());
        assertEquals("1.10", result.path("newerAvailable").path("installedVersion").asText());
        host.rows.removeIf(row -> row[8].equals("ZED") || row[8].equals("ALPHA"));
        assertFalse(EnhancedSupport.discover(host.connection(), "sql", "TARGET").has("newerAvailable"));
    }

    @Test
    void configuredLatestHasNoAlternativeNotice() throws Exception {
        Catalog host = new Catalog();
        host.add("TARGET", "2.0", true);
        host.add("OTHER", "1.99", true);
        var result = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertEquals("TARGET", result.path("library").asText());
        assertFalse(result.has("newerAvailable"));
    }

    @Test
    void reportsWhenCppCompilerLibraryIsMissing() throws Exception {
        Catalog host = new Catalog();
        host.cppCompilerLibraryPresent = false;
        var result = EnhancedSupport.discover(host.connection(), "sql", "TARGET");
        assertFalse(result.path("cppCompilerAvailable").asBoolean());
        assertTrue(host.queries.stream().anyMatch(query -> query.contains("OBJECT_STATISTICS")
                && query.contains("'*LIB'") && query.contains("'QCPPLE'")));
    }

    @Test
    void publicCheckDispatchUsesDiscovery() throws Exception {
        Catalog host = new Catalog();
        host.add("DISCOVERED", "3.0", true);
        Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
        Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
        constructor.setAccessible(true);
        Object session = constructor.newInstance(host.connection(), null, "sql");
        var sessionsField = Main.class.getDeclaredField("SESSIONS");
        sessionsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Object> sessions = (Map<String, Object>) sessionsField.get(null);
        String connectionId = "discovery-test-connection";
        sessions.put(connectionId, session);
        try {
            Method dispatch = Main.class.getDeclaredMethod("dispatch", JsonNode.class);
            dispatch.setAccessible(true);
            JsonNode request = new ObjectMapper().readTree("{\"op\":\"checkEnhancedSupport\",\"connectionId\":\""
                    + connectionId + "\",\"library\":\"TARGET\"}");
            JsonNode response = (JsonNode) dispatch.invoke(null, request);
            assertTrue(response.path("ok").asBoolean());
            assertEquals("DISCOVERED", response.path("result").path("library").asText());
            assertEquals("TARGET", response.path("result").path("configuredTarget").path("library").asText());
            assertEquals(List.of("DISCOVERED"), libraries(response.path("result").path("installations")));
        } finally {
            sessions.remove(connectionId);
        }
    }

    private static final class Catalog {
        final List<String[]> rows = new ArrayList<>();
        final Set<String> programs = new HashSet<>();
        final List<String> queries = new ArrayList<>();
        final List<String> checkedLibraries = new ArrayList<>();
        List<String> discoverySchemas;
        boolean cppCompilerLibraryPresent = true;

        String[] add(String schema, String version, boolean program) {
            String[] row = { "CMD_RUN", "CMD_RUN", "FUNCTION", schema + "/CMD_RUN", "T", "DB2SQL", version, version, schema, schema };
            rows.add(row);
            if (program) programs.add(schema);
            return row;
        }

        Connection connection() {
            return proxy(Connection.class, (method, arguments) -> switch (method) {
                case "prepareStatement" -> statement((String) arguments[0]);
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method);
            });
        }

        PreparedStatement statement(String query) {
            queries.add(query);
            Map<Integer, String> values = new HashMap<>();
            return proxy(PreparedStatement.class, (method, arguments) -> switch (method) {
                case "setString" -> { values.put((Integer) arguments[0], (String) arguments[1]); yield null; }
                case "executeQuery" -> result(query, values);
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method);
            });
        }

        ResultSet result(String query, Map<Integer, String> values) {
            List<String[]> matches = new ArrayList<>();
            if (query.startsWith("SELECT DISTINCT")) {
                if (discoverySchemas != null) {
                    discoverySchemas.forEach(schema -> matches.add(new String[] { schema }));
                } else {
                    rows.stream().filter(row -> "CMD_RUN".equals(row[0])).map(row -> row[8]).distinct()
                        .forEach(schema -> matches.add(new String[] { schema }));
                }
            } else if (query.contains("'QCPPLE'")) {
                if (cppCompilerLibraryPresent) matches.add(new String[] { "1" });
            } else {
                String schema = values.get(1);
                checkedLibraries.add(schema);
                if (query.contains("OBJECT_STATISTICS")) {
                    if (programs.contains(schema)) matches.add(new String[] { "1" });
                } else {
                    for (String[] row : rows) {
                        if ((schema.equals(row[8]) && "CMD_RUN".equals(row[0]))
                                || (schema.equals(row[9]) && "CMD_RUN".equals(row[1]))) matches.add(row);
                    }
                }
            }
            int[] index = { -1 };
            return proxy(ResultSet.class, (method, arguments) -> switch (method) {
                case "next" -> ++index[0] < matches.size();
                case "getString" -> matches.get(index[0])[(Integer) arguments[0] - 1];
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method);
            });
        }
    }

    private interface Call { Object invoke(String method, Object[] arguments) throws Throwable; }

    private static <T> T proxy(Class<T> type, Call call) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type },
                (proxy, method, arguments) -> call.invoke(method.getName(), arguments)));
    }
}