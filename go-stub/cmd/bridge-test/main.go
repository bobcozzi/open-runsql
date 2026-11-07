package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"syscall"

	"golang.org/x/term"

	"example.com/ibmi-jdbc-bridge-stub/bridge"
)

var input = bufio.NewReader(os.Stdin)

func prompt(label string) string {
	fmt.Print(label)
	s, _ := input.ReadString('\n')
	return strings.TrimSpace(s)
}

func secret(label string) string {
	fmt.Print(label)
	value, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not read password: %v\n", err)
		os.Exit(1)
	}
	return string(value)
}

func main() {
	jar := os.Getenv("IBMI_JDBC_BRIDGE_JAR")
	if jar == "" {
		jar = "../java-bridge/target/ibmi-jdbc-bridge.jar"
	}
	c, err := bridge.Start(os.Getenv("JAVA"), jar)
	if err != nil {
		panic(err)
	}
	defer c.Close()

	host := prompt("IBM i host: ")
	user := prompt("User: ")
	password := secret("Password: ")

	resp, err := c.Call("connect", map[string]any{
		"host": host, "user": user, "password": password,
		"tls":    strings.EqualFold(prompt("Use TLS? (y/N): "), "y"),
		"naming": "sql", "timeoutSeconds": 30, "fetchSize": 100,
	})
	if err != nil {
		panic(err)
	}
	connID := resp["connectionId"].(string)
	fmt.Printf("Connected: %v / %v\n", resp["databaseProduct"], resp["databaseVersion"])

	sql := prompt("SQL (default: SELECT CURRENT_USER, CURRENT_SCHEMA FROM SYSIBM.SYSDUMMY1): ")
	if sql == "" {
		sql = "SELECT CURRENT_USER, CURRENT_SCHEMA FROM SYSIBM.SYSDUMMY1"
	}
	resultResp, err := c.Call("executeSQL", map[string]any{
		"connectionId": connID, "sql": sql, "fetchSize": 100,
	})
	if err != nil {
		panic(err)
	}
	fmt.Printf("Result: %#v\n", resultResp["result"])

	_, _ = c.Call("disconnect", map[string]any{"connectionId": connID})
}
