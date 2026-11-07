
import { spawn } from "node:child_process";

const goBinary = process.env.BRIDGE_GO_BINARY ?? "../go-stub/bridge-test";

console.log("Launching Go test caller; it will start the Java/JTOpen helper.");
console.log("Build it first with: cd ../go-stub && go build -o bridge-test ./cmd/bridge-test");

const child = spawn(goBinary, [], { stdio: "inherit" });

child.on("error", err => {
    console.error("Could not launch Go test caller:", err);
    process.exitCode = 1;
});

child.on("exit", code => {
    process.exitCode = code ?? 1;
});

process.on("SIGINT", () => {
    child.kill("SIGINT");
});
