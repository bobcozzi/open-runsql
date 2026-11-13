package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

type SQLCompletion struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Detail       string `json:"detail"`
	SpecificName string `json:"specificName,omitempty"`
}

func (a *App) GetSQLCompletions(connectionID, kind, schema, object, prefix string) ([]SQLCompletion, error) {
	switch kind {
	case "tables", "columns", "routines", "tableFunctions", "parameters", "routineColumns":
	default:
		return nil, errors.New("unsupported SQL completion kind")
	}
	for _, value := range []string{schema, object, prefix} {
		if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 128 || strings.ContainsRune(value, 0) {
			return nil, errors.New("SQL completion identifiers must be at most 128 characters and contain no NUL")
		}
	}
	if strings.TrimSpace(schema) == "" {
		return nil, errors.New("schema is required for SQL completions")
	}
	if (kind == "columns" || kind == "parameters" || kind == "routineColumns") && strings.TrimSpace(object) == "" {
		return nil, errors.New("object is required for this SQL completion kind")
	}
	a.mu.Lock()
	client := a.client
	_, known := a.connections[connectionID]
	a.mu.Unlock()
	if client == nil || !known {
		return nil, errors.New("not connected")
	}
	response, err := client.Call("sqlCompletions", map[string]any{
		"connectionId": connectionID, "kind": kind, "schema": schema, "object": object, "prefix": prefix,
	})
	if err != nil {
		return nil, err
	}
	rows, ok := response["result"].([]any)
	if !ok || len(rows) > 200 {
		return nil, errors.New("invalid SQL completions response")
	}
	result := make([]SQLCompletion, 0, len(rows))
	for _, row := range rows {
		fields, ok := row.(map[string]any)
		if !ok {
			return nil, errors.New("invalid SQL completion row")
		}
		for _, key := range []string{"name", "kind", "detail"} {
			if _, ok := fields[key].(string); !ok {
				return nil, fmt.Errorf("invalid SQL completion %s", key)
			}
		}
		if specific, exists := fields["specificName"]; exists {
			if _, ok := specific.(string); !ok {
				return nil, errors.New("invalid SQL completion specificName")
			}
		}
		data, err := json.Marshal(fields)
		if err != nil {
			return nil, err
		}
		var completion SQLCompletion
		if err := json.Unmarshal(data, &completion); err != nil {
			return nil, err
		}
		result = append(result, completion)
	}
	return result, nil
}
