package com.cozziresearch.ibmi.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.ibm.as400.access.AS400;
import com.ibm.as400.access.AS400Message;
import com.ibm.as400.access.Command;
import com.ibm.as400.access.CommandCall;
import com.ibm.as400.access.ErrorCompletingRequestException;
import com.ibm.as400.access.PrintObject;
import com.ibm.as400.access.PrintObjectInputStream;
import com.ibm.as400.access.PrintObjectPageInputStream;
import com.ibm.as400.access.PrintObjectTransformedInputStream;
import com.ibm.as400.access.PrintParameterList;
import com.ibm.as400.access.SecureAS400;
import com.ibm.as400.access.SpooledFile;
import com.ibm.as400.access.SpooledFileList;

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
        // JT400 trace: writes to its own PrintWriter, not stderr — point it at
        // the bridge log file so NP-server return codes are captured.
        String traceLog = System.getenv("IBMI_BRIDGE_TRACE_LOG");
        if (traceLog != null && !traceLog.isBlank()) {
            com.ibm.as400.access.Trace.setFileName(traceLog);
            com.ibm.as400.access.Trace.setTraceErrorOn(true);
            com.ibm.as400.access.Trace.setTraceDiagnosticOn(true);
        }
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
                // Bidi string type: "" = driver default (JT400 picks per job
                // CCSID; ST5 today). Only appended when the profile sets one —
                // default connections get a byte-identical URL to before.
                String bidi = text(r, "bidiStringType", "").trim();
                if (!bidi.isEmpty() && !bidi.matches("-1|0|[45]|6|7|8|9|10|11"))
                    throw new IllegalArgumentException("bidiStringType must be one of -1,0,4,5,6,7,8,9,10,11");

                String url = "jdbc:as400://" + host + ";prompt=false;naming=" + naming
                        // Extended metadata: resolve column headings/labels fully.
                        + ";extended metadata=true;metadata source=-1"
                        // socket timeout=0 => no read ceiling on query/fetch:
                        // long-running SQL on latent links must not be killed
                        // mid-read (08S01 "Read timed out"). The user aborts
                        // via Cancel (Statement.cancel). keep-alive rides out
                        // Wi-Fi blips.
                        + ";socket timeout=0;keep alive=true";
                if (tls) url += ";secure=true";
                if (!bidi.isEmpty()) url += ";bidi string type=" + bidi;

                Properties props = new Properties();
                props.setProperty("user", user);
                props.setProperty("password", password);
                // Connect/login handshake bounded at the IBM i default 20s so a
                // dead host fails fast even with socket timeout=0 above.
                int timeout = r.path("timeoutSeconds").asInt(20);
                DriverManager.setLoginTimeout(Math.max(1, timeout));

                // Resolve first so DNS/lookup failures surface as the real
                // cause (UnknownHostException) rather than JT400's generic
                // "cannot establish the connection" wrapper.
                java.net.InetAddress.getByName(host);

                Connection c;
                try {
                    c = DriverManager.getConnection(url, props);
                } catch (SQLException first) {
                    // macOS can hand a transient EHOSTUNREACH to a socket created
                    // while a route/Wi-Fi flap is settling. One short retry rides
                    // it out — the kernel route cache has converged by then.
                    if (!isTransientConnectError(first)) throw first;
                    try { Thread.sleep(250); } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                    }
                    c = DriverManager.getConnection(url, props);
                }
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
                // CL/print services connection. CL can run long (CPYF etc.) and
                // has no cancel, so bound reads generously (120s) rather than
                // the fail-fast 15s. Spool listing overrides this to 300s around
                // its op (restored in finally).
                com.ibm.as400.access.SocketProperties sp = clSystem.getSocketProperties();
                sp.setSoTimeout(120_000);
                sp.setKeepAlive(true);
                clSystem.setSocketProperties(sp);
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
            case "listSpooledFiles" -> {
                Session s = session(r);
                out.set("result", listSpooledFiles(s,
                        text(r, "outqLib", ""), text(r, "outq", ""), text(r, "user", ""),
                        r.path("allUsers").asBoolean(false), r.path("allOutqs").asBoolean(false),
                        r.path("maxRows").asInt(0)));
            }
            case "cancelSpoolList" -> {
                Session s = session(r);
                SpooledFileList active = s.activeSpoolList;
                if (active != null) {
                    s.spoolListCancelled = true;
                    try { active.close(); } catch (Exception ignored) {}
                    out.put("cancelRequested", true);
                } else out.put("cancelRequested", false);
            }
            case "spooledFileAction" -> {
                Session s = session(r);
                out.set("result", spooledFileAction(s, required(r, "action"),
                        required(r, "name"), required(r, "number"), required(r, "jobName"),
                        required(r, "jobUser"), required(r, "jobNumber")));
            }
            case "getSpooledFileData" -> {
                Session s = session(r);
                out.set("result", getSpooledFileData(s, text(r, "format", "text"),
                        required(r, "name"), required(r, "number"), required(r, "jobName"),
                        required(r, "jobUser"), required(r, "jobNumber"), text(r, "devType", "")));
            }
            case "moveSpooledFile" -> {
                Session s = session(r);
                out.set("result", moveSpooledFile(s, required(r, "name"), required(r, "number"),
                        required(r, "jobName"), required(r, "jobUser"), required(r, "jobNumber"),
                        text(r, "toLibrary", ""), required(r, "toQueue"),
                        r.path("holdFirst").asBoolean(false)));
            }
            case "listOutputQueues" -> {
                Session s = session(r);
                out.set("result", listOutputQueues(s, text(r, "nameFilter", ""),
                        text(r, "libraryFilter", ""), r.path("limit").asInt(200)));
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

    // ATTR_OUTQUELIB/ATTR_OUTQUE are package-private constants in JT400's
    // PrintObject; the attribute IDs are stable wire-protocol values.
    private static final int ATTR_OUTQUELIB = 0x0049;
    private static final int ATTR_OUTQUE = 0x004A;

    // Spooled-file field fetcher: every getter is guarded per-field so one
    // unreadable attribute (authority, file gone mid-list) blanks that field
    // instead of failing the whole list.
    private interface SplfValue { Object get() throws Exception; }

    private static String splfStr(SplfValue g) {
        try {
            Object v = g.get();
            return v == null ? "" : nullToEmpty(String.valueOf(v).trim());
        } catch (Throwable t) {
            return "";
        }
    }

    private static long splfLong(SplfValue g) {
        try {
            Object v = g.get();
            return v instanceof Number n ? n.longValue() : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    // JT400 ATTR_DATE is CYYMMDD (C: 0=19xx, 1=20xx); convert to ISO YYYY-MM-DD.
    // Unexpected shapes come back as-is (trimmed) rather than failing.
    private static String splfDateIso(String cymmdd) {
        String d = cymmdd == null ? "" : cymmdd.trim();
        if (d.length() != 7) return d;
        try {
            int year = 1900 + Integer.parseInt(d.substring(0, 1)) * 100
                    + Integer.parseInt(d.substring(1, 3));
            return String.format(Locale.ROOT, "%04d-%s-%s", year, d.substring(3, 5), d.substring(5, 7));
        } catch (NumberFormatException e) {
            return d;
        }
    }

    // JT400 ATTR_TIME is HHMMSS; convert to ISO HH:MM:SS.
    private static String splfTimeIso(String hhmmss) {
        String v = hhmmss == null ? "" : hhmmss.trim();
        if (v.length() != 6) return v;
        return v.substring(0, 2) + ":" + v.substring(2, 4) + ":" + v.substring(4, 6);
    }

    private static ObjectNode listSpooledFiles(Session s, String outqLib, String outq,
            String user, boolean allUsers, boolean allOutqs, int maxRows) throws Exception {
        long started = System.nanoTime();
        // clSystem ops (executeCL/getCmdXml) do not take s.lock; the print
        // service is independent of the JDBC connection. Output-queue-not-found
        // and authority failures propagate to handleLine -> ok:false with the
        // host message text (shown in the frontend Messages pane).
        //
        // The NP server streams the list back chunk-by-chunk over a latent
        // link, so a 15s per-read SoTimeout kills large/slow lists mid-stream
        // ("Read timed out"). Relax the read timeout for the duration of this
        // op, then restore the connect-time 15s. getSocketProperties() returns
        // a COPY, so we must setSocketProperties() to apply it.
        com.ibm.as400.access.SocketProperties prior = s.clSystem.getSocketProperties();
        com.ibm.as400.access.SocketProperties relaxed = s.clSystem.getSocketProperties();
        relaxed.setSoTimeout(300_000); // 5 min per chunk-read while listing
        s.clSystem.setSocketProperties(relaxed);
        SpooledFileList list = new SpooledFileList(s.clSystem);
        s.activeSpoolList = list;
        s.spoolListCancelled = false;
        ArrayNode files = JSON.createArrayNode();
        long openMs = 0;
        long iterateMs = 0;
        boolean truncated = false;
        try {
            list.setUserFilter(allUsers ? "*ALL"
                    : (user == null || user.isBlank() ? "*CURRENT" : user.trim().toUpperCase(Locale.ROOT)));
            if (allOutqs) {
                // %ALL%/%ALL% is the only all-queues form JT400 accepts.
                list.setQueueFilter("/QSYS.LIB/%ALL%.LIB/%ALL%.OUTQ");
            } else if (outq != null && !outq.isBlank()) {
                String lib = outqLib == null || outqLib.isBlank()
                        ? "%LIBL%" : outqLib.trim().toUpperCase(Locale.ROOT);
                list.setQueueFilter("/QSYS.LIB/" + lib + ".LIB/"
                        + outq.trim().toUpperCase(Locale.ROOT) + ".OUTQ");
            }
            // Prefetch every attribute read below with the list entries
            // themselves — one host block per chunk instead of a round trip
            // per attribute per file.
            list.setAttributesToRetrieve(new int[] {
                    PrintObject.ATTR_USERDATA, ATTR_OUTQUE, ATTR_OUTQUELIB,
                    PrintObject.ATTR_PAGES, PrintObject.ATTR_SPLF_SIZE,
                    PrintObject.ATTR_SPLF_SIZE_MULT, PrintObject.ATTR_SPLFSTATUS,
                    PrintObject.ATTR_HOLD, PrintObject.ATTR_COPIES,
                    PrintObject.ATTR_PRINTER, PrintObject.ATTR_PRTDEVTYPE,
                    PrintObject.ATTR_DEVTYPE, PrintObject.ATTR_TOUSERID, PrintObject.ATTR_OUTPTY,
                    PrintObject.ATTR_JOBSYSTEM, PrintObject.ATTR_LPI });
            long openStart = System.nanoTime();
            list.openSynchronously();
            openMs = (System.nanoTime() - openStart) / 1_000_000L;
            long iterStart = System.nanoTime();
            Enumeration<SpooledFile> e = list.getObjects();
            // maxRows > 0 stops enumeration at the cap and closes the list —
            // the host open-list then stops producing, so giant queues never
            // fill the 16MB user space ("list is too large for user space").
            while (e.hasMoreElements()
                    && !(maxRows > 0 && files.size() >= maxRows)
                    && !s.spoolListCancelled) {
                SpooledFile f = e.nextElement();
                ObjectNode file = JSON.createObjectNode();
                file.put("name", splfStr(f::getName));
                file.put("number", splfStr(f::getNumber));
                file.put("jobName", splfStr(f::getJobName));
                file.put("jobUser", splfStr(f::getJobUser));
                file.put("jobNumber", splfStr(f::getJobNumber));
                file.put("userData", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_USERDATA)));
                file.put("outqName", splfStr(() -> f.getStringAttribute(ATTR_OUTQUE)));
                file.put("outqLib", splfStr(() -> f.getStringAttribute(ATTR_OUTQUELIB)));
                file.put("createDate", splfDateIso(splfStr(f::getCreateDate)));
                file.put("createTime", splfTimeIso(splfStr(f::getCreateTime)));
                file.put("pages", splfLong(() -> f.getIntegerAttribute(PrintObject.ATTR_PAGES)));
                // Byte size = SPLF_SIZE * SPLF_SIZE_MULT (multiplier may be 0/blank).
                long mult = splfLong(() -> f.getIntegerAttribute(PrintObject.ATTR_SPLF_SIZE_MULT));
                file.put("size", splfLong(() -> f.getIntegerAttribute(PrintObject.ATTR_SPLF_SIZE))
                        * (mult > 0 ? mult : 1));
                // Status values arrive as *READY/*HELD/etc. — drop the leading
                // asterisk for display (READY, HELD, OPEN, CLOSED).
                String status = splfStr(() -> f.getStringAttribute(PrintObject.ATTR_SPLFSTATUS));
                file.put("status", status.startsWith("*") ? status.substring(1) : status);
                file.put("holdStatus", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_HOLD)));
                file.put("copies", splfLong(() -> f.getIntegerAttribute(PrintObject.ATTR_COPIES)));
                file.put("printer", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_PRINTER)));
                file.put("printerDevType", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_PRTDEVTYPE)));
                // Data stream type: *SCS / *AFPDS / *USERASCII / ... — this
                // is ATTR_PRTDEVTYPE (what WRKSPLF shows as the printer file
                // device type). ATTR_DEVTYPE is only PRINTER/DISKETTE intent.
                file.put("deviceType", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_PRTDEVTYPE)));
                // "Created by" = TOUSERID when set, else the job's user.
                String createdBy = splfStr(() -> f.getStringAttribute(PrintObject.ATTR_TOUSERID));
                if (createdBy.isEmpty()) createdBy = splfStr(f::getJobUser);
                file.put("createdBy", createdBy);
                file.put("priority", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_OUTPTY)));
                file.put("jobSystem", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_JOBSYSTEM)));
                file.put("lpi", splfStr(() -> f.getStringAttribute(PrintObject.ATTR_LPI)));
                files.add(file);
            }
            truncated = maxRows > 0 && files.size() >= maxRows && e.hasMoreElements();
            iterateMs = (System.nanoTime() - iterStart) / 1_000_000L;
        } finally {
            try { list.close(); } catch (Exception ignored) {}
            s.activeSpoolList = null;
            // Restore the connect-time read timeout for CL/print ops.
            try { s.clSystem.setSocketProperties(prior); } catch (Exception ignored) {}
        }
        ObjectNode result = JSON.createObjectNode();
        result.put("kind", "spooledFiles");
        result.set("files", files);
        result.put("truncated", truncated);
        result.put("cancelled", s.spoolListCancelled);
        result.put("openMs", openMs);
        result.put("iterateMs", iterateMs);
        result.put("elapsedMs", elapsedMs(started));
        return result;
    }

    /** Locate one spooled file by identity (name/number/job triple). The list
        is filtered by job user to keep the scan small. The returned file's
        handle is valid only while `list` stays open — callers must keep the
        list referenced until the action/read completes. */
    private static SpooledFile findSpooledFile(SpooledFileList list, String name, String number,
            String jobName, String jobUser, String jobNumber) throws Exception {
        list.openSynchronously();
        Enumeration<SpooledFile> e = list.getObjects();
        while (e.hasMoreElements()) {
            SpooledFile f = e.nextElement();
            if (eqAttr(splfStr(f::getName), name) && eqAttr(splfStr(f::getNumber), number)
                    && eqAttr(splfStr(f::getJobName), jobName) && eqAttr(splfStr(f::getJobUser), jobUser)
                    && eqAttr(splfStr(f::getJobNumber), jobNumber)) {
                return f;
            }
        }
        return null;
    }

    private static SpooledFileList newListForUser(AS400 sys, String jobUser) throws Exception {
        SpooledFileList list = new SpooledFileList(sys);
        list.setUserFilter(jobUser == null || jobUser.isBlank() ? "*CURRENT"
                : jobUser.trim().toUpperCase(Locale.ROOT));
        return list;
    }

    private static boolean eqAttr(String a, String b) {
        return a.trim().equalsIgnoreCase(b == null ? "" : b.trim());
    }

    /** hold/release/delete on one spooled file. */
    private static ObjectNode spooledFileAction(Session s, String action, String name,
            String number, String jobName, String jobUser, String jobNumber) throws Exception {
        long started = System.nanoTime();
        SpooledFileList list = newListForUser(s.clSystem, jobUser);
        ObjectNode result = JSON.createObjectNode();
        try {
            SpooledFile f = findSpooledFile(list, name, number, jobName, jobUser, jobNumber);
            if (f == null) {
                result.put("ok", false);
                result.put("message", "Spooled file not found: " + name);
            } else {
                switch (action.toLowerCase(Locale.ROOT)) {
                    case "hold" -> f.hold("*IMMED");
                    case "release" -> f.release();
                    case "delete" -> f.delete();
                    default -> throw new IllegalArgumentException("Unknown spooled-file action: " + action);
                }
                result.put("ok", true);
                result.put("message", action + " " + name + " completed");
            }
        } finally {
            try { list.close(); } catch (Exception ignored) {}
        }
        result.put("elapsedMs", elapsedMs(started));
        return result;
    }

    /** Move a spooled file to another output queue. When holdFirst is set, the
        file is held on the SAME open list before the move so it cannot start
        printing on arrival at the target queue. */
    private static ObjectNode moveSpooledFile(Session s, String name, String number,
            String jobName, String jobUser, String jobNumber, String toLib, String toQueue,
            boolean holdFirst) throws Exception {
        long started = System.nanoTime();
        SpooledFileList list = newListForUser(s.clSystem, jobUser);
        ObjectNode result = JSON.createObjectNode();
        try {
            SpooledFile f = findSpooledFile(list, name, number, jobName, jobUser, jobNumber);
            if (f == null) {
                result.put("ok", false);
                result.put("message", "Spooled file not found: " + name);
            } else {
                String lib = toLib == null || toLib.isBlank() ? "*LIBL"
                        : toLib.trim().toUpperCase(Locale.ROOT);
                String q = toQueue == null ? "" : toQueue.trim().toUpperCase(Locale.ROOT);
                if (q.isEmpty()) throw new IllegalArgumentException("Target output queue is required");
                com.ibm.as400.access.OutputQueue target =
                        new com.ibm.as400.access.OutputQueue(s.clSystem, "/QSYS.LIB/" + lib + ".LIB/" + q + ".OUTQ");
                f.move(target);
                if (holdFirst) {
                    // Hold the file at its NEW location: re-find it on the
                    // target queue (the pre-move handle is stale after move).
                    com.ibm.as400.access.SpooledFileList dest = new com.ibm.as400.access.SpooledFileList(s.clSystem);
                    try {
                        dest.setUserFilter(jobUser == null || jobUser.isBlank() ? "*CURRENT"
                                : jobUser.trim().toUpperCase(Locale.ROOT));
                        dest.setQueueFilter("/QSYS.LIB/" + lib + ".LIB/" + q + ".OUTQ");
                        SpooledFile moved = findSpooledFile(dest, name, number, jobName, jobUser, jobNumber);
                        if (moved != null) moved.hold("*IMMED");
                    } finally {
                        try { dest.close(); } catch (Exception ignored) {}
                    }
                }
                result.put("ok", true);
                result.put("message", (holdFirst ? "Moved and held " : "Moved ") + name + " to " + lib + "/" + q);
            }
        } finally {
            try { list.close(); } catch (Exception ignored) {}
        }
        result.put("elapsedMs", elapsedMs(started));
        return result;
    }

    /** List output queues matching an optional name/library filter. Results are
        capped ( callers pass a limit ) so thousands of queues don't flood the UI. */
    private static ObjectNode listOutputQueues(Session s, String nameFilter, String libFilter,
            int limit) throws Exception {
        long started = System.nanoTime();
        String lib = libFilter == null || libFilter.isBlank() ? "%ALL%"
                : libFilter.trim().toUpperCase(Locale.ROOT);
        String q = nameFilter == null || nameFilter.isBlank() ? "%ALL%"
                : nameFilter.trim().toUpperCase(Locale.ROOT);
        com.ibm.as400.access.OutputQueueList list = new com.ibm.as400.access.OutputQueueList(s.clSystem);
        ArrayNode queues = JSON.createArrayNode();
        try {
            list.setQueueFilter("/QSYS.LIB/" + lib + ".LIB/" + q + ".OUTQ");
            list.openSynchronously();
            int count = 0;
            Enumeration<com.ibm.as400.access.OutputQueue> e = list.getObjects();
            while (e.hasMoreElements() && count < limit) {
                com.ibm.as400.access.OutputQueue oq = e.nextElement();
                ObjectNode node = JSON.createObjectNode();
                node.put("name", splfStr(oq::getName));
                node.put("library", splfStr(() -> oq.getStringAttribute(ATTR_OUTQUELIB)));
                node.put("description", splfStr(() -> oq.getStringAttribute(PrintObject.ATTR_DESCRIPTION)));
                queues.add(node);
                count++;
            }
        } finally {
            try { list.close(); } catch (Exception ignored) {}
        }
        ObjectNode result = JSON.createObjectNode();
        result.put("kind", "outputQueues");
        result.set("queues", queues);
        result.put("elapsedMs", elapsedMs(started));
        return result;
    }

    /** Read a spooled file's content: raw text bytes or PDF transform,
        base64-encoded for the JSON-lines protocol. */
    private static ObjectNode getSpooledFileData(Session s, String format, String name,
            String number, String jobName, String jobUser, String jobNumber, String devType) throws Exception {
        long started = System.nanoTime();
        SpooledFileList list = newListForUser(s.clSystem, jobUser);
        byte[] bytes;
        try {
            SpooledFile f = findSpooledFile(list, name, number, jobName, jobUser, jobNumber);
            if (f == null) throw new IllegalStateException("Spooled file not found: " + name);
            // Identity + status diagnostics: same object that read attributes
            // from the list, no reconstruction.
            String dt = devType.trim();
            if (dt.isEmpty()) {
                try { dt = nullToEmpty(f.getStringAttribute(PrintObject.ATTR_PRTDEVTYPE)).trim(); }
                catch (Throwable ignored) {}
            }
            System.err.println("[spool] name=" + f.getName() + " nbr=" + f.getNumber()
                    + " job=" + f.getJobNumber() + "/" + f.getJobUser() + "/" + f.getJobName()
                    + " status=" + safeAttr(f, PrintObject.ATTR_SPLFSTATUS)
                    + " devType=" + dt + " format=" + format);
            if ("image".equalsIgnoreCase(format)) {
                // Per-page GIF images via Host Print Transform with the
                // IBM-supplied GIF workstation customization object. Needs
                // HPT + QWPGIF on the host (base OS print services); when the
                // transform can't open, return a structured
                // imageTransformUnavailable so the frontend degrades to
                // raw-only instead of showing an error.
                ObjectNode imageResult = JSON.createObjectNode();
                imageResult.put("kind", "spooledFileData");
                imageResult.put("format", format);
                try {
                    PrintParameterList p = new PrintParameterList();
                    p.setParameter(PrintObject.ATTR_MFGTYPE, "*WSCST");
                    p.setParameter(PrintObject.ATTR_WORKSTATION_CUST_OBJECT, "/QSYS.LIB/QWPGIF.WSCST");
                    ArrayNode pages = JSON.createArrayNode();
                    long total = 0;
                    try (PrintObjectPageInputStream in = f.getPageInputStream(p)) {
                        byte[] buf = new byte[65536];
                        int n;
                        do {
                            java.io.ByteArrayOutputStream pageBytes = new java.io.ByteArrayOutputStream();
                            while ((n = in.read(buf)) > 0) pageBytes.write(buf, 0, n);
                            total += pageBytes.size();
                            pages.add(Base64.getEncoder().encodeToString(pageBytes.toByteArray()));
                        } while (in.nextPage());
                    }
                    imageResult.put("contentType", "image/gif");
                    imageResult.set("pages", pages);
                    imageResult.put("pageCount", pages.size());
                    imageResult.put("bytes", total);
                } catch (com.ibm.as400.access.AS400Exception e) {
                    // Covers ErrorCompletingRequestException and
                    // RequestNotSupportedException as well — both subclass
                    // AS400Exception in JT400.
                    System.err.println("[spool] image transform unavailable for " + name + ": " + e);
                    imageResult.put("errorCode", "imageTransformUnavailable");
                    imageResult.put("message", nullToEmpty(e.getMessage()));
                }
                imageResult.put("elapsedMs", elapsedMs(started));
                return imageResult;
            }
            if ("*USERASCII".equalsIgnoreCase(dt) || "*AFPDS".equalsIgnoreCase(dt)) {
                // No-arg getInputStream(): an empty PrintParameterList still
                // alters the NP-server open request.
                PrintObjectInputStream in = f.getInputStream();
                try {
                    bytes = in.readAllBytes();
                } catch (Exception readErr) {
                    // The ECRE is stringified into the IOException message, not
                    // chained as a cause. The host's CPF message sits on the
                    // stream impl's cpCPFMsg_ code point — dig it out via
                    // reflection and log id/text.
                    try {
                        // impl_ is private on PrintObjectInputStream itself.
                        java.lang.reflect.Field implF = in.getClass().getDeclaredField("impl_");
                        implF.setAccessible(true);
                        Object impl = implF.get(in);
                        java.lang.reflect.Field cpF = impl.getClass().getDeclaredField("cpCPFMsg_");
                        cpF.setAccessible(true);
                        Object cp = cpF.get(impl);
                        if (cp != null) {
                            // getStringValue(int) is package-private on the
                            // NPCPAttributeValue parent — find it up the chain.
                            Class<?> cls = cp.getClass();
                            java.lang.reflect.Method getter = null;
                            while (cls != null && getter == null) {
                                try {
                                    getter = cls.getDeclaredMethod("getStringValue", int.class);
                                } catch (NoSuchMethodException e) {
                                    cls = cls.getSuperclass();
                                }
                            }
                            if (getter != null) {
                                getter.setAccessible(true);
                                Object msgId = getter.invoke(cp, PrintObject.ATTR_MSGID);
                                Object msgText = getter.invoke(cp, PrintObject.ATTR_MSGTEXT);
                                System.err.println("[spool] host CPF message: " + msgId + " " + msgText);
                            } else {
                                System.err.println("[spool] getStringValue not found on " + cp.getClass());
                            }
                        } else {
                            System.err.println("[spool] no CPF message on stream impl");
                        }
                    } catch (Throwable refErr) {
                        System.err.println("[spool] reflection dig failed: " + refErr);
                    }
                    in.close();
                    throw readErr;
                }
                in.close();
            } else if ("pdf".equalsIgnoreCase(format)) {
                // PDF via host print transform: *WSCST + the default customization
                // object. Requires the host transform services; if the result isn't
                // %PDF the frontend shows the transform error instead of a file.
                PrintParameterList p = new PrintParameterList();
                p.setParameter(PrintObject.ATTR_MFGTYPE, "*WSCST");
                p.setParameter(PrintObject.ATTR_WORKSTATION_CUST_OBJECT, "/QSYS.LIB/QWPDEFAULT.WSCST");
                try (PrintObjectTransformedInputStream in = f.getTransformedInputStream(p)) {
                    bytes = in.readAllBytes();
                }
            } else if ("raw".equalsIgnoreCase(format)) {
                // Raw page-stream bytes, no CCSID decode — for SCS debugging.
                // Some devtypes (*USERASCII, certain *AFPDS) have no page
                // framing on the host; when the page stream open fails, fall
                // back to the plain byte stream so the data still comes down.
                try (PrintObjectPageInputStream in = f.getPageInputStream(new PrintParameterList())) {
                    java.io.ByteArrayOutputStream rawBytes = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    do {
                        while ((n = in.read(buf)) > 0) {
                            rawBytes.write(buf, 0, n);
                        }
                    } while (in.nextPage());
                    bytes = rawBytes.toByteArray();
                } catch (ErrorCompletingRequestException pageErr) {
                    System.err.println("[spool] " + name + " page stream failed ("
                            + pageErr.getMessage() + "); retrying with plain stream");
                    // No-arg getInputStream(): an empty PrintParameterList
                    // still alters the NP-server open request.
                    try (PrintObjectInputStream in = f.getInputStream()) {
                        bytes = in.readAllBytes();
                    }
                }
            } else {
                // Page stream: decoded text + per-record SCS column framing.
                // Decode with the spooled file's job CCSID (EBCDIC 037 etc.)
                // so text is readable; the {column} framing survives for the
                // frontend renderer.
                int ccsid = 37;
                try {
                    Object c = f.getIntegerAttribute(PrintObject.ATTR_JOBCCSID);
                    if (c instanceof Number n && n.intValue() > 0) ccsid = n.intValue();
                } catch (Throwable ignored) {}
                java.nio.charset.Charset cs;
                try {
                    cs = java.nio.charset.Charset.forName("Cp0" + ccsid);
                } catch (Throwable t) {
                    cs = java.nio.charset.Charset.forName("Cp037");
                }
                StringBuilder sb = new StringBuilder();
                try (PrintObjectPageInputStream in = f.getPageInputStream(new PrintParameterList())) {
                    byte[] buf = new byte[8192];
                    int n;
                    do {
                        while ((n = in.read(buf)) > 0) {
                            sb.append(new String(buf, 0, n, cs));
                        }
                    } while (in.nextPage());
                }
                bytes = sb.toString().getBytes(StandardCharsets.UTF_8);
            }
        } finally {
            try { list.close(); } catch (Exception ignored) {}
        }
        ObjectNode result = JSON.createObjectNode();
        result.put("kind", "spooledFileData");
        result.put("format", format);
        result.put("bytes", bytes.length);
        result.put("base64", Base64.getEncoder().encodeToString(bytes));
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

    /** True when a connect failure is a transient local socket condition
     * (EHOSTUNREACH/ECONNRESET during route/Wi-Fi settling) worth one retry. */
    private static boolean isTransientConnectError(SQLException e) {
        Throwable c = e;
        while (c != null) {
            if (c instanceof java.net.NoRouteToHostException
                    || c instanceof java.net.SocketException) return true;
            c = c.getCause();
        }
        return false;
    }

    private static ObjectNode errorNode(Throwable t) {
        // Full stack to the stderr log file for post-mortem debugging.
        t.printStackTrace();
        ObjectNode n = JSON.createObjectNode();
        if (t instanceof SQLException e) {
            n.put("type", "SQLException");
            n.put("sqlState", nullToEmpty(e.getSQLState()));
            n.put("vendorCode", e.getErrorCode());
        } else n.put("type", t.getClass().getSimpleName());
        n.put("message", nullToEmpty(t.getMessage()));
        // JT400 wraps socket failures in AS400Exception/JDError with the real
        // cause underneath — expose the chain so the UI can show it.
        Throwable cause = t.getCause();
        if (cause != null) {
            n.put("causeType", cause.getClass().getSimpleName());
            n.put("causeMessage", nullToEmpty(cause.getMessage()));
        }
        // Host-side failures (ErrorCompletingRequestException & co.) carry the
        // IBM i message list (CPF/CPD ids + text) on the AS400Exception base,
        // and a numeric return code — both may be buried under wrappers like
        // IOException, so walk the whole cause chain.
        StringBuilder msgs = new StringBuilder();
        Integer returnCode = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof com.ibm.as400.access.AS400Exception ae) {
                for (AS400Message m : ae.getAS400MessageList()) {
                    if (msgs.length() > 0) msgs.append(" | ");
                    msgs.append(m.getID()).append(": ").append(m.getText());
                }
            }
            if (returnCode == null && c instanceof com.ibm.as400.access.ReturnCodeException rce) {
                returnCode = rce.getReturnCode();
            }
        }
        if (msgs.length() > 0) n.put("hostMessages", msgs.toString());
        if (returnCode != null) n.put("returnCode", returnCode);
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
            if (s.activeSpoolList != null) {
                s.spoolListCancelled = true;
                try { s.activeSpoolList.close(); } catch (Exception ignored) {}
                s.activeSpoolList = null;
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

    /** Attribute read that never throws — returns "" on any failure. */
    private static String safeAttr(PrintObject o, int attr) {
        try {
            Object v = o.getStringAttribute(attr);
            return v == null ? "" : String.valueOf(v).trim();
        } catch (Throwable t) {
            return "";
        }
    }
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
        // In-flight spooled-file list: closed by cancelSpoolList/closeSession
        // so the host stops producing into the open-list user space.
        volatile SpooledFileList activeSpoolList;
        volatile boolean spoolListCancelled;
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
