package com.cozziresearch.ibmi.bridge;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

final class EnhancedSupport {
    private static final Pattern LIBRARY = Pattern.compile("[A-Z#$@][A-Z0-9_#$@]{0,9}");
    private static final Pattern VERSION = Pattern.compile("[0-9]+(?:\\.[0-9]+)*");
    private static final String BUNDLED_VERSION = "0.2.1";

    static String library(String value) {
        if (value == null || !value.matches("[A-Za-z#$@][A-Za-z0-9_#$@]{0,9}")) {
            throw new IllegalArgumentException("library must be a simple IBM i library name of 1 to 10 characters");
        }
        String normalized = value.toUpperCase(Locale.ROOT);
        if (!LIBRARY.matcher(normalized).matches() || normalized.equals("QTEMP") || normalized.equals("QSYS")) {
            throw new IllegalArgumentException("library must not be QTEMP or QSYS");
        }
        return normalized;
    }

    static String targetLibrary(String value) {
        String normalized = value == null ? "" : value.toUpperCase(Locale.ROOT);
        if (LIBRARY.matcher(normalized).matches() && normalized.startsWith("Q") && !normalized.equals("QGPL")) {
            throw new IllegalArgumentException("enhanced support target library must not begin with Q except QGPL");
        }
        return library(value);
    }

