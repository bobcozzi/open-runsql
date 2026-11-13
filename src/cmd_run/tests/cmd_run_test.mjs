import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(directory, '..', 'CMD_RUN.CPP'), 'utf8').replace(/\r\n/g, '\n');

function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Cannot find ${start}`);
  return source.slice(first, last);
}

const indicatorBlock = extract('//  Output Indicator Fields', '//  SQL specific parameters');
const indicators = [...indicatorBlock.matchAll(/outIndy\((\w+)\)/g)].map(match => match[1]);
assert.deepEqual(indicators, [
    'ORDPOS', 'MSGID', 'MSGSEV', 'MSGTYPE', 'SENDDTS', 'MSGTEXT',
    'SENDER', 'SENDPGM', 'SENDSTMT', 'SENDMOD', 'SENDPROC',
    'TOPGM', 'TOSTMT', 'TOMOD', 'TOPROC', 'SECLVL',
]);

let messageTypes = String.raw`
struct Qmh_Rcvpm_RCVM0100_t {
        int Bytes_Returned;
        int Bytes_Available;
        char Message_Key[4];
};
struct Qmh_Rcvpm_RCVM0300_t {
        int Bytes_Returned;
    int Bytes_Available;
        int Message_Severity;
        char Message_Id[7];
        char Message_Type[2];
        int Length_Data_Returned;
        int Length_Message_Returned;
        int Length_Help_Returned;
        int Length_Send_Returned;
};
struct Qmh_Rcvpm_Sender_t { char data[16]; };
`;
if (process.env.IBMI_QSYSINC_H) {
    const header = readFileSync(join(process.env.IBMI_QSYSINC_H, 'QMHRCVPM.C'), 'utf8');
    const names = ['RCVM0100', 'RCVM0300', 'Sender'];
    messageTypes = names.map(name => {
        const pattern = new RegExp(`typedef _Packed struct Qmh_Rcvpm_${name}\\s*\\{[\\s\\S]*?\\} Qmh_Rcvpm_${name}_t;`);
        const match = header.match(pattern);
        assert(match, `Cannot find Qmh_Rcvpm_${name}_t in QMHRCVPM.C`);
        return match[0].replace('typedef _Packed struct', 'typedef struct __attribute__((packed))');
    }).join('\n');
}

const code = String.raw`
#include <algorithm>
#include <cassert>
#include <cctype>
#include <cstdio>
#include <cstring>

bool startsWith(const char* text, const char* prefix) {
    return std::strncmp(text, prefix, std::strlen(prefix)) == 0;
}
int makeUpper(char* text) {
    for (char* current = text; *current; ++current)
        *current = std::toupper(static_cast<unsigned char>(*current));
    return 0;
}
${extract('char* extractCLCmdName(', '\nint sndMsg(')}
${extract('int xlateCheckOption(const char* pProcessMode)\n{', '\nvoid rtvMsgText(')}

#define MAX_MSGKEY_COUNT 256
#define MAX_MSGTEXT_LEN 2000
#define MAX_SECLVL_LEN 4000
#define MSG_RECEIVER_SIZE 32768
#define _CPYBYTES(destination, source, length) std::memcpy(destination, source, length)
#define QMH_FMT_RCVM0100 "RCVM0100"
#define QMH_FMT_RCVM0300 "RCVM0300"
#define QMH_MSGACT_SAME "SAME"
#define QMH_MSGACT_OLD "OLD"

struct scratch_t {
    char MSGINFO[21];
    int msgcount;
    int current_msg;
    char RQSMSGKEY[4];
    char msgkey[MAX_MSGKEY_COUNT][4];
};
${messageTypes}
struct coz_qusec {
    bool error = false;
    bool hasError() const { return error; }
    bool hasNoError() const { return !error; }
};

int mockMessageCount = 0;
int mockCalls = 0;
int mockFailAt = -1;
int mockReceiverCase = 0;
char receiver[MSG_RECEIVER_SIZE];

