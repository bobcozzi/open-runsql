package com.cozziresearch.ibmi.bridge;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.Proxy;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

class EnhancedSupportTest {
    @Test
    void validatesLibraryNames() {
        assertEquals("MY_LIB1", EnhancedSupport.library("my_lib1"));
        assertEquals("#LIB$@", EnhancedSupport.library("#lib$@"));
        for (String value : new String[] { "", "QTEMP", "qsys", "*LIBL", "foo.bar", "abc/def", "123", "TOO_LONG_NAME", " x", "é" }) {
            assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.library(value), value);
        }
    }

    @Test
    void targetLibrariesAreValidatedBeforeAnyHostAccess() throws Exception {
        assertEquals("QGPL", EnhancedSupport.targetLibrary("qGpL"));
        assertEquals("SQLTOOLS", EnhancedSupport.targetLibrary("sqltools"));
        Connection noAccess = proxy(Connection.class, (method, arguments) -> { throw new AssertionError("host access: " + method); });
        for (String value : List.of("QSYS", "qsys", "QTEMP", "qtemp", "QFOO", "qFoo")) {
            assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.install(noAccess, "sql", value), value);
            assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.upgrade(noAccess, "sql", value, "0.1.0"), value);
        }
        assertTrue(EnhancedSupport.install(new FakeHost().connection(), "sql", "qgpl").path("installed").asBoolean());
        assertTrue(EnhancedSupport.upgrade(olderHost().connection(), "sql", "qgpl", "0.1.0").path("installed").asBoolean());
    }

    @Test
    void protocolRejectsForbiddenTargetsBeforeHostAccess() throws Exception {
        Connection noAccess = proxy(Connection.class, (method, arguments) -> { throw new AssertionError("host access: " + method); });
        Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
        Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
        constructor.setAccessible(true);
        var sessionsField = Main.class.getDeclaredField("SESSIONS");
        sessionsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Object> sessions = (Map<String, Object>) sessionsField.get(null);
        sessions.put("forbidden-target-test", constructor.newInstance(noAccess, null, "sql"));
        try {
            Method dispatch = Main.class.getDeclaredMethod("dispatch", JsonNode.class);
            dispatch.setAccessible(true);
            for (String operation : List.of("installEnhancedSupport", "upgradeEnhancedSupport", "repairEnhancedSupport")) {
                for (String library : List.of("QSYS", "qsys", "QTEMP", "qtemp", "QFOO", "qFoo")) {
                    JsonNode request = new ObjectMapper().readTree("{\"op\":\"" + operation
                            + "\",\"connectionId\":\"forbidden-target-test\",\"library\":\"" + library
                            + "\",\"expectedInstalledVersion\":\"0.1.0\"}");
                    var failure = assertThrows(java.lang.reflect.InvocationTargetException.class, () -> dispatch.invoke(null, request));
                    assertInstanceOf(IllegalArgumentException.class, failure.getCause());
                    assertTrue(failure.getCause().getMessage().contains("except QGPL"));
                }
            }
        } finally {
            sessions.remove("forbidden-target-test");
        }
    }

    @Test
    void packagesAndRewritesCurrentSources() throws Exception {
        String cpp = EnhancedSupport.resource("CMD_RUN.CPP");
        String sql = EnhancedSupport.rewriteSql(EnhancedSupport.resource("CMD_RUN.SQL"), "MYLIB", EnhancedSupport.version());
        assertTrue(cpp.contains("QCAPCMD"));
        assertTrue(sql.contains("CREATE FUNCTION MYLIB.CMD_RUN("));
        assertTrue(sql.contains("SPECIFIC MYLIB.CMD_RUN"));
        assertTrue(sql.contains("EXTERNAL NAME 'MYLIB/CMD_RUN'"));
        assertEquals("0.2.1", EnhancedSupport.version());
        assertTrue(sql.contains("'0.2.1 - Run or Check CL commands via QCAPCMD'"));
        assertTrue(sql.contains("'0.2.1 - CL Command Processor"));
        assertFalse(sql.contains("${version}"));
        assertFalse(sql.toUpperCase().contains("SQLTOOLS"));
        assertFalse(sql.toUpperCase().contains("CREATE OR REPLACE"));
        assertFalse(EnhancedSupport.lines(cpp).isEmpty());
        assertFalse(EnhancedSupport.lines(sql).isEmpty());
        assertTrue(EnhancedSupport.rewriteSql(EnhancedSupport.resource("CMD_RUN.SQL"), "#A$B", "1")
            .contains("CREATE FUNCTION #A$B.CMD_RUN("));
    }

    @Test
    void rejectsUnexpectedSourceAndUnsafeRecords() {
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.rewriteSql("CREATE FUNCTION x", "LIB", "1"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.rewriteSql("CREATE or REPLACE FUNCTION sqltools.CMD_RUN( SQLTOOLS/OTHER", "LIB", "1"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.lines("a".repeat(101)));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.lines("é"));
    }

    @Test
    void validatesSourceMemberLabelLengthAndEscaping() {
        String prefix = "LABEL ON SPECIFIC ROUTINE LIB.CMD_RUN IS '";
        assertEquals("x".repeat(50), EnhancedSupport.sourceMemberText(prefix + "x".repeat(50) + "';"));
        assertEquals("1.0 - user''s source", EnhancedSupport.sourceMemberText(prefix + "1.0 - user''s source';"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.sourceMemberText(prefix + "x".repeat(51) + "';"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.sourceMemberText(prefix + "é';"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.sourceMemberText("no label"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.sourceMemberText(prefix + "one'; " + prefix + "two';"));
    }

    @Test
    void checkingSupportDoesNotInstall() throws Exception {
        FakeHost host = new FakeHost();
        var result = EnhancedSupport.check(host.connection(), "sql", "LIB");
        assertFalse(result.path("installed").asBoolean());
        assertTrue(result.path("installedVersion").isNull());
        assertEquals("0.2.1", result.path("bundledVersion").asText());
        assertEquals("unknown", result.path("versionStatus").asText());
        assertTrue(host.queries.stream().anyMatch(query -> query.contains("LONG_COMMENT, ROUTINE_TEXT, ROUTINE_SCHEMA, SPECIFIC_SCHEMA FROM QSYS2.SYSROUTINES")));
        assertTrue(host.commands.isEmpty());
        assertTrue(host.inserts.isEmpty());
        assertTrue(host.queries.stream().noneMatch(query -> query.startsWith("CREATE ")));
    }

    @Test
    void installsWithBothNamingModesAndOnlyTouchesOwnedSources() throws Exception {
        for (String naming : List.of("system", "sql")) {
            FakeHost host = new FakeHost();
            var result = EnhancedSupport.install(host.connection(), naming, "mylib");
            assertTrue(result.path("installed").asBoolean());
            assertEquals("MYLIB", result.path("library").asText());
            assertEquals(1, host.commands.stream().filter(command -> command.equals("CRTSRCPF FILE(MYLIB/QCOZZISRC) RCDLEN(142) MBR(*NONE) SYSTEM(*LCL)")).count());
            assertEquals(2, host.commands.stream().filter(command -> command.startsWith("ADDPFM FILE(MYLIB/QCOZZISRC)")).count());
            assertTrue(host.commands.contains("ADDPFM FILE(MYLIB/QCOZZISRC) MBR(CMDRUNCPP) SRCTYPE(CPP) TEXT('0.2.1 - Run or Check CL commands via QCAPCMD')"));
            assertTrue(host.commands.contains("ADDPFM FILE(MYLIB/QCOZZISRC) MBR(CMDRUNSQL) SRCTYPE(SQL) TEXT('0.2.1 - Run or Check CL commands via QCAPCMD')"));
            assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLTF") || command.startsWith("RMVM")));
            assertEquals(2, host.inserts.size());
            assertTrue(host.sourceRecords.stream().anyMatch(record -> record.contains("'0.2.1 - Run or Check CL commands via QCAPCMD'")));
            assertTrue(host.sourceRecords.stream().anyMatch(record -> record.contains("'0.2.1 - CL Command Processor")));
            String separator = naming.equals("system") ? "/" : ".";
            assertTrue(host.queries.stream().anyMatch(query -> query.startsWith("CALL QSYS2" + separator + "QCMDEXC")));
            assertTrue(host.inserts.stream().allMatch(query -> query.startsWith("INSERT INTO QTEMP" + separator)));
            assertTrue(host.queries.stream().anyMatch(query -> query.contains("MYLIB" + separator + "QCOZZISRC(CMDRUNCPP)")));
            assertTrue(host.queries.stream().anyMatch(query -> query.contains("MYLIB" + separator + "QCOZZISRC(CMDRUNSQL)")));
            assertEquals(2, host.queries.stream().filter(query -> query.startsWith("DROP ALIAS ")).count());
            assertTrue(host.records > 1000);
            assertTrue(host.commands.stream().anyMatch(command -> command.startsWith("CRTCPPMOD MODULE(MYLIB/CMD_RUN) SRCFILE(MYLIB/QCOZZISRC) SRCMBR(CMDRUNCPP)") && command.contains("OPTIMIZE(30) DBGVIEW(*SOURCE) LANGLVL(*EXTENDED0X) SYSIFCOPT(*IFS64IO) REPLACE(*NO) AUT(*ALL) TGTRLS(*CURRENT)")));
            assertTrue(host.commands.stream().anyMatch(command -> command.equals("CRTPGM PGM(MYLIB/CMD_RUN) MODULE(MYLIB/CMD_RUN) ACTGRP(*CALLER) DETAIL(*FULL) REPLACE(*NO) AUT(*ALL) TGTRLS(*CURRENT) TEXT('0.2.1 - Run CL commands via QCAPCMD')")));
            String programText = host.commands.stream().filter(command -> command.startsWith("CRTPGM "))
                .findFirst().orElseThrow().split(" TEXT\\('", 2)[1].replaceFirst("'\\)$", "");
            assertTrue(StandardCharsets.US_ASCII.newEncoder().canEncode(programText));
            assertTrue(programText.getBytes(StandardCharsets.US_ASCII).length <= 50);
            assertTrue(host.commands.stream().anyMatch(command -> command.contains("SRCFILE(MYLIB/QCOZZISRC) SRCMBR(CMDRUNSQL) COMMIT(*NONE) NAMING(*SQL) MARGINS(100)")));
        }
    }

    @Test
    void installationProgressOnlyReportsUploadsAfterSuccessfulWrites() throws Exception {
        FakeHost failed = new FakeHost();
        failed.failPrefix = "CRTSRCPF";
        List<String> failedProgress = new ArrayList<>();
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(failed.connection(), "system", "LIB", failedProgress::add));
        assertEquals(List.of("Checking for IBM i C++ compiler library QCPPLE...", "C++ compiler library QCPPLE detected.",
            "Checking for existing source file LIB/QCOZZISRC...", "Creating source file LIB/QCOZZISRC...",
            "No source members were added or uploaded; compilation and SQL registration were not attempted."), failedProgress);
        assertTrue(failure.getMessage().contains("compilation and SQL registration were not attempted"));
        assertFalse(failedProgress.stream().anyMatch(message -> message.startsWith("Uploaded")));

        FakeHost host = new FakeHost();
        List<String> progress = new ArrayList<>();
        EnhancedSupport.install(host.connection(), "system", "LIB", progress::add);
        assertTrue(progress.contains("Uploaded C++ source to LIB/QCOZZISRC(CMDRUNCPP)."));
        assertTrue(progress.contains("Uploaded SQL source to LIB/QCOZZISRC(CMDRUNSQL)."));
        assertTrue(progress.indexOf("Uploaded C++ source to LIB/QCOZZISRC(CMDRUNCPP).")
                < progress.indexOf("Uploaded SQL source to LIB/QCOZZISRC(CMDRUNSQL)."));
        assertEquals("Verified LIB.CMD_RUN version 0.2.1.", progress.get(progress.size() - 1));
    }

    @Test
    void installReusesCompatibleSourceFileAndAppendsMembersInAddUploadOrder() throws Exception {
        FakeHost host = new FakeHost();
        host.sourceFileExists = true;
        List<String> originalCpp = List.of("pre-existing C++ source");
        List<String> originalSql = List.of("pre-existing SQL source");
        host.members.put("CMDRUNCPP", new ArrayList<>(originalCpp));
        host.members.put("CMDRUNSQL", new ArrayList<>(originalSql));
        List<String> progress = new ArrayList<>();
        var result = EnhancedSupport.install(host.connection(), "system", "LIB", progress::add);
        String cppMember = result.path("cppMember").asText();
        String sqlMember = result.path("sqlMember").asText();
        assertTrue(result.path("installed").asBoolean());
        assertTrue(cppMember.matches("C[0-9A-F]{9}"));
        assertTrue(sqlMember.matches("S[0-9A-F]{9}"));
        assertFalse(host.commands.stream().anyMatch(command -> command.startsWith("CRTSRCPF")));
        assertTrue(host.commands.contains("ADDPFM FILE(LIB/QCOZZISRC) MBR(" + cppMember + ") SRCTYPE(CPP) TEXT('0.2.1 - Run or Check CL commands via QCAPCMD')"));
        assertTrue(host.commands.contains("ADDPFM FILE(LIB/QCOZZISRC) MBR(" + sqlMember + ") SRCTYPE(SQL) TEXT('0.2.1 - Run or Check CL commands via QCAPCMD')"));
        assertTrue(host.commands.stream().anyMatch(command -> command.contains("SRCFILE(LIB/QCOZZISRC) SRCMBR(" + cppMember + ")")));
        assertTrue(host.commands.stream().anyMatch(command -> command.contains("SRCFILE(LIB/QCOZZISRC) SRCMBR(" + sqlMember + ")")));
        assertEquals(originalCpp, host.members.get("CMDRUNCPP"));
        assertEquals(originalSql, host.members.get("CMDRUNSQL"));
        assertTrue(host.members.get(cppMember).stream().anyMatch(line -> line.contains("QCAPCMD")));
        assertTrue(host.members.get(sqlMember).stream().anyMatch(line -> line.contains("CREATE FUNCTION LIB.CMD_RUN")));
        int addCpp = progress.indexOf("Added C++ source member LIB/QCOZZISRC(" + cppMember + ").");
        int uploadCpp = progress.indexOf("Uploaded C++ source to LIB/QCOZZISRC(" + cppMember + ").");
        int addSql = progress.indexOf("Added SQL source member LIB/QCOZZISRC(" + sqlMember + ").");
        int uploadSql = progress.indexOf("Uploaded SQL source to LIB/QCOZZISRC(" + sqlMember + ").");
        assertTrue(addCpp >= 0 && addCpp < uploadCpp && uploadCpp < addSql && addSql < uploadSql, progress.toString());
    }

    @Test
    void installRejectsIncompatibleExistingSourceFileBeforeAddingMembers() throws Exception {
        FakeHost host = new FakeHost();
        host.sourceFileExists = true;
        host.sourceFileSafe = false;
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(host.connection(), "system", "LIB"));
        assertTrue(failure.getMessage().contains("cannot be verified as a source physical file"));
        assertTrue(failure.getMessage().contains("No source members were added or uploaded"));
        assertTrue(host.commands.isEmpty());
        assertTrue(host.inserts.isEmpty());
    }

    @Test
    void missingCppCompilerStopsBeforeSourceFileOrMemberChanges() throws Exception {
        FakeHost host = new FakeHost();
        host.cppCompilerLibraryExists = false;
        List<String> progress = new ArrayList<>();
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(host.connection(), "system", "LIB", progress::add));
        assertTrue(failure.getMessage().contains("C++ compiler library QCPPLE was not detected"));
        assertTrue(failure.getMessage().contains("No CMD_RUN source members were added or uploaded"));
        assertTrue(host.commands.isEmpty());
        assertTrue(host.inserts.isEmpty());
        assertEquals(List.of("Checking for IBM i C++ compiler library QCPPLE..."), progress);

        var discovery = EnhancedSupport.discover(host.connection(), "system", "LIB");
        assertFalse(discovery.path("cppCompilerAvailable").asBoolean());
    }

    @Test
    void installationChecksOnlyConfiguredTargetEvenWhenAnotherSchemaHasSupport() throws Exception {
        FakeHost host = new FakeHost();
        host.foreignLibrary = "OTHER";
        var result = EnhancedSupport.install(host.connection(), "sql", "TARGET");
        assertTrue(result.path("installed").asBoolean());
        assertTrue(host.checkedLibraries.stream().allMatch("TARGET"::equals));
        assertTrue(host.queries.stream().noneMatch(query -> query.startsWith("SELECT DISTINCT ROUTINE_SCHEMA")));
    }

    @Test
    void rejectsExistingObjectsAndUncommittedSessions() throws Exception {
        FakeHost host = new FakeHost();
        host.program = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "system", "LIB"));
        assertTrue(host.commands.isEmpty());
        host.program = false;
        host.routine = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "sql", "LIB"));
        assertTrue(host.commands.isEmpty());
        host.autoCommit = false;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "sql", "LIB"));
        assertTrue(host.commands.isEmpty());
    }

    @Test
    void failureRetainsSourcesAndDoesNotRetry() throws Exception {
        FakeHost host = new FakeHost();
        host.failPrefix = "RUNSQLSTM";
        Exception exception = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(host.connection(), "system", "LIB"));
        assertTrue(exception.getMessage().contains("partially installed"));
        assertEquals(1, host.commands.stream().filter(command -> command.startsWith("RUNSQLSTM")).count());
        assertTrue(exception.getMessage().contains("LIB/QCOZZISRC"));
        assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLTF") || command.startsWith("RMVM")));
        assertTrue(host.program);
        assertFalse(host.routine);
    }

    @Test
    void bindingFailureStopsBeforeRegisteringRoutine() throws Exception {
        FakeHost host = new FakeHost();
        host.failPrefix = "CRTPGM";
        Exception exception = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(host.connection(), "sql", "LIB"));
        assertTrue(exception.getMessage().contains("binding CMD_RUN program"));
        assertEquals(1, host.commands.stream().filter(command -> command.startsWith("CRTCPPMOD")).count());
        assertEquals(1, host.commands.stream().filter(command -> command.startsWith("CRTPGM")).count());
        assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("RUNSQLSTM")));
        assertFalse(host.program);
        assertFalse(host.routine);
    }

    @Test
    void missingProgramAfterBindStopsBeforeRegisteringRoutine() throws Exception {
        for (String naming : List.of("sql", "system")) {
            FakeHost host = new FakeHost();
            host.programMissingOnObjectCheck = 3;
            Exception exception = assertThrows(IllegalStateException.class,
                    () -> EnhancedSupport.install(host.connection(), naming, "LIB"));
            assertTrue(exception.getMessage().contains("program was not found after CRTPGM"));
            assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("RUNSQLSTM")));
            assertFalse(host.routine);
        }
    }

    @Test
    void sourceFileCreationFailureStopsBeforeAddingMembers() throws Exception {
        FakeHost host = new FakeHost();
        host.failPrefix = "CRTSRCPF";
        Exception exception = assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "system", "LIB"));
        assertTrue(exception.getMessage().contains("creating source file LIB/QCOZZISRC"));
        assertTrue(exception.getMessage().contains("No source members were added or uploaded"));
        assertEquals(1, host.commands.size());
        assertTrue(host.inserts.isEmpty());
    }

    @Test
    void memberCollisionStopsBeforeWritingAndRetainsFile() throws Exception {
        FakeHost host = new FakeHost();
        host.failPrefix = "ADDPFM FILE(LIB/QCOZZISRC) MBR(CMDRUNSQL)";
        Exception exception = assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "sql", "LIB"));
        assertTrue(exception.getMessage().contains("adding SQL source member CMDRUNSQL"));
        assertEquals(1, host.inserts.size());
        assertTrue(host.members.get("CMDRUNCPP").stream().anyMatch(line -> line.contains("QCAPCMD")));
        assertFalse(host.members.containsKey("CMDRUNSQL"));
        assertEquals(3, host.commands.size());
        assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLTF") || command.startsWith("RMVM")));
    }

    @Test
    void failedWriteAndAliasCleanupBothReportedWithoutRemovingSources() throws Exception {
        FakeHost host = new FakeHost();
        host.failBatch = true;
        host.failDropAlias = true;
        Exception exception = assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "sql", "LIB"));
        assertTrue(exception.getMessage().contains("Source write failed: batch failure"));
        assertTrue(exception.getMessage().contains("cleanup failed for QTEMP."));
        assertTrue(exception.getMessage().contains("alias cleanup failure"));
        assertTrue(exception.getMessage().contains("possibly partial source members"));
        assertEquals(1, host.queries.stream().filter(query -> query.startsWith("DROP ALIAS ")).count());
        assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLTF") || command.startsWith("RMVM")));
    }

    @Test
    void aliasCollisionDoesNotDropExistingAliasOrWriteSource() throws Exception {
        FakeHost host = new FakeHost();
        host.failCreateAlias = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.install(host.connection(), "sql", "LIB"));
        assertTrue(host.inserts.isEmpty());
        assertTrue(host.queries.stream().noneMatch(query -> query.startsWith("DROP ALIAS ")));
    }

    @Test
    void targetAppearingBeforeCompileOrRegistrationIsNotReplaced() throws Exception {
        FakeHost beforeCompile = new FakeHost();
        beforeCompile.programOnObjectCheck = 2;
        Exception compileFailure = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(beforeCompile.connection(), "sql", "LIB"));
        assertTrue(compileFailure.getMessage().contains("target appeared"));
        assertTrue(beforeCompile.commands.stream().noneMatch(command -> command.startsWith("CRTCPPMOD")));
        FakeHost beforeRegister = new FakeHost();
        beforeRegister.routineOnObjectCheck = 3;
        Exception routineFailure = assertThrows(IllegalStateException.class,
                () -> EnhancedSupport.install(beforeRegister.connection(), "sql", "LIB"));
        assertTrue(routineFailure.getMessage().contains("routine appeared"));
        assertTrue(beforeRegister.commands.stream().noneMatch(command -> command.startsWith("RUNSQLSTM")));
        assertTrue(beforeRegister.program);
    }

    @Test
    void parsesAndComparesVersionsConservatively() {
        assertEquals("1.10.0", EnhancedSupport.metadataVersion(" \n 1.10.0 - comment", "1.10 - label"));
        assertEquals("0.2.1", EnhancedSupport.metadataVersion(null, " 0.2.1 - label"));
        assertEquals("0.2.1", EnhancedSupport.metadataVersion("Unversioned comment", "0.2.1 - label"));
        assertEquals("0.2.1", EnhancedSupport.metadataVersion("0.2.1 - comment", "Unversioned label"));
        assertNull(EnhancedSupport.metadataVersion("  ", null));
        for (String invalid : List.of("0.2.1-rc", "0.2.1.", "0.2..0", "0.2.1abc")) {
            assertNull(EnhancedSupport.metadataVersion(invalid, "0.2.1 - label"), invalid);
        }
        assertNull(EnhancedSupport.metadataVersion("0.1.0 - comment", "0.2.1 - label"));
        assertEquals("older", EnhancedSupport.versionStatus("0.1.99"));
        assertEquals("older", EnhancedSupport.versionStatus("0.2"));
        assertEquals("current", EnhancedSupport.versionStatus("0.2.1"));
        assertEquals("newer", EnhancedSupport.versionStatus("0.10.0"));
        assertEquals("newer", EnhancedSupport.versionStatus("999999999999999999999.0"));
        assertEquals("unknown", EnhancedSupport.versionStatus(null));
        assertEquals("unknown", EnhancedSupport.versionStatus("0.2.1oops"));
    }

    @Test
    void upgradeGuardRequiresExactUnambiguousOlderTarget() throws Exception {
        FakeHost host = new FakeHost();
        host.program = true;
        host.routine = true;
        host.comment = "0.1.0 - comment";
        EnhancedSupport.requireUpgradeable(host.connection(), "sql", "LIB", "0.1.0");
        for (String expected : List.of("0.1", "0.2.1", "0.0.1", "0.1.0oops")) {
            assertThrows(RuntimeException.class, () -> EnhancedSupport.requireUpgradeable(host.connection(), "sql", "LIB", expected));
        }
        host.multipleRoutines = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.requireUpgradeable(host.connection(), "sql", "LIB", "0.1.0"));
        host.multipleRoutines = false;
        host.comment = "0.2.1 - current";
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.requireUpgradeable(host.connection(), "sql", "LIB", "0.2.1"));
        host.comment = "0.3.0 - newer";
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.requireUpgradeable(host.connection(), "sql", "LIB", "0.3.0"));
        assertTrue(host.commands.isEmpty());
    }

    @Test
    void upgradesWithNewMembersAndModuleInBothNamingModes() throws Exception {
        for (String naming : List.of("sql", "system")) {
            FakeHost host = olderHost();
            host.foreignLibrary = "OTHER";
            var result = EnhancedSupport.upgrade(host.connection(), naming, "lib", "0.1.0");
            String cpp = result.path("cppMember").asText();
            String sql = result.path("sqlMember").asText();
            String module = result.path("module").asText();
            assertTrue(cpp.matches("C[0-9A-F]{9}"));
            assertTrue(sql.matches("S[0-9A-F]{9}"));
            assertTrue(module.matches("M[0-9A-F]{9}"));
            assertEquals("0.1.0", result.path("previousVersion").asText());
            assertEquals("0.2.1", result.path("installedVersion").asText());
            assertEquals(2, host.commands.stream().filter(command -> command.startsWith("ADDPFM ")).count());
            assertTrue(host.commands.contains("ADDPFM FILE(LIB/QCOZZISRC) MBR(" + cpp + ") SRCTYPE(CPP) TEXT('0.2.1 - Run or Check CL commands via QCAPCMD')"));
            assertTrue(host.commands.contains("ADDPFM FILE(LIB/QCOZZISRC) MBR(" + sql + ") SRCTYPE(SQL) TEXT('0.2.1 - Run or Check CL commands via QCAPCMD')"));
            assertTrue(host.commands.stream().anyMatch(command -> command.startsWith("CRTCPPMOD MODULE(LIB/" + module + ")") && command.contains("REPLACE(*NO)")));
            assertTrue(host.commands.stream().anyMatch(command -> command.contains("MODULE(LIB/" + module + ") ENTMOD(LIB/" + module + ") ACTGRP(*CALLER)" ) && command.contains("REPLACE(*YES) AUT(*ALL)")));
            assertTrue(host.commands.stream().anyMatch(command -> command.startsWith("RUNSQLSTM ") && command.contains("SRCMBR(" + sql + ")")));
            assertTrue(host.sourceRecords.stream().anyMatch(record -> record.contains("CREATE OR REPLACE FUNCTION LIB.CMD_RUN(")));
            assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("CRTSRCPF") || command.startsWith("DLT") || command.startsWith("RMVM")));
            assertTrue(host.checkedLibraries.stream().allMatch("LIB"::equals));
            assertEquals(4, host.objectChecks);
            assertEquals(List.of("original CPP"), host.members.get("CMDRUNCPP"));
            assertEquals(List.of("original SQL"), host.members.get("CMDRUNSQL"));
            assertTrue(host.members.get(cpp).stream().anyMatch(record -> record.contains("QCAPCMD")));
            assertTrue(host.members.get(sql).stream().anyMatch(record -> record.contains("CREATE OR REPLACE FUNCTION")));
        }
    }

    @Test
    void upgradeRefusesUnsafeSourceFilesAndUnsafeTargetsBeforeMutation() throws Exception {
        FakeHost host = olderHost();
        host.sourceFileSafe = false;
        Exception exception = assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(host.connection(), "sql", "LIB", "0.1.0"));
        assertTrue(exception.getMessage().contains("cannot be verified"));
        assertTrue(host.commands.isEmpty());
        assertTrue(host.queries.stream().anyMatch(query -> query.contains("T.TABLE_TYPE = 'P' AND T.FILE_TYPE = 'S'")
                && query.contains("C.CHARACTER_MAXIMUM_LENGTH >= 100") && query.contains("C.CCSID <> 65535")));
        FakeHost unsafe = olderHost();
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.upgrade(unsafe.connection(), "sql", "LIB/EVIL", "0.1.0"));
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(unsafe.connection(), "sql", "LIB", "0.0.9"));
        unsafe.autoCommit = false;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(unsafe.connection(), "sql", "LIB", "0.1.0"));
        assertTrue(unsafe.commands.isEmpty());
    }

    @Test
    void upgradeRefusesMissingMismatchedOrConflictingTarget() throws Exception {
        for (String mismatch : List.of("program", "routine", "external", "unknown", "conflict", "ambiguous")) {
            FakeHost host = olderHost();
            switch (mismatch) {
                case "program" -> host.program = false;
                case "routine" -> host.routine = false;
                case "external" -> host.matchingRoutine = false;
                case "unknown" -> host.comment = host.label = null;
                case "conflict" -> host.label = "0.2.1";
                case "ambiguous" -> host.multipleRoutines = true;
            }
            assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(host.connection(), "sql", "LIB", "0.1.0"), mismatch);
            assertTrue(host.commands.isEmpty(), mismatch);
        }
    }

    @Test
    void successiveUpgradesNeverReusePriorSourceMembers() throws Exception {
        FakeHost host = olderHost();
        var first = EnhancedSupport.upgrade(host.connection(), "sql", "LIB", "0.1.0");
        String oldCpp = first.path("cppMember").asText();
        String oldSql = first.path("sqlMember").asText();
        List<String> oldCppRecords = List.copyOf(host.members.get(oldCpp));
        List<String> oldSqlRecords = List.copyOf(host.members.get(oldSql));
        host.comment = host.label = "0.1.0";
        var second = EnhancedSupport.upgrade(host.connection(), "sql", "LIB", "0.1.0");
        assertNotEquals(oldCpp, second.path("cppMember").asText());
        assertNotEquals(oldSql, second.path("sqlMember").asText());
        assertEquals(oldCppRecords, host.members.get(oldCpp));
        assertEquals(oldSqlRecords, host.members.get(oldSql));
        assertEquals(List.of("original CPP"), host.members.get("CMDRUNCPP"));
    }

    @Test
    void upgradeStopsOnCollisionsAndFailuresWithoutRetryOrDeletion() throws Exception {
        for (String prefix : List.of("ADDPFM", "CRTCPPMOD", "CRTPGM", "RUNSQLSTM")) {
            FakeHost host = olderHost();
            host.failPrefix = prefix;
            Exception exception = assertThrows(IllegalStateException.class,
                    () -> EnhancedSupport.upgrade(host.connection(), "sql", "LIB", "0.1.0"));
            assertTrue(exception.getMessage().contains("No retry, rollback or deletion"));
            assertEquals(1, host.commands.stream().filter(command -> command.startsWith(prefix)).count());
            assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLT") || command.startsWith("RMVM")));
            if (prefix.equals("ADDPFM")) assertTrue(host.inserts.isEmpty());
            if (prefix.equals("RUNSQLSTM")) assertTrue(host.programReplaced);
            else assertFalse(host.commands.stream().anyMatch(command -> command.startsWith("RUNSQLSTM")));
        }
        FakeHost alias = olderHost();
        alias.failCreateAlias = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(alias.connection(), "sql", "LIB", "0.1.0"));
        assertTrue(alias.inserts.isEmpty());
        assertTrue(alias.queries.stream().noneMatch(query -> query.startsWith("DROP ALIAS")));
        FakeHost secondMember = olderHost();
        secondMember.failMemberNumber = 2;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(secondMember.connection(), "sql", "LIB", "0.1.0"));
        assertEquals(3, secondMember.members.size());
        assertTrue(secondMember.inserts.isEmpty());
        assertEquals(List.of("original CPP"), secondMember.members.get("CMDRUNCPP"));
        assertEquals(List.of("original SQL"), secondMember.members.get("CMDRUNSQL"));
        FakeHost batch = olderHost();
        batch.failBatch = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.upgrade(batch.connection(), "sql", "LIB", "0.1.0"));
        assertTrue(batch.commands.stream().noneMatch(command -> command.startsWith("CRTCPPMOD")));
    }

    @Test
    void upgradeRechecksBeforeProgramAndRoutineReplacement() throws Exception {
        for (int changedAt : List.of(2, 3)) {
            FakeHost host = olderHost();
            host.versionChangeOnObjectCheck = changedAt;
            Exception exception = assertThrows(IllegalStateException.class,
                    () -> EnhancedSupport.upgrade(host.connection(), "sql", "LIB", "0.1.0"));
            assertTrue(exception.getMessage().contains("rechecking target"));
            assertEquals(changedAt == 2 ? 0 : 1, host.commands.stream().filter(command -> command.startsWith("CRTPGM")).count());
            assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("RUNSQLSTM")));
        }
    }

    @Test
    void upgradeProtocolUsesExplicitConfirmedVersion() throws Exception {
        FakeHost host = olderHost();
        Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
        Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
        constructor.setAccessible(true);
        var sessionsField = Main.class.getDeclaredField("SESSIONS");
        sessionsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Object> sessions = (Map<String, Object>) sessionsField.get(null);
        sessions.put("upgrade-test", constructor.newInstance(host.connection(), null, "sql"));
        try {
            Method dispatch = Main.class.getDeclaredMethod("dispatch", JsonNode.class);
            dispatch.setAccessible(true);
            JsonNode missing = new ObjectMapper().readTree("{\"op\":\"upgradeEnhancedSupport\",\"connectionId\":\"upgrade-test\",\"library\":\"LIB\"}");
            assertThrows(java.lang.reflect.InvocationTargetException.class, () -> dispatch.invoke(null, missing));
            assertTrue(host.commands.isEmpty());
            JsonNode request = new ObjectMapper().readTree("{\"op\":\"upgradeEnhancedSupport\",\"connectionId\":\"upgrade-test\",\"library\":\"LIB\",\"expectedInstalledVersion\":\"0.1.0\"}");
            JsonNode response = (JsonNode) dispatch.invoke(null, request);
            assertTrue(response.path("ok").asBoolean());
            assertEquals("0.2.1", response.path("result").path("installedVersion").asText());
        } finally {
            sessions.remove("upgrade-test");
        }
    }

    private static FakeHost olderHost() {
        FakeHost host = new FakeHost();
        host.sourceFileExists = true;
        host.program = true;
        host.routine = true;
        host.comment = "0.1.0 - comment";
        host.label = "0.1.0 - label";
        host.members.put("CMDRUNCPP", new ArrayList<>(List.of("original CPP")));
        host.members.put("CMDRUNSQL", new ArrayList<>(List.of("original SQL")));
        return host;
    }

    @Test
    void repairsProgramOnlyWithExistingOrNewSourceFileInBothNamingModes() throws Exception {
        for (String naming : List.of("sql", "system")) {
            for (boolean existing : List.of(false, true)) {
                FakeHost host = new FakeHost();
                host.program = true;
                host.sourceFileExists = existing;
                if (existing) host.members.put("ORIGINAL", new ArrayList<>(List.of("untouched")));
                var result = EnhancedSupport.repair(host.connection(), naming, "qgpl");
                String cpp = result.path("cppMember").asText();
                String sql = result.path("sqlMember").asText();
                String module = result.path("module").asText();
                assertTrue(cpp.matches("C[0-9A-F]{9}"));
                assertTrue(sql.matches("S[0-9A-F]{9}"));
                assertTrue(module.matches("M[0-9A-F]{9}"));
                assertEquals("QGPL", result.path("library").asText());
                assertEquals("0.2.1", result.path("installedVersion").asText());
                assertTrue(result.path("installed").asBoolean());
                assertEquals(existing ? 0 : 1, host.commands.stream().filter(command -> command.startsWith("CRTSRCPF ")).count());
                assertTrue(host.queries.stream().anyMatch(query -> query.contains("SYSTABLES") && query.contains("CHARACTER_MAXIMUM_LENGTH >= 100")));
                assertTrue(host.commands.stream().anyMatch(command -> command.startsWith("CRTCPPMOD MODULE(QGPL/" + module + ")") && command.contains("REPLACE(*NO)")));
                assertTrue(host.commands.stream().anyMatch(command -> command.contains("MODULE(QGPL/" + module + ") ENTMOD(QGPL/" + module + ") ACTGRP(*CALLER)") && command.contains("REPLACE(*YES) AUT(*ALL)") && command.contains("TEXT('0.2.1 - Run CL commands via QCAPCMD')")));
                assertTrue(host.members.get(sql).stream().anyMatch(record -> record.contains("CREATE FUNCTION QGPL.CMD_RUN(")));
                assertTrue(host.members.get(sql).stream().noneMatch(record -> record.contains("CREATE OR REPLACE FUNCTION")));
                assertTrue(host.modules.contains(module));
                assertEquals(4, host.objectChecks);
                assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLT") || command.startsWith("RMVM")));
                if (existing) assertEquals(List.of("untouched"), host.members.get("ORIGINAL"));
            }
        }
    }

    @Test
    void repairRejectsUnsafeTargetsAndIncompatibleFileWithoutWrites() throws Exception {
        for (String state : List.of("missing", "routineOnly", "matching", "mismatch", "multiple")) {
            FakeHost host = new FakeHost();
            host.program = !state.equals("missing") && !state.equals("routineOnly");
            host.routine = !state.equals("missing");
            host.matchingRoutine = !state.equals("mismatch");
            host.multipleRoutines = state.equals("multiple");
            assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(host.connection(), "sql", "LIB"), state);
            assertTrue(host.commands.isEmpty(), state);
            assertTrue(host.inserts.isEmpty(), state);
        }
        FakeHost invalid = new FakeHost();
        invalid.program = true;
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.repair(invalid.connection(), "sql", "QFOO"));
        assertThrows(IllegalArgumentException.class, () -> EnhancedSupport.repair(invalid.connection(), "sql", "LIB/EVIL"));
        invalid.autoCommit = false;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(invalid.connection(), "sql", "LIB"));
        assertTrue(invalid.queries.isEmpty());
        FakeHost incompatible = new FakeHost();
        incompatible.program = true;
        incompatible.sourceFileExists = true;
        incompatible.sourceFileSafe = false;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(incompatible.connection(), "sql", "LIB"));
        assertTrue(incompatible.commands.isEmpty());
        assertTrue(incompatible.inserts.isEmpty());
    }

    @Test
    void repairStopsOnRacesAndFailedCreateOperationsWithoutRetryOrDeletion() throws Exception {
        for (int changedAt : List.of(2, 3)) {
            for (boolean programDisappears : List.of(false, true)) {
                FakeHost host = new FakeHost();
                host.program = true;
                if (programDisappears) host.programMissingOnObjectCheck = changedAt;
                else host.routineOnObjectCheck = changedAt;
                Exception failure = assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(host.connection(), "sql", "LIB"));
                assertTrue(failure.getMessage().contains("rechecking target"));
                assertEquals(changedAt == 2 ? 0 : 1, host.commands.stream().filter(command -> command.startsWith("CRTPGM")).count());
                assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("RUNSQLSTM")));
            }
        }
        for (String prefix : List.of("CRTSRCPF", "ADDPFM", "CRTCPPMOD", "CRTPGM", "RUNSQLSTM")) {
            FakeHost host = new FakeHost();
            host.program = true;
            host.failPrefix = prefix;
            Exception failure = assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(host.connection(), "sql", "LIB"));
            assertTrue(failure.getMessage().contains("No retry, rollback or deletion"));
            assertTrue(failure.getMessage().contains("program may already have been replaced"));
            assertEquals(1, host.commands.stream().filter(command -> command.startsWith(prefix)).count());
            assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("DLT") || command.startsWith("RMVM")));
            assertEquals(prefix.equals("RUNSQLSTM"), host.programReplaced);
            if (!prefix.equals("RUNSQLSTM")) assertTrue(host.commands.stream().noneMatch(command -> command.startsWith("RUNSQLSTM")));
        }
        FakeHost collision = new FakeHost();
        collision.program = true;
        collision.sourceFileExists = true;
        collision.members.put("ORIGINAL", new ArrayList<>(List.of("untouched")));
        collision.failMemberNumber = 2;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(collision.connection(), "sql", "LIB"));
        assertEquals(List.of("untouched"), collision.members.get("ORIGINAL"));
        assertTrue(collision.inserts.isEmpty());
        assertEquals(2, collision.memberAttempts);
    }

    @Test
    void repairCreateTimeRacesDoNotOverwriteFileModuleOrRoutine() throws Exception {
        FakeHost fileRace = new FakeHost();
        fileRace.program = true;
        fileRace.sourceFileAppearsOnCreate = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(fileRace.connection(), "sql", "LIB"));
        assertEquals(1, fileRace.commands.size());
        assertTrue(fileRace.inserts.isEmpty());

        FakeHost moduleRace = new FakeHost();
        moduleRace.program = true;
        moduleRace.moduleAppearsOnCreate = true;
        assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(moduleRace.connection(), "sql", "LIB"));
        assertFalse(moduleRace.programReplaced);
        assertEquals(1, moduleRace.modules.size());

        FakeHost routineRace = new FakeHost();
        routineRace.program = true;
        routineRace.routineAppearsOnRegister = true;
        Exception failure = assertThrows(IllegalStateException.class, () -> EnhancedSupport.repair(routineRace.connection(), "system", "LIB"));
        assertTrue(failure.getMessage().contains("registering CMD_RUN"));
        assertTrue(routineRace.programReplaced);
        assertTrue(routineRace.routine);
        assertTrue(routineRace.queries.stream().anyMatch(query -> query.contains("(ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'CMD_RUN')")
                && query.contains("(SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = 'CMD_RUN')")));
        assertEquals(1, routineRace.commands.stream().filter(command -> command.startsWith("RUNSQLSTM")).count());
    }

    @Test
    void repairProtocolRequiresExplicitBooleanExpectedState() throws Exception {
        FakeHost host = new FakeHost();
        host.program = true;
        Class<?> sessionClass = Class.forName("com.cozziresearch.ibmi.bridge.Main$Session");
        Constructor<?> constructor = sessionClass.getDeclaredConstructor(Connection.class, com.ibm.as400.access.AS400.class, String.class);
        constructor.setAccessible(true);
        var sessionsField = Main.class.getDeclaredField("SESSIONS");
        sessionsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Object> sessions = (Map<String, Object>) sessionsField.get(null);
        sessions.put("repair-test", constructor.newInstance(host.connection(), null, "sql"));
        try {
            Method dispatch = Main.class.getDeclaredMethod("dispatch", JsonNode.class);
            dispatch.setAccessible(true);
            for (String expected : List.of("null", "{}", "{\"programExists\":true}", "{\"programExists\":false,\"routineExists\":false}", "{\"programExists\":true,\"routineExists\":true}", "{\"programExists\":\"true\",\"routineExists\":false}")) {
                JsonNode request = new ObjectMapper().readTree("{\"op\":\"repairEnhancedSupport\",\"connectionId\":\"repair-test\",\"library\":\"LIB\",\"expectedState\":" + expected + "}");
                var failure = assertThrows(java.lang.reflect.InvocationTargetException.class, () -> dispatch.invoke(null, request));
                assertInstanceOf(IllegalArgumentException.class, failure.getCause());
                assertTrue(host.queries.isEmpty());
                assertTrue(host.commands.isEmpty());
            }
            JsonNode request = new ObjectMapper().readTree("{\"op\":\"repairEnhancedSupport\",\"connectionId\":\"repair-test\",\"library\":\"LIB\",\"expectedState\":{\"programExists\":true,\"routineExists\":false}}");
            JsonNode response = (JsonNode) dispatch.invoke(null, request);
            assertTrue(response.path("ok").asBoolean());
            assertEquals("0.2.1", response.path("result").path("installedVersion").asText());
        } finally {
            sessions.remove("repair-test");
        }
    }

    @Test
    void reportsVersionOnlyForUnambiguousInstalledRoutine() throws Exception {
        FakeHost host = new FakeHost();
        host.program = true;
        host.routine = true;
        host.comment = "0.1.0 - comment";
        host.label = "0.1.0 - label";
        var result = EnhancedSupport.check(host.connection(), "system", "LIB");
        assertTrue(result.path("installed").asBoolean());
        assertEquals("0.1.0", result.path("installedVersion").asText());
        assertEquals("older", result.path("versionStatus").asText());
        host.comment = "0.10.0 - comment";
        host.label = "0.10.0 - label";
        assertEquals("newer", EnhancedSupport.check(host.connection(), "sql", "LIB").path("versionStatus").asText());
        host.comment = "0.2.1 - comment";
        host.label = "0.2.1 - label";
        assertEquals("current", EnhancedSupport.check(host.connection(), "sql", "LIB").path("versionStatus").asText());
        host.comment = "0.1.0 - comment";
        host.label = "0.2.1 - label";
        result = EnhancedSupport.check(host.connection(), "sql", "LIB");
        assertTrue(result.path("installed").asBoolean());
        assertTrue(result.path("installedVersion").isNull());
        assertEquals("unknown", result.path("versionStatus").asText());
        host.label = null;
        host.multipleRoutines = true;
        result = EnhancedSupport.check(host.connection(), "sql", "LIB");
        assertTrue(result.path("installed").asBoolean());
        assertTrue(result.path("installedVersion").isNull());
        assertEquals("unknown", result.path("versionStatus").asText());
        host.multipleRoutines = false;
        host.matchingRoutine = false;
        result = EnhancedSupport.check(host.connection(), "sql", "LIB");
        assertFalse(result.path("installed").asBoolean());
        assertTrue(result.path("routineExists").asBoolean());
        assertEquals("unknown", result.path("versionStatus").asText());
        host.matchingRoutine = true;
        host.program = false;
        result = EnhancedSupport.check(host.connection(), "sql", "LIB");
        assertFalse(result.path("installed").asBoolean());
        assertEquals("unknown", result.path("versionStatus").asText());
        assertTrue(host.commands.isEmpty());
    }

    private static final class FakeHost {
        boolean autoCommit = true;
        boolean program;
        boolean routine;
        boolean multipleRoutines;
        boolean matchingRoutine = true;
        String comment;
        String label;
        boolean failBatch;
        boolean failCreateAlias;
        boolean failDropAlias;
        boolean sourceFileSafe = true;
        boolean sourceFileExists;
        boolean cppCompilerLibraryExists = true;
        boolean sourceFileAppearsOnCreate;
        boolean moduleAppearsOnCreate;
        boolean routineAppearsOnRegister;
        boolean programReplaced;
        int failMemberNumber;
        int memberAttempts;
        int objectChecks;
        int versionChangeOnObjectCheck;
        int programOnObjectCheck;
        int programMissingOnObjectCheck;
        int routineOnObjectCheck;
        String failPrefix = "";
        String foreignLibrary;
        int records;
        final List<String> checkedLibraries = new ArrayList<>();
        final List<String> commands = new ArrayList<>();
        final List<String> queries = new ArrayList<>();
        final List<String> inserts = new ArrayList<>();
        final List<String> sourceRecords = new ArrayList<>();
        final Map<String, List<String>> members = new HashMap<>();
        final Map<String, String> aliases = new HashMap<>();
        final Set<String> modules = new HashSet<>();

        Connection connection() {
            return proxy(Connection.class, (method, arguments) -> switch (method) {
                case "getAutoCommit" -> autoCommit;
                case "prepareStatement" -> statement((String) arguments[0]);
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method);
            });
        }

        PreparedStatement statement(String query) {
            queries.add(query);
            if (query.startsWith("INSERT")) inserts.add(query);
            Map<Integer, Object> values = new HashMap<>();
            return proxy(PreparedStatement.class, (method, arguments) -> switch (method) {
                case "setString", "setInt", "setBigDecimal" -> { values.put((Integer) arguments[0], arguments[1]); yield null; }
                case "executeQuery" -> rows(query, values);
                case "addBatch" -> {
                    records++;
                    String record = (String) values.get(3);
                    sourceRecords.add(record);
                    String table = query.substring("INSERT INTO ".length(), query.indexOf(" (SRCSEQ"));
                    members.get(aliases.get(table)).add(record);
                    yield null;
                }
                case "executeBatch" -> {
                    if (failBatch) throw new SQLException("batch failure");
                    yield new int[0];
                }
                case "execute" -> {
                    if (query.startsWith("CREATE ALIAS ")) {
                        if (failCreateAlias) throw new SQLException("alias collision");
                        String table = query.substring("CREATE ALIAS ".length(), query.indexOf(" FOR "));
                        String member = query.substring(query.lastIndexOf('(') + 1, query.lastIndexOf(')'));
                        aliases.put(table, member);
                        yield false;
                    }
                    if (query.startsWith("DROP ALIAS ")) {
                        if (failDropAlias) throw new SQLException("alias cleanup failure");
                        aliases.remove(query.substring("DROP ALIAS ".length()));
                        yield false;
                    }
                    String command = (String) values.get(1);
                    commands.add(command);
                    if (!failPrefix.isEmpty() && command.startsWith(failPrefix)) {
                        throw new SQLException("simulated failure");
                    }
                    if (command.startsWith("CRTSRCPF")) {
                        if (sourceFileAppearsOnCreate) sourceFileExists = true;
                        if (sourceFileExists) throw new SQLException("file collision");
                        sourceFileExists = true;
                    }
                    if (command.startsWith("ADDPFM")) {
                        if (!sourceFileExists) throw new SQLException("source file missing");
                        memberAttempts++;
                        String member = command.substring(command.indexOf(" MBR(") + 5, command.indexOf(") SRCTYPE"));
                        if (memberAttempts == failMemberNumber || members.containsKey(member)) throw new SQLException("member collision");
                        members.put(member, new ArrayList<>());
                    }
                    if (command.startsWith("CRTCPPMOD")) {
                        String module = command.substring(command.indexOf('/') + 1, command.indexOf(") SRCFILE"));
                        if (moduleAppearsOnCreate) modules.add(module);
                        if (!command.contains("REPLACE(*NO)") || !modules.add(module)) throw new SQLException("module collision");
                    }
                    if (command.startsWith("CRTPGM")) {
                        if (program && !command.contains("REPLACE(*YES)")) throw new SQLException("program collision");
                        if (!program && command.contains("REPLACE(*YES)")) throw new SQLException("program missing");
                        program = true;
                        programReplaced = command.contains("REPLACE(*YES)");
                    }
                    if (command.startsWith("RUNSQLSTM")) {
                        if (routineAppearsOnRegister) routine = true;
                        String member = command.substring(command.indexOf(" SRCMBR(") + 8, command.indexOf(") COMMIT"));
                        List<String> sql = members.get(member);
                        if (sql == null || sql.stream().noneMatch(record -> record.contains("CREATE FUNCTION ") || record.contains("CREATE OR REPLACE FUNCTION "))) throw new SQLException("missing CREATE FUNCTION");
                        if (routine && sql.stream().noneMatch(record -> record.contains("CREATE OR REPLACE FUNCTION "))) throw new SQLException("routine collision");
                        routine = true;
                        if (programReplaced) comment = label = EnhancedSupport.version();
                    }
                    yield false;
                }
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method);
            });
        }

        ResultSet rows(String query, Map<Integer, Object> values) {
            String library = (String) values.get(1);
            if (!query.contains("'QCPPLE'")) checkedLibraries.add(library);
            if (query.contains("OBJECT_STATISTICS") && query.contains("'*PGM'")) {
                objectChecks++;
                if (objectChecks == programOnObjectCheck) program = true;
                if (objectChecks == programMissingOnObjectCheck) program = false;
                if (objectChecks == routineOnObjectCheck) routine = true;
                if (objectChecks == versionChangeOnObjectCheck) comment = label = "0.3.0";
            }
            boolean present = query.startsWith("SELECT DISTINCT") ? false
                    : query.contains("'QCPPLE'") ? cppCompilerLibraryExists
                    : query.contains("SYSTABLES") ? sourceFileExists && sourceFileSafe
                    : query.contains("'*FILE'") ? sourceFileExists
                    : library.equals(foreignLibrary) || (query.contains("OBJECT_STATISTICS") ? program : routine);
            String[] row = { "CMD_RUN", "CMD_RUN", "FUNCTION", library + (matchingRoutine ? "/CMD_RUN" : "/OTHER"), "T", "DB2SQL", comment, label, library, library };
            int[] consumed = { 0 };
            return proxy(ResultSet.class, (method, arguments) -> switch (method) {
                case "next" -> present && consumed[0]++ < (multipleRoutines && !query.contains("OBJECT_STATISTICS") ? 2 : 1);
                case "getString" -> row[(Integer) arguments[0] - 1];
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