    static String resource(String name) throws IOException {
        try (InputStream input = EnhancedSupport.class.getResourceAsStream("/cmd_run/" + name)) {
            if (input == null) throw new IOException("Missing bundled CMD_RUN source: " + name);
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    static String version() {
        return BUNDLED_VERSION;
    }

    static String metadataVersion(String comment, String label) {
        String version = null;
        for (String text : new String[] { comment, label }) {
            if (text == null || text.isBlank()) continue;
            String token = text.strip().split("\\s+", 2)[0];
            if (!VERSION.matcher(token).matches()) {
                if (token.charAt(0) >= '0' && token.charAt(0) <= '9') return null;
                continue;
            }
            if (version != null && compareVersions(version, token) != 0) return null;
            if (version == null) version = token;
        }
        return version;
    }

    static int compareVersions(String left, String right) {
        String[] leftParts = left.split("\\.");
        String[] rightParts = right.split("\\.");
        for (int index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
            BigInteger leftPart = index < leftParts.length ? new BigInteger(leftParts[index]) : BigInteger.ZERO;
            BigInteger rightPart = index < rightParts.length ? new BigInteger(rightParts[index]) : BigInteger.ZERO;
            int comparison = leftPart.compareTo(rightPart);
            if (comparison != 0) return comparison;
        }
        return 0;
    }

    static String versionStatus(String installedVersion) {
        if (installedVersion == null || !VERSION.matcher(installedVersion).matches()) return "unknown";
        int comparison = compareVersions(installedVersion, version());
        return comparison < 0 ? "older" : comparison > 0 ? "newer" : "current";
    }

    static String rewriteSql(String source, String library, String version) {
        String normalized = library(library);
        if (version == null || !VERSION.matcher(version).matches() || version.length() > 50) throw new IllegalArgumentException("Invalid version");
        String create = "CREATE or REPLACE FUNCTION sqltools.CMD_RUN(";
        if (source.indexOf(create) < 0 || source.indexOf(create) != source.lastIndexOf(create)) {
            throw new IllegalArgumentException("Unexpected CMD_RUN SQL CREATE statement");
        }
        String sql = source.replace(create, "CREATE FUNCTION sqltools.CMD_RUN(")
                .replaceAll("(?i)\\bsqltools\\.CMD_RUN\\b", Matcher.quoteReplacement(normalized + ".CMD_RUN"))
                .replace("'SQLTOOLS/CMD_RUN'", "'" + normalized + "/CMD_RUN'")
                .replace("${version}", version);
        if (Pattern.compile("(?i)\\bsqltools\\b").matcher(sql).find() && !normalized.equals("SQLTOOLS")) {
            throw new IllegalArgumentException("Unexpected SQLTOOLS reference in CMD_RUN SQL");
        }
        return sql;
    }

    static List<String> lines(String source) {
        List<String> lines = source.lines().toList();
        if (lines.size() > 999999) throw new IllegalArgumentException("Too many source records");
        for (String line : lines) {
            if (!StandardCharsets.US_ASCII.newEncoder().canEncode(line) || line.length() > 100) {
                throw new IllegalArgumentException("CMD_RUN source must use ASCII lines of at most 100 bytes");
            }
        }
        return lines;
    }

    static String sourceMemberText(String sql) {
        Matcher label = Pattern.compile("(?is)\\bLABEL\\s+ON\\s+SPECIFIC\\s+ROUTINE\\s+[^\\s]+\\s+IS\\s+'((?:''|[^'])*)'\\s*;").matcher(sql);
        if (!label.find()) throw new IllegalArgumentException("CMD_RUN SQL routine label is missing");
        String text = label.group(1).replace("''", "'");
        if (label.find() || !StandardCharsets.US_ASCII.newEncoder().canEncode(text) || text.length() > 50) {
            throw new IllegalArgumentException("CMD_RUN routine label must be unique ASCII text of at most 50 bytes");
        }
        return text.replace("'", "''");
    }

    private static String qualified(String naming, String schema, String name) {
        return schema + (naming.equals("system") ? "/" : ".") + name;
    }

    static ObjectNode check(Connection connection, String naming, String requestedLibrary) throws SQLException {
        String library = library(requestedLibrary);
        boolean program = false;
        boolean routine = false;
        boolean matchingRoutine = false;
        int routineCount = 0;
        String installedVersion = null;
        String objects = qualified(naming, "QSYS2", "OBJECT_STATISTICS");
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT 1 FROM TABLE(" + objects + "(?, '*PGM', 'CMD_RUN')) AS O FETCH FIRST 1 ROW ONLY")) {
            statement.setString(1, library);
            try (ResultSet result = statement.executeQuery()) { program = result.next(); }
        }
        String routines = qualified(naming, "QSYS2", "SYSROUTINES");
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT ROUTINE_NAME, SPECIFIC_NAME, ROUTINE_TYPE, EXTERNAL_NAME, FUNCTION_TYPE, PARAMETER_STYLE, LONG_COMMENT, ROUTINE_TEXT, ROUTINE_SCHEMA, SPECIFIC_SCHEMA FROM " + routines
                    + " WHERE (ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'CMD_RUN')"
                    + " OR (SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = 'CMD_RUN')")) {
            statement.setString(1, library);
                statement.setString(2, library);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    routine = true;
                    routineCount++;
                    String externalName = result.getString(4);
                    if ("CMD_RUN".equals(result.getString(1)) && "CMD_RUN".equals(result.getString(2))
                            && "FUNCTION".equals(result.getString(3))
                            && "T".equals(result.getString(5)) && "DB2SQL".equals(result.getString(6))
                            && sameSchema(library, result.getString(9)) && sameSchema(library, result.getString(10))
                            && externalName != null && externalName.trim().equalsIgnoreCase(library + "/CMD_RUN")) {
                        matchingRoutine = true;
                        installedVersion = metadataVersion(result.getString(7), result.getString(8));
                    }
                }
            }
        }
        ObjectNode result = JsonNodeFactory.instance.objectNode();
        result.put("library", library);
        result.put("programExists", program);
        result.put("routineExists", routine);
        result.put("routineMatches", matchingRoutine);
        result.put("installed", program && matchingRoutine);
        if (!program || !matchingRoutine || routineCount != 1) installedVersion = null;
        if (installedVersion == null) result.putNull("installedVersion");
        else result.put("installedVersion", installedVersion);
        result.put("bundledVersion", version());
        result.put("versionStatus", versionStatus(installedVersion));
        return result;
    }

    private static boolean sameSchema(String library, String schema) {
        return schema != null && library.equals(schema.trim());
    }

    static void requireUpgradeable(Connection connection, String naming, String library, String expectedVersion) throws SQLException {
        if (expectedVersion == null || !VERSION.matcher(expectedVersion).matches()) {
            throw new IllegalArgumentException("expectedInstalledVersion must be a numeric installed version");
        }
        ObjectNode target = check(connection, naming, library);
        if (!target.path("installed").asBoolean() || !"older".equals(target.path("versionStatus").asText())
                || !expectedVersion.equals(target.path("installedVersion").asText())) {
            throw new IllegalStateException("CMD_RUN target is not a uniquely matching older installation at expected version "
                    + expectedVersion + "; check the target again before requesting an upgrade");
        }
    }

    static ObjectNode discover(Connection connection, String naming, String requestedLibrary) throws SQLException {
        String targetLibrary = library(requestedLibrary);
        ObjectNode target = check(connection, naming, targetLibrary);
        Set<String> schemas = new LinkedHashSet<>();
        schemas.add(targetLibrary);
        String routines = qualified(naming, "QSYS2", "SYSROUTINES");
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT DISTINCT ROUTINE_SCHEMA FROM " + routines + " WHERE ROUTINE_NAME = 'CMD_RUN'")) {
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    String schema = result.getString(1);
                    if (schema == null) continue;
                    schema = schema.trim();
                    try {
                        if (schema.equals(library(schema))) schemas.add(schema);
                    } catch (IllegalArgumentException ignored) {
                    }
                }
            }
        }
        ObjectNode best = target.path("installed").asBoolean() ? target : null;
        List<ObjectNode> installations = new ArrayList<>();
        for (String schema : schemas) {
            ObjectNode candidate = schema.equals(targetLibrary) ? target : check(connection, naming, schema);
            if (!candidate.path("installed").asBoolean()) continue;
            installations.add(candidate);
            if (best == null || preferred(candidate, best, targetLibrary)) best = candidate;
        }
        installations.sort(EnhancedSupport::compareInstallations);
        ObjectNode selected = target.path("installed").asBoolean() ? target : best;
        ObjectNode result = (selected == null ? target : selected).deepCopy();
        result.set("configuredTarget", target.deepCopy());
        var installedArray = result.putArray("installations");
        installations.forEach(candidate -> installedArray.add(candidate.deepCopy()));
        if (selected != null && best != null && !selected.path("installedVersion").isNull()
                && !best.path("installedVersion").isNull()
                && compareVersions(best.path("installedVersion").asText(), selected.path("installedVersion").asText()) > 0) {
            result.set("newerAvailable", best.deepCopy());
        }
        result.put("cppCompilerAvailable", cppCompilerLibraryExists(connection, naming));
        return result;
    }

    private static boolean cppCompilerLibraryExists(Connection connection, String naming) throws SQLException {
        String objects = qualified(naming, "QSYS2", "OBJECT_STATISTICS");
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT 1 FROM TABLE(" + objects + "(?, '*LIB', 'QCPPLE')) AS O FETCH FIRST 1 ROW ONLY")) {
            statement.setString(1, "QSYS");
            try (ResultSet result = statement.executeQuery()) { return result.next(); }
        }
    }

    private static void requireCppCompilerLibrary(Connection connection, String naming) throws SQLException {
        if (!cppCompilerLibraryExists(connection, naming)) {
            throw new IllegalStateException("IBM i C++ compiler library QCPPLE was not detected; "
                    + "No CMD_RUN source members were added or uploaded and no module was built");
        }
    }

    private static int compareInstallations(ObjectNode left, ObjectNode right) {
        String leftVersion = left.path("installedVersion").isNull() ? null : left.path("installedVersion").asText();
        String rightVersion = right.path("installedVersion").isNull() ? null : right.path("installedVersion").asText();
        if (leftVersion == null && rightVersion != null) return 1;
        if (leftVersion != null && rightVersion == null) return -1;
        if (leftVersion != null) {
            int comparison = compareVersions(rightVersion, leftVersion);
            if (comparison != 0) return comparison;
        }
        return left.path("library").asText().compareTo(right.path("library").asText());
    }

    private static boolean preferred(ObjectNode candidate, ObjectNode selected, String targetLibrary) {
        String candidateVersion = candidate.path("installedVersion").isNull() ? null : candidate.path("installedVersion").asText();
        String selectedVersion = selected.path("installedVersion").isNull() ? null : selected.path("installedVersion").asText();
        if (candidateVersion != null && selectedVersion == null) return true;
        if (candidateVersion == null && selectedVersion != null) return false;
        if (candidateVersion != null) {
            int comparison = compareVersions(candidateVersion, selectedVersion);
            if (comparison != 0) return comparison > 0;
        }
        String candidateLibrary = candidate.path("library").asText();
        String selectedLibrary = selected.path("library").asText();
        if (candidateLibrary.equals(targetLibrary) != selectedLibrary.equals(targetLibrary)) {
            return candidateLibrary.equals(targetLibrary);
        }
        return candidateLibrary.compareTo(selectedLibrary) < 0;
    }

    static ObjectNode install(Connection connection, String naming, String requestedLibrary) throws Exception {
        return install(connection, naming, requestedLibrary, ignored -> {});
    }

    static ObjectNode install(Connection connection, String naming, String requestedLibrary, Consumer<String> progress) throws Exception {
        String library = targetLibrary(requestedLibrary);
        Consumer<String> report = progress == null ? ignored -> {} : progress;
        if (!connection.getAutoCommit()) {
            throw new IllegalStateException("Enhanced support installation requires autoCommit=true; existing transactions are never committed");
        }
        report.accept("Checking for IBM i C++ compiler library QCPPLE...");
        requireCppCompilerLibrary(connection, naming);
        report.accept("C++ compiler library QCPPLE detected.");
        List<String> cpp = lines(resource("CMD_RUN.CPP"));
        String version = version();
        String sqlSource = rewriteSql(resource("CMD_RUN.SQL"), library, version);
        String memberText = sourceMemberText(sqlSource);
        List<String> sql = lines(sqlSource);
        ObjectNode before = check(connection, naming, library);
        if (before.path("programExists").asBoolean() || before.path("routineExists").asBoolean()) {
            throw new IllegalStateException("CMD_RUN collision in " + library + ": programExists="
                    + before.path("programExists").asBoolean() + ", routineExists="
                    + before.path("routineExists").asBoolean() + "; nothing was replaced");
        }
        String cppMember = "CMDRUNCPP";
        String sqlMember = "CMDRUNSQL";
        boolean sourceMembersStarted = false;
        String stage = "checking for existing source file " + library + "/QCOZZISRC";
        try {
            report.accept("Checking for existing source file " + library + "/QCOZZISRC...");
            if (sourceFileExists(connection, naming, library)) {
                stage = "validating existing source file " + library + "/QCOZZISRC";
                requireSourceFile(connection, naming, library);
                cppMember = tempName("C");
                sqlMember = tempName("S");
                report.accept("Reusing compatible source file " + library + "/QCOZZISRC; existing members will be left unchanged.");
            } else {
                stage = "creating source file " + library + "/QCOZZISRC";
                report.accept("Creating source file " + library + "/QCOZZISRC...");
                command(connection, naming, "CRTSRCPF FILE(" + library + "/QCOZZISRC) RCDLEN(142) MBR(*NONE) SYSTEM(*LCL)");
                stage = "verifying created source file " + library + "/QCOZZISRC";
                requireSourceFile(connection, naming, library);
                report.accept("Created and verified source file " + library + "/QCOZZISRC.");
            }
            stage = "adding C++ source member " + cppMember;
            command(connection, naming, "ADDPFM FILE(" + library + "/QCOZZISRC) MBR(" + cppMember + ") SRCTYPE(CPP) TEXT('" + memberText + "')");
            sourceMembersStarted = true;
            report.accept("Added C++ source member " + library + "/QCOZZISRC(" + cppMember + ").");
            stage = "uploading C++ source member " + cppMember;
            writeSource(connection, naming, library, cppMember, cpp);
            report.accept("Uploaded C++ source to " + library + "/QCOZZISRC(" + cppMember + ").");
            stage = "adding SQL source member " + sqlMember;
            command(connection, naming, "ADDPFM FILE(" + library + "/QCOZZISRC) MBR(" + sqlMember + ") SRCTYPE(SQL) TEXT('" + memberText + "')");
            report.accept("Added SQL source member " + library + "/QCOZZISRC(" + sqlMember + ").");
            stage = "uploading SQL source member " + sqlMember;
            writeSource(connection, naming, library, sqlMember, sql);
            report.accept("Uploaded SQL source to " + library + "/QCOZZISRC(" + sqlMember + ").");
            stage = "checking target objects before compilation";
            ObjectNode recheck = check(connection, naming, library);
            if (recheck.path("programExists").asBoolean() || recheck.path("routineExists").asBoolean()) {
                throw new IllegalStateException("CMD_RUN target appeared during installation; nothing was replaced");
            }
            stage = "compiling CMD_RUN module";
            command(connection, naming, "CRTCPPMOD MODULE(" + library + "/CMD_RUN) SRCFILE(" + library
                    + "/QCOZZISRC) SRCMBR(" + cppMember + ") OUTPUT(*PRINT) OPTIMIZE(30) DBGVIEW(*SOURCE) LANGLVL(*EXTENDED0X) SYSIFCOPT(*IFS64IO) REPLACE(*NO) AUT(*ALL) TGTRLS(*CURRENT) OPTION(*NOEVENTF *LONGLONG)");
            report.accept("Compiled module " + library + "/CMD_RUN from " + cppMember + ".");
            stage = "binding CMD_RUN program";
            command(connection, naming, "CRTPGM PGM(" + library + "/CMD_RUN) MODULE(" + library
                    + "/CMD_RUN) ACTGRP(*CALLER) DETAIL(*FULL) REPLACE(*NO) AUT(*ALL) TGTRLS(*CURRENT)"
                    + " TEXT('" + version + " - Run CL commands via QCAPCMD')");
            report.accept("Created program " + library + "/CMD_RUN.");
            stage = "checking target program and routine before registration";
            ObjectNode afterBind = check(connection, naming, library);
            if (!afterBind.path("programExists").asBoolean()) {
                throw new IllegalStateException("CMD_RUN program was not found after CRTPGM; SQL registration was not attempted. Inspect the CRTPGM job log and listing");
            }
            if (afterBind.path("routineExists").asBoolean()) {
                throw new IllegalStateException("CMD_RUN routine appeared during installation; it was not replaced");
            }
            stage = "registering CMD_RUN with RUNSQLSTM";
            command(connection, naming, "RUNSQLSTM SRCFILE(" + library
                    + "/QCOZZISRC) SRCMBR(" + sqlMember + ") COMMIT(*NONE) NAMING(*SQL) MARGINS(100) ERRLVL(10)");
                report.accept("Registered SQL function " + library + ".CMD_RUN from " + sqlMember + ".");
            stage = "verifying target objects";
            ObjectNode result = check(connection, naming, library);
            if (!result.path("installed").asBoolean()) throw new IllegalStateException("CMD_RUN target verification failed");
            result.put("version", version);
            result.put("cppMember", cppMember);
            result.put("sqlMember", sqlMember);
            report.accept("Verified " + library + ".CMD_RUN version " + version + ".");
            return result;
        } catch (Exception exception) {
            if (!sourceMembersStarted) {
                report.accept("No source members were added or uploaded; compilation and SQL registration were not attempted.");
                throw new IllegalStateException("Enhanced support installation stopped before source upload while " + stage + ": "
                        + exception.getMessage() + ". No source members were added or uploaded; compilation and SQL registration were not attempted.", exception);
            }
            throw new IllegalStateException("Enhanced support installation failed while " + stage + ": "
                    + exception.getMessage() + ". " + library + "/QCOZZISRC may be pre-existing or may contain retained,"
                    + " possibly partial source members; it was not removed. Target objects may be partially installed; inspect "
                    + library + "/CMD_RUN and QCOZZISRC before attempting installation again. No automatic retry was made.", exception);
        }
    }

    static ObjectNode upgrade(Connection connection, String naming, String requestedLibrary, String expectedVersion) throws Exception {
        String library = targetLibrary(requestedLibrary);
        if (!connection.getAutoCommit()) {
            throw new IllegalStateException("Enhanced support upgrade requires autoCommit=true; existing transactions are never committed");
        }
        requireCppCompilerLibrary(connection, naming);
        List<String> cpp = lines(resource("CMD_RUN.CPP"));
        String sqlSource = rewriteSql(resource("CMD_RUN.SQL"), library, version())
                .replace("CREATE FUNCTION " + library + ".CMD_RUN(", "CREATE OR REPLACE FUNCTION " + library + ".CMD_RUN(");
        String memberText = sourceMemberText(sqlSource);
        List<String> sql = lines(sqlSource);
        requireUpgradeable(connection, naming, library, expectedVersion);
        String cppMember = tempName("C");
        String sqlMember = tempName("S");
        String module = tempName("M");
        String stage = "verifying existing source file";
        try {
            requireSourceFile(connection, naming, library);
            stage = "adding new source members";
            command(connection, naming, "ADDPFM FILE(" + library + "/QCOZZISRC) MBR(" + cppMember
                    + ") SRCTYPE(CPP) TEXT('" + memberText + "')");
            command(connection, naming, "ADDPFM FILE(" + library + "/QCOZZISRC) MBR(" + sqlMember
                    + ") SRCTYPE(SQL) TEXT('" + memberText + "')");
            stage = "writing new source members";
            writeSource(connection, naming, library, cppMember, cpp);
            writeSource(connection, naming, library, sqlMember, sql);
            stage = "compiling new module";
            command(connection, naming, "CRTCPPMOD MODULE(" + library + "/" + module + ") SRCFILE(" + library
                    + "/QCOZZISRC) SRCMBR(" + cppMember + ") OUTPUT(*PRINT) OPTIMIZE(30) DBGVIEW(*SOURCE) LANGLVL(*EXTENDED0X) SYSIFCOPT(*IFS64IO) REPLACE(*NO) AUT(*ALL) TGTRLS(*CURRENT) OPTION(*NOEVENTF *LONGLONG)");
            stage = "rechecking target immediately before program replacement";
            requireUpgradeable(connection, naming, library, expectedVersion);
            stage = "replacing CMD_RUN program";
            command(connection, naming, "CRTPGM PGM(" + library + "/CMD_RUN) MODULE(" + library + "/" + module
                    + ") ENTMOD(" + library + "/" + module + ") ACTGRP(*CALLER) DETAIL(*FULL) REPLACE(*YES) AUT(*ALL) TGTRLS(*CURRENT)"
                    + " TEXT('" + version() + " - Run CL commands via QCAPCMD')");
            stage = "rechecking target immediately before routine replacement";
            requireUpgradeable(connection, naming, library, expectedVersion);
            stage = "registering CMD_RUN with RUNSQLSTM";
            command(connection, naming, "RUNSQLSTM SRCFILE(" + library + "/QCOZZISRC) SRCMBR(" + sqlMember
                    + ") COMMIT(*NONE) NAMING(*SQL) MARGINS(100) ERRLVL(10)");
            stage = "verifying target objects";
            ObjectNode result = check(connection, naming, library);
            if (!result.path("installed").asBoolean() || !version().equals(result.path("installedVersion").asText())) {
                throw new IllegalStateException("CMD_RUN target verification failed");
            }
            result.put("version", version());
            result.put("previousVersion", expectedVersion);
            result.put("cppMember", cppMember);
            result.put("sqlMember", sqlMember);
            result.put("module", module);
            return result;
        } catch (Exception exception) {
            throw new IllegalStateException("Enhanced support upgrade failed while " + stage + ": " + exception.getMessage()
                    + ". Source members " + cppMember + ", " + sqlMember + " and module " + module + " in " + library
                    + " may be absent, pre-existing, or retained and incomplete. The program or routine may already have changed; inspect the target, source members, module and host job log. No retry, rollback or deletion was performed.", exception);
        }
    }

    static ObjectNode repair(Connection connection, String naming, String requestedLibrary) throws Exception {
        String library = targetLibrary(requestedLibrary);
        if (!connection.getAutoCommit()) {
            throw new IllegalStateException("Enhanced support repair requires autoCommit=true; existing transactions are never committed");
        }
        requireCppCompilerLibrary(connection, naming);
        List<String> cpp = lines(resource("CMD_RUN.CPP"));
        String sqlSource = rewriteSql(resource("CMD_RUN.SQL"), library, version());
        String memberText = sourceMemberText(sqlSource);
        List<String> sql = lines(sqlSource);
        requireRepairable(connection, naming, library);
        String cppMember = tempName("C");
        String sqlMember = tempName("S");
        String module = tempName("M");
        String stage = "checking source file";
        try {
            if (sourceFileExists(connection, naming, library)) {
                requireSourceFile(connection, naming, library);
            } else {
                stage = "creating source file";
                command(connection, naming, "CRTSRCPF FILE(" + library + "/QCOZZISRC) RCDLEN(142) MBR(*NONE) SYSTEM(*LCL)");
                stage = "verifying source file";
                requireSourceFile(connection, naming, library);
            }
            stage = "adding new source members";
            command(connection, naming, "ADDPFM FILE(" + library + "/QCOZZISRC) MBR(" + cppMember
                    + ") SRCTYPE(CPP) TEXT('" + memberText + "')");
            command(connection, naming, "ADDPFM FILE(" + library + "/QCOZZISRC) MBR(" + sqlMember
                    + ") SRCTYPE(SQL) TEXT('" + memberText + "')");
            stage = "writing new source members";
            writeSource(connection, naming, library, cppMember, cpp);
            writeSource(connection, naming, library, sqlMember, sql);
            stage = "compiling new module";
            command(connection, naming, "CRTCPPMOD MODULE(" + library + "/" + module + ") SRCFILE(" + library
                    + "/QCOZZISRC) SRCMBR(" + cppMember + ") OUTPUT(*PRINT) OPTIMIZE(30) DBGVIEW(*SOURCE) LANGLVL(*EXTENDED0X) SYSIFCOPT(*IFS64IO) REPLACE(*NO) AUT(*ALL) TGTRLS(*CURRENT) OPTION(*NOEVENTF *LONGLONG)");
            stage = "rechecking target immediately before program replacement";
            requireRepairable(connection, naming, library);
            stage = "replacing CMD_RUN program";
            command(connection, naming, "CRTPGM PGM(" + library + "/CMD_RUN) MODULE(" + library + "/" + module
                    + ") ENTMOD(" + library + "/" + module + ") ACTGRP(*CALLER) DETAIL(*FULL) REPLACE(*YES) AUT(*ALL) TGTRLS(*CURRENT)"
                    + " TEXT('" + version() + " - Run CL commands via QCAPCMD')");
            stage = "rechecking target immediately before routine registration";
            requireRepairable(connection, naming, library);
            stage = "registering CMD_RUN with RUNSQLSTM";
            command(connection, naming, "RUNSQLSTM SRCFILE(" + library + "/QCOZZISRC) SRCMBR(" + sqlMember
                    + ") COMMIT(*NONE) NAMING(*SQL) MARGINS(100) ERRLVL(10)");
            stage = "verifying target objects";
            ObjectNode result = check(connection, naming, library);
            if (!result.path("installed").asBoolean() || !version().equals(result.path("installedVersion").asText())) {
                throw new IllegalStateException("CMD_RUN target verification failed");
            }
            result.put("version", version());
            result.put("cppMember", cppMember);
            result.put("sqlMember", sqlMember);
            result.put("module", module);
            return result;
        } catch (Exception exception) {
            throw new IllegalStateException("Enhanced support repair failed while " + stage + ": " + exception.getMessage()
                    + ". " + library + "/QCOZZISRC, source members " + cppMember + ", " + sqlMember + " and module " + module
                    + " may be absent, pre-existing, or retained and incomplete. The program may already have been replaced and the routine may be absent or partially registered; inspect the target, artifacts and host job log. No retry, rollback or deletion was performed.", exception);
        }
    }

    private static void requireRepairable(Connection connection, String naming, String library) throws SQLException {
        ObjectNode target = check(connection, naming, library);
        if (!target.path("programExists").asBoolean() || target.path("routineExists").asBoolean()) {
            throw new IllegalStateException("CMD_RUN target is not program-only (programExists=true, routineExists=false); check the target again before requesting repair");
        }
    }

    private static boolean sourceFileExists(Connection connection, String naming, String library) throws SQLException {
        String objects = qualified(naming, "QSYS2", "OBJECT_STATISTICS");
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT 1 FROM TABLE(" + objects + "(?, '*FILE', 'QCOZZISRC')) AS O FETCH FIRST 1 ROW ONLY")) {
            statement.setString(1, library);
            try (ResultSet result = statement.executeQuery()) { return result.next(); }
        }
    }

    private static void requireSourceFile(Connection connection, String naming, String library) throws SQLException {
        String tables = qualified(naming, "QSYS2", "SYSTABLES");
        String columns = qualified(naming, "QSYS2", "SYSCOLUMNS");
        String query = "SELECT 1 FROM " + tables + " T WHERE T.SYSTEM_TABLE_SCHEMA = ?"
                + " AND T.SYSTEM_TABLE_NAME = 'QCOZZISRC' AND T.TABLE_TYPE = 'P' AND T.FILE_TYPE = 'S'"
                + " AND EXISTS (SELECT 1 FROM " + columns + " C WHERE C.SYSTEM_TABLE_SCHEMA = T.SYSTEM_TABLE_SCHEMA"
                + " AND C.SYSTEM_TABLE_NAME = T.SYSTEM_TABLE_NAME AND C.SYSTEM_COLUMN_NAME = 'SRCDTA'"
                + " AND C.COLUMN_NAME = 'SRCDTA' AND C.DATA_TYPE = 'CHAR' AND C.CHARACTER_MAXIMUM_LENGTH >= 100"
                + " AND C.CCSID <> 65535)";
        try (PreparedStatement statement = connection.prepareStatement(query)) {
            statement.setString(1, library);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next() || result.next()) {
                    throw new IllegalStateException(library + "/QCOZZISRC cannot be verified as a source physical file with at least 100 character source data; no source members were added");
                }
            }
        }
    }

    private static String tempName(String prefix) {
        return prefix + UUID.randomUUID().toString().replace("-", "").substring(0, 9).toUpperCase(Locale.ROOT);
    }

    private static void command(Connection connection, String naming, String command) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "CALL " + qualified(naming, "QSYS2", "QCMDEXC") + "(?)")) {
            statement.setString(1, command);
            statement.execute();
        }
    }

    private static void writeSource(Connection connection, String naming, String library, String member, List<String> source) throws SQLException {
        String table = qualified(naming, "QTEMP", tempName("A"));
        try (PreparedStatement statement = connection.prepareStatement("CREATE ALIAS " + table + " FOR "
                + qualified(naming, library, "QCOZZISRC") + "(" + member + ")")) {
            statement.execute();
        }
        SQLException writeFailure = null;
        try {
            insertSource(connection, table, source);
        } catch (SQLException exception) {
            writeFailure = exception;
            throw exception;
        } finally {
            try (PreparedStatement statement = connection.prepareStatement("DROP ALIAS " + table)) {
                statement.execute();
            } catch (SQLException cleanup) {
                if (writeFailure != null) {
                    throw new SQLException("Source write failed: " + writeFailure.getMessage()
                            + "; cleanup failed for " + table + ": " + cleanup.getMessage(), writeFailure);
                }
                throw new SQLException("Cleanup failed for " + table + ": " + cleanup.getMessage(), cleanup);
            }
        }
    }

    private static void insertSource(Connection connection, String table, List<String> source) throws SQLException {
        String insert = "INSERT INTO " + table + " (SRCSEQ, SRCDAT, SRCDTA) VALUES "
                + "(CAST(? AS NUMERIC(6,2)), CAST(? AS NUMERIC(6,0)), CAST(? AS VARCHAR(100)))";
        try (PreparedStatement statement = connection.prepareStatement(insert)) {
            for (int index = 0; index < source.size(); index++) {
                statement.setBigDecimal(1, BigDecimal.valueOf(index + 1, 2));
                statement.setInt(2, 0);
                statement.setString(3, source.get(index));
                statement.addBatch();
                if ((index + 1) % 250 == 0) statement.executeBatch();
            }
            if (source.size() % 250 != 0) statement.executeBatch();
        }
    }

    private EnhancedSupport() {}
}