void QMHRCVPM(char* buffer, int, const char*, const char*, int, const char*,
              const char*, int, const char*, coz_qusec* error) {
    if (mockCalls++ == mockFailAt) {
        error->error = true;
        return;
    }
    auto* reply = reinterpret_cast<Qmh_Rcvpm_RCVM0100_t*>(buffer);
    reply->Bytes_Returned = mockCalls <= mockMessageCount ? sizeof(*reply) : 8;
    std::memcpy(reply->Message_Key, &mockCalls, sizeof(reply->Message_Key));
}
void QMHRCVPM(char* buffer, int, const char*, const char*, int, const char*,
              const char*, int, const char*, coz_qusec* error, int,
              const char*, const char*, int) {
    if (mockReceiverCase == 2) {
        error->error = true;
        return;
    }
    auto* reply = reinterpret_cast<Qmh_Rcvpm_RCVM0300_t*>(buffer);
    reply->Bytes_Returned = sizeof(*reply) + 4;
    reply->Bytes_Available = reply->Bytes_Returned + (mockReceiverCase == 4 ? 1 : 0);
    reply->Length_Message_Returned = mockReceiverCase == 3 ? -1 : 4;
    std::memcpy(reply->Message_Id, "CPF1234", 7);
    std::memcpy(buffer + sizeof(*reply), "text", 4);
}
char* coz_getPtrUsrSpace(const char*) { return mockReceiverCase == 1 ? nullptr : receiver; }
void copyStrToFixed(char* target, const char* text, int length) {
    std::memset(target, ' ', length);
    std::memcpy(target, text, std::min<int>(std::strlen(text), length));
}
int getMsgType(char* result, const char*) { std::strcpy(result, "*INFO"); return 4; }

${extract('inline int collectAllMsgKeys(scratch_t* pScratch)\n{', '\n\n\n/* ============================================= */')}
${extract('int getNextCmdMsg(scratch_t* pScratch, char* msgid, int* msgsev, char* msgtype,\n', '\n\n\n/* ============================================= */')}

int collect(int count, int failAt) {
    scratch_t scratch = {};
    mockMessageCount = count;
    mockCalls = 0;
    mockFailAt = failAt;
    return collectAllMsgKeys(&scratch);
}
int fetch(int receiverCase) {
    scratch_t scratch = {};
    scratch.msgcount = 1;
    mockReceiverCase = receiverCase;
    char id[8] = {}, type[11] = {}, text[2001] = {}, help[4001] = {};
    int severity = 0;
    Qmh_Rcvpm_Sender_t* sender = nullptr;
    const int result = getNextCmdMsg(&scratch, id, &severity, type, text, help, sender);
    if (receiverCase == 0) {
        assert(result == 1);
        assert(std::strcmp(text, "text") == 0);
    }
    return result;
}
int main() {
    char name[11];
    assert(isProhibitedCmd("PWRDWNSYS", name, sizeof(name)));
    assert(isProhibitedCmd("qsys/pwrdwnsys", name, sizeof(name)));
    assert(isProhibitedCmd("label: QSYS/ENDTCPSVR", name, sizeof(name)));
    assert(!isProhibitedCmd("QSYS/CHKOBJ", name, sizeof(name)));
    assert(xlateCheckOption("RUN") == 0);
    assert(xlateCheckOption("CHECK") == 1);
    assert(xlateCheckOption("LIMIT") == 2);
    assert(xlateCheckOption("CHECKLIMIT") == 3);
    assert(xlateCheckOption("NOTAMODE") == -1);
    assert(parseProcessMode(nullptr) == 0);
    assert(parseProcessMode("") == 0);
    assert(parseProcessMode("  *   ") == 0);
    assert(parseProcessMode(" *run  ") == 0);
    assert(parseProcessMode(" *check ") == 1);
    assert(parseProcessMode("invalid") == -1);
    assert(collect(0, -1) == 0);
    assert(collect(1, -1) == 1);
    assert(collect(256, -1) == 256);
    assert(collect(257, -1) == -2);
    assert(collect(1, 0) == -1);
    assert(fetch(0) == 1);
    assert(fetch(1) == -1);
    assert(fetch(2) == -1);
    assert(fetch(3) == -1);
    assert(fetch(4) == -1);
}
`;

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cmd-run-test-'));
try {
  const binary = join(temporaryDirectory, 'cmd-run-test');
  execFileSync('clang++', ['-std=c++11', '-x', 'c++', '-', '-o', binary], { input: code, stdio: ['pipe', 'inherit', 'inherit'] });
  execFileSync(binary, { stdio: 'inherit' });
  console.log('CMD_RUN portable tests passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}